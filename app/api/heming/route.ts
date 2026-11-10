import { NextRequest } from 'next/server';

// 合盘 AI 分析接口（OpenAI 兼容流式协议）
// 前端在 app/heming/page.tsx 以 SSE 方式消费：
//   每行 `data: {"delta":{"text":"..."}}`，结尾 `data: [DONE]`
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function buildSystemPrompt(chartA: unknown, chartB: unknown): string {
  return `你是一位精通倪海厦《天纪》紫微斗数体系的命理师，擅长合盘（双方命盘）分析，
常用于感情、合伙、亲子、朋友等关系的契合度与互动模式解读。
以下是两张命盘（JSON 结构，由本仓库的排盘引擎生成）：

【命盘 A】
${JSON.stringify(chartA)}

【命盘 B】
${JSON.stringify(chartB)}

请结合双方命盘，用专业但通俗易懂的中文进行分析。可涵盖：性格与沟通模式、感情契合度、
相处中的优势与需要注意的摩擦点、事业/合伙协作、以及具体可操作的相处建议。
回答要结构清晰，避免空泛玄虚。`;
}

export async function POST(req: NextRequest) {
  let body: { chartA?: unknown; chartB?: unknown; question?: string };
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (!body.chartA || !body.chartB) {
    return new Response('Missing chartA or chartB', { status: 400 });
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

  const messages = [
    { role: 'system' as const, content: buildSystemPrompt(body.chartA, body.chartB) },
    {
      role: 'user' as const,
      content:
        body.question && body.question.trim()
          ? body.question
          : '请对这两张命盘进行全面的合盘分析，并给出相处建议。',
    },
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
