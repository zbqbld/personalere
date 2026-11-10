/**
 * 归属档案接口 —— 所有涉及用户信息的读 / 写 / 改 / 删入口
 *
 * 每个方法都先注入 Cloudflare D1（若在 Workers），再经 requireOwner 预检
 * （含请求体中伪造 ownerId 的检测），最后调用统一异步服务层。
 * 任何未登录、他人账号、越权指定 userId 的情况统一返回 403 ACCESS_DENIED。
 */
import { NextRequest, NextResponse } from 'next/server';
import { ACCESS_DENIED, AUTH_COOKIE, DENY_STATUS, deny, type Failure, type ProfileInput, type ServiceResult } from '@/lib/account/contract';
import { initAccountBackend } from '@/lib/account/context';
import { requireOwner } from '@/lib/account/guard';
import {
  bindOwnedProfiles,
  clearOwnedProfiles,
  deleteOwnedProfile,
  getOwnedProfile,
  listOwnedProfiles,
  saveOwnedProfiles,
  updateOwnedProfile,
} from '@/lib/account/service';
import type { BirthDraft } from '@/lib/ziwei/memory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function tokenOf(req: NextRequest): string | undefined {
  return req.cookies.get(AUTH_COOKIE)?.value;
}

function denyResponse(): NextResponse {
  return NextResponse.json(deny(), { status: DENY_STATUS });
}

function respond(r: ServiceResult<unknown>): NextResponse {
  if (r.ok) return NextResponse.json({ ok: true, data: r.data });
  if (r.code === ACCESS_DENIED.code) return denyResponse();
  return NextResponse.json(r as Failure, { status: 400 });
}

/** 统一门禁预检：连带检测请求中伪造 / 越权的 ownerId */
async function precheck(req: NextRequest, claimed: unknown): Promise<NextResponse | null> {
  const guard = await requireOwner(tokenOf(req), claimed);
  return guard.ok ? null : denyResponse();
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
  const blocked = await precheck(req, req.nextUrl.searchParams.get('ownerId'));
  if (blocked) return blocked;
  const token = tokenOf(req);
  const userId = req.nextUrl.searchParams.get('userId');
  return respond(await (userId ? getOwnedProfile(token, userId) : listOwnedProfiles(token)));
}

export async function POST(req: NextRequest) {
  await initAccountBackend();
  const body = await parseBody(req);
  const blocked = await precheck(req, body.ownerId);
  if (blocked) return blocked;
  const token = tokenOf(req);
  const inputs: ProfileInput[] = Array.isArray(body.inputs)
    ? body.inputs as ProfileInput[] : [];
  const result = body.action === 'bind'
    ? await bindOwnedProfiles(token, inputs)
    : await saveOwnedProfiles(token, inputs, undefined, body.ownerId);
  return respond(result);
}

export async function PATCH(req: NextRequest) {
  await initAccountBackend();
  const body = await parseBody(req);
  const blocked = await precheck(req, body.ownerId);
  if (blocked) return blocked;
  return respond(await updateOwnedProfile(
    tokenOf(req),
    body.userId,
    (body.patch ?? {}) as Partial<BirthDraft>,
  ));
}

export async function DELETE(req: NextRequest) {
  await initAccountBackend();
  const body = await parseBody(req);
  const blocked = await precheck(req, body.ownerId ?? req.nextUrl.searchParams.get('ownerId'));
  if (blocked) return blocked;
  const userId = typeof body.userId === 'string'
    ? body.userId
    : req.nextUrl.searchParams.get('userId');
  return respond(await (userId
    ? deleteOwnedProfile(tokenOf(req), userId)
    : clearOwnedProfiles(tokenOf(req))));
}
