/**
 * 计费核心逻辑（卡密次数制）
 *
 * 设计要点：
 *  1. 纯逻辑 + 注入式 D1 最小接口，可在 Node 回归测试里用 Fake D1 驱动；
 *  2. 主体统一为 subject：'u:<ownerId>'（登录）或 'a:<ipHash>'（匿名），
 *     钱包与每日免费计数共用同一套表；
 *  3. 消耗顺序：当天免费额度 → 卡密次数，两者都无则拒绝（402）；
 *  4. 卡密兑换走 batch 原子写：先占卡（status unused→used）再给钱包加次数；
 *  5. 所有 SQL 都用参数绑定，不接受拼接输入。
 */

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run<T = { meta?: { changes?: number } }>(): Promise<T>;
}
export interface D1Like {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

export interface BillingOptions {
  /** 每个主体每天可免费使用的解读次数；0 = 无免费额度 */
  freeDaily: number;
  /** 注入当前时间（毫秒），测试用；默认 Date.now() */
  now?: number;
}

export interface BillingIdentity {
  /** 登录账号的 ownerId；未登录为 null */
  ownerId: string | null;
  /** 匿名主体标识（如 ip 哈希）；登录时忽略 */
  anonId: string | null;
}

export interface BillingStatus {
  freeLimit: number;
  freeUsed: number;
  freeLeft: number;
  credits: number;
  canUse: boolean;
}

export type RedeemResult =
  | { ok: true; credits: number; added: number }
  | { ok: false; code: 'INVALID_CODE' | 'STORAGE_ERROR'; message: string };

export type ConsumeResult =
  | { ok: true; source: 'free' | 'credit'; freeLeft: number; credits: number }
  | { ok: false; code: 'QUOTA_EXCEEDED'; status: BillingStatus };

/** 自然日（UTC+8）：用户在国内，按北京时间计免费额度 */
export function dayKeyOf(now: number): string {
  const d = new Date(now + 8 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function subjectOf(identity: BillingIdentity): string | null {
  if (identity.ownerId) return `u:${identity.ownerId}`;
  if (identity.anonId) return `a:${identity.anonId}`;
  return null;
}

export function createBilling(db: D1Like, options: BillingOptions) {
  const freeDaily = Math.max(0, Math.floor(options.freeDaily));
  const now = () => (typeof options.now === 'number' ? options.now : Date.now());

  const readStatus = async (subject: string): Promise<BillingStatus> => {
    const n = now();
    const day = dayKeyOf(n);
    const usageRow = await db
      .prepare('SELECT count FROM billing_usage WHERE subject = ? AND day = ?')
      .bind(subject, day)
      .first<{ count: number }>();
    const freeUsed = usageRow && Number.isFinite(usageRow.count) ? usageRow.count : 0;
    const walletRow = await db
      .prepare('SELECT credits FROM billing_wallets WHERE subject = ?')
      .bind(subject)
      .first<{ credits: number }>();
    const credits = walletRow && Number.isFinite(walletRow.credits) ? walletRow.credits : 0;
    const freeLeft = Math.max(0, freeDaily - freeUsed);
    return { freeLimit: freeDaily, freeUsed, freeLeft, credits, canUse: freeLeft > 0 || credits > 0 };
  };

  return {
    /** 查询某主体的剩余状态 */
    async status(identity: BillingIdentity): Promise<BillingStatus | null> {
      const subject = subjectOf(identity);
      if (!subject) return null;
      return readStatus(subject);
    },

    /** 消耗一次：先用免费额度，用完扣卡密次数；都没有则返回 QUOTA_EXCEEDED */
    async consume(identity: BillingIdentity): Promise<ConsumeResult> {
      const subject = subjectOf(identity);
      if (!subject) return { ok: false, code: 'QUOTA_EXCEEDED', status: { freeLimit: freeDaily, freeUsed: 0, freeLeft: 0, credits: 0, canUse: false } };
      const n = now();
      const day = dayKeyOf(n);

      if (freeDaily > 0) {
        // 条件递增：count < freeDaily 才写入，超限时不产生变更（changes=0）
        const r = await db
          .prepare(
            `INSERT INTO billing_usage (subject, day, count, updated_at)
             VALUES (?, ?, 1, ?)
             ON CONFLICT(subject, day) DO UPDATE SET count = count + 1, updated_at = ?
             WHERE count < ?`,
          )
          .bind(subject, day, n, n, freeDaily)
          .run<{ meta?: { changes?: number } }>();
        const changes = r?.meta?.changes ?? 0;
        if (changes > 0) {
          const status = await readStatus(subject);
          return { ok: true, source: 'free', freeLeft: status.freeLeft, credits: status.credits };
        }
      }

      // 免费额度用完：扣卡密次数（credits > 0 才会变更）
      const r2 = await db
        .prepare('UPDATE billing_wallets SET credits = credits - 1, updated_at = ? WHERE subject = ? AND credits > 0')
        .bind(n, subject)
        .run<{ meta?: { changes?: number } }>();
      if ((r2?.meta?.changes ?? 0) > 0) {
        const status = await readStatus(subject);
        return { ok: true, source: 'credit', freeLeft: status.freeLeft, credits: status.credits };
      }

      return { ok: false, code: 'QUOTA_EXCEEDED', status: await readStatus(subject) };
    },

    /**
     * 兑换卡密：原子占卡 + 钱包加次数。卡不存在 / 已被使用返回 INVALID_CODE。
     * 只有登录主体能兑换（匿名无法归属资产）。
     */
    async redeem(code: string, ownerId: string): Promise<RedeemResult> {
      const clean = String(code || '').trim().toUpperCase();
      if (!/^[A-Z0-9-]{8,40}$/.test(clean)) {
        return { ok: false, code: 'INVALID_CODE', message: '卡密格式不正确' };
      }
      const subject = `u:${ownerId}`;
      const n = now();

      // 原子占卡：只有 status='unused' 时会更新，changes=0 即卡无效或已被用
      const claim = await db
        .prepare("UPDATE billing_cards SET status = 'used', used_by = ?, used_at = ? WHERE code = ? AND status = 'unused'")
        .bind(subject, n, clean)
        .run<{ meta?: { changes?: number } }>();
      if ((claim?.meta?.changes ?? 0) === 0) {
        return { ok: false, code: 'INVALID_CODE', message: '卡密不存在或已被使用' };
      }

      const cardRow = await db
        .prepare('SELECT credits FROM billing_cards WHERE code = ?')
        .bind(clean)
        .first<{ credits: number }>();
      const added = cardRow && Number.isFinite(cardRow.credits) ? Math.max(0, Math.floor(cardRow.credits)) : 0;

      try {
        await db
          .prepare(
            `INSERT INTO billing_wallets (subject, credits, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(subject) DO UPDATE SET credits = credits + ?, updated_at = ?`,
          )
          .bind(subject, added, n, added, n)
          .run();
      } catch (err) {
        // 钱包写入失败：回滚占卡，避免用户凭空损失一张卡
        await db
          .prepare("UPDATE billing_cards SET status = 'unused', used_by = NULL, used_at = NULL WHERE code = ?")
          .bind(clean)
          .run();
        return { ok: false, code: 'STORAGE_ERROR', message: '写入失败，请稍后重试' };
      }

      const status = await readStatus(subject);
      return { ok: true, credits: status.credits, added };
    },
  };
}
