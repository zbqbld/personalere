/**
 * 起盘用户档案库 —— 按「用户」维度分别保存多个起盘人的信息
 *
 * ── 保存要求（契约，验收见 scripts/regression/user-profiles.test.ts）──────
 * R1 用户可区分：每条记录有稳定主键 userId。显式 userId 优先；未传时由
 *    「姓名 + 出生年月日 + 性别」派生（身份五元组）。出生时间、出生地属于
 *    可变属性，不参与主键，因此修改时辰/城市仍是同一个用户，走更新而非新建。
 *    边界：同名、同生日、同性别的两个不同人无法自动区分，调用方必须显式
 *    传入 userId；无账号体系时以派生 ID 为准，并在验收标准中明确写出。
 * R2 按用户分别保存：单键存储 { version, profiles, revision, updatedAt }，
 *    profiles 以 userId 唯一。写入只替换目标 userId 的槽位，绝不整体覆盖。
 * R3 批量新增：saveUserProfiles(inputs) 逐条校验，合法项一次写入（单次
 *    setItem 原子提交）；非法项返回结构化错误且不影响同批其他用户。
 * R4 按用户更新：updateUserProfile(userId, patch) 合并字段后重新校验，
 *    保留 createdAt、递增单条 revision；不存在的 userId 返回 NOT_FOUND。
 * R5 重复提交去重：内容指纹 fingerprint = 规整后完整表单的哈希。
 *    - 同 userId + 同 fingerprint → duplicate，不写盘、不推进版本/时间；
 *    - 同 userId + 不同 fingerprint → updated；
 *    - 同一批次内相同 userId → 合并到最后一条，其余标 duplicate。
 * R6 缺失信息明确校验：起盘必需字段（年月日、性别、出生时分，未知时辰除外）
 *    缺失或非法一律拒绝并给出 field/code/message；姓名、出生地、经度属于
 *    可选信息，缺失时给出 warning 但允许保存（表单中姓名本就可选）。
 * R7 数据不丢失：不再按条数截断历史。达到 MAX_PROFILES 时拒绝新增
 *    （STORE_FULL），绝不静默删除最旧记录；旧 ziwei_history 数据在首次
 *    读取时迁移，不丢已有用户。
 * R8 状态一致：读取时严格校验并修复（丢弃非法单条、同 userId 取 revision
 *    最大者、重算 fingerprint），修复结果回写；每次写入前重新读取最新快照，
 *    避免用陈旧内存 state 覆盖磁盘；写盘失败一律返回 STORAGE_UNAVAILABLE，
 *    不制造「假成功」；跨标签页通过 storage 事件同步（见 history.ts）。
 *
 * 存储：仅浏览器 localStorage，不发起网络请求。所有 API 在 window 缺失或
 * localStorage 被禁用时安全降级，不抛异常。now 可注入以便确定性测试。
 */

import { scopedKey } from '../account/scope';
import {
  HISTORY_KEY,
  PROFILES_KEY,
  describeBirthDraft,
  normalizeBirthDraft,
  type BirthDraft,
} from './memory';

export const PROFILES_VERSION = 1;
/** 容量上限：达到后拒绝新增而非丢弃旧数据 */
export const MAX_PROFILES = 200;
const MAX_USER_ID = 64;
const MAX_LABEL = 160;

/* ─── 数据结构 ─────────────────────────────────────────────── */

/** 一个起盘用户的档案；userId 是唯一主键 */
export interface UserProfile {
  userId: string;
  /** 展示名：姓名，或未命名时带短码的可区分标识 */
  displayName: string;
  /** 完整摘要，供历史列表展示 */
  label: string;
  /** 规整后的完整起盘信息 */
  form: BirthDraft;
  /** 内容指纹，重复提交去重依据 */
  fingerprint: string;
  createdAt: number;
  updatedAt: number;
  /** 单条版本号，每次内容变更 +1 */
  revision: number;
}

/** 全库快照。revision 每次写入 +1，用于判定状态是否推进 */
export interface UserProfileStore {
  version: typeof PROFILES_VERSION;
  profiles: UserProfile[];
  revision: number;
  updatedAt: number;
}

export interface ProfileInput {
  /** 可选：显式用户标识；缺省时由身份五元组派生 */
  userId?: string;
  /** 起盘表单（可为任意来源数据，写入前统一规整校验） */
  form: unknown;
}

export interface ProfileIssue {
  field: string;
  code: string;
  message: string;
}

export type ProfileStatus = 'created' | 'updated' | 'duplicate' | 'rejected';

export interface ProfileResult {
  index: number;
  userId: string;
  status: ProfileStatus;
  profile: UserProfile | null;
  errors: ProfileIssue[];
  warnings: ProfileIssue[];
}

