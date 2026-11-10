/**
 * 账号接口：注册 / 登录 / 登出 / 当前账号
 *
 * 会话令牌只通过 HttpOnly Cookie 传递，绝不从请求体读取，也不返回给前端 JS。
 * 注册可附带 bind（本机既有档案），注册成功后直接绑定到新账号。
 * 每个请求先注入 Cloudflare D1（若在 Workers），再走统一异步业务层。
 */
import { NextRequest, NextResponse } from 'next/server';
import { ACCESS_DENIED, AUTH_COOKIE, DENY_STATUS, SESSION_TTL_MS, deny, type Failure, type ServiceResult } from '@/lib/account/contract';
import { initAccountBackend } from '@/lib/account/context';
import { bindOwnedProfiles, currentAccount, login, logout, register } from '@/lib/account/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function tokenOf(req: NextRequest): string | undefined {
  return req.cookies.get(AUTH_COOKIE)?.value;
}

function denyResponse(): NextResponse {
  return NextResponse.json(deny(), { status: DENY_STATUS });
}

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
