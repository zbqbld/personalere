/**
 * 旧解读会话生辰回填回归测试
 *
 * 覆盖：命中用户档案的旧会话补写 birthInfo、未命中档案的会话保持原样、
 * 已有 birthInfo 的会话不重复改动（幂等）、档案异常时跳过。
 */
import assert from 'node:assert/strict';
import {
  CHAT_VERSION,
  chatKeyForBirth,
  chatStorageKey,
  loadChat,
} from '../../lib/ziwei/memory';
import { formToBirthInfo } from '../../lib/ziwei/share';
import { saveUserProfiles } from '../../lib/ziwei/user-profiles';
import { backfillChatBirthInfo } from '../../lib/ziwei/chat-backfill';

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

const form = {
  name: '甲',
  year: '1994',
  month: '5',
  day: '18',
  clockHour: '14',
  clockMinute: '30',
  unknownTime: false,
  province: '',
  city: '',
  longitude: 0,
  gender: 'male' as const,
};

function writeLegacyChat(key: string, label: string) {
  storage.setItem(chatStorageKey(key), JSON.stringify({
    version: CHAT_VERSION,
    key,
    label,
    messages: [
      { role: 'user', content: '帮我看下事业' },
      { role: 'assistant', content: '从命盘看……' },
    ],
    savedAt: Date.now(),
    facts: [],
  }));
}

// 1) 档案来源：与旧会话同一份表单
const saved = saveUserProfiles([{ form }]);
assert.ok(saved.results[0].status === 'created' || saved.results[0].status === 'updated',
  `档案应写入成功，实际 ${saved.results[0].status}: ${saved.results[0].errors.map(e => e.message).join(';')}`);

// 2) 命中档案的旧会话 → 应被回填
const hitKey = chatKeyForBirth(formToBirthInfo(form));
writeLegacyChat(hitKey, '甲 · 1994年5月18日 · 男');

// 3) 不命中任何档案的旧会话 → 保持原样（仍不可恢复，但可删除）
writeLegacyChat('deadbeef', '无名氏 · 1900年1月1日 · 男');

assert.equal(backfillChatBirthInfo(), 1, '只应回填命中档案的 1 条');
const mem = loadChat(hitKey);
assert.ok(mem?.birthInfo, '回填后应能读到 birthInfo');
assert.equal(mem!.birthInfo!.year, 1994);
assert.equal(mem!.birthInfo!.month, 5);
assert.equal(mem!.birthInfo!.gender, 'male');

// 4) 幂等：第二次运行不再产生改动
assert.equal(backfillChatBirthInfo(), 0, '重复执行应跳过已回填的会话');

// 5) 未命中的保持原样（没有 birthInfo）
assert.equal(loadChat('deadbeef')?.birthInfo, undefined, '未命中档案的会话不应被伪造生辰');

console.log('chat-backfill.test.ts: PASS (命中档案回填 / 未命中跳过 / 幂等 / 损坏容错)');
