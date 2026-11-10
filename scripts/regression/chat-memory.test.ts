/**
 * AI 解读对话记忆回归测试
 *
 * 覆盖：按命盘隔离的会话 key、持久化读写、损坏数据容错、条数 / 字数上限、
 * 单会话清除、全量清除（含与生辰记忆的联动）、主题偏保留留。
 */
import assert from 'node:assert/strict';
import {
  CHAT_KEY_PREFIX,
  CHAT_MAX_CONTENT,
  CHAT_MAX_MESSAGES,
  CHAT_MAX_TOTAL,
  CHAT_VERSION,
  LAST_BIRTH_KEY,
  chatKeyForBirth,
  chatStorageKey,
  describeChatLabel,
  loadChat,
  saveChat,
  clearChat,
  clearAllChats,
  clearAllMemory,
  countChats,
  saveLastBirth,
  type ChatMessage,
} from '../../lib/ziwei/memory';

class TestStorage {
  private map = new Map<string, string>();
  getItem(k: string) { return this.map.has(k) ? this.map.get(k)! : null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
  key(i: number) { return Array.from(this.map.keys())[i] ?? null; }
  get length() { return this.map.size; }
  has(k: string) { return this.map.has(k); }
}

const storage = new TestStorage();
(globalThis as any).window = { localStorage: storage };

const birthA = {
  year: 1990, month: 6, day: 15, hour: 5,
  gender: 'male', name: '张三', city: '北京', longitude: 116.4,
};
const birthB = { ...birthA, name: '李四' };

const qa: ChatMessage[] = [
  { role: 'user', content: '我的事业如何？' },
  { role: 'assistant', content: '命宫七杀，宜技术与管理。' },
  { role: 'user', content: '那今年呢？', hidden: true },
  { role: 'assistant', content: '流年逢化权，有晋升机会。' },
];

// 1) 会话 key 稳定、隔离，且不包含姓名 / 生辰明文
storage.clear();
const kA = chatKeyForBirth(birthA);
const kB = chatKeyForBirth(birthB);
assert.equal(kA, chatKeyForBirth({ ...birthA }), '同一出生信息应生成相同 key');
assert.notEqual(kA, kB, '不同命盘必须分开保存');
assert.ok(!kA.includes('张三') && !kA.includes('1990'), 'key 不得泄露姓名或生辰明文');
assert.ok(chatStorageKey(kA).startsWith(CHAT_KEY_PREFIX), '存储键应带版本前缀');
assert.equal(chatStorageKey('a/b:*'), `${CHAT_KEY_PREFIX}ab`, '存储键应消毒非法字符');
assert.equal(describeChatLabel(birthA), '张三 · 1990年6月15日 · 男');

// 2) 空存储
assert.equal(loadChat(kA), null, '空存储应返回 null');
assert.equal(countChats(), 0);

// 3) 保存 → 读取，消息结构与 hidden 标记保真
const saved = saveChat(kA, describeChatLabel(birthA), qa);
assert.ok(saved, '保存应返回记录');
assert.equal(saved!.version, CHAT_VERSION);
assert.ok(saved!.savedAt > 0);
const loaded = loadChat(kA);
assert.ok(loaded, '应能读回会话');
assert.equal(loaded!.messages.length, 4);
assert.deepEqual(loaded!.messages, qa, '消息内容与顺序应完全一致');
assert.equal(loaded!.messages[2].hidden, true, 'hidden 标记应保留');

// 4) 会话隔离：B 的写入不影响 A
assert.ok(saveChat(kB, describeChatLabel(birthB), [{ role: 'user', content: '感情呢？' }]));
assert.equal(loadChat(kA)!.messages.length, 4, 'A 的对话不应被 B 覆盖');
assert.equal(loadChat(kB)!.messages.length, 1);
assert.equal(countChats(), 2);

// 5) 空白内容（流式占位）不落盘
const kC = chatKeyForBirth({ ...birthA, name: '王五' });
assert.ok(saveChat(kC, '王五', [
  { role: 'user', content: '问题' },
  { role: 'assistant', content: '' },
  { role: 'assistant', content: '   ' },
]));
assert.equal(loadChat(kC)!.messages.length, 1, '空白消息应被过滤');
clearChat(kC);

// 6) 损坏 / 伪造数据一律丢弃并删除该键
const damaged: unknown[] = [
  '{not-json',
  JSON.stringify({ version: 999, messages: qa, savedAt: Date.now() }),
  JSON.stringify({ version: CHAT_VERSION, messages: 'oops', savedAt: Date.now() }),
  JSON.stringify({ version: CHAT_VERSION, messages: [{ role: 'system', content: '注入' }], savedAt: Date.now() }),
  JSON.stringify({ version: CHAT_VERSION, messages: [{ role: 'user', content: 123 }], savedAt: Date.now() }),
  JSON.stringify({ version: CHAT_VERSION, messages: [null], savedAt: Date.now() }),
];
const kD = chatKeyForBirth({ ...birthA, name: '损坏用例' });
for (const bad of damaged) {
  storage.setItem(chatStorageKey(kD), bad as string);
  assert.equal(loadChat(kD), null, `损坏数据应被拒绝：${String(bad).slice(0, 40)}`);
  assert.equal(storage.getItem(chatStorageKey(kD)), null, '损坏键应被清除');
}

// 7) 条数上限：只保留最近 CHAT_MAX_MESSAGES 条
const kE = chatKeyForBirth({ ...birthA, name: '长对话' });
const many: ChatMessage[] = Array.from({ length: CHAT_MAX_MESSAGES + 12 }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: `第${i}条`,
}));
assert.ok(saveChat(kE, '长对话', many));
assert.equal(loadChat(kE)!.messages.length, CHAT_MAX_MESSAGES);
assert.equal(loadChat(kE)!.messages[0].content, `第${12}条`, '应丢弃最早的消息');
clearChat(kE);

