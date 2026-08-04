/**
 * sitemap 解析。
 *
 * 刻意用正则而不是 fast-xml-parser：sitemap 是机器生成的、结构极窄的 XML
 * （只有 <sitemapindex>/<urlset> 两种根，每条只有 <loc>/<lastmod>），
 * 上正则的解析面比引一个通用 XML 解析器小得多，也没有 XXE/entity-expansion
 * 那一堆需要显式关掉的开关。作为交换，这里加了四道**结构断言**：
 *   1. 根元素必须是 sitemapindex 或 urlset —— WAF 拦截页/HTML 错误页会被当场识破
 *      （否则会静默解析出 0 条，而 0 条在 absence 推断里等于"全站页面都被删了"）；
 *   2. **根元素必须闭合**（`</urlset>` / `</sitemapindex>` 存在）——
 *      2026-07-27 补：截断的响应用正则解析会"成功"，只是少了尾部若干条，
 *      而少条在 absence 推断里就是**幻影删除**（正是 v1 那 54 万条的形状）。
 *      传输层对截断的覆盖并不完整（gzip 截断会 gunzip 失败、content-length
 *      不符会报错，但 chunked + 提前 EOF 有可能"看起来正常"），所以这层必须自己拦。
 *      实测 4 个 page + 9 个 thread + 1 个 category 共 14 份响应全部以闭合标签结尾。
 *   3. 条目数必须 > 0；
 *   4. 每条必须有 <loc>。
 * 任何一条不满足就抛 SitemapParseError，让整轮 run 判 failed —— 绝不返回空数组。
 * （v1 syncer 的 54 万幻影 removed 正是"扫描失败=空数据"这一模式的产物。）
 */

export class SitemapParseError extends Error {
  override readonly name = 'SitemapParseError';
  constructor(message: string, readonly url: string, readonly snippet: string) {
    super(`${message} (url=${url}) :: ${snippet}`);
  }
}

export type SitemapKind = 'page' | 'thread' | 'category' | 'unknown';

export interface SitemapIndexEntry {
  loc: string;
  kind: SitemapKind;
  /** sitemap_page_3.xml → 3；无编号时 null。 */
  index: number | null;
}

export interface SitemapEntry {
  loc: string;
  /** 归一化后的 slug（小写、剥协议与域名、剥首尾斜杠）；无法解析时 null。 */
  slug: string | null;
  /** ISO-8601 UTC 字符串；thread/category sitemap 没有 lastmod，为 null。 */
  lastmod: string | null;
  /** 原始 lastmod 文本，留作审计（实测格式 2026-07-27T07:24:33+00:00）。 */
  lastmodRaw: string | null;
}

const BLOCK_RE = /<(url|sitemap)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
const LOC_RE = /<loc\b[^>]*>([\s\S]*?)<\/loc\s*>/i;
const LASTMOD_RE = /<lastmod\b[^>]*>([\s\S]*?)<\/lastmod\s*>/i;
const ROOT_INDEX_RE = /<sitemapindex\b/i;
const ROOT_URLSET_RE = /<urlset\b/i;
const CLOSE_INDEX_RE = /<\/sitemapindex\s*>/i;
const CLOSE_URLSET_RE = /<\/urlset\s*>/i;

/** 解析 sitemap 索引（sitemap.xml）→ 子 sitemap 列表。 */
export function parseSitemapIndex(xml: string, url: string): SitemapIndexEntry[] {
  assertRoot(xml, url, 'sitemapindex');
  const out: SitemapIndexEntry[] = [];
  for (const block of iterBlocks(xml, 'sitemap')) {
    const loc = extract(block, LOC_RE);
    if (!loc) throw new SitemapParseError('索引中存在无 <loc> 的条目', url, snippet(block));
    out.push({ loc, ...classifySitemapUrl(loc) });
  }
  if (out.length === 0) throw new SitemapParseError('索引解析出 0 条子 sitemap', url, snippet(xml));
  return out;
}

/** 解析 urlset（sitemap_page_N.xml 等）→ 条目列表。 */
export function parseUrlset(xml: string, url: string): SitemapEntry[] {
  assertRoot(xml, url, 'urlset');
  const out: SitemapEntry[] = [];
  for (const block of iterBlocks(xml, 'url')) {
    const loc = extract(block, LOC_RE);
    if (!loc) throw new SitemapParseError('urlset 中存在无 <loc> 的条目', url, snippet(block));
    const lastmodRaw = extract(block, LASTMOD_RE);
    out.push({
      loc,
      slug: slugFromLoc(loc),
      lastmod: normalizeLastmod(lastmodRaw),
      lastmodRaw,
    });
  }
  if (out.length === 0) throw new SitemapParseError('urlset 解析出 0 条 URL', url, snippet(xml));
  return out;
}

