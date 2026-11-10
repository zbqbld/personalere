/**
 * Cloudflare D1 存储后端回归测试
 *
 * 用内存 Fake D1 模拟 workerd 的 prepare/bind/first/all/run/batch，
 * 验证账号唯一约束、会话过期清理、按 ownerId 隔离的档案整组替换，
 * 以及非法 payload 被丢弃 —— 这些是 Workers 部署后数据不丢失、不串号的关键。
 */
import assert from 'node:assert/strict';
import { createD1Storage } from '../../lib/account/store.d1';
import type { OwnedProfile, SessionRecord, StoredAccount } from '../../lib/account/contract';

interface Row { [key: string]: unknown }

class FakeD1 {
  accounts = new Map<string, Row>();
  sessions = new Map<string, Row>();
  profiles = new Map<string, string>();

  prepare(sql: string) {
    let values: unknown[] = [];
    const stmt: {
      sql: string;
      values: unknown[];
      bind: (...v: unknown[]) => typeof stmt;
      first: <T>() => Promise<T | null>;
      all: <T>() => Promise<{ results: T[] }>;
      run: () => Promise<{ meta: { changes: number } }>;
    } = {
      sql,
      get values() { return values; },
      bind(...v: unknown[]) { values = v; return stmt; },
      async first<T>() { const r = await exec(sql, values); return (r[0] ?? null) as T | null; },
      async all<T>() { return { results: await exec(sql, values) as T[] }; },
      async run() { await exec(sql, values); return { meta: { changes: 1 } }; },
    };
    const self = this;
    async function exec(query: string, v: unknown[]): Promise<Row[]> {
      const q = query.trim();
      if (q.startsWith('SELECT * FROM accounts WHERE username')) {
        const row = self.accounts.get(String(v[0]));
        return row ? [row] : [];
      }
      if (q.startsWith('SELECT * FROM accounts WHERE owner_id')) {
        const row = [...self.accounts.values()].find(r => r.owner_id === v[0]);
        return row ? [row] : [];
      }
      if (q.startsWith('INSERT OR IGNORE INTO accounts')) {
        if (!self.accounts.has(String(v[0]))) {
          self.accounts.set(String(v[0]), {
            username: v[0], owner_id: v[1], nickname: v[2],
            created_at: v[3], password_salt: v[4], password_hash: v[5],
          });
        }
        return [];
      }
      if (q.startsWith('SELECT * FROM sessions WHERE token')) {
        const row = self.sessions.get(String(v[0]));
        return row ? [row] : [];
      }
      if (q.startsWith('DELETE FROM sessions WHERE token')) {
        self.sessions.delete(String(v[0]));
        return [];
      }
      if (q.startsWith('INSERT OR REPLACE INTO sessions')) {
        self.sessions.set(String(v[0]), {
          token: v[0], owner_id: v[1], created_at: v[2], expires_at: v[3],
        });
        return [];
      }
      if (q.startsWith('SELECT owner_id, user_id, payload FROM profiles')) {
        const out: Row[] = [];
        for (const [key, payload] of self.profiles) {
          const [owner, user] = key.split('|');
          if (owner === v[0]) out.push({ owner_id: owner, user_id: user, payload });
        }
        return out;
      }
      if (q.startsWith('DELETE FROM profiles WHERE owner_id')) {
        for (const key of [...self.profiles.keys()]) {
          if (key.startsWith(`${v[0]}|`)) self.profiles.delete(key);
        }
        return [];
      }
      if (q.startsWith('INSERT OR REPLACE INTO profiles')) {
        self.profiles.set(`${v[0]}|${v[1]}`, String(v[2]));
        return [];
      }
      throw new Error(`FakeD1 未实现的 SQL: ${q}`);
    }
    return stmt;
  }

  async batch(statements: Array<{ sql: string; values: unknown[] }>) {
    for (const s of statements) {
      // 复用同一套分发逻辑：构造一个已绑定的 statement 再触发 run
      const bound = this.prepare(s.sql);
      bound.bind(...s.values);
      await bound.run();
    }
    return [];
  }
}