export interface SaveResult {
  results: ProfileResult[];
  /** 写入成功后的快照；未写盘时为写前快照 */
  store: UserProfileStore;
  written: boolean;
}

/* ─── 基础工具 ─────────────────────────────────────────────── */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** FNV-1a 32 位哈希；仅用于标识与指纹，不用于安全用途 */
function hash32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function positiveNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}

/** 用户标识消毒：保留可读字符，去掉控制字符与路径分隔符 */
function sanitizeUserId(raw: string): string {
  return raw.trim().slice(0, MAX_USER_ID).replace(/[\x00-\x1f/:*?"<>|\\]/g, '_');
}

/**
 * 由「姓名 + 出生年月日 + 性别」派生稳定用户 ID。
 * 出生时间、出生地不参与，保证改时辰/城市时仍是同一个用户。
 */
export function deriveUserId(form: BirthDraft): string {
  // 仅使用消毒后仍不变的字符，保证「写入 → 读取规整」后主键完全一致
  return `auto_${hash32([
    form.name.trim(), form.year, form.month, form.day, form.gender,
  ].join('|'))}`;
}

/** 完整表单指纹：任何可见字段变化都会被识别为一次真实更新 */
export function fingerprintOf(form: BirthDraft): string {
  return hash32(JSON.stringify([
    form.name, form.year, form.month, form.day,
    form.clockHour, form.clockMinute, form.unknownTime,
    form.province, form.city, form.longitude, form.gender,
  ]));
}

function sortByUserId(list: UserProfile[]): UserProfile[] {
  return list.sort((a, b) => a.userId.localeCompare(b.userId));
}

function emptyStore(): UserProfileStore {
  return { version: PROFILES_VERSION, profiles: [], revision: 0, updatedAt: 0 };
}

function writeStoreRaw(store: UserProfileStore): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(scopedKey(PROFILES_KEY), JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

function removeStoreKey(): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(scopedKey(PROFILES_KEY)); } catch { /* ignore */ }
}

/* ─── 校验 ─────────────────────────────────────────────────── */

export interface ProfileCandidate {
  index: number;
  userId: string;
  form: BirthDraft | null;
  fingerprint: string;
  displayName: string;
  label: string;
  errors: ProfileIssue[];
  warnings: ProfileIssue[];
}

function present(v: unknown): boolean {
  return (typeof v === 'string' && v.trim() !== '') ||
    (typeof v === 'number' && Number.isFinite(v));
}

/**
 * 单条输入校验。起盘必需字段为 error（拒绝写入）；可选信息缺失为 warning
 * （允许写入但明确报告）。规整统一交给 memory.normalizeBirthDraft，避免
 * 与排盘引擎的字段口径出现第二套规则。
 */
export function validateProfileInput(input: unknown, index: number): ProfileCandidate {
  const errors: ProfileIssue[] = [];
  const warnings: ProfileIssue[] = [];
  const root = isRecord(input) ? input : {};
  const f: Record<string, unknown> = isRecord(root.form) ? root.form : {};

  for (const [field, label] of [
    ['year', '出生年份'], ['month', '出生月份'], ['day', '出生日期'],
  ] as const) {
    if (!present(f[field])) {
      errors.push({ field, code: 'MISSING_BIRTH_DATE', message: `缺少${label}` });
    }
  }
  if (f.gender !== 'male' && f.gender !== 'female') {
    errors.push({ field: 'gender', code: 'INVALID_GENDER', message: '性别必须为 male 或 female' });
  }
  if (f.unknownTime !== true) {
    if (!present(f.clockHour)) {
      errors.push({ field: 'clockHour', code: 'MISSING_BIRTH_TIME', message: '缺少出生时；若不清楚请勾选「时辰不详」' });
    }
    if (!present(f.clockMinute)) {
      errors.push({ field: 'clockMinute', code: 'MISSING_BIRTH_TIME', message: '缺少出生分；若不清楚请勾选「时辰不详」' });
    }
  }

  const form = normalizeBirthDraft(f);
  if (!form) {
    errors.push({ field: 'form', code: 'INVALID_FORM', message: '出生日期不存在或字段类型不符合要求' });
  }

  let userId = '';
  const explicit = root.userId;
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    userId = sanitizeUserId(explicit);
    if (!userId) {
      errors.push({ field: 'userId', code: 'INVALID_USER_ID', message: '用户标识不可为空' });
    } else if (userId !== explicit.trim()) {
      warnings.push({ field: 'userId', code: 'USER_ID_NORMALIZED', message: '用户标识含非法字符，已归一化' });
    }
  }
  if (!userId && form) userId = sanitizeUserId(deriveUserId(form));
  if (!userId) {
    errors.push({ field: 'userId', code: 'MISSING_USER_IDENTITY', message: '无法确定用户标识' });
  }

  if (form) {
    if (!form.name.trim()) {
      warnings.push({ field: 'name', code: 'MISSING_NAME', message: '未填写姓名，已按身份信息生成可区分的用户编号' });
    }
    if (!form.province && !form.city) {
      warnings.push({ field: 'location', code: 'MISSING_LOCATION', message: '未填写出生地，经度按默认值 120 处理' });
    }
    if (f.longitude === undefined || f.longitude === null) {
      warnings.push({ field: 'longitude', code: 'LONGITUDE_DEFAULTED', message: '经度缺失，已按 120 处理' });
    }
  }

  return {
    index,
    userId,
    form,
    fingerprint: form ? fingerprintOf(form) : '',
    displayName: form?.name.trim() || `未命名·${userId.slice(-6)}`,
    label: form ? describeBirthDraft(form) : '',
    errors,
    warnings,
  };
}

