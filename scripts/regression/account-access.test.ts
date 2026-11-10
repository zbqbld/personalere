/**
 * 账号归属与访问边界回归测试
 *
 * 覆盖：注册信息校验、重复账号、密码不落明文、会话、注册绑定、账号内
 * 批量/更新/删除/清空、以及核心约束——未登录 / 无效会话 / 其他账号 /
 * 伪造 ownerId / 越权 userId 在**所有**用户数据入口都得到完全一致的拒绝。
 * 业务层已异步化（本地文件 / Cloudflare D1 通用），因此断言统一 await。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ACCESS_DENIED, SESSION_TTL_MS } from '../../lib/account/contract';
import { requireOwner } from '../../lib/account/guard';
import { scopedKey, setAccountScope } from '../../lib/account/scope';
import { getStorage } from '../../lib/account/store';
import * as service from '../../lib/account/service';
import type { BirthDraft } from '../../lib/ziwei/memory';
import { LAST_BIRTH_KEY } from '../../lib/ziwei/memory';

// 每个测试进程使用独立的临时数据目录，避免污染项目 data/ 或相互干扰
const dataDir = mkdtempSync(path.join(tmpdir(), 'ziwei-account-'));
process.env.ZIWEI_DATA_DIR = dataDir;

const base: BirthDraft = {
  name: '张三', year: '1990', month: '6', day: '15',
  clockHour: '10', clockMinute: '30', unknownTime: false,
  province: '北京市', city: '北京', longitude: 116.4, gender: 'male',
};
const formOf = (over: Partial<BirthDraft> = {}): BirthDraft => ({ ...base, ...over });
const reg = (username: string, password = 'Passw0rd', extra: Record<string, unknown> = {}) => ({
  username, password, confirmPassword: password, ...extra,
});

function assertDenied(r: unknown, label: string): void {
  assert.equal((r as { ok: boolean }).ok, false, `${label} 应被拒绝`);
  assert.deepEqual(r, ACCESS_DENIED, `${label} 的拒绝结果必须与统一拒绝完全一致`);
}

const denials: unknown[] = [];
const recordDenial = (r: unknown, label: string): void => {
  assertDenied(r, label);
  denials.push(r);
};

/** 直接检查本地文件，验证「明文密码不落盘」；档案读取走抽象存储层 */
function readAccountsFile(): Record<string, { ownerId: string; passwordHash: string; passwordSalt: string }> {
  try {
    return JSON.parse(readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'));
  } catch {
    return {};
  }
}
async function profilesOf(ownerId: string) {
  return (await getStorage()).listProfiles(ownerId);
}

async function main(): Promise<void> {
  // ── 1) 注册信息校验 ─────────────────────────────────────────
  for (const [label, input, expected] of [
    ['空表单', {}, 'MISSING_USERNAME'],
    ['账号过短', reg('a'), 'INVALID_USERNAME'],
    ['账号含非法字符', reg('a b/c'), 'INVALID_USERNAME'],
    ['密码过短', reg('user01', 'Ab1'), 'WEAK_PASSWORD'],
    ['密码缺数字', reg('user01', 'abcdefgh'), 'WEAK_PASSWORD'],
    ['确认密码不一致', { ...reg('user01'), confirmPassword: 'Passw0rdX' }, 'PASSWORD_MISMATCH'],
    ['缺确认密码', { username: 'user01', password: 'Passw0rd' }, 'MISSING_CONFIRM_PASSWORD'],
  ] as const) {
    const r = await service.register(input);
    assert.equal(r.ok, false, `${label} 应被拒绝`);
    assert.ok(!r.ok && r.fields?.some(f => f.code === expected), `${label} 应给出 ${expected}`);
  }
  assert.equal(Object.keys(readAccountsFile()).length, 0, '校验失败不得创建账号');

  // ── 2) 注册、账号归属与重复账号 ─────────────────────────────
  const regA = await service.register(reg('Alice', 'Passw0rdA', { nickname: '爱丽丝' }));
  assert.equal(regA.ok, true, '合法注册应成功');
  assert.ok(regA.ok);
  const ownerA = regA.data.account.ownerId;
  const tokenA = regA.data.token;
  assert.match(ownerA, /^usr_[0-9a-f]+$/, 'ownerId 应由服务端生成');
  assert.equal(regA.data.account.username, 'alice', '账号名应规范化为小写');
  assert.equal(regA.data.account.nickname, '爱丽丝');
  assert.ok(!('passwordHash' in regA.data.account) && !('password' in regA.data.account), '返回给前端的账号不得含密码字段');

  const accountsRaw = JSON.stringify(readAccountsFile());
  assert.ok(!accountsRaw.includes('Passw0rdA'), '存储中不得出现明文密码');
  assert.ok(readAccountsFile()['alice'].passwordHash.length > 0 && readAccountsFile()['alice'].passwordSalt.length > 0);

  const duplicate = await service.register(reg('ALICE', 'Another1'));
  assert.equal(duplicate.ok, false, '重复账号必须拒绝');
  assert.ok(!duplicate.ok && duplicate.code === 'ACCOUNT_EXISTS');
  assert.equal(Object.keys(readAccountsFile()).length, 1, '重复注册不得新增或覆盖账号');
  assert.equal(readAccountsFile()['alice'].ownerId, ownerA, '重复注册不得改动原账号归属');
  assert.equal(readAccountsFile()['alice'].passwordHash, JSON.parse(accountsRaw)['alice'].passwordHash, '重复注册不得改动原账号密码');

  const regB = await service.register(reg('bob', 'Passw0rdB'));
  assert.ok(regB.ok);
  const ownerB = regB.data.account.ownerId;
  const tokenB = regB.data.token;
  assert.notEqual(ownerA, ownerB, '不同账号必须有不同 ownerId');

  // ── 3) 登录、防账号枚举、当前账号 ───────────────────────────
  const badLogin = await service.login({ username: 'alice', password: 'WrongPass1' });
  const unknownLogin = await service.login({ username: 'nobody', password: 'WrongPass1' });
  assert.equal(badLogin.ok, false);
  assert.equal(unknownLogin.ok, false);
  assert.deepEqual(badLogin, unknownLogin, '密码错误与账号不存在必须返回同一结果，避免账号枚举');
  const loginA = await service.login({ username: 'ALICE', password: 'Passw0rdA' });
  assert.ok(loginA.ok);
  assert.equal(loginA.data.account.ownerId, ownerA);
  const me = await service.currentAccount(loginA.data.token);
  assert.ok(me.ok);
  assert.equal(me.data.ownerId, ownerA);
  assert.ok(!('passwordHash' in me.data), '当前账号信息不得泄露密码派生值');

  // ── 4) 注册时绑定本机既有档案 ───────────────────────────────
  const bind = await service.bindOwnedProfiles(tokenA, [
    { userId: 'local-1', form: formOf({ name: '张三' }) },
    { userId: 'local-2', form: formOf({ name: '李四', year: '1988', month: '3', day: '22' }) },
  ]);
  assert.ok(bind.ok);
  assert.equal(bind.data.results.every(r => r.status === 'created'), true);
  assert.equal((await profilesOf(ownerA)).length, 2);
  assert.equal((await profilesOf(ownerA)).every(p => p.ownerId === ownerA), true, '绑定数据必须归属注册账号');
  assert.equal((await profilesOf(ownerB)).length, 0, 'B 账号不应看到 A 绑定或新建的数据');

  // ── 5) 账号内的正常操作（批量 / 去重 / 更新 / 查询 / 删除 / 清空）──
  const saved = await service.saveOwnedProfiles(tokenA, [
    { form: formOf({ name: '王五' }) },
    { form: formOf({ name: '赵六' }) },
  ]);
  assert.ok(saved.ok);
  assert.equal(saved.data.results.every(r => r.status === 'created'), true);
  const idWang = saved.data.results[0].userId;
  const dup = await service.saveOwnedProfiles(tokenA, [{ form: formOf({ name: '王五' }) }]);
  assert.ok(dup.ok);
  assert.equal(dup.data.results[0].status, 'duplicate', '重复提交应去重');
  assert.equal(dup.data.written, false);
  const updated = await service.updateOwnedProfile(tokenA, idWang, { city: '上海' });
  assert.ok(updated.ok);
  assert.equal(updated.data.status, 'updated');
  assert.equal(updated.data.profile!.form.city, '上海');
  assert.equal(updated.data.profile!.ownerId, ownerA);
  const one = await service.getOwnedProfile(tokenA, idWang);
  assert.ok(one.ok);
  assert.equal(one.data.userId, idWang);
  const listA = await service.listOwnedProfiles(tokenA);
  assert.ok(listA.ok);
  assert.equal(listA.data.length, 4, 'A 账号应有 4 条档案');
  assert.equal(listA.data.every(p => p.ownerId === ownerA), true);

  // ── 6) 访问边界：所有入口、所有越权场景 → 完全一致的拒绝 ──────
  const forgedOwnerInputs = [{ userId: 'x', ownerId: ownerA, form: formOf({ name: '越权写入' }) }];

  for (const bad of [undefined, '', 'forged-token']) {
    const tag = `未登录(${String(bad)})`;
    recordDenial(await service.listOwnedProfiles(bad), `${tag}/列表`);
    recordDenial(await service.getOwnedProfile(bad, idWang), `${tag}/单条查询`);
    recordDenial(await service.saveOwnedProfiles(bad, [{ form: base }]), `${tag}/批量保存`);
    recordDenial(await service.bindOwnedProfiles(bad, [{ form: base }]), `${tag}/绑定`);
    recordDenial(await service.updateOwnedProfile(bad, idWang, { city: '重庆' }), `${tag}/按用户更新`);
    recordDenial(await service.deleteOwnedProfile(bad, idWang), `${tag}/删除`);
    recordDenial(await service.clearOwnedProfiles(bad), `${tag}/清空`);
    recordDenial(await service.currentAccount(bad), `${tag}/当前账号`);
    recordDenial(await service.logout(bad), `${tag}/登出`);
    recordDenial(await requireOwner(bad, undefined), `${tag}/门禁`);
  }

  const listB = await service.listOwnedProfiles(tokenB);
  assert.ok(listB.ok, 'B 应能正常读取自己的（空）空间');
  assert.equal(listB.data.length, 0, 'B 的空间不得出现 A 的数据');
  recordDenial(await service.getOwnedProfile(tokenB, idWang), 'B 读取 A 的单条档案');
  recordDenial(await service.updateOwnedProfile(tokenB, idWang, { city: '广州' }), 'B 修改 A 的档案');
  recordDenial(await service.deleteOwnedProfile(tokenB, idWang), 'B 删除 A 的档案');
  recordDenial(await service.getOwnedProfile(tokenB, 'local-1'), 'B 读取 A 绑定的档案');
  recordDenial(await service.saveOwnedProfiles(tokenB, [{ form: base }], undefined, ownerA), 'B 伪造 A 的 ownerId');
  recordDenial(await service.saveOwnedProfiles(tokenB, forgedOwnerInputs), 'B 在请求体里伪造 ownerId');
  recordDenial(await requireOwner(tokenB, ownerA), 'B 门禁声明 A 的 ownerId');

  recordDenial(await service.saveOwnedProfiles(tokenA, [{ form: base }], undefined, ownerB), 'A 伪造 B 的 ownerId');
  recordDenial(await service.saveOwnedProfiles(tokenA, [{ ownerId: ownerB, form: base }]), 'A 在档案里伪造 ownerId');
  recordDenial(await service.getOwnedProfile(tokenA, 'not-exist'), 'A 查询不存在的档案（不泄露存在性）');

  for (const d of denials) assert.deepEqual(d, denials[0], '所有越权场景的拒绝结果必须完全一致');
  assert.equal(Object.keys(denials[0] as object).sort().join(','), 'code,message,ok', '拒绝结果不得附带额外字段');
  assert.equal(JSON.stringify(denials[0]).includes('张三'), false, '拒绝结果不得泄露任何用户数据');
  assert.equal((await profilesOf(ownerA)).length, 4, '越权请求不得变更 A 的数据');
  assert.equal((await profilesOf(ownerB)).length, 0, '越权请求不得写入 B 的数据');
  assert.equal((await profilesOf(ownerA)).find(p => p.userId === idWang)!.form.city, '上海', 'A 的档案内容保持不变');

  // ── 7) 账号内删除 / 清空 + 登出后失效 ────────────────────────
  const removed = await service.deleteOwnedProfile(tokenA, idWang);
  assert.ok(removed.ok);
  assert.equal(removed.data.total, 3);
  const clearedB = await service.clearOwnedProfiles(tokenB);
  assert.ok(clearedB.ok, 'B 可以清空自己的空间');
  assert.equal((await profilesOf(ownerA)).length, 3, 'B 的清空不得影响 A');
  const out = await service.logout(tokenB);
  assert.ok(out.ok);
  recordDenial(await service.listOwnedProfiles(tokenB), '登出后读取');

  // ── 8) 会话过期 → 同一拒绝 ─────────────────────────────────
  recordDenial(
    await service.listOwnedProfiles(tokenA, Date.now() + SESSION_TTL_MS + 1000),
    '过期会话读取',
  );

  // ── 9) 兼容：匿名空间键名与旧版一致，账号空间互不重叠 ─────────
  setAccountScope(null);
  assert.equal(scopedKey(LAST_BIRTH_KEY), LAST_BIRTH_KEY, '未登录时键名必须与改动前完全一致');
  setAccountScope(ownerA);
  const keyA = scopedKey(LAST_BIRTH_KEY);
  assert.ok(keyA.includes(ownerA));
  setAccountScope(ownerB);
  const keyB = scopedKey(LAST_BIRTH_KEY);
  assert.ok(keyB.includes(ownerB));
  assert.notEqual(keyA, keyB, '不同账号的本地命名空间必须隔离');
  setAccountScope(null);
  assert.equal(scopedKey(LAST_BIRTH_KEY), LAST_BIRTH_KEY, '登出后回到匿名空间');
}

main().then(() => {
  rmSync(dataDir, { recursive: true, force: true });
  delete process.env.ZIWEI_DATA_DIR;
  console.log('account-access.test.ts: PASS (注册校验 / 重复账号 / 密码哈希 / 归属绑定 / 全入口统一拒绝 / 会话过期 / 匿名兼容)');
}).catch(e => {
  console.error(e);
  process.exit(1);
});
