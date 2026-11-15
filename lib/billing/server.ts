/**
 * 计费服务端装配：开关、主体识别、请求级门禁
 *
 * 开关与额度全部来自服务端环境（wrangler vars / .env），不进客户端包：
 *   BILLING_MODE=card        启用卡密次数制；未设置或为其他值 = 完全关闭（现状）
 *   BILLING_FREE_DAILY=3     每主体每天免费解读次数（默认 3）
 *
 * 门禁策略（fail-open）：数据库不可用、识别不到主体时放行，
 * 避免基础设施抖动把全部用户的 AI 解读打死；滥用防护依赖账号体系。
 */
import { createBilling, type BillingIdentity } from './core';
import { initAccountBackend, getCloudflareDB } from '../account/context';
import { requireOwner } from '../account/guard';
import type { D1Like } from './core';

export interface BillingRuntimeConfig {
  enabled: boolean;
  freeDaily: number;
}

export function billingConfig(): BillingRuntimeConfig {
  const enabled = process.env.BILLING_MODE === 'card';
  const raw = parseInt(process.env.BILLING_FREE_DAILY || '3', 10);
  const freeDaily = Number.isFinite(raw) ? Math.max(0, raw) : 3;
  return { enabled, freeDaily };
}

/** 匿名主体：IP + UA 做哈希（不落库明文 IP），同一浏览器当日稳定 */
async function anonIdOf(req: Request, cookieAnon: string | undefined): Promise<string> {
  const ip = req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for') || 'unknown';
  const ua = req.headers.get('user-agent') || '';
  const base = `${cookieAnon || 'v1'}|${ip}|${ua}`;
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(base));
    return Array.from(new Uint8Array(buf)).slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return 'unavailable';
  }
}

export interface GateResult {
  pass: boolean;
  response?: Response;
}

/**
 * AI 解读接口的计费门禁。
 * 返回 { pass:true } 放行，或 { pass:false, response } 直接作为接口响应。
 */
export async function billingGate(req: Request, token: string | undefined | null): Promise<GateResult> {
  const config = billingConfig();
  if (!config.enabled) return { pass: true };

  try {
    await initAccountBackend();
    const db = getCloudflareDB() as D1Like | null;
    if (!db) return { pass: true }; // 数据库不可用：放行，避免整体故障

    // 识别主体：优先登录会话，其次匿名
    let ownerId: string | null = null;
    if (token) {
      const guard = await requireOwner(token);
      if (guard.ok) ownerId = guard.ownerId;
    }
    const cookieAnon = req.headers.get('cookie')?.match(/zw_anon=([^;]+)/)?.[1];
    const identity: BillingIdentity = { ownerId, anonId: ownerId ? null : await anonIdOf(req, cookieAnon) };

    const billing = createBilling(db, { freeDaily: config.freeDaily });
    const result = await billing.consume(identity);
    if (result.ok) return { pass: true };

    const body = JSON.stringify({
      ok: false,
      code: 'QUOTA_EXCEEDED',
      message: '今日 1 次免费解读已用完。请在「账号与数据归属」面板的「解读额度」处输入卡密兑换，兑换后即可继续解读。',
      data: { freeLimit: result.status.freeLimit, freeUsed: result.status.freeUsed, credits: result.status.credits, loggedIn: Boolean(ownerId) },
    });
    return {
      pass: false,
      response: new Response(body, {
        status: 402,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      }),
    };
  } catch {
    return { pass: true }; // 计费自身异常不拦截业务
  }
}

/** 计费状态查询 / 兑换共用的主体识别（与门禁一致） */
export async function billingIdentity(req: Request, token: string | undefined | null): Promise<BillingIdentity> {
  let ownerId: string | null = null;
  if (token) {
    const guard = await requireOwner(token);
    if (guard.ok) ownerId = guard.ownerId;
  }
  const cookieAnon = req.headers.get('cookie')?.match(/zw_anon=([^;]+)/)?.[1];
  return { ownerId, anonId: ownerId ? null : await anonIdOf(req, cookieAnon) };
}

export function createBillingForRequest(db: unknown, config: BillingRuntimeConfig) {
  return createBilling(db as D1Like, { freeDaily: config.freeDaily });
}