async function main(): Promise<void> {
  const db = new FakeD1();
  const store = createD1Storage(db);
  const now = Date.now();

  const account: StoredAccount = {
    username: 'alice', ownerId: 'usr_a', nickname: '爱丽丝',
    createdAt: now, passwordSalt: 'salt-a', passwordHash: 'hash-a',
  };
  assert.equal(await store.putAccount(account), true, '首次写入账号应成功');
  assert.equal(await store.putAccount({ ...account, ownerId: 'usr_other', passwordHash: 'hash-x' }), false,
    '同名账号应被唯一约束拒绝');
  const stored = await store.getAccount('alice');
  assert.equal(stored!.ownerId, 'usr_a', '重复写入不得覆盖原账号');
  assert.equal(stored!.passwordHash, 'hash-a', '重复写入不得改动密码');
  assert.equal((await store.findAccountByOwner('usr_a'))!.username, 'alice');
  assert.equal(await store.findAccountByOwner('usr_missing'), null);

  const session: SessionRecord = { token: 'tok-a', ownerId: 'usr_a', createdAt: now, expiresAt: now + 60000 };
  await store.putSession(session);
  assert.equal((await store.getSession('tok-a'))!.ownerId, 'usr_a');
  await store.deleteSession('tok-a');
  assert.equal(await store.getSession('tok-a'), null, '登出后会话不可再解析');

  await store.putSession({ ...session, token: 'tok-expired', expiresAt: now - 1000 });
  assert.equal(await store.getSession('tok-expired'), null, '过期会话应返回 null');
  assert.equal(db.sessions.has('tok-expired'), false, '过期会话应被清理');

  const profile = (userId: string, ownerId: string): OwnedProfile => ({
    ownerId, userId, displayName: userId, label: userId,
    form: {
      name: userId, year: '1990', month: '6', day: '15', clockHour: '10', clockMinute: '30',
      unknownTime: false, province: '', city: '', longitude: 120, gender: 'male',
    },
    fingerprint: `fp-${userId}`, createdAt: now, updatedAt: now, revision: 1,
  });

  await store.replaceProfiles('usr_a', [profile('p1', 'usr_a'), profile('p2', 'usr_a')]);
  await store.replaceProfiles('usr_b', [profile('p3', 'usr_b')]);
  assert.equal((await store.listProfiles('usr_a')).length, 2);
  assert.equal((await store.listProfiles('usr_b')).length, 1, '不同账号档案必须隔离');
  assert.equal((await store.listProfiles('usr_b'))[0].userId, 'p3');

  // 整组替换：旧档案被清除，不会残留
  await store.replaceProfiles('usr_a', [profile('p9', 'usr_a')]);
  const afterReplace = await store.listProfiles('usr_a');
  assert.deepEqual(afterReplace.map(p => p.userId), ['p9'], 'replaceProfiles 应整组替换');
  assert.equal((await store.listProfiles('usr_b')).length, 1, '替换 A 不得影响 B');

  // 非法 payload 被丢弃，合法档案仍在
  db.profiles.set('usr_a|bad', '{not-json');
  const withBad = await store.listProfiles('usr_a');
  assert.deepEqual(withBad.map(p => p.userId), ['p9'], '损坏单条应被跳过');

  // 归属不符的记录不得被读取
  db.profiles.set('usr_a|foreign', JSON.stringify(profile('x', 'usr_other')));
  assert.deepEqual((await store.listProfiles('usr_a')).map(p => p.userId), ['p9'], '跨账号记录应被过滤');
}

main().then(() => {
  console.log('d1-storage.test.ts: PASS (账号唯一约束 / 会话过期清理 / 档案整组替换 / 归属隔离 / 损坏数据过滤)');
}).catch(e => {
  console.error(e);
  process.exit(1);
});
