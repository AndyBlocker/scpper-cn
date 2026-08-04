/**
 * 页面身份解析：整页 GET → `WIKIREQUEST.info.pageId`。
 *
 * ── 为什么是整页 GET 而不是 /norender/true/noredirect/true ──────────────────
 * 实测（field-matrix）：整页 GET **258–430 ms**，`/norender/…` 反而 **1,251 ms**。
 * 库（`@ukwhatn/wikidot`）的 `acquirePageIds` 走的是后者，还有两条更硬的问题：
 *   · 它是"批量"接口但物理上仍是**每页一个 HTTP 请求**；
 *   · **任一页的正则匹配不到就 throw NoElementError，整批失败**（api-survey#176）。
 *     删页竞态下极易触发 —— sitemap 的 TTL≈60 min，我们看到的 slug 里本来就会
 *     混进"已经被删掉"的页。
 * 所以这里刻意**逐页独立容错**：每页自己的成败自己承担，一页 404 绝不影响其它页。
 *
 * ── 同一段 JS 白送的字段 ────────────────────────────────────────────────────
 * pageId / categoryId / siteId / siteUnixName / pageUnixName / requestPageName /
 * themeId / lang。CROM 只有 pageId 一个（存成字符串）。categoryId 是 CROM 完全没有
 * 的能力（用于 SiteChangesListModule 的分类级增量过滤）。
 *
 * ── 身份守卫 ────────────────────────────────────────────────────────────────
 * `pageUnixName` 实测**含 category 前缀**（`component:image-block` 原样返回），
 * 与 sitemap slug 同口径。两者不等 ⇒ 我们请求 A 却拿到了 B 的身份（重定向/别名）。
 * 这种情况**绝不注册**：注册就等于把 A 的 slug 绑到 B 的 wikidot_id 上，
 * 正是 v1「删除+新建=改名」误判的同型错误。
 */

import { HttpStatusError, TransportError, type HttpClient } from '../http/client.js';
import { createLogger, type Logger } from '../util/log.js';

export interface PageIdentity {
  wikidotId: number;
  categoryId: number | null;
  siteId: number | null;
  siteUnixName: string | null;
  pageUnixName: string | null;
  requestPageName: string | null;
  themeId: number | null;
  lang: string | null;
}

export type IdentityOutcome =
  | { kind: 'ok'; httpStatus: number; identity: PageIdentity; wireBytes: number; durationMs: number }
  /** 404：sitemap 生成（TTL≈60min）与我们抓取之间页面被删了。不是错误。 */
  | { kind: 'gone'; httpStatus: number; error: string }
  /** 200 但 pageUnixName ≠ 请求 slug（重定向/别名）。刻意不注册。 */
  | { kind: 'mismatch'; httpStatus: number; identity: PageIdentity; observedSlug: string }
  /** 其它失败：403 / 5xx / 传输错 / 解析不出 pageId。走指数退避。 */
  | { kind: 'failed'; httpStatus: number | null; error: string };

const INFO_RE = (key: string): RegExp =>
  new RegExp(`WIKIREQUEST\\.info\\.${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([0-9]+))`);

function readString(html: string, key: string): string | null {
  const m = INFO_RE(key).exec(html);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

function readInt(html: string, key: string): number | null {
  const v = readString(html, key);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 从整页 HTML 抽 WIKIREQUEST.info.*。pageId 抽不到即返回 null（调用方判 failed）。 */
export function extractPageIdentity(html: string): PageIdentity | null {
  const wikidotId = readInt(html, 'pageId');
  if (wikidotId === null || wikidotId <= 0) return null;
  return {
    wikidotId,
    categoryId: readInt(html, 'categoryId'),
    siteId: readInt(html, 'siteId'),
    siteUnixName: readString(html, 'siteUnixName'),
    pageUnixName: readString(html, 'pageUnixName'),
    requestPageName: readString(html, 'requestPageName'),
    themeId: readInt(html, 'themeId'),
    lang: readString(html, 'lang'),
  };
}

/**
 * slug → URL 路径。
 * wikidot fullname 的 `:` 分隔符**不能**被百分号编码（`component:image-block`
 * 编码成 `component%3Aimage-block` 后站点返回的是另一个页面/404）。
 * 其余部分正常编码（CN 站存在非 ASCII slug）。
 */
export function slugToUrl(baseUrl: string, slug: string): string {
  const encoded = slug
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/%3A/gi, ':'))
    .join('/');
  return `${baseUrl.replace(/\/+$/, '')}/${encoded}`;
}

/**
 * 取一页的身份。**任何失败都以返回值表达，不抛异常**（除断路器/头契约，那两个
 * 是"整个进程该停了"的信号，由上层处理）—— 这是"逐页独立容错"的物理保证：
 * 调用方不需要 try/catch 就不可能被单页失败带走整批。
 */
export async function fetchPageIdentity(
  http: HttpClient,
  baseUrl: string,
  slug: string,
  log: Logger = createLogger('identity'),
): Promise<IdentityOutcome> {
  const url = slugToUrl(baseUrl, slug);
  try {
    const res = await http.get(url, 'page:identity', { maxAttempts: 2 });
    const html = res.text();
    const identity = extractPageIdentity(html);
    if (identity === null) {
      return {
        kind: 'failed',
        httpStatus: res.status,
        error:
          `HTTP ${res.status} 但解析不出 WIKIREQUEST.info.pageId（${res.body.byteLength} B）。` +
          `可能是私有页/重定向页，也可能是页面模板变了 —— 后者要人看。`,
      };
    }
    const observed = (identity.pageUnixName ?? identity.requestPageName ?? '').toLowerCase();
    if (observed !== '' && observed !== slug.toLowerCase()) {
      log.warn('身份不匹配：请求 slug 与 pageUnixName 不同，拒绝注册', {
        slug,
        observed,
        wikidotId: identity.wikidotId,
      });
      return { kind: 'mismatch', httpStatus: res.status, identity, observedSlug: observed };
    }
    return {
      kind: 'ok',
      httpStatus: res.status,
      identity,
      wireBytes: res.telemetry.wireBytes,
      durationMs: res.telemetry.durationMs,
    };
  } catch (err) {
    if (err instanceof HttpStatusError) {
      if (err.status === 404) {
        return { kind: 'gone', httpStatus: 404, error: '整页 GET 返回 404（页面已不存在）' };
      }
      return { kind: 'failed', httpStatus: err.status, error: String(err) };
    }
    if (err instanceof TransportError) {
      return { kind: 'failed', httpStatus: null, error: String(err) };
    }
    // CircuitOpenError / HeaderContractError 等"进程级"错误原样上抛
    throw err;
  }
}
