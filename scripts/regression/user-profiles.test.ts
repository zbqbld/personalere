/**
 * 多起盘用户档案库回归测试
 *
 * 覆盖保存要求 R1–R8：用户可区分、按用户分别保存、批量新增、按用户更新、
 * 重复提交去重、缺失信息校验、多次保存不丢失、状态一致（损坏修复 / 迁移 /
 * 写盘失败 / 容量上限 / 清除联动 / 起盘复原链路）。
 */
import assert from 'node:assert/strict';
import { generateChart } from '../../lib/ziwei/algorithm';
import { formToBirthInfo } from '../../lib/ziwei/share';
import {
  HISTORY_KEY,
  LAST_BIRTH_KEY,
  PROFILES_KEY,
  clearAllMemory,
  saveLastBirth,
  type BirthDraft,
} from '../../lib/ziwei/memory';
import {
  MAX_PROFILES,
  PROFILES_VERSION,
  deriveUserId,
  fingerprintOf,
  getUserProfile,
  listUserProfiles,
  readStore,
  removeUserProfile,
  saveUserProfiles,
  updateUserProfile,
} from '../../lib/ziwei/user-profiles';

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
  size() { return this.map.size; }
}

const storage = new TestStorage();
(globalThis as any).window = { localStorage: storage };
const reset = () => { storage.clear(); (globalThis as any).window = { localStorage: storage }; };

const base: BirthDraft = {
  name: '张三', year: '1990', month: '6', day: '15',
  clockHour: '10', clockMinute: '30', unknownTime: false,
  province: '北京市', city: '北京', longitude: 116.4, gender: 'male',
};
const formOf = (over: Partial<BirthDraft> = {}): BirthDraft => ({ ...base, ...over });
const T0 = 1_700_000_000_000;

// 1) 空存储
reset();
assert.equal(listUserProfiles().length, 0, '空存储应返回空列表');
assert.equal(readStore(T0).profiles.length, 0);
assert.equal(readStore(T0).version, PROFILES_VERSION);

// 2) 缺失 / 非法信息：明确拒绝，且不写盘
reset();
const invalid: Array<{ label: string; form: unknown; code: string }> = [
  { label: '缺年份', form: { ...base, year: '' }, code: 'MISSING_BIRTH_DATE' },
  { label: '缺月份', form: { ...base, month: '' }, code: 'MISSING_BIRTH_DATE' },
  { label: '不存在的日期', form: formOf({ month: '2', day: '30' }), code: 'INVALID_FORM' },
  { label: '非法性别', form: { ...base, gender: 'x' }, code: 'INVALID_GENDER' },
  { label: '缺时辰', form: { ...base, clockHour: '' }, code: 'MISSING_BIRTH_TIME' },
  { label: '非对象', form: null, code: 'INVALID_FORM' },
];
for (const item of invalid) {
  const r = saveUserProfiles([{ form: item.form }], T0);
  assert.equal(r.results[0].status, 'rejected', `${item.label} 应被拒绝`);
  assert.ok(r.results[0].errors.some(e => e.code === item.code), `${item.label} 应给出明确错误码`);
  assert.equal(r.written, false, `${item.label} 不应写盘`);
}
assert.equal(storage.has(PROFILES_KEY), false, '校验失败不应产生存储键');

// 「时辰不详」允许缺省时分，但仍要校验日期
const unknown = saveUserProfiles([{
  form: { ...base, unknownTime: true, clockHour: '', clockMinute: '' },
}], T0);
assert.equal(unknown.results[0].status, 'created', '勾选时辰不详时允许缺省时分');

// 3) 可选信息缺失：明确 warning 但允许保存，且记录仍可区分
reset();
const noName = formOf({ name: '' });
const rNoName = saveUserProfiles([{ form: noName }], T0);
assert.equal(rNoName.results[0].status, 'created');
assert.ok(rNoName.results[0].warnings.some(w => w.code === 'MISSING_NAME'), '姓名缺失应明确提示');
assert.match(rNoName.results[0].profile!.displayName, /^未命名·/, '未命名用户也必须有可区分标识');
const noLocation: Record<string, unknown> = { ...base, province: '', city: '' };
delete noLocation.longitude;
const rNoLoc = saveUserProfiles([{ form: noLocation }], T0 + 1);
assert.ok(rNoLoc.results[0].warnings.some(w => w.code === 'MISSING_LOCATION'));
assert.ok(rNoLoc.results[0].warnings.some(w => w.code === 'LONGITUDE_DEFAULTED'));
assert.equal(rNoLoc.results[0].profile!.form.longitude, 120, '经度缺失应落到明确默认值');