/* ─── 读取与修复 ───────────────────────────────────────────── */

function normalizeStoredProfile(raw: unknown, now: number): UserProfile | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.userId !== 'string') return null;
  const userId = sanitizeUserId(raw.userId);
  if (!userId) return null;
  const form = normalizeBirthDraft(raw.form);
  if (!form) return null;

  return {
    userId,
    displayName: typeof raw.displayName === 'string' && raw.displayName.trim()
      ? raw.displayName.slice(0, MAX_LABEL)
      : (form.name.trim() || `未命名·${userId.slice(-6)}`),
    label: typeof raw.label === 'string' && raw.label.trim()
      ? raw.label.slice(0, MAX_LABEL)
      : describeBirthDraft(form),
    form,
    // 重算而非信任落盘值，保证 fingerprint 与内容始终一致
    fingerprint: fingerprintOf(form),
    createdAt: positiveNumber(raw.createdAt, now),
    updatedAt: positiveNumber(raw.updatedAt, now),
    revision: Math.max(1, Math.floor(positiveNumber(raw.revision, 1))),
  };
}

/** 迁移旧版 ziwei_history 数组；只在用户库键完全不存在时执行 */
function migrateLegacy(now: number): UserProfileStore | null {
  if (typeof window === 'undefined') return null;
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(scopedKey(HISTORY_KEY)); } catch { return null; }
  if (!raw) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!Array.isArray(parsed)) return null;

  const byId = new Map<string, UserProfile>();
  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i];
    if (!isRecord(item)) continue;
    const c = validateProfileInput({ form: item.form }, i);
    if (c.errors.length > 0 || !c.form || !c.userId) continue;
    const savedAt = positiveNumber(item.savedAt, now);
    const profile: UserProfile = {
      userId: c.userId,
      displayName: c.displayName,
      label: c.label,
      form: c.form,
      fingerprint: c.fingerprint,
      createdAt: savedAt,
      updatedAt: savedAt,
      revision: 1,
    };
    const prev = byId.get(profile.userId);
    if (!prev || profile.updatedAt >= prev.updatedAt) byId.set(profile.userId, profile);
  }
  if (byId.size === 0) return null;
  const store: UserProfileStore = {
    version: PROFILES_VERSION,
    profiles: sortByUserId([...byId.values()]),
    revision: 1,
    updatedAt: now,
  };
  writeStoreRaw(store);
  return store;
}

/**
 * 读取全库：损坏/未知版本 → 清除并返回空；非法单条 → 丢弃但不影响其他用户；
 * 重复 userId → 保留 revision 最大者；修复结果回写，保证多次保存后状态一致。
 */
export function readStore(now: number = Date.now()): UserProfileStore {
  if (typeof window === 'undefined') return emptyStore();
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(scopedKey(PROFILES_KEY)); } catch { return emptyStore(); }
  if (raw === null) return migrateLegacy(now) ?? emptyStore();

  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { removeStoreKey(); return emptyStore(); }
  if (!isRecord(parsed) || parsed.version !== PROFILES_VERSION || !Array.isArray(parsed.profiles)) {
    removeStoreKey();
    return emptyStore();
  }

  const byId = new Map<string, UserProfile>();
  for (const item of parsed.profiles) {
    const profile = normalizeStoredProfile(item, now);
    if (!profile) continue;
    const prev = byId.get(profile.userId);
    if (!prev || profile.revision >= prev.revision) byId.set(profile.userId, profile);
  }

  const store: UserProfileStore = {
    version: PROFILES_VERSION,
    profiles: sortByUserId([...byId.values()]),
    revision: Math.max(0, Math.floor(positiveNumber(parsed.revision, byId.size))),
    updatedAt: positiveNumber(parsed.updatedAt, now),
  };
  if (JSON.stringify(store) !== raw) writeStoreRaw(store);
  return store;
}

