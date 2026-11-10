/**
 * 配色可读性回归测试
 *
 * 背景：命盘组件（ChartBoard / PalaceCell / InsightPanel / ChatPanel /
 * ChartSummary / TimeNav / StarDetailPanel …）大量引用 --t-* 变量，
 * 但上游从未在 CSS 中定义，导致 color/background/border 退化为继承值，
 * 文字层级与卡片边界丢失；叠加 inline opacity 后 8–11px 小字几乎不可读。
 *
 * 本用例锁定三件事：
 *  1) 所有被组件引用的 --t-* 变量都必须有定义（防止再次缺失）；
 *  2) 明暗两套主题的文字色均达到 WCAG AA（正文 ≥4.5:1）；
 *  3) 金色底按钮必须用深墨字，暗色主题必须覆盖四化语义色。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const css = readFileSync(path.resolve('app/globals.css'), 'utf8');

/** 取出某个选择器规则块的声明文本 */
function block(selector: string): string {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `缺少 ${selector} 规则块`);
  const open = css.indexOf('{', start);
  const end = css.indexOf('}', open);
  return css.slice(open + 1, end);
}

function parseVars(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of src.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out[m[1]] = m[2].trim();
  return out;
}

const light = parseVars(block(':root'));
const dark = parseVars(block('[data-theme="dark"]'));

/** 解析 var(--x) 引用链，得到可直接计算的字面色值 */
function resolve(raw: string, scope: Record<string, string>, seen = new Set<string>()): string {
  const ref = raw.match(/^var\((--[a-z0-9-]+)\)$/i);
  if (!ref) return raw;
  const name = ref[1];
  assert.ok(!seen.has(name), `变量循环引用：${name}`);
  seen.add(name);
  const next = scope[name];
  assert.ok(next, `引用的变量未定义：${name}`);
  return resolve(next, scope, seen);
}

function luminance(hex: string): number {
  assert.ok(/^#?[0-9a-f]{6}$/i.test(hex), `无法计算对比度：${hex}`);
  const h = hex.replace('#', '');
  const ch = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255);
  const [r, g, b] = ch.map(v => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5;
const TEXT_VARS = [
  '--tx-1', '--tx-2', '--tx-3',
  '--t-text', '--t-text1', '--t-text2', '--t-faint', '--t-gold',
  '--ac-dim', '--lu', '--quan', '--ke', '--ji',
  '--t-purple', '--t-sky',
];

function checkTheme(scope: Record<string, string>, label: string, bg: string): void {
  for (const name of TEXT_VARS) {
    const color = resolve(scope[name] ?? '', scope);
    const ratio = contrast(color, bg);
    assert.ok(
      ratio >= AA,
      `${label} ${name}（${color}）在 ${bg} 上仅 ${ratio.toFixed(2)}:1，低于 AA 4.5:1`,
    );
  }
}

checkTheme(light, '浅色', '#FFFFFF');      // 卡片白底
checkTheme(light, '浅色/页面', '#F8F6F0'); // 页面暖白底
checkTheme(dark, '暗色', '#0A1220');       // 暗色卡片底
checkTheme(dark, '暗色/页面', '#020810');  // 暗色页面底

// 金色按钮：白字仅 3.22:1，必须用深墨字
assert.ok(contrast('#1A1206', resolve(light['--ac'], light)) >= AA, '浅色金色按钮文字对比不足');
assert.ok(contrast('#0B0A08', resolve(dark['--ac'], dark)) >= AA, '暗色金色按钮文字对比不足');
assert.ok(!/color:\s*white\s*;/i.test(css), '金色底按钮不应再使用白字');

// 暗色主题必须覆盖四化语义色（沿用浅色深值时仅 2.6–4.0:1）
for (const name of ['--lu', '--quan', '--ke', '--ji']) {
  assert.ok(dark[name], `暗色主题缺少 ${name} 覆盖`);
  assert.notEqual(dark[name], light[name], `暗色 ${name} 不应与浅色相同`);
}

// 组件引用到的 --t-* 变量必须全部有定义
function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const p = path.join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(tsx?|jsx?|css)$/.test(entry) && !p.endsWith('globals.css')) acc.push(p);
  }
  return acc;
}

const referenced = new Set<string>();
for (const file of [...walk('components'), ...walk('app'), ...walk('lib')]) {
  for (const m of readFileSync(file, 'utf8').matchAll(/var\((--t-[a-z0-9-]+)\)/gi)) {
    referenced.add(m[1]);
  }
}
assert.ok(referenced.size >= 10, `应检测到组件引用的 --t-* 变量，实际 ${referenced.size} 个`);
for (const name of referenced) {
  assert.ok(light[name], `组件引用了 ${name}，但 CSS 中未定义`);
}

// 可读性补丁必须保留
for (const marker of [
  ':is(.text-\\[8px\\]',
  '[class*="text-emerald-500"]',
  '[data-theme="dark"] .badge-lu',
  'prefers-reduced-motion',
]) {
  assert.ok(css.includes(marker), `可读性补丁缺失：${marker}`);
}

console.log(
  `PASS 配色可读性：明暗双主题 ${TEXT_VARS.length * 2} 组文字色均 ≥ ${AA}:1；` +
  `${referenced.size} 个 --t-* 变量全部已定义；四化语义色与金色按钮达标`,
);
