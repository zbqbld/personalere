/**
 * 左右分栏布局回归
 *
 * 钉住两件事：
 *  1) 布局结构存在（两栏 + 分隔线 + 格局在右栏），且拖动只改 grid 列宽；
 *  2) 业务数据与调用未被改动——拖动 handler 不得触碰 chart/messages/quota 等 state。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const page = readFileSync(new URL('../../app/chart/page.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');

// ── 1) 结构锚定 ──
for (const needle of [
  'className="zw-scroll zw-pane-left"',
  'className="zw-splitter"',
  'className="zw-scroll zw-pane-right"',
  'role="separator"',
  'onPointerDown={startDrag}',
  'onPointerMove={onDrag}',
  'onPointerUp={endDrag}',
  'onDoubleClick={() => setLeftPct(46)}',
  'gridTemplateColumns: `minmax(0, ${leftPct}fr) 10px minmax(0, ${100 - leftPct}fr)`',
]) {
  assert.ok(page.includes(needle), `页面应包含 ${needle}`);
}
// 格局卡片必须在右栏（解析区），不能留在命盘栏
const leftStart = page.indexOf('zw-pane-left');
const rightStart = page.indexOf('zw-pane-right');
const patternsPos = page.indexOf('<PatternsCard');
assert.ok(patternsPos > rightStart && patternsPos < page.indexOf('<InsightPanel'), '格局卡片必须在右栏且位于解读之前');
assert.ok(leftStart > 0 && rightStart > leftStart, '左栏应在右栏之前');

// ── 2) 拖动只改布局比例，不碰业务 state ──
const dragBlock = page.slice(page.indexOf('const startDrag'), page.indexOf('const endDrag'));
const forbidden = ['setChart(', 'setMessages(', 'setSelectedPalace(', 'setQuota(', 'setLeftPct(Math.max'];
for (const f of forbidden.slice(0, 4)) {
  assert.ok(!dragBlock.includes(f), `拖动逻辑不得调用 ${f}（会改业务数据）`);
}
assert.ok(dragBlock.includes('setLeftPct(Math.max(30, Math.min(70, pct)))'), '拖动应限制在 30–70%');

// ── 3) CSS：分栏 + 窄屏回退 + 不溢出 ──
for (const needle of [
  'grid-template-columns: minmax(0, 46fr) 10px minmax(0, 54fr)',
  '.zw-pane-left { position: sticky; top: 12px; }',
  'touch-action: none;',
  '不要在这里写 svg { height:auto }',
  '@media (max-width: 900px)',
  'grid-template-columns: minmax(0, 1fr) !important;',
  '.zw-splitter { display: none; }',
]) {
  assert.ok(css.includes(needle), `CSS 应包含 ${needle}`);
}

console.log('layout-split.test.ts: PASS (分栏结构 / 格局在右栏 / 拖动不改业务数据 / 响应式回退)');
