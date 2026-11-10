/**
 * 账号存储门面
 *
 * 业务层只通过 getStorage() 拿到后端（本地文件 / Cloudflare D1），不再直接
 * 依赖 node:fs，因此同一份代码既能在 next dev / Node 服务器运行，也能在
 * Cloudflare Workers（workerd）运行。具体实现见 store.node.ts / store.d1.ts。
 */
import { SESSION_TTL_MS, type SessionRecord } from './contract';

export { getStorage, setD1Binding, resetStorage } from './storage';
export type { AccountStorage } from './storage';

/** Web Crypto 随机数：Node 18+ 与 Workers 均可用，不依赖 node:crypto */
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
}

export function newOwnerId(): string {
  return `usr_${randomHex(12)}`;
}

export function newSession(ownerId: string, now: number = Date.now()): SessionRecord {
  return {
    token: randomHex(32),
    ownerId,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  };
}
