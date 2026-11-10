/**
 * Cloudflare Workers 的账号存储：D1（SQLite，强一致、跨实例共享）
 *
 * 表结构见 db/schema.sql。所有写操作都按主键做 INSERT OR REPLACE /
 * OR IGNORE，整组档案替换走 db.batch 保证原子性。
 * 用结构化类型而非 any 暴露 D1 的最小 API，避免引入 workers-types 依赖。
 */
import type { OwnedProfile, SessionRecord, StoredAccount } from './contract';
import type { AccountStorage } from './storage';

interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run<T = { meta?: { changes?: number } }>(): Promise<T>;
}
interface D1Like {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

interface AccountRow {
  username: string; owner_id: string; nickname: string;
  created_at: number; password_salt: string; password_hash: string;
}
interface SessionRow {
  token: string; owner_id: string; created_at: number; expires_at: number;
}
interface ProfileRow { owner_id: string; user_id: string; payload: string; }

function toAccount(row: AccountRow): StoredAccount {
  return {
    username: row.username,
    ownerId: row.owner_id,
    nickname: row.nickname,
    createdAt: row.created_at,
    passwordSalt: row.password_salt,
    passwordHash: row.password_hash,
  };
}

function toSession(row: SessionRow): SessionRecord {
  return {
    token: row.token,
    ownerId: row.owner_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** 与文件实现一致的严格校验：非法单条丢弃，但不影响其他用户 */
function parseProfiles(rows: ProfileRow[], ownerId: string): OwnedProfile[] {
  const out: OwnedProfile[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    let p: OwnedProfile;
    try { p = JSON.parse(row.payload) as OwnedProfile; } catch { continue; }
    if (!p || typeof p !== 'object') continue;
    if (p.ownerId !== ownerId || row.owner_id !== ownerId) continue;
    if (typeof p.userId !== 'string' || !p.userId || p.userId !== row.user_id) continue;
    if (typeof p.fingerprint !== 'string' || !p.form) continue;
    if (seen.has(p.userId)) continue;
    seen.add(p.userId);
    out.push(p);
  }
  return out;
}

export function createD1Storage(binding: unknown): AccountStorage {
  const db = binding as D1Like;

  const getAccount = async (username: string): Promise<StoredAccount | null> => {
    const row = await db.prepare('SELECT * FROM accounts WHERE username = ?')
      .bind(username).first<AccountRow>();
    return row ? toAccount(row) : null;
  };

  return {
    getAccount,

    async findAccountByOwner(ownerId) {
      const row = await db.prepare('SELECT * FROM accounts WHERE owner_id = ? LIMIT 1')
        .bind(ownerId).first<AccountRow>();
      return row ? toAccount(row) : null;
    },

    async putAccount(account) {
      // INSERT OR IGNORE 保证账号唯一；随后确认写入者是自己，避免并发下误判成功
      await db.prepare(
        'INSERT OR IGNORE INTO accounts (username, owner_id, nickname, created_at, password_salt, password_hash) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(
        account.username, account.ownerId, account.nickname, account.createdAt,
        account.passwordSalt, account.passwordHash,
      ).run();
      const stored = await getAccount(account.username);
      return stored?.ownerId === account.ownerId;
    },

    async getSession(token) {
      const row = await db.prepare('SELECT * FROM sessions WHERE token = ?')
        .bind(token).first<SessionRow>();
      if (!row || typeof row.owner_id !== 'string') return null;
      if (typeof row.expires_at !== 'number' || row.expires_at <= Date.now()) {
        await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
        return null;
      }
      return toSession(row);
    },

    async putSession(session) {
      await db.prepare(
        'INSERT OR REPLACE INTO sessions (token, owner_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      ).bind(session.token, session.ownerId, session.createdAt, session.expiresAt).run();
    },

    async deleteSession(token) {
      await db.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    },

    async listProfiles(ownerId) {
      const { results } = await db.prepare('SELECT owner_id, user_id, payload FROM profiles WHERE owner_id = ?')
        .bind(ownerId).all<ProfileRow>();
      return parseProfiles(results ?? [], ownerId);
    },

    async replaceProfiles(ownerId, profiles) {
      const statements: D1Statement[] = [
        db.prepare('DELETE FROM profiles WHERE owner_id = ?').bind(ownerId),
        ...profiles.map(p => db.prepare(
          'INSERT OR REPLACE INTO profiles (owner_id, user_id, payload) VALUES (?, ?, ?)',
        ).bind(ownerId, p.userId, JSON.stringify(p))),
      ];
      await db.batch(statements);
    },
  };
}
