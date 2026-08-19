/**
 * Wikidot 旧域名的图片主机改写。
 *
 * 现象：www.scp-wiki.net / ja.scp-wiki.net 上的图片全部抓不到，历史 0 次成功。
 * 一度被判为「主机不可达」，但实测**不是网络问题**——目标 IP 107.20.139.176 的
 * 443 与 80 都能连上，失败在 TLS：服务端为 scp-wiki.net 出示的是 `*.wikidot.com`
 * 证书（SAN 只有 wikidot.com / *.wikidot.com），主机名不匹配，客户端在第一跳即中止，
 * 从未走到跳转。
 *
 * 因此换出口 IP 无用：证书不匹配对每个出口都一样。实测 7890 固定出口 2 次、
 * 7891 轮换池 5 次，全部相同失败。
 *
 * 站点自身的跳转（忽略证书后可见）是：
 *   https://www.scp-wiki.net/local--files/X  →  https://scp-wiki.wdfiles.com/local--files/X
 *   http://ja.scp-wiki.net/local--files/X    →  http://scp-jp.wdfiles.com/local--files/X
 * 目标主机证书正常，用完整 TLS 校验即可直取（实测 41,915 字节的真实 JPEG）。
 *
 * 所以这里做的不是「绕过校验」，而是**把站点自己的跳转前置**：直接请求最终主机，
 * 全程保持 TLS 验证不放宽。
 *
 * 只对 `/local--files/` 生效：这正是上述跳转成立的路径前缀（站点根路径的跳转目标
 * 是 scp-wiki.wikidot.com 而非 wdfiles），越界改写就不再与站点行为等价。
 */
export const LEGACY_IMAGE_HOST_REWRITES: ReadonlyMap<string, string> = new Map([
  ['www.scp-wiki.net', 'scp-wiki.wdfiles.com'],
  ['scp-wiki.net', 'scp-wiki.wdfiles.com'],
  ['ja.scp-wiki.net', 'scp-jp.wdfiles.com'],
]);

const LEGACY_REWRITE_PATH_PREFIX = '/local--files/';

export interface LegacyHostRewrite {
  /** 实际用于抓取的 URL；未命中改写时与入参一致。 */
  url: string;
  /** 命中时为原主机，未命中为 null。仅用于可观测性，不参与去重身份。 */
  rewrittenFrom: string | null;
}

/**
 * 把旧域名的图片 URL 改写到其文件主机。
 *
 * 不修改 `normalized_url`（那是来自页面源码的去重身份），只改抓取目标；
 * 资产按内容 SHA 落盘，因此改写不会影响去重或既有资产。
 */
export function rewriteLegacyImageHost(rawUrl: string): LegacyHostRewrite {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { url: rawUrl, rewrittenFrom: null };
  }
  const host = parsed.hostname.toLowerCase();
  const target = LEGACY_IMAGE_HOST_REWRITES.get(host);
  if (target === undefined) return { url: rawUrl, rewrittenFrom: null };
  if (!parsed.pathname.startsWith(LEGACY_REWRITE_PATH_PREFIX)) {
    return { url: rawUrl, rewrittenFrom: null };
  }
  parsed.hostname = target;
  parsed.host = target;
  // 旧域名的跳转最终落在 https 文件主机；统一升到 https，证书由目标主机提供且有效。
  parsed.protocol = 'https:';
  return { url: parsed.toString(), rewrittenFrom: host };
}
