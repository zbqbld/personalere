/**
 * Cloudflare 请求上下文桥接
 *
 * 在 Workers 里通过 @opennextjs/cloudflare 拿到 env.ZIWEI_DB 并注入存储层；
 * 本地 next dev / 单元测试没有该上下文，静默回退到文件实现。
 * 用变量 specifier 动态 import，避免把适配器变成业务层的静态依赖。
 */
import { setD1Binding } from './storage';

export async function initAccountBackend(): Promise<void> {
  try {
    const pkg = '@opennextjs/cloudflare';
    const mod = await import(pkg) as {
      getCloudflareContext?: (opts: { async: true }) => Promise<{ env?: Record<string, unknown> }>;
    };
    if (typeof mod?.getCloudflareContext !== 'function') return;
    const ctx = await mod.getCloudflareContext({ async: true });
    const db = ctx?.env?.ZIWEI_DB;
    if (db) setD1Binding(db);
  } catch {
    // 非 Cloudflare 环境：保持 Node 文件后端
  }
}
