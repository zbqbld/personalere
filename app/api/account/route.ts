/**
 * 账号接口：注册 / 登录 / 登出 / 当前账号
 *
 * 会话令牌只通过 HttpOnly Cookie 传递，绝不从请求体读取，也不返回给前端 JS。
 * 注册可附带 bind（本机既有档案），注册成功后直接绑定到新账号。
 * 每个请求先注入 Cloudflare D1（若在 Workers），再走统一异步业务层。
 */
import { NextRequest, NextResponse } from 'next/server';
import { ACCESS_DENIED, AUTH_COOKIE, SESSION_TTL_MS, type Failure, type ServiceResult } from '@/lib/account/contract';
import { tokenOf, denyResponse } from '@/lib/account/http';
import { initAccountBackend, getCloudflareDB } from '@/lib/account/context';
import { bindOwnedProfiles, currentAccount, login, logout, register } from '@/lib/account/service';
import { normalizeUsername } from '@/lib/account/validation';
import { createEmailCodeStore, EMAIL_CODE_TTL_MS } from '@/lib/account/email-codes';
import { sendEmail, emailConfig } from '@/lib/email/brevo';
import { getStorage } from '@/lib/account/storage';
import type { D1Like } from '@/lib/billing/core';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function failureResponse(r: Failure): NextResponse {
  if (r.code === ACCESS_DENIED.code) return denyResponse();
  const status = r.code === 'ACCOUNT_EXISTS' ? 409
    : r.code === 'INVALID_CREDENTIALS' ? 401
      : 400;
  return NextResponse.json(r, { status });
}

function respond(r: ServiceResult<unknown>): NextResponse {
  return r.ok ? NextResponse.json({ ok: true, data: r.data }) : failureResponse(r);
}

function cookieBase() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure: process.env.NODE_ENV === 'production',
  };
}

function withSession(res: NextResponse, token: string): NextResponse {
  res.cookies.set(AUTH_COOKIE, token, { ...cookieBase(), maxAge: Math.floor(SESSION_TTL_MS / 1000) });
  return res;
}

function fail(code: string, message: string, status = 400): NextResponse {
  return NextResponse.json({ ok: false, code, message }, { status });
}

function clearSession(res: NextResponse): NextResponse {
  res.cookies.set(AUTH_COOKIE, '', { ...cookieBase(), maxAge: 0 });
  return res;
}

