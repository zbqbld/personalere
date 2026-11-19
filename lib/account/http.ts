/**
 * 账号相关 API 路由共用的 HTTP 辅助（纯传输层，无业务逻辑）
 *
 * tokenOf / denyResponse 在 account 与 profiles 两个路由中原为逐字重复。
 * 抽到这里保证「鉴权失败一律 403 + 统一拒绝体」只有一处实现，
 * 避免日后某个路由漏改导致资源存在性泄露。
 */
import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIE, DENY_STATUS, deny } from './contract';

export function tokenOf(req: NextRequest): string | undefined {
  return req.cookies.get(AUTH_COOKIE)?.value;
}

export function denyResponse(): NextResponse {
  return NextResponse.json(deny(), { status: DENY_STATUS });
}
