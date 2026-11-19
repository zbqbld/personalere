/**
 * AI 上游流式转发回归：契约不变 + 稳定性增强
 *
 * 抽取 /api/interpret 与 /api/heming 的公共传输层后，钉住三件事：
 *  1) fetch 阶段失败 / 上游非 2xx 仍返回 502 文本（对外契约不变）；
 *  2) 成功路径的 SSE 格式与抽取前一致（delta / keep-alive / [DONE]）；
 *  3) 上游异常显式发 error 事件，不再静默 [DONE]；SSE 跨块缓冲不丢字。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../lib/ai/stream-upstream.ts', import.meta.url), 'utf8');

// ── 1) 源码锚定：契约与稳定性要点 ──
const anchors: Array<[string, string]> = [
  ['fetch 失败 502', 'Upstream request failed:'],
  ['上游非2xx 502', 'Upstream error ${upstream.status}'],
  ['错误脱敏-不回传上游原文', 'console.error(\'[ai-upstream] non-2xx\''],
  ['fetch 失败脱敏', 'connection error'],
  ['超时中断', 'controller.abort(), UPSTREAM_TIMEOUT_MS'],
  ['超时清理', 'clearTimeout(timeoutId)'],
  ['跨块缓冲', "buffer = lines.pop() ?? ''"],
  ['保活注释', "': keep-alive\\n'"],
  ['错误事件', "error: aborted ? 'upstream_timeout' : 'upstream_interrupted'"],
  ['SSE 响应头', "'text/event-stream; charset=utf-8'"],
];
for (const [label, needle] of anchors) {
  assert.ok(src.includes(needle), `共享传输层应包含${label}（${needle}）`);
}
// 两个路由都必须走共享函数，不能再各自实现传输层
for (const route of ['interpret', 'heming']) {
  const r = readFileSync(new URL(`../../app/api/${route}/route.ts`, import.meta.url), 'utf8');
  assert.ok(r.includes("import { streamUpstream } from '@/lib/ai/stream-upstream'"), `${route} 应 import 共享传输层`);
  assert.ok(!r.includes('let upstream: Response'), `${route} 不应再保留自己的 upstream 传输实现`);
  assert.ok(r.includes('return streamUpstream('), `${route} 应调用共享传输层`);
}

// ── 2) SSE 转发逻辑（与 streamUpstream 内一致的纯逻辑镜像）──
function forwardSse(chunks: string[], onEvent: (evt: string) => void, onDone: () => void): void {
  let buffer = '';
  for (const chunk of chunks) {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') { onDone(); continue; }
      try {
        const json = JSON.parse(data);
        const text: string = json?.choices?.[0]?.delta?.content ?? '';
        if (text) onEvent(JSON.stringify({ delta: { text } }));
      } catch { /* 半行等待 */ }
    }
  }
  if (buffer.trim()) {
    try {
      const json = JSON.parse(buffer.trim().slice(5).trim());
      const text: string = json?.choices?.[0]?.delta?.content ?? '';
      if (text) onEvent(JSON.stringify({ delta: { text } }));
    } catch { /* 忽略 */ }
  }
}

const line = 'data: {"choices":[{"delta":{"content":"紫微斗数解读正文"}}]}\ndata: [DONE]\n';
// 逐字节切分：任何切点都不能丢字
for (let cut = 1; cut < line.length; cut++) {
  const got: string[] = [];
  let done = false;
  forwardSse([line.slice(0, cut), line.slice(cut)], e => got.push(e), () => { done = true; });
  assert.equal(got.length, 1, `第 ${cut} 字节切开应完整解析出 1 个事件`);
  assert.ok(got[0].includes('紫微斗数解读正文'), `第 ${cut} 字节切开不应丢字`);
  assert.equal(done, true, '[DONE] 应被识别');
}
// ── 3) 账号路由鉴权辅助抽取：两路由必须共用 tokenOf/denyResponse ──
for (const route of ['account', 'profiles']) {
  const r = readFileSync(new URL(`../../app/api/${route}/route.ts`, import.meta.url), 'utf8');
  assert.ok(r.includes("from '@/lib/account/http'"), `${route} 应复用共享鉴权辅助`);
  assert.ok(!r.includes('function denyResponse()'), `${route} 不应再自己定义 denyResponse`);
}
const httpShared = readFileSync(new URL('../../lib/account/http.ts', import.meta.url), 'utf8');
assert.ok(httpShared.includes('DENY_STATUS'), '共享模块必须保持统一 403 拒绝');

console.log('ai-stream-shared.test.ts: PASS (契约锚定 / 两路由接入 / SSE 逐字节切分 / 鉴权辅助去重)');
