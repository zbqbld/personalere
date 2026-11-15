import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIE } from '@/lib/account/contract';
import { initAccountBackend, getCloudflareDB } from '@/lib/account/context';
import { billingConfig, billingIdentity, createBillingForRequest } from '@/lib/billing/server';
import type { D1Like } from '@/lib/billing/core';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function fail(code: string, message: string, status = 400) {
  return NextResponse.json({ ok: false, code, message }, { status });
}

/** 当前访客的解读额度状态（未启用计费时返回 enabled:false，前端据此隐藏入口） */
export async function GET(req: NextRequest) {
  const config = billingConfig();
  if (!config.enabled) {
    return NextResponse.json({ ok: true, data: { enabled: false } });
  }
  try {
    await initAccountBackend();
    const db = getCloudflareDB() as D1Like | null;
    if (!db) return NextResponse.json({ ok: true, data: { enabled: false } });
    const identity = await billingIdentity(req, req.cookies.get(AUTH_COOKIE)?.value);
    const billing = createBillingForRequest(db, config);
    const status = await billing.status(identity);
    return NextResponse.json({
      ok: true,
      data: {
        enabled: true,
        loggedIn: Boolean(identity.ownerId),
        freeLimit: status?.freeLimit ?? config.freeTotal,
        freeLeft: status?.freeLeft ?? 0,
        credits: status?.credits ?? 0,
      },
    });
  } catch {
    return NextResponse.json({ ok: true, data: { enabled: false } });
  }
}

/** 兑换卡密：必须登录（匿名无法归属资产） */
export async function POST(req: NextRequest) {
  const config = billingConfig();
  if (!config.enabled) return fail('BILLING_DISABLED', '当前未开启计费', 404);

  let body: { action?: string; code?: string };
  try {
    body = await req.json();
  } catch {
    return fail('INVALID_JSON', '请求体不是合法 JSON');
  }
  if (body.action !== 'redeem') return fail('UNKNOWN_ACTION', '未知操作');
  await initAccountBackend();
  const db = getCloudflareDB() as D1Like | null;
  if (!db) return fail('STORAGE_UNAVAILABLE', '存储不可用，请稍后重试', 503);

  const identity = await billingIdentity(req, req.cookies.get(AUTH_COOKIE)?.value);
  if (!identity.ownerId) {
    return fail('LOGIN_REQUIRED', '兑换前请先注册并登录（卡密次数要绑定到账号）', 401);
  }

  const billing = createBillingForRequest(db, config);
  const result = await billing.redeem(String(body.code || ''), identity.ownerId);
  if (!result.ok) {
    return NextResponse.json({ ok: false, code: result.code, message: result.message }, { status: 400 });
  }
  return NextResponse.json({ ok: true, data: { added: result.added, credits: result.credits } });
}
