/**
 * 长期对话上下文回归测试 —— 本次优化的验收标准
 *
 * 覆盖：
 *  ① 多轮上下文连贯：严格交替、user 起止、问答对不拆散、空/失败占位不进上下文；
 *  ② 历史信息准确：只认用户手动输入，自动话题模板与失败提示不参与事实抽取；
 *  ③ 长期状态一致：超出 40 条存储窗口 / 10 条上下文窗口后，早前设定仍被沿用；
 *  ④ 边界：过期（事实 + 会话）、重复（消息 + 设定）、冲突（同类后写覆盖、
 *     同时间戳确定性）、损坏 facts、旧数据零迁移、清除联动、禁用存储降级；
 *  ⑤ 对外契约不变：元素仅 {role,content}，无长期事实时不产生 system 消息。
 */
import assert from 'node:assert/strict';
import {
  MEMORY_TTL_MS,
  CTX_MAX_TURNS,
  CHAT_MAX_MESSAGES,
  FACT_MAX_ITEMS,
  chatKeyForBirth,
  chatStorageKey,
  extractLongTermFacts,
  normalizeFacts,
  renderFactsAnchor,
  buildApiMessages,
  isFailureNotice,
  loadChat,
  saveChat,
  clearChat,
  clearAllMemory,
  countChats,
  type ChatMessage,
  type LongTermFact,
} from '../../lib/ziwei/memory';

class TestStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
  key(i: number) { return Array.from(this.map.keys())[i] ?? null; }
  get length() { return this.map.size; }
}

const storage = new TestStorage();
(globalThis as any).window = { localStorage: storage };

const NOW = Date.now();
const birth = { year: 1990, month: 6, day: 15, hour: 5, gender: 'male', name: '张三', city: '北京', longitude: 116.4 };
const key = chatKeyForBirth(birth);
const storageKey = chatStorageKey(key);

// ── ① 事实抽取：只认用户手动输入 ─────────────────────────────
const base: ChatMessage[] = [
  { role: 'user', content: '以后请用简体中文回答', ts: NOW - 90000 },
  { role: 'assistant', content: '好的。' },
  { role: 'user', content: '请生成命格总览，按以下结构输出', hidden: true },
  { role: 'assistant', content: '总览内容。' },
  { role: 'user', content: '请不要讲术语', ts: NOW - 80000 },
  { role: 'assistant', content: '明白。' },
  { role: 'user', content: '解读失败，请稍后重试。', ts: NOW - 70000 },
];
const f1 = extractLongTermFacts(base, [], NOW);
assert.equal(f1.length, 2, '应抽出「语言」与「禁忌」两类设定');
assert.ok(f1.some(f => f.key === '语言' && f.value.includes('简体')));
assert.ok(f1.some(f => f.key === '禁忌' && f.value.includes('不要讲术语')));
assert.ok(!f1.some(f => f.value.includes('命格总览')), 'hidden 自动话题模板不得被当成偏好');
assert.ok(!f1.some(f => f.value.includes('解读失败')), '失败提示不得被当成偏好');
assert.ok(isFailureNotice('解读失败，请稍后重试。'));
assert.ok(isFailureNotice('开源版不含 AI 解读接口'));
assert.ok(!isFailureNotice('正常回答'));

// ── ② 重复：同一句重复设定收敛为一条 ─────────────────────────
const dup: ChatMessage[] = [
  { role: 'user', content: '以后请用简体中文回答', ts: NOW - 90000 },
  { role: 'user', content: '以后请用简体中文回答', ts: NOW - 85000 },
  { role: 'assistant', content: '好的。' },
];
const f2 = extractLongTermFacts(dup, [], NOW);
assert.equal(f2.length, 1, '重复设定应收敛为一条');
assert.equal(f2[0].key, '语言');

