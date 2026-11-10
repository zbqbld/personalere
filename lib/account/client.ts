'use client';

/**
 * 前端账号 API 封装
 *
 * 会话令牌完全由 HttpOnly Cookie 承载，前端不读取、不保存令牌；
 * 「当前账号」只能由服务端 /api/account 返回，前端据此切换本地数据命名空间。
 * 所有失败结果统一为 { ok:false, code, message, fields? }，其中越权与未登录
 * 都会收到同一个 ACCESS_DENIED，前端不据此区分资源是否存在。
 */
import { setAccountScope } from './scope';
import type { BirthDraft } from '../ziwei/memory';

export interface AccountInfo {
  ownerId: string;
  username: string;
  nickname: string;
  createdAt: number;
}

export interface ApiFieldIssue { field: string; code: string; message: string }

export interface ApiFailure {
  ok: false;
  code: string;
  message: string;
  fields?: ApiFieldIssue[];
}

export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

async function call<T>(url: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, {
      ...init,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    const body: unknown = await res.json().catch(() => ({}));
    const parsed = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    if (!res.ok || parsed.ok === false) {
      return {
        ok: false,
        code: typeof parsed.code === 'string' ? parsed.code : 'REQUEST_FAILED',
        message: typeof parsed.message === 'string' ? parsed.message : '请求失败，请稍后重试',
        fields: Array.isArray(parsed.fields) ? parsed.fields as ApiFieldIssue[] : undefined,
      };
    }
    return { ok: true, data: (parsed.data ?? null) as T };
  } catch {
    return { ok: false, code: 'NETWORK_ERROR', message: '网络异常，请稍后重试' };
  }
}

/** 切换本地数据命名空间：登录后隔离，登出后回到匿名空间（键名与旧版一致） */
export function applyAccountScope(ownerId: string | null): void {
  setAccountScope(ownerId);
}

export async function loadAccount(): Promise<AccountInfo | null> {
  const r = await call<AccountInfo>('/api/account', { method: 'GET' });
  if (!r.ok) return null;
  applyAccountScope(r.data.ownerId);
  return r.data;
}

export interface RegisterPayload {
  username: string;
  password: string;
  confirmPassword: string;
  nickname?: string;
}

export interface ProfilePayload {
  userId?: string;
  form: BirthDraft;
}

export async function registerAccount(
  input: RegisterPayload,
  bind: ProfilePayload[] = [],
): Promise<ApiResult<{ account: AccountInfo; bound: number }>> {
  return call<{ account: AccountInfo; bound: number }>('/api/account', {
    method: 'POST',
    body: JSON.stringify({ action: 'register', ...input, bind }),
  });
}

export async function loginAccount(
  input: { username: string; password: string },
): Promise<ApiResult<{ account: AccountInfo }>> {
  return call<{ account: AccountInfo }>('/api/account', {
    method: 'POST',
    body: JSON.stringify({ action: 'login', ...input }),
  });
}

export async function logoutAccount(): Promise<ApiResult<{ loggedOut: boolean }>> {
  return call<{ loggedOut: boolean }>('/api/account', {
    method: 'POST',
    body: JSON.stringify({ action: 'logout' }),
  });
}

export async function listAccountProfiles(): Promise<ApiResult<unknown[]>> {
  return call<unknown[]>('/api/profiles', { method: 'GET' });
}

export async function saveAccountProfiles(inputs: ProfilePayload[]): Promise<ApiResult<unknown>> {
  return call<unknown>('/api/profiles', {
    method: 'POST',
    body: JSON.stringify({ action: 'save', inputs }),
  });
}

export async function updateAccountProfile(
  userId: string,
  patch: Partial<BirthDraft>,
): Promise<ApiResult<unknown>> {
  return call<unknown>('/api/profiles', {
    method: 'PATCH',
    body: JSON.stringify({ userId, patch }),
  });
}

export async function deleteAccountProfile(userId: string): Promise<ApiResult<unknown>> {
  return call<unknown>('/api/profiles', {
    method: 'DELETE',
    body: JSON.stringify({ userId }),
  });
}

export async function clearAccountProfiles(): Promise<ApiResult<unknown>> {
  return call<unknown>('/api/profiles', {
    method: 'DELETE',
    body: JSON.stringify({}),
  });
}