/** sitemap_page_3.xml → {kind:'page', index:3}。 */
export function classifySitemapUrl(loc: string): { kind: SitemapKind; index: number | null } {
  const m = /sitemap_(page|thread|category)_(\d+)\.xml/i.exec(loc);
  if (m) {
    return { kind: m[1]!.toLowerCase() as SitemapKind, index: Number(m[2]) };
  }
  const m2 = /sitemap_(page|thread|category)\.xml/i.exec(loc);
  if (m2) return { kind: m2[1]!.toLowerCase() as SitemapKind, index: null };
  return { kind: 'unknown', index: null };
}

/**
 * loc → 归一化 slug。
 *
 * wikidot 的 canonical URL 一律 http://，但 sitemap 里也可能出现 https://；
 * 协议与域名都被剥掉，所以两者等价。slug 保留 wikidot 原生 fullname 形态
 * （'category:name'，_default 分类无前缀），与 ingest.page_slug_history.slug 同口径。
 */
export function slugFromLoc(loc: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(loc).pathname;
  } catch {
    return null;
  }
  let slug: string;
  try {
    slug = decodeURIComponent(pathname);
  } catch {
    slug = pathname; // 非法百分号编码时退回原样，不丢条目
  }
  slug = slug.replace(/^\/+/, '').replace(/\/+$/, '').trim().toLowerCase();
  // 站点根（http://site/）没有 slug —— 不猜它是不是 'main'，交给调用方计入 skipped。
  return slug === '' ? null : slug;
}

/**
 * lastmod → ISO-8601 UTC。
 *
 * 实测语义：sitemap 的 lastmod === ListPages 的 %%updated_at%%，**逐秒完全相等**（5/5），
 * UTC、无时区歧义。这是全链路里唯一一个不需要猜时区的时间源，务必原样保留精度。
 */
export function normalizeLastmod(raw: string | null): string | null {
  if (!raw) return null;
  const t = Date.parse(raw.trim());
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

// ─── 内部 ────────────────────────────────────────────────────────────────────

function assertRoot(xml: string, url: string, expected: 'sitemapindex' | 'urlset'): void {
  const re = expected === 'sitemapindex' ? ROOT_INDEX_RE : ROOT_URLSET_RE;
  if (!re.test(xml)) {
    throw new SitemapParseError(
      `响应不是 <${expected}>（很可能是 WAF 拦截页 / HTML 错误页）。` +
        `绝不把它当成"0 条"继续 —— 0 条在 absence 推断里等于全站被删。`,
      url,
      snippet(xml),
    );
  }
  const closeRe = expected === 'sitemapindex' ? CLOSE_INDEX_RE : CLOSE_URLSET_RE;
  if (!closeRe.test(xml)) {
    throw new SitemapParseError(
      `响应缺少 </${expected}> 闭合标签 —— 极可能是**被截断的响应**（长度 ${xml.length} 字符）。` +
        `截断用正则解析会"成功"但少掉尾部条目，而少掉的条目在 absence 推断里就是幻影删除。` +
        `宁可判本轮失败。`,
      url,
      tailSnippet(xml),
    );
  }
}

function* iterBlocks(xml: string, tag: 'url' | 'sitemap'): Generator<string> {
  BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_RE.exec(xml)) !== null) {
    if (m[1]!.toLowerCase() === tag) yield m[2]!;
  }
}

function extract(block: string, re: RegExp): string | null {
  const m = re.exec(block);
  if (!m || m[1] === undefined) return null;
  const v = decodeXmlEntities(m[1]).trim();
  return v === '' ? null : v;
}

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITY_MAP[body.toLowerCase()] ?? whole;
  });
}

function snippet(s: string): string {
  return s.slice(0, 200).replace(/\s+/g, ' ').trim();
}

/** 截断诊断要看的是**尾部**，头部一切正常恰恰是截断的特征。 */
function tailSnippet(s: string): string {
  return `…${s.slice(-200).replace(/\s+/g, ' ').trim()}`;
}