// ── ③ 冲突：同类后写覆盖，且同时间戳仍确定性 ──────────────────
const conflict: ChatMessage[] = [
  { role: 'user', content: '以后请用简体中文回答', ts: NOW - 90000 },
  { role: 'assistant', content: '好的。' },
  { role: 'user', content: '以后请改用繁体中文回答', ts: NOW - 1000 },
];
const f3 = extractLongTermFacts(conflict, [], NOW);
assert.equal(f3.length, 1, '同类设定只保留一条');
assert.ok(f3[0].value.includes('繁体'), '应以最近一次设定为准');
assert.ok(!f3[0].value.includes('简体'), '锚点不得自相矛盾');
const sameTs: ChatMessage[] = [
  { role: 'user', content: '请用简体中文', ts: NOW },
  { role: 'user', content: '请用繁体中文', ts: NOW },
];
assert.ok(extractLongTermFacts(sameTs, [], NOW)[0].value.includes('繁体'),
  '同一时间戳下仍按消息顺序后写覆盖（seq 保证确定性）');

// ── ④ 过期：超期事实淘汰，未过期保留 ─────────────────────────
const staleFacts: LongTermFact[] = [
  { key: '语言', value: '请用简体中文', ts: NOW - MEMORY_TTL_MS - 1, seq: 1 },
];
assert.equal(extractLongTermFacts([], staleFacts, NOW).length, 0, '超期事实应淘汰');
assert.equal(extractLongTermFacts([], [
  { key: '语言', value: '请用简体中文', ts: NOW - 1000, seq: 1 },
], NOW).length, 1, '未过期事实应保留');
assert.equal(extractLongTermFacts([
  { role: 'user', content: '请用简体中文', ts: NOW - MEMORY_TTL_MS - 1 },
], [], NOW).length, 0, '超期消息里的设定也不得复活');

// ── ⑤ 长期一致性：构造 51 条多轮，早前设定跨窗口沿用 ──────────
const long: ChatMessage[] = [
  { role: 'user', content: '以后请用简体中文回答，并请分点说明', ts: NOW - 100000 },
  { role: 'assistant', content: '好的。' },
];
for (let i = 0; i < 24; i++) {
  long.push({ role: 'user', content: `第${i}个追问`, ts: NOW - 90000 + i * 1000 });
  long.push({ role: 'assistant', content: `第${i}个回答`, ts: NOW - 90000 + i * 1000 });
}
long.push({ role: 'user', content: '最后再问一次', ts: NOW });
assert.ok(long.length > CHAT_MAX_MESSAGES, '应超过存储窗口上限');

const facts = extractLongTermFacts(long, [], NOW);
assert.ok(facts.some(f => f.key === '语言' && f.value.includes('简体')));
const apiLong = buildApiMessages(long, facts, NOW);
assert.equal(apiLong[0].role, 'system', '长期事实应以 system 锚点注入');
assert.ok(apiLong[0].content.includes('简体'), '早前设定仍进入每轮上下文');
assert.ok(apiLong.length <= 1 + CTX_MAX_TURNS, '上下文窗口仍需受控');

// 关键：原设定消息已被 40 条存储窗口裁掉，事实仍从 previous 存活
const trimmed = long.slice(-CHAT_MAX_MESSAGES);
assert.ok(!trimmed.some(m => m.content.includes('简体')), '原设定消息应已被裁掉');
const apiTrimmed = buildApiMessages(trimmed, facts, NOW);
assert.equal(apiTrimmed[0].role, 'system');
assert.ok(apiTrimmed[0].content.includes('简体'), '长期状态不应随窗口滚动丢失');

// ── ⑥ 持久化闭环 + 旧数据零迁移 ──────────────────────────────
storage.clear();
assert.ok(saveChat(key, '张三', long, facts), '应写入会话');
const loaded = loadChat(key);
assert.ok(loaded);
assert.ok(loaded.facts.some(f => f.key === '语言' && f.value.includes('简体')), '刷新后事实仍在');
const apiReloaded = buildApiMessages(loaded.messages, loaded.facts, NOW);
assert.equal(apiReloaded[0].role, 'system');
assert.ok(apiReloaded[0].content.includes('简体'));

