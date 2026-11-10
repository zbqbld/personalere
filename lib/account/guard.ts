/**
 * 统一访问门禁 —— 所有涉及用户信息的操作入口的唯一入口
 *
 * 设计要点：
 *  1. ownerId 只能由「服务端会话」推导，客户端传入的 ownerId 只用于检测越权；
 *  2. 未登录、token 无效 / 过期、伪造 ownerId、访问他人档案，全部返回同一个
 *     deny() 结果，不泄露资源是否存在，也不给任何差异化的提示；
 *  3. requireOwnedProfile 把「档案不存在」与「档案属于他人」收敛为同一拒绝，
 *     避免通过 404 / 403 的区别枚举其他账号的 userId。
 *
 * 会话读取走抽象存储后端，因此本地文件与 Cloudflare D1 使用同一套门禁。
 */

import { deny, type Failure } from './contract';
import { getStorage } from './storage';

export type GuardResult = { ok: true; ownerId: string } | Failure;

export async function requireOwner(
  token: string | undefined | null,
  claimedOwnerId?: unknown,
  now: number = Date.now(),
): Promise<GuardResult> {
  const session = token ? await (await getStorage()).getSession(token) : null;
  if (!session || typeof session.expiresAt !== 'number' || session.expiresAt <= now) return deny();
  if (
    claimedOwnerId !== undefined &&
    claimedOwnerId !== null &&
    claimedOwnerId !== '' &&
    claimedOwnerId !== session.ownerId
  ) {
    return deny();
  }
  return { ok: true, ownerId: session.ownerId };
}

export type OwnedResult<T> = { ok: true; profile: T } | Failure;

export function requireOwnedProfile<T extends { ownerId: string }>(
  ownerId: string,
  profile: T | null | undefined,
): OwnedResult<T> {
  if (!profile || profile.ownerId !== ownerId) return deny();
  return { ok: true, profile };
}
