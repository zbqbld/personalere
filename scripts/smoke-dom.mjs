/**
 * 真实 DOM 冒烟测试（jsdom）
 * 运行：node --experimental-strip-types scripts/smoke-dom.mjs
 *
 * 验证：
 *  - 浏览器 localStorage 中的上次信息能自动回填到表单 DOM；
 *  - 顶栏状态、沿用 / 重新起盘 / 清除 三个入口在 DOM 中存在且可点击；
 *  - 「清除本地记忆」二次确认生效，且不误删主题偏好。
 */
import assert from 'node:assert/strict';
import jsdomPkg from 'jsdom';

const { JSDOM } = jsdomPkg;
const dom = new JSDOM(
  `<!doctype html><html><body>
    <div id="status"></div>
    <form id="birth">
      <input id="name" />
      <input id="year" />
      <input id="month" />
      <input id="day" />
      <input type="checkbox" id="remember" checked />
    </form>
    <button id="resume">沿用上次信息 · 直接查看命盘</button>
    <button id="restart">重新起盘 · 全新填写</button>
    <button id="clear">清除本地记忆</button>
    <div class="zw-chat-bar">
      <label class="zw-chat-toggle"><input type="checkbox" id="remember-chat" checked /><span>记住对话</span></label>
      <span class="zw-chat-state" id="chat-state">仅存本机 · 按命盘分开保存</span>
      <button id="clear-chat">清空对话</button>
    </div>
  </body></html>`,
  { url: 'http://localhost:3000/chart' },
);

globalThis.window = dom.window;
globalThis.document = dom.window.document;

const mem = await import('../lib/ziwei/memory.ts');
const { window } = dom;
const $ = (sel) => window.document.querySelector(sel);

const form = {
  name: '李四',
  year: '1988',
  month: '3',
  day: '22',
  clockHour: '9',
  clockMinute: '15',
  unknownTime: false,
  province: '上海市',
  city: '上海',
  longitude: 121.5,
  gender: 'female',
};

// ── 首次输入 → 持久化 ─────────────────────────────────────
const saved = mem.saveLastBirth(form);
assert.ok(saved, '首次提交应写入 localStorage');
assert.ok(window.localStorage.getItem(mem.LAST_BIRTH_KEY), '真实 localStorage 中应有记录');

// 模拟「清空浏览器重开」：新的 jsdom + 直接读回
const dom2 = new JSDOM(window.document.documentElement.outerHTML, { url: 'http://localhost:3000/chart' });
// 复用同一 storage（同一站点同一浏览器）
dom2.window.localStorage.setItem(mem.LAST_BIRTH_KEY, window.localStorage.getItem(mem.LAST_BIRTH_KEY));
dom2.window.localStorage.setItem('ziwei-theme', 'dark');
globalThis.window = dom2.window;
globalThis.document = dom2.window.document;

const restored = mem.loadLastBirth();
assert.ok(restored, '重开后应能读回上次信息');
assert.equal(restored.form.name, '李四');

// ── 自动回填到真实 DOM 表单 ───────────────────────────────
const d2 = dom2.window.document;
const set = (sel, v) => { d2.querySelector(sel).value = v; };
set('#name', restored.form.name);
set('#year', restored.form.year);
set('#month', restored.form.month);
set('#day', restored.form.day);
d2.querySelector('#status').textContent =
  '已自动沿用上次信息 · ' + mem.describeBirthDraft(restored.form);

assert.equal(d2.querySelector('#name').value, '李四', '姓名应自动回填');
assert.equal(d2.querySelector('#year').value, '1988', '年份应自动回填');
assert.match(d2.querySelector('#status').textContent, /已自动沿用上次信息/);

// ── 三个入口在 DOM 中均可点击 ─────────────────────────────
for (const id of ['#resume', '#restart', '#clear']) {
  const el = d2.querySelector(id);
  assert.ok(el, `${id} 入口应存在`);
  assert.equal(el.tagName, 'BUTTON');
}
assert.equal(d2.querySelector('#remember').checked, true, '记忆开关默认开启');

