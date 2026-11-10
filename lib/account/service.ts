/**
 * 账号与归属档案的业务层（服务端唯一的数据操作入口）
 *
 * 每一个函数都遵循同一顺序：校验输入 → requireOwner(会话) → 用会话推导出的
 * ownerId 读写该账号专属数据 → 返回结果。任何情况下都不会使用请求体里的
 * ownerId 去定位数据；若请求体携带了别的 ownerId，直接返回统一拒绝。
 *
 * 存储经 getStorage() 抽象：本地 / Node 用文件，Cloudflare Workers 用 D1，
 * 因此业务层全异步，但对外契约与拒绝结果完全一致。
 *
 * 与匿名流程的兼容：这些函数不触碰浏览器 localStorage。未注册 / 未登录的
 * 用户继续使用原有本地记忆链路；注册时可把本机既有档案一次性绑定到新账号。
 */

import {
  PROFILE_CAP,
  deny,
  type AccountPublic,
  type AuthPayload,
  type Failure,
  type FieldIssue,
  type LoginInput,
  type OwnedProfile,
  type ProfileInput,
  type RegisterInput,
  type ServiceResult,
  type StoredAccount,
} from './contract';
import { requireOwner, requireOwnedProfile } from './guard';
import { getStorage, newOwnerId, newSession } from './store';
import {
  hashPassword,
  newSalt,
  validateLogin,
  validateRegistration,
  verifyPassword,
} from './validation';
import { validateProfileInput } from '../ziwei/user-profiles';
import type { BirthDraft } from '../ziwei/memory';

export type ProfileStatus = 'created' | 'updated' | 'duplicate' | 'rejected';

export interface ProfileOpResult {
  index: number;
  userId: string;
  status: ProfileStatus;
  profile: OwnedProfile | null;
  errors: FieldIssue[];
  warnings: FieldIssue[];
}

