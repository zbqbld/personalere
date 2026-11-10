/**
 * 账号命名空间入口（转发层）
 *
 * 实际状态与 scopedKey 实现位于 lib/ziwei/memory.ts：该模块被 Node 原生
 * --experimental-strip-types 直接加载（scripts/smoke-dom.mjs），不能引入
 * 无扩展名的外部模块，因此实现内联在那里。此处保留独立入口，供账号客户端、
 * 注册面板与回归测试使用统一路径。
 *
 * 语义：
 *  - 未登录：scopedKey(base) === base，旧数据 / 旧流程 / 旧测试零改动；
 *  - 已登录：键名追加 :acct:<ownerId>，与未登录及其他账号物理隔离；
 *  - 账号数据的权威副本在服务端，本地只存匿名便利数据或账号专属命名空间。
 */
export { getAccountScope, setAccountScope, scopedKey } from '../ziwei/memory';