/** 按最近更新倒序，供 UI 历史列表展示 */
export function listUserProfiles(): UserProfile[] {
  return readStore().profiles
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt || a.userId.localeCompare(b.userId));
}

export function getUserProfile(userId: string): UserProfile | null {
  const target = sanitizeUserId(userId);
  return readStore().profiles.find(p => p.userId === target) ?? null;
}

/* ─── 写入 ─────────────────────────────────────────────────── */

function rejected(c: ProfileCandidate, extraErrors: ProfileIssue[] = []): ProfileResult {
  return {
    index: c.index,
    userId: c.userId,
    status: 'rejected',
    profile: null,
    errors: [...c.errors, ...extraErrors],
    warnings: c.warnings,
  };
}

/**
 * 批量新增 / 更新 / 去重。一次调用只产生一次 setItem（或无变更时不写盘）。
 * 逐条返回结果，调用方可据此给出明确的校验反馈。
 */
export function saveUserProfiles(
  inputs: ReadonlyArray<ProfileInput> = [],
  now: number = Date.now(),
): SaveResult {
  const before = readStore(now);
  const list: unknown[] = Array.isArray(inputs) ? [...inputs] : [];
  const candidates = list.map((item, i) => validateProfileInput(item, i));

  // 批内去重：同一 userId 只保留最后一条作为有效写入
  const lastIndex = new Map<string, number>();
  for (const c of candidates) {
    if (c.errors.length === 0) lastIndex.set(c.userId, c.index);
  }

  const byId = new Map(before.profiles.map(p => [p.userId, p]));
  const results: ProfileResult[] = [];
  let changed = false;

  for (const c of candidates) {
    if (c.errors.length > 0 || !c.form) {
      results.push(rejected(c));
      continue;
    }
    if (lastIndex.get(c.userId) !== c.index) {
      results.push({
        index: c.index,
        userId: c.userId,
        status: 'duplicate',
        profile: byId.get(c.userId) ?? null,
        errors: [],
        warnings: [...c.warnings, {
          field: 'userId',
          code: 'BATCH_DEDUPED',
          message: '同一批次内重复提交，已合并到最后一条',
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
    if (!existing && byId.size >= MAX_PROFILES) {
      results.push(rejected(c, [{
        field: 'store', code: 'STORE_FULL',
        message: `用户档案已达上限 ${MAX_PROFILES}，已拒绝新增且保留全部旧数据`,
      }]));
      continue;
    }

    const profile: UserProfile = {
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
      index: c.index,
      userId: c.userId,
      status: existing ? 'updated' : 'created',
      profile,
      errors: [],
      warnings: c.warnings,
    });
  }

  if (!changed) return { results, store: before, written: false };

  const store: UserProfileStore = {
    version: PROFILES_VERSION,
    profiles: sortByUserId([...byId.values()]),
    revision: before.revision + 1,
    updatedAt: now,
  };
  if (!writeStoreRaw(store)) {
    // 写盘失败不得制造「假成功」：把本次本应新增/更新的结果改为拒绝
    const failed = results.map(r => (r.status === 'created' || r.status === 'updated')
      ? {
        ...r,
        status: 'rejected' as const,
        profile: null,
        errors: [...r.errors, {
          field: 'storage', code: 'STORAGE_UNAVAILABLE',
          message: '浏览器禁止本地存储或配额已满，本次未写入',
        }],
      }
      : r);
    return { results: failed, store: before, written: false };
  }
  return { results, store, written: true };
}

/** 按用户更新：只动指定 userId，保留创建时间与其余用户记录 */
export function updateUserProfile(
  userId: string,
  patch: Partial<BirthDraft>,
  now: number = Date.now(),
): ProfileResult {
  const target = sanitizeUserId(userId);
  const existing = readStore(now).profiles.find(p => p.userId === target);
  if (!existing) {
    return {
      index: 0,
      userId: target,
      status: 'rejected',
      profile: null,
      errors: [{ field: 'userId', code: 'NOT_FOUND', message: '该用户档案不存在' }],
      warnings: [],
    };
  }
  const merged = { ...existing.form, ...(isRecord(patch) ? patch : {}) };
  return saveUserProfiles([{ userId: target, form: merged }], now).results[0];
}

/** 删除单个用户；返回是否确实写盘删除 */
export function removeUserProfile(userId: string, now: number = Date.now()): boolean {
  const target = sanitizeUserId(userId);
  const before = readStore(now);
  const profiles = before.profiles.filter(p => p.userId !== target);
  if (profiles.length === before.profiles.length) return false;
  return writeStoreRaw({
    version: PROFILES_VERSION,
    profiles,
    revision: before.revision + 1,
    updatedAt: now,
  });
}

export function clearUserProfiles(): void {
  removeStoreKey();
}
