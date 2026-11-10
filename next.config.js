/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['lunar-javascript'],
  // 关闭 Next.js 开发态的英文 Issues 指示器（框架内置文案不可本地化）；
  // 生产构建本就不显示，关闭后开发预览也不会有红色角标遮挡界面。
  devIndicators: false,
  // 原 middleware.ts 只做根路径跳转；Next 16 已弃用该约定，且 OpenNext
  // 对 Node middleware 支持不完整，改用框架级 redirects（静态/边缘均生效）。
  async redirects() {
    return [{ source: '/', destination: '/chart', permanent: false }];
  },
};

module.exports = nextConfig;
