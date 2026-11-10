/**
 * 国内可访问入口（Cloudflare Pages 反向代理）
 *
 * 背景：*.workers.dev 在中国大陆被 DNS 污染（解析到 Facebook 的 face:b00c 地址），
 *     直接打不开；而 *.pages.dev 未受影响（实测 HTTP 200）。
 *
 * 做法：本项目正式应用仍部署在 Cloudflare Workers（OpenNext 产物，含 D1 与全部 API），
 *     这里用一个 Pages 项目做同网络内反向代理，把 pages.dev 的请求转发给 Worker，
 *     于是国内用户访问 https://<project>.pages.dev 即可正常使用，无需改动应用本身。
 *
 * 部署：cd cloudflare-proxy && npx wrangler pages deploy dist --project-name=ziwei-doushu --branch=main
 */

const ORIGIN = 'https://ziwei-doushu.515554707.workers.dev';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // 健康检查，便于判断 Pages 侧是否存活
    if (url.pathname === '/__proxy/health') {
      return new Response('pages-proxy-ok', {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    const target = new URL(ORIGIN);
    target.pathname = url.pathname;
    target.search = url.search;

    const headers = new Headers();
    for (const [key, value] of request.headers) {
      const k = key.toLowerCase();
      // 交由运行时重新生成/协商的头部
      if (k === 'host' || k === 'accept-encoding' || k === 'connection' || k === 'content-length') continue;
      headers.set(key, value);
    }
    headers.set('host', target.host);
    // Next.js 的 Server Action / 重定向会参考该头部判断外部来源
    headers.set('x-forwarded-host', url.host);
    headers.set('x-forwarded-proto', url.protocol.replace(':', ''));

    const init = {
      method: request.method,
      headers,
      redirect: 'manual',
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
    }

    let upstream;
    try {
      upstream = await fetch(target.toString(), init);
    } catch (err) {
      return new Response(`上游 Worker 请求失败：${err && err.message ? err.message : '未知错误'}`, {
        status: 502,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }

    const out = new Headers();
    for (const [key, value] of upstream.headers) {
      if (key.toLowerCase() === 'set-cookie') continue;
      out.set(key, value);
    }
    // set-cookie 必须逐条 append，合并会破坏多 Cookie（登录会话）
    const cookies =
      typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
    if (cookies.length) {
      for (const cookie of cookies) out.append('set-cookie', cookie);
    } else {
      const single = upstream.headers.get('set-cookie');
      if (single) out.append('set-cookie', single);
    }

    // 把指回 workers.dev 的重定向改写到 pages.dev，避免浏览器跳出被墙域名
    const location = out.get('location');
    if (location && location.startsWith(ORIGIN)) {
      out.set('location', url.origin + location.slice(ORIGIN.length));
    }

    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  },
};