// 旧数据（无 facts 字段）读取不报错，且偏好仍能从消息重建
storage.setItem(storageKey, JSON.stringify({
  version: 1,
  messages: [
    { role: 'user', content: '以后请用简体中文回答', ts: NOW - 1000 },
    { role: 'assistant', content: '好的。' },
  ],
  savedAt: NOW,
}));
const legacy = loadChat(key);
assert.ok(legacy, '旧数据应可读');
assert.deepEqual(legacy.facts, [], '旧数据 facts 应补为空数组');
const apiLegacy = buildApiMessages(legacy.messages, legacy.facts, NOW);
assert.equal(apiLegacy[0].role, 'system');
assert.ok(apiLegacy[0].content.includes('简体'), '旧消息里的偏好应能被重建');

// 3 参数调用仍兼容，且自动继承已有事实（调用方遗漏也不会丢状态）
storage.clear();
assert.ok(saveChat(key, '张三', long, facts));
assert.ok(saveChat(key, '张三', [
  { role: 'user', content: '新问题' },
  { role: 'assistant', content: '新回答' },
]));
const inherited = loadChat(key)!;
assert.ok(inherited.facts.some(f => f.key === '语言' && f.value.includes('简体')),
  '3 参数调用也应继承已有长期事实');

// ── ⑦ 会话过期：惰性清除 ────────────────────────────────────
const current = loadChat(key, NOW);
assert.ok(current, '当前时间应能读回');
assert.equal(loadChat(key, current.savedAt + MEMORY_TTL_MS + 1), null, '过期会话应被惰性清除');
assert.equal(storage.getItem(storageKey), null, '过期会话键应被删除');

// ── ⑧ 损坏 facts 容错 ───────────────────────────────────────
storage.setItem(storageKey, JSON.stringify({
  version: 1,
  messages: [{ role: 'user', content: '你好' }],
  savedAt: NOW,
  facts: [
    { key: '语言', value: 123 },
    null,
    { key: '禁忌', value: '不要讲术语', ts: NOW, seq: 5 },
  ],
}));
const loadedBad = loadChat(key);
assert.ok(loadedBad);
assert.equal(loadedBad.facts.length, 1, '非法 facts 条目应被丢弃');
assert.equal(loadedBad.facts[0].key, '禁忌');
assert.equal(renderFactsAnchor([]), '', '无事实不应产生锚点');
assert.ok(renderFactsAnchor(loadedBad.facts).includes('始终遵守'));

// ── ⑨ 容量上限与输出稳定性 ──────────────────────────────────
const hugeFacts = Array.from({ length: FACT_MAX_ITEMS + 10 }, (_, i) => ({
  key: `k${i}`, value: `值${i}`, ts: NOW, seq: i + 1,
}));
assert.equal(normalizeFacts(hugeFacts).length, FACT_MAX_ITEMS);
assert.deepEqual(normalizeFacts(hugeFacts), normalizeFacts(hugeFacts), '输出应确定性稳定');

