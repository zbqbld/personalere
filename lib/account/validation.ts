/**
 * 注册信息校验与密码处理
 *
 * 改用 Web Crypto（PBKDF2-SHA256 + getRandomValues）：Node 18+ 与 Cloudflare
 * Workers 都支持，不再依赖 node:crypto 的 scryptSync / Buffer。
 * 注意：哈希算法与旧的 scrypt 版本不兼容，升级后旧账号需要重新注册。
 *
 * - 账号：去空白并转小写后作为唯一键；2–32 位中英文 / 数字 / _ . - 。
 * - 密码：8–64 位，且必须同时含字母与数字；只保存随机盐 + 派生值。
 * - 确认密码：必填且必须与密码一致。
 * - 昵称：可选，缺省时用账号名，仅用于展示。
 */
import type { FieldIssue, LoginInput, RegisterInput } from './contract';

const USERNAME_RE = /^[a-z0-9_.\-\u4e00-\u9fa5]{2,32}$/u;
const NICKNAME_MAX = 32;
const PBKDF2_ITERATIONS = 100000;
const KEY_BITS = 256;

export function normalizeUsername(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : '';
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return new Uint8Array(0);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 常量时间比较，避免通过响应耗时推断密码 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function newSalt(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

async function derive(password: string, saltHex: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const rawSalt = fromHex(saltHex);
  const saltBuffer = new ArrayBuffer(rawSalt.length);
  new Uint8Array(saltBuffer).set(rawSalt);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBuffer, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  return toHex(await derive(password, salt));
}

export async function verifyPassword(password: string, salt: string, expectedHex: string): Promise<boolean> {
  try {
    return constantTimeEqual(await derive(password, salt), fromHex(expectedHex));
  } catch {
    return false;
  }
}

export interface RegistrationValue {
  username: string;
  password: string;
  nickname: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; fields: FieldIssue[] };

export function validateRegistration(input: RegisterInput): ValidationResult<RegistrationValue> {
  const fields: FieldIssue[] = [];
  const username = normalizeUsername(input.username);
  if (!username) {
    fields.push({ field: 'username', code: 'MISSING_USERNAME', message: '请输入注册账号' });
  } else if (!USERNAME_RE.test(username)) {
    fields.push({ field: 'username', code: 'INVALID_USERNAME', message: '账号需为 2–32 位中英文、数字、下划线、点或横线' });
  }

  const password = typeof input.password === 'string' ? input.password : '';
  if (!password) {
    fields.push({ field: 'password', code: 'MISSING_PASSWORD', message: '请输入密码' });
  } else if (password.length < 8 || password.length > 64) {
    fields.push({ field: 'password', code: 'WEAK_PASSWORD', message: '密码长度需为 8–64 位' });
  } else if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    fields.push({ field: 'password', code: 'WEAK_PASSWORD', message: '密码需同时包含字母与数字' });
  }

  const confirm = typeof input.confirmPassword === 'string' ? input.confirmPassword : '';
  if (!confirm) {
    fields.push({ field: 'confirmPassword', code: 'MISSING_CONFIRM_PASSWORD', message: '请再次输入密码' });
  } else if (confirm !== password) {
    fields.push({ field: 'confirmPassword', code: 'PASSWORD_MISMATCH', message: '两次输入的密码不一致' });
  }

  const nickname = typeof input.nickname === 'string' && input.nickname.trim()
    ? input.nickname.trim().slice(0, NICKNAME_MAX)
    : username;

  return fields.length > 0
    ? { ok: false, fields }
    : { ok: true, value: { username, password, nickname } };
}

export function validateLogin(input: LoginInput): ValidationResult<{ username: string; password: string }> {
  const username = normalizeUsername(input.username);
  const password = typeof input.password === 'string' ? input.password : '';
  if (!username || !password) {
    return {
      ok: false,
      fields: [{ field: 'credentials', code: 'MISSING_CREDENTIALS', message: '请输入账号与密码' }],
    };
  }
  return { ok: true, value: { username, password } };
}