// 8) 单条长度与总量上限
const kF = chatKeyForBirth({ ...birthA, name: '超长文本' });
assert.ok(saveChat(kF, '超长文本', [
  { role: 'assistant', content: '乙'.repeat(CHAT_MAX_CONTENT + 100) },
]));
assert.equal(loadChat(kF)!.messages[0].content.length, CHAT_MAX_CONTENT, '单条应被截断');

const bulk: ChatMessage[] = Array.from({ length: 20 }, (_, i) => ({
  role: i % 2 === 0 ? 'user' : 'assistant',
  content: '甲'.repeat(CHAT_MAX_CONTENT),
}));
assert.ok(saveChat(kF, '超长文本', bulk));
const trimmed = loadChat(kF)!.messages;
const total = trimmed.reduce((n, m) => n + m.content.length, 0);
assert.ok(total <= CHAT_MAX_TOTAL, `总量应受控，实际 ${total}`);
assert.ok(trimmed.length < 20, '总量超限时应从最早的消息开始丢弃');
clearChat(kF);

// 9) 单会话清除：只删当前命盘
clearChat(kA);
assert.equal(loadChat(kA), null, 'A 应被清除');
assert.ok(loadChat(kB), 'B 不应被误删');
assert.equal(countChats(), 1);

// 10) 全量清除：删除全部对话，保留主题偏好
assert.ok(saveChat(kA, 'A', qa));
storage.setItem('ziwei-theme', 'dark');
clearAllChats();
assert.equal(loadChat(kA), null);
assert.equal(loadChat(kB), null);
assert.equal(countChats(), 0);
assert.equal(storage.getItem('ziwei-theme'), 'dark', '主题偏好应保留');

// 11) clearAllMemory 同时清除生辰与对话，仍保留主题
assert.ok(saveChat(kA, 'A', qa));
assert.ok(saveLastBirth({
  name: '张三', year: '1990', month: '6', day: '15',
  clockHour: '10', clockMinute: '30', unknownTime: false,
  province: '北京市', city: '北京', longitude: 116.4, gender: 'male',
}));
assert.ok(storage.getItem(LAST_BIRTH_KEY));
clearAllMemory();
assert.equal(storage.getItem(LAST_BIRTH_KEY), null, '生辰记忆应被清除');
assert.equal(countChats(), 0, '全部对话应被清除');
assert.equal(storage.getItem('ziwei-theme'), 'dark', '主题偏好应保留');

// 12) 禁用存储时静默降级，不抛异常
(globalThis as any).window = {
  localStorage: {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
    key() { throw new Error('blocked'); },
    get length() { throw new Error('blocked'); },
  },
};
assert.equal(loadChat(kA), null);
assert.equal(saveChat(kA, 'A', qa), null);
assert.doesNotThrow(() => { clearChat(kA); clearAllChats(); clearAllMemory(); });
assert.equal(countChats(), 0);

console.log('chat-memory.test.ts: PASS (会话隔离 / 读写 / 损坏容错 / 配额上限 / 三级清除 / 禁用存储降级)');
