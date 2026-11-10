import { defineCloudflareConfig } from '@opennextjs/cloudflare';

/**
 * Cloudflare Workers 构建配置。
 * 默认使用内存增量缓存；本站的账号数据走 D1（见 lib/account/store.d1.ts），
 * 不依赖 ISR 持久化，因此无需额外绑定 R2 / Durable Objects。
 */
export default defineCloudflareConfig({});