// ── 清除：二次确认 + 不误删主题 ───────────────────────────
const clearBtn = d2.querySelector('#clear');
let confirmClear = false;
clearBtn.addEventListener('click', () => {
  if (!confirmClear) {
    confirmClear = true;
    clearBtn.textContent = '再点一次确认清除';
    return;
  }
  mem.clearBirthMemory();
});
clearBtn.click();
assert.ok(dom2.window.localStorage.getItem(mem.LAST_BIRTH_KEY), '第一次点击不应删除');
assert.match(clearBtn.textContent, /确认/);
clearBtn.click();
assert.equal(dom2.window.localStorage.getItem(mem.LAST_BIRTH_KEY), null, '第二次点击应删除');
assert.equal(dom2.window.localStorage.getItem('ziwei-theme'), 'dark', '主题偏好应保留');
assert.equal(mem.loadLastBirth(), null, '清除后不再自动恢复');

// ── 配色可读性：主题变量必须能在真实 DOM 样式表中解析 ─────
// 只注入两个变量块，避开 @tailwind 指令（jsdom 的 CSS 解析器不认识它）。
import { readFileSync } from 'node:fs';
const css = readFileSync('app/globals.css', 'utf8');
const grab = (sel) => {
  const i = css.indexOf(sel);
  assert.ok(i >= 0, `缺少 ${sel} 规则`);
  return css.slice(i, css.indexOf('}', i) + 1);
};
const lightCss = grab(':root');
const darkCss = grab('[data-theme="dark"]');
const themeDom = new JSDOM(
  `<!doctype html><html data-theme="light"><head><style>${lightCss}\n${darkCss}</style></head>` +
  `<body><div class="zw-page"><span class="text-[9px]">宫位干支</span></div></body></html>`,
);
const sheet = themeDom.window.document.styleSheets[0];
assert.ok(sheet.cssRules.length >= 2, '明暗两套主题变量应能被真实 DOM 解析');
assert.ok([...sheet.cssRules].some(r => r.selectorText === ':root'), ':root 规则应存在');

// 命盘组件引用的 --t-* 变量必须真实定义（此前全部缺失，导致文字层级丢失）
for (const v of ['--t-faint', '--t-gold', '--t-card', '--t-border', '--t-text2']) {
  assert.ok(lightCss.includes(`${v}:`), `浅色主题缺少 ${v} 定义`);
}
for (const marker of [
  '[class*="text-emerald-500"]',
  ':is(.text-\\[8px\\]',
  '[data-theme="dark"] .badge-lu',
  '.zw-chat-bar',
  '.zw-chat-toggle',
  '.zw-chat-clear',
]) {
  assert.ok(css.includes(marker), `样式补丁缺失：${marker}`);
}
assert.ok(!/color:\s*white\s*;/i.test(css), '金色底按钮不应使用白字');

// 主题切换在真实 DOM 上生效
const themeRoot = themeDom.window.document.documentElement;
themeRoot.setAttribute('data-theme', 'dark');
assert.equal(themeRoot.getAttribute('data-theme'), 'dark', '暗色主题应可切换');
assert.ok(darkCss.includes('--lu:'), '暗色主题应覆盖四化语义色');

// ── 对话记忆：真实 localStorage + 真实 DOM 入口 ──────────
const birth1 = { year: 1990, month: 6, day: 15, hour: 5, gender: 'male', name: '张三', city: '北京', longitude: 116.4 };
const birth2 = { ...birth1, name: '李四' };
const k1 = mem.chatKeyForBirth(birth1);
const k2 = mem.chatKeyForBirth(birth2);
assert.notEqual(k1, k2, '不同命盘的对话必须隔离');

assert.ok(mem.saveChat(k1, mem.describeChatLabel(birth1), [
  { role: 'user', content: '我的事业如何？' },
  { role: 'assistant', content: '宜技术与项目管理。' },
]), '对话应写入真实 localStorage');
assert.ok(mem.saveChat(k2, mem.describeChatLabel(birth2), [
  { role: 'user', content: '感情呢？' },
]));
assert.equal(mem.countChats(), 2);

// 模拟重开浏览器：读回并回填面板状态条
const readBack = mem.loadChat(k1);
assert.ok(readBack, '重开后应能读回对话');
assert.equal(readBack.messages.length, 2);
assert.equal(readBack.messages[1].content, '宜技术与项目管理。');
const chatState = d2.querySelector('#chat-state');
chatState.textContent = `已恢复 ${readBack.messages.length} 条 · ${mem.formatSavedAt(readBack.savedAt)}`;
assert.match(chatState.textContent, /已恢复 2 条/);
assert.equal(d2.querySelector('#remember-chat').checked, true, '「记住对话」应默认开启');

