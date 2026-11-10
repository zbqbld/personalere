/**
 * 账号存储抽象：同一套业务层可在两种后端上运行
 *
 *  - 本地 / Node 部署：文件实现（store.node.ts，数据落在 data/）
 *  - Cloudflare Workers：D1 实现（store.d1.ts，强一致、可跨实例共享）
 *
 * 后端按「请求开始时注入的 D1 binding」选择；未注入时回退文件实现。
 * 两个实现同时打包；Workers 分支只用 D1，node:fs 由 nodejs_compat 提供
 * 兼容层且运行时不会被调用。
 */
import type { OwnedProfile, SessionRecord, StoredAccount } from './contract';
import { createNodeStorage } from './store.node';
import { createD1Storage } from './store.d1';

export interface AccountStorage {
  getAccount(username: string): Promise<StoredAccount | null>;
  findAccountByOwner(ownerId: string): Promise<StoredAccount | null>;
  /** 返回 false 表示账号已存在（唯一约束），调用方据此返回 ACCOUNT_EXISTS */
  putAccount(account: StoredAccount): Promise<boolean>;
  getSession(token: string): Promise<SessionRecord | null>;
  putSession(session: SessionRecord): Promise<void>;
  deleteSession(token: string): Promise<void>;
  listProfiles(ownerId: string): Promise<OwnedProfile[]>;
  /** 整组替换，实现内部需保证原子性 */
  replaceProfiles(ownerId: string, profiles: OwnedProfile[]): Promise<void>;
}

let cached: AccountStorage | null = null;
let d1Binding: unknown = null;

/** 由 API 路由在 Cloudflare 请求上下文里注入 D1 binding */
export function setD1Binding(binding: unknown): void {
  d1Binding = binding;
  cached = null;
}

/** 测试或切换环境时清空缓存的后端实例 */
export function resetStorage(): void {
  cached = null;
  d1Binding = null;
}

export async function getStorage(): Promise<AccountStorage> {
  if (cached) return cached;
  cached = d1Binding ? createD1Storage(d1Binding) : createNodeStorage();
  return cached as AccountStorage;
}
