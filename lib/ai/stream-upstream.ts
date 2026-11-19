/**
 * AI 上游流式转发（/api/interpret 与 /api/heming 共用）
 *
 * 只负责传输层：向上游发起请求 → 把 OpenAI 兼容的 delta.content 转成简化 SSE。
 * 业务层（system prompt、计费门禁、请求体校验）仍由各路由自己负责。
 *
 * 对外契约与抽取前完全一致：
 *  - fetch 失败 → HTTP 502 + 文本（原样）
 *  - 上游非 2xx → HTTP 502 + 文本（原样）
 *  - 连接成功后 → SSE 流（delta / keep-alive / error / [DONE]）
 *
 * 稳定性增强：上游请求带 180s 超时；SSE 跨网络块缓冲；上游异常显式发 error 事件。
 */
export interface UpstreamPayload {
  model: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  stream?: boolean;
  reasoning_effort?: string;
}

const UPSTREAM_TIMEOUT_MS = 180000;

export async function streamUpstream(
  payload: UpstreamPayload | Record<string, unknown>,
  apiKey: string,
  baseURL: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  let upstream: Response;
  try {
    upstream = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeoutId);
    const aborted = e instanceof Error && e.name === 'AbortError';
    // 服务端记录原因；客户端只给分类提示，不暴露底层异常详情
    console.error('[ai-upstream] fetch failed', aborted ? 'timeout' : (e as Error)?.message?.slice(0, 200));
    return new Response(
      `Upstream request failed: ${aborted ? 'timeout' : 'connection error'}`,
      { status: 502 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    clearTimeout(timeoutId);
    const txt = await upstream.text().catch(() => '');
    // 服务端记录摘要供排障；客户端只回传状态码，不暴露上游原文（可能含内部细节）
    console.error('[ai-upstream] non-2xx', upstream.status, txt.slice(0, 200));
    return new Response(`Upstream error ${upstream.status}`, { status: 502 });
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controllerStream) {
      let buffer = '';
      let lastBeat = 0;
      const push = (s: string) => controllerStream.enqueue(encoder.encode(s));
      // 立即冲刷响应头：模型思考阶段前端也能进入「加载中」
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
                const now = Date.now();
                if (now - lastBeat > 2000) {
                  push(': keep-alive\n');
                  lastBeat = now;
                }
              }
            } catch {
              /* 跳过非 JSON 行（半行已在 buffer 中等待） */
            }
          }
        }
        push('data: [DONE]\n');
      } catch (e) {
        const aborted = e instanceof Error && e.name === 'AbortError';
        const message = aborted ? '上游响应超时' : (e as Error)?.message || '上游连接中断';
        // 流已开始，无法改 HTTP 状态；用 error 事件让前端识别中断（interpret 原行为）
        push(`data: ${JSON.stringify({ error: aborted ? 'upstream_timeout' : 'upstream_interrupted', message })}\n`);
        push('data: [DONE]\n');
      } finally {
        clearTimeout(timeoutId);
        controllerStream.close();
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
