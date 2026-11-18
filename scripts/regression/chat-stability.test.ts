/**
 * 对话稳定性回归：重试 / 自动提问排队 / 失败占位清理
 *
 * 这些逻辑在 InsightPanel 的 React 组件内，直接渲染需要 DOM 环境。
 * 本测试用「源码断言 + 纯逻辑镜像」两层：
 *  1) 源码断言钉住关键修复没被误删（防回归）；
 *  2) 纯逻辑镜像验证队列语义（FIFO / 截断 / 消费时机）与消息清理规则。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../components/InsightPanel.tsx', import.meta.url), 'utf8');

// ── 1) 源码钉住：修复点都在 ──
const anchors: Array<[string, string]> = [
  ['超时中断', 'controller.abort(), 180000'],
  ['AbortError 提示', "e.name === 'AbortError'"],
  ['失败重试按钮', 'ios-turn-retry'],
  ['重试参数复用', 'setRetryInfo({ apiMessages })'],
  ['切页落盘 pagehide', "addEventListener('pagehide'"],
  ['切后台落盘', "document.visibilityState === 'hidden'"],
  ['自动提问排队', 'pendingAutoRef.current'],
  ['排队消费', 'pendingAutoRef.current.shift()'],
  ['busy 提示不进历史', 'setBusyHint('],
  ['超时清理', 'window.clearTimeout(timeoutId)'],
];
for (const [label, needle] of anchors) {
  assert.ok(src.includes(needle), `源码应包含${label}（${needle}），否则修复被回退`);
}
// 手动提问被拦下时不得再往消息历史里 push 提示（会污染上下文与持久化）
assert.ok(
  !/setMessages\(prev => \[\.\.\.prev, \{ role: 'assistant', content: '（上一条解读还在生成/.test(src),
  'busy 提示不得写入消息历史',
);

// ── 2) 排队语义：FIFO + 最近 3 条截断 ──
function enqueue(queue: string[], item: string): string[] {
  return [...queue.slice(-2), item];
}
let q: string[] = [];
for (const s of ['A', 'B', 'C', 'D']) q = enqueue(q, s);
assert.deepEqual(q, ['B', 'C', 'D'], '排队只保留最近 3 条');
assert.equal(q.shift(), 'B', '队列按 FIFO 消费');
assert.deepEqual(q, ['C', 'D']);

// ── 3) 失败占位清理：从尾部移除连续 assistant，不动 user 与更早内容 ──
type M = { role: 'user' | 'assistant'; content: string };
function dropTrailingAssistant(msgs: M[]): M[] {
  const next = msgs.slice();
  while (next.length > 0 && next[next.length - 1].role === 'assistant') next.pop();
  return next;
}
const history: M[] = [
  { role: 'user', content: '问题1' },
  { role: 'assistant', content: '回答1' },
  { role: 'user', content: '问题2' },
  { role: 'assistant', content: '半截内容（连接中断…）' },
];
const cleaned = dropTrailingAssistant(history);
assert.equal(cleaned.length, 3, '只移除失败占位');
assert.equal(cleaned[2].content, '问题2', '用户提问必须保留');
assert.equal(cleaned[1].content, '回答1', '更早的正常回答必须保留');

console.log('chat-stability.test.ts: PASS (修复点锚定 / 排队 FIFO 与截断 / 失败占位清理不误删)');