async function parseBody(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export async function GET(req: NextRequest) {
  await initAccountBackend();
  return respond(await currentAccount(tokenOf(req)));
}

export async function POST(req: NextRequest) {
  await initAccountBackend();
  const body = await parseBody(req);
  const action = typeof body.action === 'string' ? body.action : '';
  const token = tokenOf(req);

  if (action === 'register') {
    const result = await register({
      username: body.username,
      password: body.password,
      confirmPassword: body.confirmPassword,
      nickname: body.nickname,
    });
    if (!result.ok) return failureResponse(result);

    // 注册即绑定：把本机匿名档案一次性归入新账号，绑定结果带该账号 ownerId
    let bound = 0;
    if (Array.isArray(body.bind) && body.bind.length > 0) {
      const bindResult = await bindOwnedProfiles(result.data.token, body.bind);
      if (bindResult.ok) bound = bindResult.data.results.filter(r => r.status === 'created').length;
    }
    const res = NextResponse.json({
      ok: true,
      data: { account: result.data.account, bound },
    });
    return withSession(res, result.data.token);
  }

  /** 邮箱验证码注册：先发码 */
  if (action === 'send-email-code') {
    await initAccountBackend();
    const db = getCloudflareDB() as D1Like | null;
    if (!db) return fail('STORAGE_UNAVAILABLE', '存储不可用，请稍后重试', 503);
    const email = normalizeUsername(body.email);
    if (!EMAIL_RE.test(email)) return fail('INVALID_EMAIL', '邮箱格式不正确');
    const account = await (await getStorage()).getAccount(email);
    if (account) return fail('ACCOUNT_EXISTS', '该邮箱已注册，请直接登录', 409);

    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
    const codes = createEmailCodeStore(db);
    const saved = await codes.saveCode(email, code, Date.now());
    if (!saved) return fail('RATE_LIMITED', '发送太频繁，请 1 分钟后再试', 429);

    let result: Awaited<ReturnType<typeof sendEmail>>;
    try {
      result = await sendEmail(
        email,
        '紫微命盘 注册验证码',
        `你的注册验证码是：${code}\n\n10 分钟内有效。如果不是你本人操作，请忽略本邮件。`,
      );
    } catch {
      result = { ok: false, code: 'SEND_FAILED', message: '邮件发送失败，请稍后重试' };
    }
    if (!result.ok) {
      // 回滚占码：否则用户会白等 60 秒重发锁，邮箱里却一封邮件都没有
      await codes.clearCode(email);
      return NextResponse.json({ ok: false, code: result.code, message: result.message }, { status: 503 });
    }
    return NextResponse.json({ ok: true, data: { sent: true, expiresInSec: Math.floor(EMAIL_CODE_TTL_MS / 1000) } });
  }

  /** 邮箱验证码注册：邮箱 + 验证码 + 密码，等价于用户名=邮箱的普通注册 */
  if (action === 'register-email') {
    await initAccountBackend();
    const db = getCloudflareDB() as D1Like | null;
    if (!db) return fail('STORAGE_UNAVAILABLE', '存储不可用，请稍后重试', 503);
    const email = normalizeUsername(body.email);
    if (!EMAIL_RE.test(email)) return fail('INVALID_EMAIL', '邮箱格式不正确');
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (!/^\d{4,8}$/.test(code)) return fail('INVALID_CODE', '验证码格式不正确');

    const codes = createEmailCodeStore(db);
    const verdict = await codes.verifyCode(email, code, Date.now());
    if (verdict !== 'ok') {
      const message = verdict === 'EXPIRED' ? '验证码已过期，请重新发送'
        : verdict === 'TOO_MANY_ATTEMPTS' ? '错误次数过多，请重新发送验证码'
          : verdict === 'NOT_FOUND' ? '请先获取验证码'
            : '验证码不正确';
      return fail('CODE_' + verdict, message, 400);
    }

    const bind = Array.isArray(body.bind)
      ? (body.bind as { userId?: unknown; form?: unknown }[]).map(p => ({ userId: p.userId, form: p.form }))
      : undefined;
    const result = await register({
      username: email,
      password: body.password,
      confirmPassword: body.confirmPassword,
      nickname: body.nickname,
    });
    if (!result.ok) return failureResponse(result);

    // 与普通注册一致：把本机匿名档案一次性归入新账号
    let bound = 0;
    if (Array.isArray(body.bind) && body.bind.length > 0) {
      const bindResult = await bindOwnedProfiles(result.data.token, body.bind);
      if (bindResult.ok) bound = bindResult.data.results.filter(r => r.status === 'created').length;
    }
    const res = NextResponse.json({ ok: true, data: { account: result.data.account, bound } });
    return withSession(res, result.data.token);
  }

  if (action === 'login') {
    const result = await login({ username: body.username, password: body.password });
    if (!result.ok) return failureResponse(result);
    const res = NextResponse.json({ ok: true, data: { account: result.data.account } });
    return withSession(res, result.data.token);
  }

  if (action === 'logout') {
    const result = await logout(token);
    if (!result.ok) return failureResponse(result);
    return clearSession(NextResponse.json({ ok: true, data: { loggedOut: true } }));
  }

  if (action === 'me') return respond(await currentAccount(token));

  return NextResponse.json(
    { ok: false, code: 'INVALID_ACTION', message: '不支持的账号操作' },
    { status: 400 },
  );
}