export interface SaveOutcome {
  results: ProfileOpResult[];
  written: boolean;
  total: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toPublic(account: StoredAccount): AccountPublic {
  return {
    ownerId: account.ownerId,
    username: account.username,
    nickname: account.nickname,
    createdAt: account.createdAt,
  };
}

function invalidInput(fields: FieldIssue[]): Failure {
  return { ok: false, code: 'INVALID_INPUT', message: '注册信息校验未通过', fields };
}

const ACCOUNT_EXISTS: Failure = {
  ok: false, code: 'ACCOUNT_EXISTS', message: '该账号已注册，请直接登录或更换账号',
};
const INVALID_CREDENTIALS: Failure = {
  ok: false, code: 'INVALID_CREDENTIALS', message: '账号或密码不正确',
};

/* ─── 账号与会话 ─────────────────────────────────────────── */

/** 注册：校验 → 重复账号拒绝（不改动原账号）→ 建账号 → 自动登录 */
export async function register(
  input: RegisterInput,
  now: number = Date.now(),
): Promise<ServiceResult<AuthPayload>> {
  const v = validateRegistration(input);
  if (!v.ok) return invalidInput(v.fields);

  const storage = await getStorage();
  if (await storage.getAccount(v.value.username)) return { ...ACCOUNT_EXISTS };

  const ownerId = newOwnerId();
  const salt = newSalt();
  const account: StoredAccount = {
    ownerId,
    username: v.value.username,
    nickname: v.value.nickname,
    createdAt: now,
    passwordSalt: salt,
    passwordHash: await hashPassword(v.value.password, salt),
  };
  // putAccount 内部用唯一约束防并发重复；false 表示已有同名账号
  if (!await storage.putAccount(account)) return { ...ACCOUNT_EXISTS };

  const session = newSession(ownerId, now);
  await storage.putSession(session);
  return { ok: true, data: { token: session.token, account: toPublic(account) } };
}

/** 登录：账号不存在、密码错误、格式错误一律同一响应，避免账号枚举 */
export async function login(
  input: LoginInput,
  now: number = Date.now(),
): Promise<ServiceResult<AuthPayload>> {
  const v = validateLogin(input);
  if (!v.ok) return { ...INVALID_CREDENTIALS };
  const account = await (await getStorage()).getAccount(v.value.username);
  if (!account || !await verifyPassword(v.value.password, account.passwordSalt, account.passwordHash)) {
    return { ...INVALID_CREDENTIALS };
  }
  const session = newSession(account.ownerId, now);
  await (await getStorage()).putSession(session);
  return { ok: true, data: { token: session.token, account: toPublic(account) } };
}

/** 登出：同样经过门禁；无有效会话时返回统一拒绝，不泄露会话状态 */
export async function logout(
  token: string | undefined | null,
  now: number = Date.now(),
): Promise<ServiceResult<{ loggedOut: boolean }>> {
  const guard = await requireOwner(token, undefined, now);
  if (!guard.ok) return guard;
  if (token) await (await getStorage()).deleteSession(token);
  return { ok: true, data: { loggedOut: true } };
}

/** 当前账号信息（不含任何密码字段） */
export async function currentAccount(
  token: string | undefined | null,
  now: number = Date.now(),
): Promise<ServiceResult<AccountPublic>> {
  const guard = await requireOwner(token, undefined, now);
  if (!guard.ok) return guard;
  const account = await (await getStorage()).findAccountByOwner(guard.ownerId);
  if (!account) return deny();
  return { ok: true, data: toPublic(account) };
}

/* ─── 归属档案：所有入口统一门禁 ───────────────────────────── */

/** 列表：只返回会话账号自己的档案 */
export async function listOwnedProfiles(
  token: string | undefined | null,
  now: number = Date.now(),
): Promise<ServiceResult<OwnedProfile[]>> {
  const guard = await requireOwner(token, undefined, now);
  if (!guard.ok) return guard;
  const list = await (await getStorage()).listProfiles(guard.ownerId);
  return {
    ok: true,
    data: list.slice().sort((a, b) =>
      (b.updatedAt || 0) - (a.updatedAt || 0) || a.userId.localeCompare(b.userId)),
  };
}

/** 单条查询：不存在或属于他人 → 同一拒绝 */
export async function getOwnedProfile(
  token: string | undefined | null,
  userId: unknown,
  now: number = Date.now(),
): Promise<ServiceResult<OwnedProfile>> {
  const guard = await requireOwner(token, undefined, now);
  if (!guard.ok) return guard;
  const target = typeof userId === 'string' ? userId : '';
  const list = await (await getStorage()).listProfiles(guard.ownerId);
  const owned = requireOwnedProfile(guard.ownerId, list.find(p => p.userId === target));
  if (!owned.ok) return owned;
  return { ok: true, data: owned.profile };
}

/**
 * 批量新增 / 更新 / 去重 / 注册时绑定。
 * 越权检测：请求体里任何 ownerId 与会话不一致即统一拒绝；
 * 服务端写入的 ownerId 恒定来自会话，客户端无法篡改归属。
 */
export async function saveOwnedProfiles(
  token: string | undefined | null,
  inputs: ReadonlyArray<ProfileInput> = [],
  now: number = Date.now(),
  claimedOwnerId?: unknown,
): Promise<ServiceResult<SaveOutcome>> {
  const guard = await requireOwner(token, claimedOwnerId, now);
  if (!guard.ok) return guard;

  const list: unknown[] = Array.isArray(inputs) ? [...inputs] : [];
  for (const item of list) {
    if (isRecord(item) && item.ownerId !== undefined && item.ownerId !== null && item.ownerId !== ''
      && item.ownerId !== guard.ownerId) {
      return deny();
    }
  }

  const candidates = list.map((item, i) => validateProfileInput(item, i));
  const lastIndex = new Map<string, number>();
  for (const c of candidates) {
    if (c.errors.length === 0) lastIndex.set(c.userId, c.index);
  }

  const storage = await getStorage();
  const current = await storage.listProfiles(guard.ownerId);
  const byId = new Map(current.map(p => [p.userId, p]));
  const results: ProfileOpResult[] = [];
  let changed = false;

  for (const c of candidates) {
    if (c.errors.length > 0 || !c.form) {
      results.push({
        index: c.index, userId: c.userId, status: 'rejected', profile: null,
        errors: c.errors, warnings: c.warnings,
      });
      continue;
    }
    if (lastIndex.get(c.userId) !== c.index) {
      results.push({
        index: c.index, userId: c.userId, status: 'duplicate',
        profile: byId.get(c.userId) ?? null, errors: [],
        warnings: [...c.warnings, {
          field: 'userId', code: 'BATCH_DEDUPED', message: '同一批次内重复提交，已合并到最后一条',
        }],
      });
      continue;
    }
    const existing = byId.get(c.userId);
    if (existing && existing.fingerprint === c.fingerprint) {
      results.push({
        index: c.index, userId: c.userId, status: 'duplicate',
        profile: existing, errors: [], warnings: c.warnings,
      });
      continue;
    }
    if (!existing && byId.size >= PROFILE_CAP) {
      results.push({
        index: c.index, userId: c.userId, status: 'rejected', profile: null,
        errors: [{ field: 'store', code: 'STORE_FULL', message: '档案数量已达上限，已保留全部旧数据' }],
        warnings: c.warnings,
      });
      continue;
    }

    const profile: OwnedProfile = {
      ownerId: guard.ownerId,
      userId: c.userId,
      displayName: c.displayName,
      label: c.label,
      form: c.form,
      fingerprint: c.fingerprint,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      revision: (existing?.revision ?? 0) + 1,
    };
    byId.set(c.userId, profile);
    changed = true;
    results.push({
      index: c.index, userId: c.userId,
      status: existing ? 'updated' : 'created',
      profile, errors: [], warnings: c.warnings,
    });
  }

  if (!changed) return { ok: true, data: { results, written: false, total: byId.size } };
  const next = [...byId.values()].sort((a, b) => a.userId.localeCompare(b.userId));
  await storage.replaceProfiles(guard.ownerId, next);
  return { ok: true, data: { results, written: true, total: next.length } };
}

/** 注册时把本机既有档案绑定至新账号（绑定结果全部带该账号 ownerId） */
export function bindOwnedProfiles(
  token: string | undefined | null,
  inputs: ReadonlyArray<ProfileInput> = [],
  now: number = Date.now(),
): Promise<ServiceResult<SaveOutcome>> {
  return saveOwnedProfiles(token, inputs, now);
}

/** 按用户更新：只改本人的指定档案 */
export async function updateOwnedProfile(
  token: string | undefined | null,
  userId: unknown,
  patch: Partial<BirthDraft>,
  now: number = Date.now(),
): Promise<ServiceResult<ProfileOpResult>> {
  const guard = await requireOwner(token, undefined, now);
  if (!guard.ok) return guard;
  const target = typeof userId === 'string' ? userId : '';
  const storage = await getStorage();
  const current = await storage.listProfiles(guard.ownerId);
  const owned = requireOwnedProfile(guard.ownerId, current.find(p => p.userId === target));
  if (!owned.ok) return owned;
  const merged = { ...owned.profile.form, ...(isRecord(patch) ? patch : {}) };
  const saved = await saveOwnedProfiles(token, [{ userId: target, form: merged }], now);
  if (!saved.ok) return saved;
  return { ok: true, data: saved.data.results[0] };
}

export async function deleteOwnedProfile(
  token: string | undefined | null,
  userId: unknown,
  now: number = Date.now(),
): Promise<ServiceResult<{ deleted: boolean; total: number }>> {
  const guard = await requireOwner(token, undefined, now);
  if (!guard.ok) return guard;
  const target = typeof userId === 'string' ? userId : '';
  const storage = await getStorage();
  const current = await storage.listProfiles(guard.ownerId);
  const owned = requireOwnedProfile(guard.ownerId, current.find(p => p.userId === target));
  if (!owned.ok) return owned;
  const next = current.filter(p => p.userId !== target);
  await storage.replaceProfiles(guard.ownerId, next);
  return { ok: true, data: { deleted: true, total: next.length } };
}

export async function clearOwnedProfiles(
  token: string | undefined | null,
  now: number = Date.now(),
): Promise<ServiceResult<{ cleared: number }>> {
  const guard = await requireOwner(token, undefined, now);
  if (!guard.ok) return guard;
  const storage = await getStorage();
  const current = await storage.listProfiles(guard.ownerId);
  await storage.replaceProfiles(guard.ownerId, []);
  return { ok: true, data: { cleared: current.length } };
}