// 4) 批量新增：三个用户各自一条、userId 可区分、内容互不串用
reset();
const forms = [
  formOf({ name: '张三' }),
  formOf({ name: '李四', year: '1988', month: '3', day: '22', gender: 'female' }),
  formOf({ name: '王五', year: '2000', month: '1', day: '1', city: '上海' }),
];
const batch = saveUserProfiles(forms.map(form => ({ form })), T0);
assert.equal(batch.written, true);
assert.deepEqual(batch.results.map(r => r.status), ['created', 'created', 'created']);
const ids = batch.results.map(r => r.userId);
assert.equal(new Set(ids).size, 3, '每个起盘用户必须有不同的 userId');
assert.equal(listUserProfiles().length, 3);
assert.equal(readStore(T0).revision, 1, '批量写入只推进一次全库版本');
for (const r of batch.results) {
  assert.equal(getUserProfile(r.userId)!.form.name, r.profile!.form.name);
}

// 5) 不同用户同生辰（旧实现会互相覆盖的边界）
reset();
const sameBirth = saveUserProfiles([
  { form: formOf({ name: '张三' }) },
  { form: formOf({ name: '李四' }) },
], T0);
assert.equal(sameBirth.results.length, 2);
assert.equal(listUserProfiles().length, 2, '同生辰不同姓名不得互相覆盖');
// 同名同生辰的两个不同人：必须显式 userId 才能区分
const explicitPair = saveUserProfiles([
  { userId: 'account-a', form: formOf({ name: '张三' }) },
  { userId: 'account-b', form: formOf({ name: '张三' }) },
], T0 + 1);
assert.equal(listUserProfiles().length, 4, '显式 userId 可区分同名同生辰的不同人');
assert.notEqual(explicitPair.results[0].userId, explicitPair.results[1].userId);
assert.equal(explicitPair.results[0].warnings.length, 0, '合法显式 userId 不应产生归一化警告');

// 6) 重复提交去重：同 userId + 同内容不写盘、不推进状态
reset();
const first = saveUserProfiles([{ form: base }], T0);
const dup = saveUserProfiles([{ form: formOf() }], T0 + 9999);
assert.equal(dup.results[0].status, 'duplicate');
assert.equal(dup.written, false, '完全相同的内容不应产生写入');
const afterDup = readStore(T0);
assert.equal(afterDup.revision, 1);
assert.equal(afterDup.profiles[0].updatedAt, T0);
assert.equal(afterDup.profiles[0].revision, 1);
assert.deepEqual(dup.results[0].profile, first.results[0].profile);

// 7) 按用户更新：只动目标用户，保留 createdAt，其余用户不变
reset();
const seed = saveUserProfiles([
  { form: formOf({ name: '张三' }) },
  { form: formOf({ name: '李四' }) },
], T0);
const idA = seed.results[0].userId;
const idB = seed.results[1].userId;
const beforeB = getUserProfile(idB)!;
const changed = saveUserProfiles([{ form: formOf({ name: '张三', clockHour: '14', city: '天津' }) }], T0 + 100);
assert.equal(changed.results[0].status, 'updated');
assert.equal(changed.results[0].profile!.createdAt, T0, '更新应保留创建时间');
assert.equal(changed.results[0].profile!.revision, 2);
assert.equal(changed.results[0].profile!.form.clockHour, '14');
assert.equal(readStore(T0).revision, 2);
assert.deepEqual(getUserProfile(idB), beforeB, '李四的记录不得被覆盖或改动');
assert.equal(listUserProfiles().length, 2, '更新不得新增用户');
// 身份五元组不变（只改时间/地点）时派生 ID 稳定
assert.equal(deriveUserId(formOf({ name: '张三', clockHour: '14', city: '天津' })), idA);
assert.notEqual(fingerprintOf(formOf({ name: '张三', clockHour: '14' })), fingerprintOf(base));

