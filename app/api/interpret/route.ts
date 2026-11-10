import { NextRequest } from 'next/server';

// 命盘 AI 解读接口（OpenAI 兼容流式协议）
// 前端在 components/ChatPanel.tsx / InsightPanel.tsx 以 SSE 方式消费：
//   每行 `data: {"delta":{"text":"..."}}`，结尾 `data: [DONE]`
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function buildSystemPrompt(chart: unknown): string {
  return `你是一位精通倪海厦《天纪》紫微斗数体系的命理师，擅长排盘、四化飞星、大限流年与格局分析。
以下是用户的命盘（JSON 结构，由本仓库的排盘引擎生成）：
${JSON.stringify(chart)}
请根据命盘，用专业但通俗易懂的中文回答用户的问题。涉及大限、流年、四化飞星、宫位星曜时，请结合倪师的理论进行解读，并尽量给出可操作的生活/决策建议。回答要结构清晰，避免过度玄虚。`;
}

export async function POST(req: NextRequest) {
  let body: { chart?: unknown; messages?: { role: 'user' | 'assistant' | 'system'; content: string }[] };
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.MIMO_API_KEY;
  const baseURL = (process.env.MIMO_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const model = process.env.MIMO_MODEL || 'deepseek-chat';

  if (!apiKey) {
    return new Response(
      'Missing API key. 请在 .env.local 中配置 DEEPSEEK_API_KEY 或 MIMO_API_KEY。',
      { status: 500 }
    );
  }

  // 上下文最终校验（不改变任何对外契约）：
  //  - 过滤空内容与非法 role，避免脏历史 / 失败占位进入上游；
  //  - 客户端附带的 system 锚点（长期偏好）合并进单条系统提示，
  //    保证任意 OpenAI 兼容上游只看到一条 system，消除多 system 兼容风险。
  // 常规请求（仅 user/assistant）经此处理后与优化前完全一致。
  const systemExtras: string[] = [];
  const convo: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m || typeof m.content !== 'string') continue;
    const content = m.content;
    if (!content.trim()) continue;
    if (m.role === 'system') { systemExtras.push(content); continue; }
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    convo.push({ role: m.role, content });
  }
  const messages = [
    { role: 'system' as const, content: [buildSystemPrompt(body.chart), ...systemExtras].join('\n\n') },
    ...convo,
  ];

  // 智谱 GLM-5.3 系列始终思考、不支持关闭；官方仅提供 reasoning_effort（low|high|max）。
  // 默认 low 以兼顾响应速度，可通过 .env.local 的 MIMO_REASONING_EFFORT 调整。
  const payload: Record<string, unknown> = { model, stream: true, messages };
  const effortEnv = process.env.MIMO_REASONING_EFFORT;
  if (effortEnv && ['low', 'high', 'max'].includes(effortEnv)) {
    payload.reasoning_effort = effortEnv;
  } else if (model.startsWith('glm-5.3')) {
    payload.reasoning_effort = 'low';
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    return new Response(`Upstream request failed: ${(e as Error).message}`, { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    const txt = await upstream.text().catch(() => '');
    return new Response(`Upstream error ${upstream.status}: ${txt}`, { status: 502 });
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = '';
      let lastBeat = 0;
      const push = (s: string) => controller.enqueue(encoder.encode(s));
      // 立即冲刷响应头：即使模型处于思考阶段（仅 reasoning_content），
      // 前端也能马上拿到 200 响应进入“加载中”，不会被误判为失败。
      push(': connected\n');
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const raw of lines) {
            const line = raw.trim();
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') {
              push('data: [DONE]\n');
              continue;
            }
            try {
              const json = JSON.parse(data);
              const text: string = json?.choices?.[0]?.delta?.content ?? '';
              if (text) {
                push(`data: ${JSON.stringify({ delta: { text } })}\n`);
              } else {
                // 思考阶段：每 2 秒发一次 SSE 注释保活，避免连接被判超时
                const now = Date.now();
                if (now - lastBeat > 2000) {
                  push(': keep-alive\n');
                  lastBeat = now;
                }
              }
            } catch {
              /* 跳过非 JSON 行 */
            }
          }
        }
        push('data: [DONE]\n');
      } catch {
        push('data: [DONE]\n');
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
