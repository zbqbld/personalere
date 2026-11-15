/**
 * 邮箱验证码存取回归测试
 *
 * 覆盖：60 秒重发限速、验证成功即删除（防重放）、验证码错误累计次数、
 * 过期作废、超过 5 次错误后作废需重发。
 */
import assert from 'node:assert/strict';
import { createEmailCodeStore } from '../../lib/account/email-codes';
import type { D1Statement } from '../../lib/billing/core';

type Row = Record<string, unknown>;

class FakeD1 {
  rows = new Map<string, { code: string; attempts: number; expires_at: number; created_at: number }>();
  prepare(sql: string) {
    let values: unknown[] = [];
    const self = this;
    async function exec(v: unknown[]): Promise<Row[]> {
      const q = sql.trim();
      const email = String(v[0]);
      if (q.startsWith('SELECT created_at FROM email_codes')) {
        const r = self.rows.get(email);
        return r ? [{ created_at: r.created_at }] : [];
      }
      if (q.startsWith('SELECT code, attempts, expires_at')) {
        const r = self.rows.get(email);
        return r ? [{ ...r }] : [];
      }
      if (q.startsWith('INSERT INTO email_codes')) {
        self.rows.set(email, {
          code: String(v[1]), attempts: 0,
          expires_at: Number(v[2]), created_at: Number(v[3]),
        });
        return [{ ok: 1 }];
      }
      if (q.startsWith('DELETE FROM email_codes')) {
        self.rows.delete(email);
        return [{ ok: 1 }];
      }
      if (q.startsWith('UPDATE email_codes SET attempts')) {
        const r = self.rows.get(email);
        if (r) r.attempts += 1;
        return [{ ok: 1 }];
      }
      throw new Error('FakeD1 未实现的 SQL: ' + q.slice(0, 50));
    }
    const stmt = {
      sql,
      bind: (...v: unknown[]) => { values = v; return stmt; },
      first: async <T>() => ((await exec(values))[0] ?? null) as T | null,
      all: async <T>() => ({ results: (await exec(values)) as T[] }),
      run: async () => ({ meta: { changes: (await exec(values)).length } }),
    };
    return stmt as D1Statement;
  }
  batch() { return Promise.resolve([]); }
}

const T0 = new Date('2026-11-15T04:00:00Z').getTime();

(async () => {
  const db = new FakeD1();
  const store = createEmailCodeStore(db as never);

  // 1) 发码 → 60 秒内重发被限速 → 61 秒后可重发
  assert.ok(await store.saveCode('a@b.com', '123456', T0), '首次发码应成功');
  assert.equal(await store.saveCode('a@b.com', '234567', T0 + 30 * 1000), false, '60 秒内重发应被拒绝');
  assert.ok(await store.saveCode('a@b.com', '234567', T0 + 61 * 1000), '61 秒后应可重发（覆盖旧码）');

  // 2) 旧码在新码写入后失效
  assert.equal(await store.verifyCode('a@b.com', '123456', T0 + 62 * 1000), 'MISMATCH', '旧验证码应不匹配');
  assert.equal(await store.verifyCode('a@b.com', '234567', T0 + 62 * 1000), 'ok', '新验证码应通过');
  assert.equal(await store.verifyCode('a@b.com', '234567', T0 + 63 * 1000), 'NOT_FOUND', '成功后验证码应删除（防重放）');

  // 3) 过期
  await store.saveCode('c@d.com', '111111', T0);
  assert.equal(await store.verifyCode('c@d.com', '111111', T0 + 11 * 60 * 1000), 'EXPIRED', '超过 10 分钟应过期');

  // 4) 错误 5 次后作废
  await store.saveCode('e@f.com', '222222', T0);
  for (let i = 0; i < 5; i++) {
    assert.equal(await store.verifyCode('e@f.com', '000000', T0 + 1000), 'MISMATCH', `第 ${i + 1} 次错误应 MISMATCH`);
  }
  assert.equal(await store.verifyCode('e@f.com', '222222', T0 + 2000), 'TOO_MANY_ATTEMPTS', '错误 5 次后即使码对也应作废');

  // 5) 发信失败回滚：clearCode 后同一时刻可立刻重新发码，不会被 60 秒锁住
  await store.saveCode('g@h.com', '333333', T0);
  assert.equal(await store.saveCode('g@h.com', '444444', T0 + 1000), false, '回滚前重发应被限速');
  await store.clearCode('g@h.com');
  assert.ok(await store.saveCode('g@h.com', '555555', T0 + 1000), '回滚后应能立刻重发');
  assert.equal(await store.verifyCode('g@h.com', '555555', T0 + 2000), 'ok', '重发的新码应可用');

  console.log('email-codes.test.ts: PASS (重发限速 / 防重放 / 过期 / 错误次数上限 / 发信失败回滚)');
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
