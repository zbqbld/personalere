/**
 * 三方四正连线回归：防止全局 svg 样式破坏覆盖层定位
 *
 * 命盘上的三方四正 SVG 依赖 width/height=100% + 百分比坐标覆盖在
 * 绝对定位容器上（无 viewBox）。任何 `.zw-pane-left svg { height:auto }`
 * 之类全局规则都会让它塌陷成 150px，连线错位到命盘顶部。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../app/globals.css', import.meta.url), 'utf8');
const board = readFileSync(new URL('../../components/ChartBoard.tsx', import.meta.url), 'utf8');

// 1) 覆盖层 SVG 必须保留 100% 尺寸与百分比坐标
assert.ok(board.includes('height="100%"'), '三方四正 SVG 必须有 height=100%');
assert.ok(board.includes('width="100%"'), '三方四正 SVG 必须有 width=100%');
assert.ok(board.includes("position: 'absolute'") && board.includes('zIndex: 20'), '覆盖层必须绝对定位在最上层');
assert.ok(board.includes('${p0[0]}%'), '连线坐标必须用百分比');
// 无 viewBox 是这条实现的前提（有 viewBox 时 auto 高度行为不同）
const svgBlock = board.slice(board.indexOf('<svg', board.indexOf('sanFangBranches !== null')), board.indexOf('</svg>', board.indexOf('sanFangBranches !== null')));
assert.ok(!svgBlock.includes('viewBox'), '三方四正 SVG 不应有 viewBox（依赖百分比坐标）');

// 2) CSS 不得有任何会覆盖覆盖层尺寸的全局 svg 规则
assert.ok(
  !/\.zw-pane-left\s+svg\s*\{[^}]*height\s*:\s*auto/i.test(css),
  '不得对 .zw-pane-left 下所有 svg 设 height:auto（会压塌三方四正覆盖层）',
);
assert.ok(
  !/^\s*svg\s*\{[^}]*height\s*:\s*auto/im.test(css),
  '不得设置全局 svg height:auto',
);

console.log('sanfang-overlay.test.ts: PASS (覆盖层 100% 尺寸 / 百分比坐标 / 无全局 svg 塌陷规则)');
