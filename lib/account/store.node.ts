/**
 * 本地 / Node 部署的账号存储：沿用原来的 data/*.json 文件布局。
 * 仅在本机或传统 Node 服务器上使用；Cloudflare Workers 会走 store.d1.ts。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { OwnedProfile, SessionRecord, StoredAccount } from './contract';
import type { AccountStorage } from './storage';

function dataDir(): string {
  return process.env.ZIWEI_DATA_DIR || path.join(process.cwd(), 'data');
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fallback;
    return parsed as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  writeFileSync(file, JSON.stringify(value), 'utf8');
}

function accountsFile(): string { return path.join(dataDir(), 'accounts.json'); }
function sessionsFile(): string { return path.join(dataDir(), 'sessions.json'); }

function safeOwnerId(ownerId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(ownerId)) throw new Error('invalid ownerId');
  return ownerId;
}

function profileFile(ownerId: string): string {
  return path.join(dataDir(), 'profiles', `${safeOwnerId(ownerId)}.json`);
}

type AccountMap = Record<string, StoredAccount>;
type SessionMap = Record<string, SessionRecord>;

export function createNodeStorage(): AccountStorage {
  const accounts = (): AccountMap => readJson<AccountMap>(accountsFile(), {});
  const sessions = (): SessionMap => readJson<SessionMap>(sessionsFile(), {});

  return {
    async getAccount(username) {
      return accounts()[username] ?? null;
    },

    async findAccountByOwner(ownerId) {
      return Object.values(accounts()).find(a => a.ownerId === ownerId) ?? null;
    },

    async putAccount(account) {
      const all = accounts();
      if (all[account.username]) return false;
      all[account.username] = account;
      writeJson(accountsFile(), all);
      return true;
    },

    async getSession(token) {
      const all = sessions();
      const session = all[token];
      if (!session || typeof session.ownerId !== 'string') return null;
      if (typeof session.expiresAt !== 'number' || session.expiresAt <= Date.now()) {
        delete all[token];
        writeJson(sessionsFile(), all);
        return null;
      }
      return session;
    },

    async putSession(session) {
      const all = sessions();
      all[session.token] = session;
      writeJson(sessionsFile(), all);
    },

    async deleteSession(token) {
      const all = sessions();
      if (all[token]) {
        delete all[token];
        writeJson(sessionsFile(), all);
      }
    },

    async listProfiles(ownerId) {
      const raw = readJson<{ profiles?: unknown }>(profileFile(ownerId), {});
      if (!Array.isArray(raw.profiles)) return [];
      const out: OwnedProfile[] = [];
      const seen = new Set<string>();
      for (const item of raw.profiles) {
        if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
        const p = item as Partial<OwnedProfile>;
        if (p.ownerId !== ownerId) continue;
        if (typeof p.userId !== 'string' || !p.userId) continue;
        if (typeof p.form !== 'object' || p.form === null) continue;
        if (typeof p.fingerprint !== 'string') continue;
        if (seen.has(p.userId)) continue;
        seen.add(p.userId);
        out.push(p as OwnedProfile);
      }
      return out;
    },

    async replaceProfiles(ownerId, profiles) {
      writeJson(profileFile(ownerId), { version: 1, ownerId, profiles });
    },
  };
}