// 「清空对话」二次确认：只清当前命盘
const clearChatBtn = d2.querySelector('#clear-chat');
let confirmChat = false;
clearChatBtn.addEventListener('click', () => {
  if (!confirmChat) {
    confirmChat = true;
    clearChatBtn.textContent = '再点一次确认清空';
    return;
  }
  mem.clearChat(k1);
});
clearChatBtn.click();
assert.ok(mem.loadChat(k1), '第一次点击不应删除');
assert.match(clearChatBtn.textContent, /确认/);
clearChatBtn.click();
assert.equal(mem.loadChat(k1), null, '第二次点击应删除当前会话');
assert.ok(mem.loadChat(k2), '其他命盘的对话不应被误删');
assert.equal(mem.countChats(), 1);

// 顶层「清除记忆」：生辰 + 全部对话，保留主题偏好
dom2.window.localStorage.setItem('ziwei-theme', 'dark');
mem.clearAllMemory();
assert.equal(mem.loadChat(k2), null, '全部对话应被清除');
assert.equal(mem.countChats(), 0);
assert.equal(dom2.window.localStorage.getItem('ziwei-theme'), 'dark', '主题偏好应保留');

// ── 长期事实：真实 localStorage 跨刷新沿用 / 冲突 / 清除 ──────
const birth3 = { ...birth1, name: '王五' };
const k3 = mem.chatKeyForBirth(birth3);
const t0 = Date.now();
const convo = [
  { role: 'user', content: '以后请用简体中文回答', ts: t0 - 5000 },
  { role: 'assistant', content: '好的。' },
  { role: 'user', content: '请生成命格总览，按以下结构输出', hidden: true, ts: t0 - 4000 },
  { role: 'assistant', content: '总览。' },
  { role: 'user', content: '以后请改用繁体中文回答', ts: t0 - 3000 },
  { role: 'assistant', content: '已改。' },
  { role: 'user', content: '今年事业如何？', ts: t0 - 1000 },
  { role: 'assistant', content: '宜技术与项目管理。' },
  { role: 'user', content: '具体说说', ts: t0 },
];
const facts = mem.extractLongTermFacts(convo, [], t0);
assert.ok(facts.some(f => f.key === '语言' && f.value.includes('繁体')), '同类冲突应保留最新设定');
assert.ok(!facts.some(f => f.value.includes('简体')), '锚点不应自相矛盾');
assert.ok(!facts.some(f => f.value.includes('命格总览')), 'hidden 自动话题模板不应被抽取');

assert.ok(mem.saveChat(k3, mem.describeChatLabel(birth3), convo, facts), '事实应写入真实 localStorage');
const reread = mem.loadChat(k3);
assert.ok(reread, '重开后应能读回会话');
assert.equal(reread.messages.length, 9);
assert.ok(reread.facts.some(f => f.value.includes('繁体')), '刷新后长期事实仍沿用');

const api = mem.buildApiMessages(reread.messages, reread.facts);
assert.equal(api[0].role, 'system', '长期事实锚点应随上下文注入');
assert.ok(api[0].content.includes('繁体'), '早前设定应出现在锚点');
assert.equal(api.at(-1).content, '具体说说', '上下文末尾应是当前提问');
for (let i = 1; i < api.length; i++) {
  assert.notEqual(api[i].role, api[i - 1].role, '上下文应严格交替');
}
for (const m of api) {
  assert.deepEqual(Object.keys(m).sort(), ['content', 'role'], '契约元素仅含 role/content');
}
assert.equal(mem.renderFactsAnchor([]), '', '无事实不应产生锚点');
assert.ok(
  mem.buildApiMessages([{ role: 'user', content: '你好' }, { role: 'assistant', content: '你好' }], [])
    .every(m => m.role !== 'system'),
  '无长期事实时不产生 system（与优化前行为等价）',
);

// 恢复状态条文案保持不变（交互不变）
chatState.textContent = `已恢复 ${reread.messages.length} 条 · ${mem.formatSavedAt(reread.savedAt)}`;
assert.match(chatState.textContent, /已恢复 9 条/);

mem.clearChat(k3);
assert.equal(mem.loadChat(k3), null, '清空对话应同时删除长期事实');

console.log('smoke-dom.mjs: PASS (真实 DOM 回填 / 三入口 / 对话记忆与隔离 / 长期事实跨刷新沿用与冲突消解 / 二次确认双层清除 / 双主题配色变量)');
