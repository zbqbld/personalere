/**
 * 邮箱验证码存取（D1）
 *
 * 规则：
 *  - 每个邮箱同时只有一条有效验证码（表以 email 为主键，重发即覆盖）；
 *  - 重发限速：60 秒内只能发一次，1 小时内最多 5 次（按 created_at 统计历史行不行——
 *    覆盖式存储拿不到历史，因此限速退化两层：60 秒覆盖限制 + 验证失败 5 次作废；
 *    更强的限速由 Brevo 免费档 300 封/天 的硬上限兜底）；
 *  - 有效期 10 分钟；验证失败累计 attempts，≥5 次作废，需重新发送；
 *  - 验证成功即删除，防止重放。
 */
import type { D1Like } from '../billing/core';

export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
export const EMAIL_CODE_RESEND_INTERVAL_MS = 60 * 1000;

export interface EmailCodeStore {
  /** 写入/覆盖验证码；返回 false 表示 60 秒内已发过，需稍后再试 */
  saveCode(email: string, code: string, now: number): Promise<boolean>;
  /** 校验验证码：返回 'ok' | 'EXPIRED' | 'MISMATCH' | 'TOO_MANY_ATTEMPTS' | 'NOT_FOUND' */
  verifyCode(email: string, code: string, now: number): Promise<'ok' | 'EXPIRED' | 'MISMATCH' | 'TOO_MANY_ATTEMPTS' | 'NOT_FOUND'>;
}

interface CodeRow { code: string; attempts: number; expires_at: number; created_at: number }

export function createEmailCodeStore(db: D1Like): EmailCodeStore {
  return {
    async saveCode(email, code, now) {
      const row = await db
        .prepare('SELECT created_at FROM email_codes WHERE email = ?')
        .bind(email)
        .first<{ created_at: number }>();
      if (row && typeof row.created_at === 'number' && now - row.created_at < EMAIL_CODE_RESEND_INTERVAL_MS) {
        return false;
      }
      await db
        .prepare(
          `INSERT INTO email_codes (email, code, purpose, attempts, expires_at, created_at)
           VALUES (?, ?, 'register', 0, ?, ?)
           ON CONFLICT(email) DO UPDATE SET code = excluded.code, purpose = 'register',
             attempts = 0, expires_at = excluded.expires_at, created_at = excluded.created_at`,
        )
        .bind(email, code, now + EMAIL_CODE_TTL_MS, now)
        .run();
      return true;
    },

    async verifyCode(email, code, now) {
      const row = await db
        .prepare('SELECT code, attempts, expires_at FROM email_codes WHERE email = ?')
        .bind(email)
        .first<CodeRow>();
      if (!row) return 'NOT_FOUND';
      if (row.expires_at <= now) {
        await db.prepare('DELETE FROM email_codes WHERE email = ?').bind(email).run();
        return 'EXPIRED';
      }
      if (row.attempts >= EMAIL_CODE_MAX_ATTEMPTS) {
        await db.prepare('DELETE FROM email_codes WHERE email = ?').bind(email).run();
        return 'TOO_MANY_ATTEMPTS';
      }
      if (String(code).trim() !== row.code) {
        await db
          .prepare('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ?')
          .bind(email)
          .run();
        return 'MISMATCH';
      }
      await db.prepare('DELETE FROM email_codes WHERE email = ?').bind(email).run();
      return 'ok';
    },
  };
}
