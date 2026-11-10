/**
 * 本地记忆回归测试
 *
 * 覆盖：持久化读写、字段校验、损坏数据容错、清除 / 重置、
 * 以及「读取上次信息 → 直接复原命盘」的完整链路（无需重新输入、无需重新起盘）。
 */
import assert from 'node:assert/strict';
import { generateChart } from '../../lib/ziwei/algorithm';
import { formToBirthInfo } from '../../lib/ziwei/share';
import {
  LAST_BIRTH_KEY,
  HISTORY_KEY,
  MEMORY_VERSION,
  normalizeBirthDraft,
  loadLastBirth,
  saveLastBirth,
  clearBirthMemory,
  describeBirthDraft,
  formatSavedAt,
  type BirthDraft,
} from '../../lib/ziwei/memory';

// ── 符合 Storage 语义的测试替身 ───────────────────────────
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

const valid: BirthDraft = {
  name: '张三',
  year: '1990',
  month: '6',
  day: '15',
  clockHour: '10',
  clockMinute: '30',
  unknownTime: false,
  province: '北京市',
  city: '北京',
  longitude: 116.4,
  gender: 'male',
};

// 1) 初始为空
storage.clear();
assert.equal(loadLastBirth(), null, '空存储应返回 null');

// 2) 保存 → 读取
const saved = saveLastBirth(valid);
assert.ok(saved, '保存应返回记录');
assert.equal(saved!.version, MEMORY_VERSION);
assert.ok(saved!.savedAt > 0);
const loaded = loadLastBirth();
assert.ok(loaded, '应能读回记录');
assert.equal(loaded!.form.name, '张三');
assert.equal(loaded!.form.year, '1990');
assert.equal(loaded!.form.longitude, 116.4);
assert.equal(loaded!.form.gender, 'male');
assert.ok(storage.has(LAST_BIRTH_KEY), '应写入版本化键');

// 3) 完整复原链路：上次信息 → 命盘（核心诉求）
const chart = generateChart(formToBirthInfo(loaded!.form));
assert.equal(chart.palaces.length, 12, '复原命盘应有 12 宫');
assert.equal(chart.birthInfo.name, '张三', '姓名应随命盘一并恢复');
assert.equal(chart.birthInfo.year, 1990);
assert.equal(chart.birthInfo.gender, 'male');

// 4) 摘要与时间戳
assert.match(describeBirthDraft(loaded!.form), /张三/);
assert.match(describeBirthDraft(loaded!.form), /1990年6月15日/);
assert.match(formatSavedAt(saved!.savedAt), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);

// 5) 损坏 JSON → 返回 null 且清除损坏键
storage.setItem(LAST_BIRTH_KEY, '{not json');
assert.equal(loadLastBirth(), null, '损坏数据不应被使用');
assert.equal(storage.has(LAST_BIRTH_KEY), false, '损坏键应被清除');

// 6) 版本号不匹配 → 拒绝
storage.setItem(LAST_BIRTH_KEY, JSON.stringify({ version: 999, form: valid, savedAt: Date.now() }));
assert.equal(loadLastBirth(), null, '未知版本应拒绝');

// 7) 非法日期 / 越界年份 → 拒绝，绝不喂给排盘引擎
assert.equal(normalizeBirthDraft({ ...valid, year: '3000' }), null, '未来年份应拒绝');
assert.equal(normalizeBirthDraft({ ...valid, year: '1800' }), null, '过早年份应拒绝');
assert.equal(normalizeBirthDraft({ ...valid, month: '2', day: '30' }), null, '不存在的日期应拒绝');
assert.equal(normalizeBirthDraft({ ...valid, month: '13' }), null, '越界月份应拒绝');
assert.equal(normalizeBirthDraft(null), null, '非对象应拒绝');
storage.clear();
assert.equal(saveLastBirth({ ...valid, month: '2', day: '30' }), null, '非法表单不应写入');

// 8) 超长文本被截断，避免异常数据撑爆存储
const normalized = normalizeBirthDraft({ ...valid, name: 'X'.repeat(500) });
assert.ok(normalized);
assert.equal(normalized!.name.length, 60);

// 9) 异常时间字段回退到安全默认值
const fallback = normalizeBirthDraft({ ...valid, clockHour: '99', clockMinute: '99' });
assert.equal(fallback!.clockHour, '8');
assert.equal(fallback!.clockMinute, '0');

// 10) 清除只删生辰数据，保留主题偏好
storage.clear();
saveLastBirth(valid);
storage.setItem(HISTORY_KEY, JSON.stringify([]));
storage.setItem('ziwei-theme', 'light');
clearBirthMemory();
assert.equal(storage.has(LAST_BIRTH_KEY), false, '上次信息应被删除');
assert.equal(storage.has(HISTORY_KEY), false, '历史记录应被删除');
assert.equal(storage.getItem('ziwei-theme'), 'light', '主题偏好不应被误删');
assert.equal(loadLastBirth(), null, '清除后不再自动恢复');

// 11) localStorage 不可用（隐私模式 / 配额满）时静默降级，不抛异常
const broken = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
  removeItem() { throw new Error('SecurityError'); },
};
(globalThis as any).window = { localStorage: broken };
assert.equal(loadLastBirth(), null, '读取失败应返回 null');
assert.equal(saveLastBirth(valid), null, '写入失败应返回 null');
assert.doesNotThrow(() => clearBirthMemory(), '清除失败不应抛出异常');

console.log('local-memory.test.ts: PASS (11 组断言)');
