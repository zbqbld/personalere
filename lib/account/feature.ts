/**
 * 账号体系总开关（注册 / 登录 / 服务端档案绑定）
 *
 * - 线上部署：不设置该变量 → 默认 true，注册登录功能完整保留。
 * - 本地运行：在 .env.local 里设 NEXT_PUBLIC_ACCOUNT_ENABLED=false → 关闭
 *   注册面板与所有账号相关入口，打开页面即可直接起盘，数据只写浏览器本地。
 *
 * 这是「界面 / 流程」开关，不是删除后端代码：API 路由仍然存在，线上构建
 * 因为拿不到该变量会保持原样。变量名带 NEXT_PUBLIC_ 前缀，Next 会在构建时
 * 内联到客户端包，所以本地开发服务器读取的是 .env.local 里的值。
 */
export const ACCOUNT_ENABLED = process.env.NEXT_PUBLIC_ACCOUNT_ENABLED !== 'false';