// 8) updateUserProfile：按用户 patch、找不到时明确报错
const patched = updateUserProfile(idA, { city: '重庆' }, T0 + 200);
assert.equal(patched.status, 'updated');
assert.equal(patched.profile!.userId, idA, 'patch 不得改变用户主键');
assert.equal(patched.profile!.form.city, '重庆');
assert.equal(getUserProfile(idB)!.form.city, '北京', '其他用户不受影响');
const missing = updateUserProfile('no-such-user', { city: '南京' }, T0 + 300);
assert.equal(missing.status, 'rejected');
assert.ok(missing.errors.some(e => e.code === 'NOT_FOUND'));

// 9) 批内重复 userId：合并到最后一条，只保留一条记录
reset();
const inBatch = saveUserProfiles([
  { userId: 'u1', form: formOf({ city: '北京' }) },
  { form: formOf({ name: '李四' }) },
  { userId: 'u1', form: formOf({ city: '广州' }) },
], T0);
assert.equal(inBatch.results[0].status, 'duplicate');
assert.ok(inBatch.results[0].warnings.some(w => w.code === 'BATCH_DEDUPED'));
assert.equal(listUserProfiles().length, 2, '批内重复 userId 应合并');
assert.equal(getUserProfile('u1')!.form.city, '广州', '批次内最后一条生效');

// 10) 多次保存不丢失（旧实现 slice(0,10) 会静默丢弃）
reset();
const many = Array.from({ length: 14 }, (_, i) => ({
  form: formOf({ name: `用户${i}`, day: String((i % 27) + 1) }),
}));
const manyResult = saveUserProfiles(many, T0);
assert.equal(manyResult.results.every(r => r.status === 'created'), true);
assert.equal(listUserProfiles().length, 14, '超过 10 个用户也不得截断');
// 再对其中 7 个用户做第二轮更新，全部原有记录仍在
const secondRound = saveUserProfiles(
  many.slice(0, 7).map((x, i) => ({ form: { ...x.form, clockMinute: String(i) } })),
  T0 + 1000,
);
assert.equal(secondRound.results.every(r => r.status === 'updated'), true);
assert.equal(listUserProfiles().length, 14, '多轮保存后用户数不减少');

// 11) 读取修复：损坏数据清除、非法单条丢弃、重复 userId 取最新且回写
reset();
storage.setItem(PROFILES_KEY, '{not-json');
assert.equal(readStore(T0).profiles.length, 0, '损坏 JSON 应返回空');
assert.equal(storage.has(PROFILES_KEY), false, '损坏键应被清除');
storage.setItem(PROFILES_KEY, JSON.stringify({ version: 999, profiles: [], revision: 1 }));
assert.equal(readStore(T0).profiles.length, 0, '未知版本应拒绝');
assert.equal(storage.has(PROFILES_KEY), false);

reset();
const good = saveUserProfiles([
  { form: formOf({ name: '张三' }) },
  { form: formOf({ name: '李四' }) },
], T0);
const idGood = good.results[0].userId;
const stale = JSON.parse(storage.getItem(PROFILES_KEY)!);
stale.profiles.push({ userId: 'broken', form: null });                  // 非法单条
const target = stale.profiles.find((p: { userId: string }) => p.userId === idGood);
stale.profiles.push({
  ...target, userId: idGood, revision: 99,
  form: { ...base, name: '张三（伪造）' },
}); // 同 userId 重复，revision 更大者应胜出
storage.setItem(PROFILES_KEY, JSON.stringify(stale));
const repaired = readStore(T0);
assert.equal(repaired.profiles.length, 2, '非法单条应被丢弃，合法用户不丢失');
assert.equal(repaired.profiles.find(p => p.userId === idGood)!.form.name, '张三（伪造）', '同 userId 取 revision 最大者');
assert.equal(repaired.profiles.find(p => p.userId === idGood)!.fingerprint,
  fingerprintOf({ ...base, name: '张三（伪造）' }), '修复时重算内容指纹');