// ── ⑩ 上下文连贯性与契约不变 ────────────────────────────────
const plain: ChatMessage[] = [
  { role: 'user', content: '我的事业如何？' },
  { role: 'assistant', content: '宜技术。' },
  { role: 'user', content: '那今年呢？', hidden: true },
  { role: 'assistant', content: '有晋升机会。' },
  { role: 'user', content: '具体说说' },
];
const apiPlain = buildApiMessages(plain, [], NOW);
assert.ok(apiPlain.every(m => m.role !== 'system'), '无长期事实时不产生 system 消息（行为等价）');
assert.deepEqual(apiPlain.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
assert.equal(apiPlain[apiPlain.length - 1].content, '具体说说');
for (const m of apiPlain) {
  assert.deepEqual(Object.keys(m).sort(), ['content', 'role'], '元素只能含 role/content');
}

const dirty: ChatMessage[] = [
  { role: 'user', content: '第一个问题' },
  { role: 'assistant', content: '第一个回答' },
  { role: 'assistant', content: '第一个回答' },
  { role: 'assistant', content: '   ' },
  { role: 'user', content: '第二个问题' },
  { role: 'user', content: '补充问题' },
  { role: 'assistant', content: '解读失败，请稍后重试。' },
  { role: 'user', content: '第三个问题' },
  { role: 'assistant', content: '第三个回答' },
  { role: 'user', content: '当前提问' },
];
const apiDirty = buildApiMessages(dirty, [], NOW);
assert.ok(apiDirty.every(m => m.content.trim().length > 0), '空消息应过滤');
assert.ok(!apiDirty.some(m => m.content.includes('解读失败')), '失败占位不得进上下文');
assert.equal(apiDirty[0].role, 'user');
assert.equal(apiDirty[apiDirty.length - 1].role, 'user');
assert.equal(apiDirty[apiDirty.length - 1].content, '当前提问');
for (let i = 1; i < apiDirty.length; i++) {
  assert.notEqual(apiDirty[i].role, apiDirty[i - 1].role, '不应出现连续同角色');
}

// 窗口裁剪必须落在 user 上，不拆散一问一答
const pairs: ChatMessage[] = [];
for (let i = 0; i < 8; i++) {
  pairs.push({ role: 'user', content: `问${i}` });
  pairs.push({ role: 'assistant', content: `答${i}` });
}
pairs.push({ role: 'user', content: '最新提问' });
const apiPairs = buildApiMessages(pairs, [], NOW);
assert.ok(apiPairs.length <= 1 + CTX_MAX_TURNS);
assert.equal(apiPairs[0].role, 'user', '窗口起点必须是 user');
assert.equal(apiPairs[1].role, 'assistant', '起点 user 后应紧跟它的回答，问答对不被拆散');
assert.equal(apiPairs[apiPairs.length - 1].content, '最新提问');
for (let i = 1; i < apiPairs.length; i++) {
  assert.notEqual(apiPairs[i].role, apiPairs[i - 1].role, '窗口内应严格交替');
}

// ── ⑪ 清除联动：事实与对话一起消失，主题偏好保留 ──────────────
storage.clear();
storage.setItem('ziwei-theme', 'dark');
assert.ok(saveChat(key, 'A', long, facts));
assert.ok(loadChat(key)!.facts.length > 0);
clearChat(key);
assert.equal(loadChat(key), null, '「清空对话」应同时删除长期事实');
assert.equal(storage.getItem(storageKey), null);
assert.equal(storage.getItem('ziwei-theme'), 'dark');

const key2 = chatKeyForBirth({ ...birth, name: '李四' });
assert.ok(saveChat(key, 'A', long, facts));
assert.ok(saveChat(key2, 'B', [{ role: 'user', content: '你好' }]));
assert.equal(countChats(), 2);
clearAllMemory();
assert.equal(countChats(), 0, '全量清除应删除所有会话及其事实');
assert.equal(storage.getItem('ziwei-theme'), 'dark', '主题偏好应保留');

// ── ⑫ 禁用存储降级：纯函数不依赖 localStorage ────────────────
(globalThis as any).window = {
  localStorage: {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
    key() { throw new Error('blocked'); },
    get length() { throw new Error('blocked'); },
  },
};
assert.equal(loadChat(key), null);
assert.equal(saveChat(key, 'A', plain), null);
assert.doesNotThrow(() => buildApiMessages(plain, [], NOW));
assert.ok(extractLongTermFacts(base, [], NOW).length > 0, '事实抽取为纯计算，不受存储影响');

console.log('long-context.test.ts: PASS (多轮连贯 / 跨窗口长期沿用 / 重复去重 / 冲突后写覆盖 / 事实与会话过期 / 损坏容错 / 旧数据兼容 / 清除联动 / 契约不变)');
