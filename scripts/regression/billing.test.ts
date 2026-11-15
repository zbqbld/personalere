/**
 * 计费核心逻辑回归测试（卡密次数制）
 *
 * 覆盖：每日免费额度递增与上限、卡密兑换（单次有效 / 未知卡密 / 重复兑换）、
 * 额度用尽后扣卡密次数、拒绝路径（QUOTA_EXCEEDED）、匿名与登录主体隔离、
 * 跨自然日额度重置、钱包写入失败回滚占卡。
 */
import assert from 'node:assert/strict';
import { createBilling, type D1Statement } from '../../lib/billing/core';

interface CardRow { credits: number; status: string; batch?: string }
type Row = Record<string, unknown>;

class FakeD1 {
  usage = new Map<string, number>();   // `${subject}|${day}` -> count
  wallets = new Map<string, number>(); // subject -> credits
  cards = new Map<string, CardRow>();  // code -> row
  failWalletInsert = false;

  prepare(sql: string) {
    let values: unknown[] = [];
    const self = this;
    async function exec(v: unknown[]): Promise<Row[]> {
      const q = sql.trim();
      if (q.startsWith('SELECT count FROM billing_usage')) {
        const c = self.usage.get(`${v[0]}|${v[1]}`);
        return c === undefined ? [] : [{ count: c }];
      }
      if (q.startsWith('SELECT credits FROM billing_wallets')) {
        const c = self.wallets.get(String(v[0]));
        return c === undefined ? [] : [{ credits: c }];
      }
      if (q.startsWith('INSERT INTO billing_usage')) {
        const k = `${v[0]}|${v[1]}`;
        const cur = self.usage.get(k) ?? 0;
        const limit = Number(v[4]);
        if (cur >= limit) return []; // WHERE count < ? 不满足 → changes 0
        self.usage.set(k, cur + 1);
        return [{ ok: 1 }]; // 产生 1 行变更，让 run().meta.changes = 1
      }
      if (q.startsWith('UPDATE billing_wallets SET credits = credits - 1')) {
        const s = String(v[1]);
        const cur = self.wallets.get(s) ?? 0;
        if (cur <= 0) return [];
        self.wallets.set(s, cur - 1);
        return [{ credits: cur - 1 }];
      }
      if (q.startsWith("UPDATE billing_cards SET status = 'used'")) {
        const code = String(v[2]);
        const card = self.cards.get(code);
        if (!card || card.status !== 'unused') return [];
        card.status = 'used';
        return [{ code }];
      }
      if (q.startsWith('SELECT credits FROM billing_cards')) {
        const card = self.cards.get(String(v[0]));
        return card ? [{ credits: card.credits }] : [];
      }
      if (q.startsWith('INSERT INTO billing_wallets (subject, credits, updated_at)')) {
        if (self.failWalletInsert) throw new Error('simulated wallet failure');
        const s = String(v[0]);
        self.wallets.set(s, (self.wallets.get(s) ?? 0) + Number(v[1]));
        return [{ ok: 1 }];
      }
      if (q.startsWith("UPDATE billing_cards SET status = 'unused'")) {
        const card = self.cards.get(String(v[0]));
        if (card) card.status = 'unused';
        return [{ ok: 1 }];
      }
      throw new Error('FakeD1 未实现的 SQL: ' + q.slice(0, 60));
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

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date('2026-11-15T04:00:00Z').getTime(); // 北京时间 12:00

function newBilling(db: FakeD1, freeDaily = 3, now = T0) {
  return createBilling(db as never, { freeDaily, now });
}

(async () => {
  const db = new FakeD1();
  const user = { ownerId: 'u1', anonId: null };
  const anon = { ownerId: null, anonId: 'iphash1' };
  const b = newBilling(db);

  // 1) 免费额度：3 次内免费，第 4 次且无卡密 → 拒绝
  for (let i = 0; i < 3; i++) {
    const r = await b.consume(user);
    assert.ok(r.ok && r.source === 'free', `第 ${i + 1} 次应走免费额度`);
  }
  const denied = await b.consume(user);
  assert.ok(!denied.ok && denied.code === 'QUOTA_EXCEEDED', '免费用尽且无卡密应拒绝');
  assert.equal(denied.status.freeUsed, 3);

  // 2) 卡密兑换：占卡 + 加次数
  db.cards.set('ZW-AAAA-BBBB-CCCC', { credits: 50, status: 'unused' });
  const redeemed = await b.redeem('zw-aaaa-bbbb-cccc', 'u1'); // 小写也应归一化
  assert.ok(redeemed.ok && redeemed.added === 50 && redeemed.credits === 50, '兑换应入账 50 次');
  assert.equal(db.cards.get('ZW-AAAA-BBBB-CCCC')?.status, 'used');

  // 3) 重复兑换 / 未知卡密
  const again = await b.redeem('ZW-AAAA-BBBB-CCCC', 'u1');
  assert.ok(!again.ok && again.code === 'INVALID_CODE', '同一张卡不能兑两次');
  const ghost = await b.redeem('ZW-9999-9999-9999', 'u1');
  assert.ok(!ghost.ok && ghost.code === 'INVALID_CODE', '不存在的卡密应拒绝');

  // 4) 免费用尽后扣卡密次数
  const paid = await b.consume(user);
  assert.ok(paid.ok && paid.source === 'credit' && paid.credits === 49, '应扣卡密次数到 49');

  // 5) 主体隔离：匿名与登录互不影响
  const anonFree = await b.consume(anon);
  assert.ok(anonFree.ok && anonFree.source === 'free', '匿名主体应有独立免费额度');

  // 6) 跨自然日：免费额度重置
  const bNext = newBilling(db, 3, T0 + DAY);
  const nextDay = await bNext.consume(user);
  assert.ok(nextDay.ok && nextDay.source === 'free', '次日免费额度应重置');

  // 7) freeDaily=0：完全无免费额度，直接走卡密
  const db2 = new FakeD1();
  db2.cards.set('ZW-DDDD-EEEE-FFFF', { credits: 10, status: 'unused' });
  const b2 = newBilling(db2, 0);
  const r2 = await b2.consume(user);
  assert.ok(!r2.ok && r2.code === 'QUOTA_EXCEEDED', '无免费额度且无卡密应拒绝');
  await b2.redeem('ZW-DDDD-EEEE-FFFF', 'u1');
  const r3 = await b2.consume(user);
  assert.ok(r3.ok && r3.source === 'credit', '零免费额度下应直接扣卡密');

  // 8) 钱包写入失败：回滚占卡
  const db3 = new FakeD1();
  db3.cards.set('ZW-GGGG-HHHH-IIII', { credits: 20, status: 'unused' });
  db3.failWalletInsert = true;
  const b3 = newBilling(db3);
  const fail = await b3.redeem('ZW-GGGG-HHHH-IIII', 'u1');
  assert.ok(!fail.ok && fail.code === 'STORAGE_ERROR', '钱包写入失败应报错');
  assert.equal(db3.cards.get('ZW-GGGG-HHHH-IIII')?.status, 'unused', '占卡应回滚');

  console.log('billing.test.ts: PASS (免费额度 / 卡密兑换单次有效 / 扣减顺序 / 主体隔离 / 跨日重置 / 失败回滚)');
})().catch((e) => { console.error('FAIL:', e); process.exit(1); });