assert.equal(JSON.parse(storage.getItem(PROFILES_KEY)!).profiles.length, 2, '修复结果应回写，保证状态一致');

// 12) 旧 ziwei_history 迁移：已有用户不丢失
reset();
storage.setItem(HISTORY_KEY, JSON.stringify([
  { id: '1', label: '张三', form: formOf({ name: '张三' }), savedAt: T0 - 100 },
  { id: '2', label: '李四', form: formOf({ name: '李四' }), savedAt: T0 - 50 },
  { id: '3', label: '损坏', form: { ...base, year: '' }, savedAt: T0 },
]));
const migrated = readStore(T0);
assert.equal(migrated.profiles.length, 2, '旧历史中的合法用户应被迁移');
assert.equal(storage.has(PROFILES_KEY), true);
assert.equal(listUserProfiles().length, 2);

// 13) 删除与清除联动，且不影响主题偏好
reset();
const del = saveUserProfiles([
  { form: formOf({ name: '张三' }) },
  { form: formOf({ name: '李四' }) },
], T0);
assert.equal(removeUserProfile(del.results[0].userId, T0 + 10), true);
assert.equal(listUserProfiles().length, 1);
assert.equal(removeUserProfile('not-exist', T0 + 20), false);
saveLastBirth(base);
storage.setItem('ziwei-theme', 'dark');
clearAllMemory();
assert.equal(storage.has(PROFILES_KEY), false, '顶层清除应删除用户档案库');
assert.equal(storage.has(LAST_BIRTH_KEY), false);
assert.equal(storage.getItem('ziwei-theme'), 'dark', '主题偏好不应被误删');
assert.equal(listUserProfiles().length, 0);

// 14) 存储禁用：不抛异常，且不制造「假成功」
const broken = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
  removeItem() { throw new Error('SecurityError'); },
  key() { throw new Error('SecurityError'); },
  get length() { throw new Error('SecurityError'); },
};
(globalThis as any).window = { localStorage: broken };
const blocked = saveUserProfiles([{ form: base }], T0);
assert.equal(blocked.written, false);
assert.equal(blocked.results[0].status, 'rejected');
assert.ok(blocked.results[0].errors.some(e => e.code === 'STORAGE_UNAVAILABLE'));
assert.equal(listUserProfiles().length, 0);
assert.doesNotThrow(() => { removeUserProfile('x'); clearAllMemory(); });

// 15) 容量上限：拒绝新增但绝不删除旧数据
reset();
const full = Array.from({ length: MAX_PROFILES }, (_, i) => ({
  form: formOf({ name: `批量用户${i}`, day: String((i % 27) + 1) }),
}));
assert.equal(saveUserProfiles(full, T0).written, true);
const overflow = saveUserProfiles([{ form: formOf({ name: '第201个用户', day: '28' }) }], T0 + 1);
assert.equal(overflow.results[0].status, 'rejected');
assert.ok(overflow.results[0].errors.some(e => e.code === 'STORE_FULL'));
assert.equal(listUserProfiles().length, MAX_PROFILES, '达到上限时旧数据一条都不能丢');
// 已有用户在满库时仍可更新
const existingId = deriveUserId(formOf({ name: '批量用户0', day: '1' }));
const stillUpdatable = updateUserProfile(existingId, { city: '深圳' }, T0 + 2);
assert.equal(stillUpdatable.status, 'updated', '满库不应阻止对已有用户更新');

// 16) 数据可用：读回的 form 能直接复原命盘
reset();
const persisted = saveUserProfiles([{ form: base }], T0).results[0];
const restoredForm = getUserProfile(persisted.userId)!.form;
const chart = generateChart(formToBirthInfo(restoredForm));
assert.equal(chart.palaces.length, 12);
assert.equal(chart.birthInfo.name, '张三');
assert.equal(chart.birthInfo.year, 1990);

console.log('user-profiles.test.ts: PASS (用户隔离 / 批量新增 / 按用户更新 / 去重 / 缺失校验 / 容量 / 迁移 / 修复 / 清除 / 复原)');
