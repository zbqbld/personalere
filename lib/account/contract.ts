/**
 * 账号归属与访问边界的统一契约
 *
 * ── 核心约束 ────────────────────────────────────────────────
 * A1 账号归属：每个注册账号有唯一 ownerId；每条用户档案都带 ownerId，
 *    服务端按 ownerId 分桶存储，账号数据永不写入浏览器本地档案库。
 * A2 统一门禁：所有涉及用户信息的读 / 写 / 改 / 删入口都必须先经过
 *    requireOwner()，且只使用「会话推导出的 ownerId」定位数据，绝不信任
 *    请求体传入的 ownerId。
 * A3 一致的拒绝：未登录、会话无效或过期、访问其他账号资源、伪造 ownerId、
 *    越权指定 userId —— 一律返回同一个 ACCESS_DENIED 结果（同一状态码、
 *    同一 code、同一文案、无附加字段），不区分「资源不存在」与「属于他人」，
 *    避免通过响应差异枚举账号或档案是否存在。
 * A4 兼容：未注册 / 未登录时的匿名使用流程完全保留（本地 localStorage 键名
 *    与改动前一致）；注册成功可把本机既有档案一次性绑定到新账号。
 */

import type { BirthDraft } from '../ziwei/memory';

export const AUTH_COOKIE = 'zw_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DENY_STATUS = 403;

/** 所有访问拒绝都返回这一个对象的内容，不得因场景不同而变化 */
export const ACCESS_DENIED = {
  ok: false,
  code: 'ACCESS_DENIED',
  message: '无权访问该用户数据',
} as const;

export interface FieldIssue {
  field: string;
  code: string;
  message: string;
}

export interface Failure {
  ok: false;
  code: string;
  message: string;
  fields?: FieldIssue[];
}

export type ServiceResult<T> = { ok: true; data: T } | Failure;

/** 唯一的拒绝构造函数：任何访问边界失败都必须调用它 */
export function deny(): Failure {
  return { ok: ACCESS_DENIED.ok, code: ACCESS_DENIED.code, message: ACCESS_DENIED.message };
}

export function isAccessDenied(r: ServiceResult<unknown> | Failure): boolean {
  return !r.ok && r.code === ACCESS_DENIED.code && r.message === ACCESS_DENIED.message;
}

export interface AccountPublic {
  ownerId: string;
  username: string;
  nickname: string;
  createdAt: number;
}

/** 服务端账号记录：只存随机盐 + scrypt 派生值，绝不存明文密码 */
export interface StoredAccount extends AccountPublic {
  passwordSalt: string;
  passwordHash: string;
}

export interface SessionRecord {
  token: string;
  ownerId: string;
  createdAt: number;
  expiresAt: number;
}

/** 归属档案：ownerId 与 userId 共同定位，ownerId 只能来自会话 */
export interface OwnedProfile {
  ownerId: string;
  userId: string;
  displayName: string;
  label: string;
  form: BirthDraft;
  fingerprint: string;
  createdAt: number;
  updatedAt: number;
  revision: number;
}

export interface RegisterInput {
  username?: unknown;
  password?: unknown;
  confirmPassword?: unknown;
  nickname?: unknown;
}

export interface LoginInput {
  username?: unknown;
  password?: unknown;
}

export interface AuthPayload {
  token: string;
  account: AccountPublic;
}

export interface ProfileInput {
  userId?: string;
  form: unknown;
  /** 若携带且不等于会话 ownerId，视为越权并统一拒绝 */
  ownerId?: unknown;
}

export const PROFILE_CAP = 200;
