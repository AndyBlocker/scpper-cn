/**
 * M6 · 站点约定页。
 *
 * 这组页面不是普通内容页，而是站点用 wiki source 维护的“数据库”：
 *   - attribution-metadata / attribution-metadata-translation：署名四列表；
 *   - 顶栏动态发现的 SCP 系列列表页：页面 → 备用标题。
 *
 * 两条安全边界在本文件里做成了不同 API，而不是靠调用方记住：
 *   1. 存量署名只能走 applyMappedAttributionSnapshots()，输入必须已经由
 *      v1 pageVerId → PageVersion.pageId 映射成 v2 pageId；该入口拒绝任何 slug 字段。
 *   2. 只有明确判定为“新增”的源行才能走 resolveNewAttributionEntriesBySlug()。
 *      slug 被多页复用时，必须有日精度日期且恰好命中一个生命周期；否则隔离。
 *
 * 采集仍只复用 HttpClient / amcRequest，落事实仍只调用 apply_*。
 */

import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import type { Pool } from 'pg';

import { decodeEntities } from '../content/extractText.js';
import { amcRequest } from '../http/amc.js';
import type { HttpClient } from '../http/client.js';
import { slugToUrl } from '../page/identity.js';
import { query, toPgTimestamptz } from '../store/db.js';
import { recordPageScan } from '../store/meta.js';
import { toPgJson } from '../store/pgText.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import { parseWikidotPageId } from './pageid.js';
import {
  assertUniqueKeys,
  diagnostics,
  failed,
  ok,
  partial,
  type CollectResult,
} from './result.js';
import { parseSourceBody } from './source.js';

export const ATTRIBUTION_SOURCE_SLUGS = [
  'attribution-metadata',
  'attribution-metadata-translation',
] as const;

const CONVENTION_SOURCE_TIMEOUT_MS = 40_000;
const ATTRIBUTION_HEADER = ['标题', '用户', '类型', '时间'] as const;
const ATTRIBUTION_HEADER_EN = ['title', 'user', 'type', 'date'] as const;

export type AttributionRole =
  | 'AUTHOR'
  | 'REWRITER'
  | 'MAINTAINER'
  | 'CREATOR'
  | 'TRANSLATOR'
  | 'CONTRIBUTOR';

const ATTRIBUTION_ROLE_MAP: Readonly<Record<string, AttributionRole>> = {
  作者: 'AUTHOR',
  重写: 'REWRITER',
  重寫: 'REWRITER',
  重写者: 'REWRITER',
  重寫者: 'REWRITER',
  维护者: 'MAINTAINER',
  維護者: 'MAINTAINER',
  创建者: 'CREATOR',
  創建者: 'CREATOR',
  翻译: 'TRANSLATOR',
  翻譯: 'TRANSLATOR',
  贡献者: 'CONTRIBUTOR',
  貢獻者: 'CONTRIBUTOR',
};

export interface ConventionSource {
  slug: string;
  wikidotId: number;
  source: string;
  sha256Hex: string;
}

export interface ConventionSourceScan<T> {
  /** 汇总结果；失败与合法空数据绝不共用一个返回形状。 */
  result: CollectResult<T>;
  /** 每个请求页都显式留在 Map 中，失败页不会凭空消失。 */
  sources: Map<string, CollectResult<ConventionSource>>;
}

export type AttributionDatePrecision = 'none' | 'day' | 'month' | 'unknown';

export interface ParsedAttributionEntry {
  sourceSlug: string;
  line: number;
  pageSlug: string;
  userName: string;
  rawType: string;
  role: AttributionRole;
  /** 只有日精度才进入数据库 date 与复用 slug 生命周期裁决。 */
  atDate: string | null;
  rawDate: string;
  datePrecision: AttributionDatePrecision;
  isForumOrigin: boolean;
  /** 同一页面、同一 role 内从 0 开始。 */
  ord: number;
}

export interface RejectedConventionRow {
  sourceSlug: string;
  line: number;
  raw: string;
  reason: string;
}

export interface AttributionSourceSnapshot {
  sourceSlug: string;
  entries: ParsedAttributionEntry[];
  rejectedRows: RejectedConventionRow[];
  attributionTables: number;
  ignoredOtherTables: number;
  warnings: string[];
}

export interface AttributionCollection {
  entries: ParsedAttributionEntry[];
  rejectedRows: RejectedConventionRow[];
  sourceHashes: Record<string, string>;
  warnings: string[];
}

export interface AlternateTitleEntry {
  sourceSlug: string;
  line: number;
  pageSlug: string;
  alternateTitle: string;
}

export interface AlternateTitleSourceSnapshot {
  sourceSlug: string;
  entries: AlternateTitleEntry[];
  /** 包含占位行；用于证明“合法空标题”来自一个真实列表，而不是 WAF 空响应。 */
  listedSlugs: string[];
  rejectedRows: RejectedConventionRow[];
  candidateRows: number;
}

export interface SeriesDiscovery {
  sourcePageSlugs: string[];
  /**
   * 从真实链接动态归纳出的系列页族；仅作指纹与告警，不拿它重新拼硬编码页名。
   * 例如 scp-series-10 会归入 scp-series。
   */
  discoveredPrefixes: string[];
  groupHeadings: string[];
}

export interface AlternateTitleCollection {
  discovery: SeriesDiscovery;
  entries: AlternateTitleEntry[];
  listedSlugs: string[];
  rejectedRows: RejectedConventionRow[];
  sourceHashes: Record<string, string>;
}

export interface AlternateTitleScan extends ConventionSourceScan<AlternateTitleCollection> {
  discovery: CollectResult<SeriesDiscovery>;
  pages: Map<string, CollectResult<AlternateTitleSourceSnapshot>>;
}

interface WikiTableLine {
  cells: string[];
  isHeader: boolean;
}

/**
 * wiki 简单表格只在 `||` 边界切分；本约定页的四列值不允许内嵌 `||`。
 * 非表格行返回 null，畸形表格行仍返回 cells，交上层显式计数。
 */
function parseWikiTableLine(line: string): WikiTableLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('||') || !trimmed.endsWith('||')) return null;
  const inner = trimmed.slice(2, -2);
  const cells = inner.split('||').map((cell) => cell.trim());
  return {
    cells,
    isHeader: cells.some((cell) => cell.trimStart().startsWith('~')),
  };
}

function normalizeHeaderCell(value: string): string {
  return decodeEntities(value)
    .replace(/^~\s*/, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

function isAttributionHeader(cells: readonly string[]): boolean {
  if (cells.length !== 4) return false;
  const normalized = cells.map(normalizeHeaderCell);
  const zh = ATTRIBUTION_HEADER.every((value, i) => normalized[i] === value);
  const en = ATTRIBUTION_HEADER_EN.every((value, i) => normalized[i] === value);
  return zh || en;
}

function normalizeSlug(value: string): string {
  let slug = decodeEntities(value).trim();
  const internalLink = /^\[\[\[\s*([^|\]]+)(?:\|[^\]]*)?\]\]\]$/.exec(slug);
  if (internalLink?.[1]) slug = internalLink[1].trim();
  try {
    if (/^https?:\/\//i.test(slug)) {
      const url = new URL(slug);
      slug = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, ''));
    }
  } catch {
    // URL 形态本身会在调用方的空值/非法字符校验中成为 rejected，不在这里吞异常。
  }
  return slug.toLowerCase();
}

function parseAttributionDate(rawValue: string): {
  atDate: string | null;
  rawDate: string;
  precision: AttributionDatePrecision;
  isForumOrigin: boolean;
  warning: string | null;
} {
  const rawDate = decodeEntities(rawValue).trim();
  const isForumOrigin = rawDate.startsWith('*');
  const value = rawDate.replace(/^\*/, '').trim();
  if (value === '') {
    return {
      atDate: null,
      rawDate,
      precision: 'none',
      isForumOrigin,
      warning: null,
    };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) && isRealCalendarDate(value)) {
    return {
      atDate: value,
      rawDate,
      precision: 'day',
      isForumOrigin,
      warning: null,
    };
  }
  if (/^\d{4}-\d{2}$/.test(value)) {
    return {
      atDate: null,
      rawDate,
      precision: 'month',
      isForumOrigin,
      warning: `日期 ${JSON.stringify(rawDate)} 只有月精度，不伪造月首；复用 slug 时该行会被拒绝。`,
    };
  }
  return {
    atDate: null,
    rawDate,
    precision: 'unknown',
    isForumOrigin,
    warning: `日期 ${JSON.stringify(rawDate)} 不是可识别的 YYYY-MM-DD，原样留证且不参与生命周期裁决。`,
  };
}

function isRealCalendarDate(value: string): boolean {
  const [yearRaw, monthRaw, dayRaw] = value.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * 解析单张 attribution source。
 *
 * 真实 translation 页尾部另有“旧论坛 ID / Wiki ID”两列表。这里由表头驱动状态机：
 * 只在四列署名表头之后解释数据行，遇到别的表头立即退出，绝不把那 20 行误判成署名。
 */
export function parseAttributionSource(
  source: string,
  sourceSlug = 'attribution-metadata',
): CollectResult<AttributionSourceSnapshot> {
  if (source.trim() === '') {
    return failed('署名 source 为空；缺少四列表头，不是合法的 0 行快照。');
  }

  const entries: ParsedAttributionEntry[] = [];
  const rejectedRows: RejectedConventionRow[] = [];
  const warnings: string[] = [];
  const orderByPageRole = new Map<string, number>();
  let attributionTables = 0;
  let ignoredOtherTables = 0;
  let insideAttributionTable = false;

  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const parsed = parseWikiTableLine(raw);
    if (parsed === null) continue;

    if (parsed.isHeader) {
      insideAttributionTable = isAttributionHeader(parsed.cells);
      if (insideAttributionTable) attributionTables++;
      else ignoredOtherTables++;
      continue;
    }
    if (!insideAttributionTable) continue;

    if (parsed.cells.length !== 4) {
      rejectedRows.push({
        sourceSlug,
        line: i + 1,
        raw,
        reason: `署名表数据行只有 ${parsed.cells.length} 列，期望 4 列。`,
      });
      continue;
    }

    const [pageRaw = '', userRaw = '', typeRaw = '', dateRaw = ''] = parsed.cells;
    const pageSlug = normalizeSlug(pageRaw);
    const userName = decodeEntities(userRaw).trim();
    const rawType = decodeEntities(typeRaw).trim();
    const role = ATTRIBUTION_ROLE_MAP[rawType];
    if (pageSlug === '' || userName === '' || rawType === '' || role === undefined) {
      rejectedRows.push({
        sourceSlug,
        line: i + 1,
        raw,
        reason:
          pageSlug === '' || userName === '' || rawType === ''
            ? '署名表的 page/user/type 有空值。'
            : `未知署名类型 ${JSON.stringify(rawType)}；拒绝静默 lower-case 后写入。`,
      });
      continue;
    }

    const parsedDate = parseAttributionDate(dateRaw);
    if (parsedDate.warning !== null) warnings.push(`${sourceSlug}:${i + 1} ${parsedDate.warning}`);
    const orderKey = `${pageSlug}\n${role}`;
    const ord = orderByPageRole.get(orderKey) ?? 0;
    orderByPageRole.set(orderKey, ord + 1);
    entries.push({
      sourceSlug,
      line: i + 1,
      pageSlug,
      userName,
      rawType,
      role,
      atDate: parsedDate.atDate,
      rawDate: parsedDate.rawDate,
      datePrecision: parsedDate.precision,
      isForumOrigin: parsedDate.isForumOrigin,
      ord,
    });
  }

  if (attributionTables === 0) {
    return failed(
      '找不到“标题/用户/类型/时间”四列署名表头；不把 WAF、普通文章或模板改版解释成 0 行。',
      diagnostics(null, 0),
    );
  }

  const snapshot: AttributionSourceSnapshot = {
    sourceSlug,
    entries,
    rejectedRows,
    attributionTables,
    ignoredOtherTables,
    warnings,
  };
  const d = diagnostics(null, entries.length, warnings);
  if (rejectedRows.length > 0) {
    return partial(
      snapshot,
      `署名表有 ${rejectedRows.length} 条结构/类型不完整行；整轮不得产生 removed。`,
      d,
    );
  }
  return ok(snapshot, d);
}

function cleanAlternateTitle(raw: string): string | null {
  let title = decodeEntities(raw).trim();
  if (title === '' || title === '[ACCESS DENIED]') return null;
  if (/^\/\/[\s\S]*\/\/$/.test(title)) return null;
  title = title
    .replace(/\s*\[已锁\]\s*$/u, '')
    .replace(/\s*\[[^\]]*已删除[^\]]*\]\s*$/u, '')
    .trim();
  return title === '' ? null : title;
}

/**
 * 解析单张系列列表页。
 *
 * 合法空结果可由“结构正确但全是占位标题”的列表构成；缺少任何列表候选行则 failed。
 */
export function parseAlternateTitleSource(
  source: string,
  sourceSlug = 'series-page',
): CollectResult<AlternateTitleSourceSnapshot> {
  if (source.trim() === '') {
    return failed('系列页 source 为空；不是合法的 0 个备用标题。');
  }

  const lines = source.split(/\r?\n/);
  const rawRows: Array<{
    sourceLine: string;
    line: number;
    pageSlug: string;
    display: string;
    remainder: string;
  }> = [];
  const structurallyBroken: Array<{ sourceLine: string; line: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    if (!/^\s*\*\s+/.test(raw) || !raw.includes('[[[')) continue;
    // 允许站点在链接外包 [[span]]，也允许一行尾部还有 Portland Vice 等第二链接。
    const match = /\[\[\[\s*([^|\]]+?)(?:\|([^\]]*?))?\s*\]\]\]/.exec(raw);
    if (match === null) {
      structurallyBroken.push({ sourceLine: raw, line: i + 1 });
      continue;
    }
    const pageSlug = normalizeSlug(match[1] ?? '');
    if (pageSlug === '') {
      structurallyBroken.push({ sourceLine: raw, line: i + 1 });
      continue;
    }
    rawRows.push({
      sourceLine: raw,
      line: i + 1,
      pageSlug,
      display: decodeEntities(match[2] ?? '').trim(),
      remainder: raw.slice((match.index ?? 0) + match[0].length).trim(),
    });
  }

  if (rawRows.length === 0 && structurallyBroken.length === 0) {
    return failed(
      '系列页没有任何 “* [[[...]]]” 列表候选行；不把 WAF/普通文章解释成 0 个备用标题。',
      diagnostics(null, 0),
    );
  }

  /*
   * 站内同一系列页混用四种合法写法：
   *   [[[SCP-9000]]] - 标题
   *   [[[SCP-9089|标题]]]
   *   [[[SCP-7168]]] – 标题
   *   [[[SCP-CN-3204|显示标题]]]：附注
   *
   * 不能把所有 `* [[[...]]]` 都当条目：页面顶部还有 artwork/安保等级等导航链接。
   * 因而先从真实的数字条目动态归纳 article prefix（scp- / scp-cn- / scp-pl- …），
   * 不维护前缀数组；同 prefix 至少出现 3 次才算该页的系列条目族。
   */
  const prefixCounts = new Map<string, number>();
  for (const row of rawRows) {
    const prefix = prefixBeforeFirstDigit(row.pageSlug);
    if (prefix !== null) prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
  }
  const articlePrefixes = [...prefixCounts]
    .filter(([, count]) => count >= 3)
    .map(([prefix]) => prefix);

  const entries: AlternateTitleEntry[] = [];
  const listedSlugs: string[] = [];
  const rejectedRows: RejectedConventionRow[] = [];
  let candidateRows = 0;
  for (const broken of structurallyBroken) {
    // 含 SCP 形态的未闭合链接是解析失败；其它未闭合导航链接不属于备用标题域。
    if (!/scp(?:-|:)/iu.test(broken.sourceLine)) continue;
    candidateRows++;
    rejectedRows.push({
      sourceSlug,
      line: broken.line,
      raw: broken.sourceLine,
      reason: '系列条目含 `[[[` 但链接未完整闭合，无法可靠取得 slug/title。',
    });
  }
  for (const row of rawRows) {
    const separatorTitle = titleAfterSeparator(row.remainder);
    const isArticle = articlePrefixes.some((prefix) => row.pageSlug.startsWith(prefix));
    // 传统 “ - title” 写法本来就被 v1 接受；无分隔符写法只接受动态归纳出的条目族。
    if (separatorTitle === null && !isArticle) continue;
    candidateRows++;
    listedSlugs.push(row.pageSlug);

    const displayTitle =
      row.display !== '' && !isIdentifierPlaceholder(row.display, row.pageSlug)
        ? row.display
        : null;
    const plainRemainderTitle =
      isArticle && separatorTitle === null
        ? cleanPlainRemainder(row.remainder)
        : null;
    const alternateTitle = cleanAlternateTitle(
      separatorTitle ?? displayTitle ?? plainRemainderTitle ?? '',
    );
    if (alternateTitle === null) continue;
    entries.push({
      sourceSlug,
      line: row.line,
      pageSlug: row.pageSlug,
      alternateTitle,
    });
  }

  if (candidateRows === 0) {
    return failed(
      '页面虽有普通 wiki 列表链接，但没有可证明属于系列条目的 prefix/“ - title” 行。',
      diagnostics(null, 0),
    );
  }

  const snapshot: AlternateTitleSourceSnapshot = {
    sourceSlug,
    entries,
    listedSlugs: [...new Set(listedSlugs)],
    rejectedRows,
    candidateRows,
  };
  if (rejectedRows.length > 0) {
    return partial(
      snapshot,
      `系列页有 ${rejectedRows.length}/${candidateRows} 条候选行结构异常；不得做 absence 清空。`,
      diagnostics(candidateRows, entries.length),
    );
  }
  return ok(snapshot, diagnostics(candidateRows, entries.length));
}

function prefixBeforeFirstDigit(slug: string): string | null {
  const index = slug.search(/\d/u);
  if (index <= 0) return null;
  return slug.slice(0, index);
}

function titleAfterSeparator(remainder: string): string | null {
  const cleaned = remainder
    .replace(/^\s*\[\[\/span\]\]\s*/iu, '')
    .trim();
  /*
   * 冒号后的文本经常只是“附注”，不能压过链接里的显示标题；
   * 这里只让横线写法拥有最高优先级。冒号/裸文本留给
   * cleanPlainRemainder，并排在链接显示标题之后。
   */
  const match = /^(?:-|–|—)\s*(.+)$/u.exec(cleaned);
  return match?.[1]?.trim() || null;
}

function cleanPlainRemainder(remainder: string): string | null {
  const cleaned = remainder
    .replace(/^\s*\[\[\/span\]\]\s*/iu, '')
    .trim();
  if (cleaned === '' || cleaned.includes('[[[')) return null;
  return cleaned.replace(/^(?:-|–|—|:|：)\s*/u, '').trim() || null;
}

function isIdentifierPlaceholder(display: string, slug: string): boolean {
  const normalize = (value: string): string =>
    value.toLowerCase().replace(/[\s_|/]+/gu, '-').replace(/-+/gu, '-').replace(/^-|-$/gu, '');
  const normalized = normalize(display);
  return (
    normalized === normalize(slug) ||
    /(?:xxxx|待定|不可用|access-denied)/iu.test(normalized)
  );
}

function directTextWithoutChildren(
  $: ReturnType<typeof load>,
  element: Parameters<ReturnType<typeof load>>[0],
): string {
  return $(element)
    .contents()
    .filter((_i, node) => node.type === 'text')
    .text()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从站点顶栏动态发现系列列表页，不维护 SERIES_PAGES 数组。
 *
 * 发现依据是站点自己的导航结构：
 *   - 顶级组名含 SCP；
 *   - 相对站内链接；
 *   - 页面链接/显示名自身表明是 SCP 列表；
 *   - 排除故事/tales 子列表。
 *
 * 因此新增 `scp-series-10/11` 会自动进入，非 SCP 的“原创异常物品记录”等不会误入。
 */
export function discoverSeriesPages(html: string): CollectResult<SeriesDiscovery> {
  if (html.trim() === '') return failed('系列页发现 HTML 为空。');
  const $ = load(html);
  const root = $('#top-bar .top-bar').first();
  if (root.length === 0) {
    return failed('页面缺少 #top-bar .top-bar；不使用硬编码系列页数组兜底。');
  }

  const slugs: string[] = [];
  const groupHeadings: string[] = [];
  root
    .children('ul')
    .children('li')
    .each((_i, group) => {
      const heading = directTextWithoutChildren($, group);
      if (!/SCP/i.test(heading)) return;
      groupHeadings.push(heading);
      $(group)
        .children('ul')
        .find('a[href]')
        .each((_j, anchor) => {
          const href = ($(anchor).attr('href') ?? '').trim();
          const label = $(anchor).text().replace(/\s+/g, ' ').trim();
          if (!href.startsWith('/') || href.startsWith('//')) return;
          if (/(?:tales|故事)/iu.test(`${href} ${label}`)) return;
          if (!/(?:scp-series|SCP)/iu.test(`${href} ${label}`)) return;
          const slug = normalizeSlug(href.replace(/^\/+/, '').split(/[?#]/, 1)[0] ?? '');
          if (slug !== '') slugs.push(slug);
        });
    });

  const sourcePageSlugs = [...new Set(slugs)];
  if (groupHeadings.length === 0 || sourcePageSlugs.length === 0) {
    return failed(
      `顶栏结构存在，但未发现 SCP 系列组/列表页（groups=${groupHeadings.length}, pages=${sourcePageSlugs.length}）。`,
    );
  }
  const discoveredPrefixes = [
    ...new Set(sourcePageSlugs.map((slug) => slug.replace(/-\d+$/u, ''))),
  ].sort();
  return ok(
    { sourcePageSlugs, discoveredPrefixes, groupHeadings },
    diagnostics(null, sourcePageSlugs.length),
  );
}

async function fetchConventionSource(
  http: HttpClient,
  baseUrl: string,
  slug: string,
  knownWikidotId?: number,
): Promise<CollectResult<ConventionSource>> {
  try {
    let wikidotId = knownWikidotId ?? null;
    if (wikidotId === null) {
      const page = await http.get(
        `${slugToUrl(baseUrl, slug)}/norender/true/noredirect/true`,
        'm6:convention-identity',
        { maxAttempts: 3 },
      );
      wikidotId = parseWikidotPageId(page.text());
      if (wikidotId === null) {
        return failed(
          `${slug}: 整页 HTTP ${page.status} 但没有 WIKIREQUEST.info.pageId；不请求错误身份的 source。`,
        );
      }
    }

    const response = await amcRequest(http, baseUrl, {
      moduleName: 'viewsource/ViewSourceModule',
      params: { page_id: wikidotId },
      mode: 'm6:convention-source',
      timeoutMs: CONVENTION_SOURCE_TIMEOUT_MS,
      maxAttempts: 3,
    });
    if (response.status !== 'ok' || response.body === null) {
      return failed(
        `${slug}: ViewSourceModule status=${response.status}, body=${response.body === null ? 'null' : 'present'}。`,
      );
    }
    const parsed = parseSourceBody(response.body, {
      pageId: wikidotId,
      wikidotId,
    });
    if (parsed.status !== 'ok') return failed(`${slug}: ${parsed.error}`, parsed.diagnostics);
    return ok({
      slug,
      wikidotId,
      source: parsed.data.source,
      sha256Hex: parsed.data.sha256Hex,
    });
  } catch (err) {
    return failed(`${slug}: 约定页抓取失败：${String(err)}`);
  }
}

async function fetchConventionSources(
  http: HttpClient,
  baseUrl: string,
  slugs: readonly string[],
  knownWikidotIds: ReadonlyMap<string, number> | undefined,
  concurrency: number,
): Promise<Map<string, CollectResult<ConventionSource>>> {
  assertUniqueKeys(slugs, (slug) => slug);
  const pairs = await mapWithConcurrency(slugs, concurrency, async (slug) => [
    slug,
    await fetchConventionSource(http, baseUrl, slug, knownWikidotIds?.get(slug)),
  ] as const);
  return new Map(pairs);
}

/** 每轮强制重抓两张署名页；本模块没有 source cache 命中短路。 */
export async function collectAttributions(
  http: HttpClient,
  baseUrl: string,
  opts: {
    knownWikidotIds?: ReadonlyMap<string, number>;
    concurrency?: number;
  } = {},
): Promise<ConventionSourceScan<AttributionCollection>> {
  const sources = await fetchConventionSources(
    http,
    baseUrl,
    ATTRIBUTION_SOURCE_SLUGS,
    opts.knownWikidotIds,
    opts.concurrency ?? 2,
  );
  const entries: ParsedAttributionEntry[] = [];
  const rejectedRows: RejectedConventionRow[] = [];
  const warnings: string[] = [];
  const sourceHashes: Record<string, string> = {};
  let isPartial = false;

  for (const slug of ATTRIBUTION_SOURCE_SLUGS) {
    const source = sources.get(slug);
    if (source === undefined || source.status === 'failed') {
      return {
        sources,
        result: failed(
          source?.error ?? `${slug}: 内部错误，抓取结果 Map 缺项。`,
          diagnostics(null, entries.length),
        ),
      };
    }
    sourceHashes[slug] = source.data.sha256Hex;
    const parsed = parseAttributionSource(source.data.source, slug);
    if (parsed.status === 'failed') {
      return { sources, result: failed(`${slug}: ${parsed.error}`, parsed.diagnostics) };
    }
    if (parsed.status === 'partial') isPartial = true;
    entries.push(...parsed.data.entries);
    rejectedRows.push(...parsed.data.rejectedRows);
    warnings.push(...parsed.data.warnings);
  }

  const data: AttributionCollection = { entries, rejectedRows, sourceHashes, warnings };
  return {
    sources,
    result: isPartial
      ? partial(
          data,
          `署名源存在 ${rejectedRows.length} 条拒绝行；只能处理明确新增，禁止全量 removal。`,
          diagnostics(null, entries.length, warnings),
        )
      : ok(data, diagnostics(null, entries.length, warnings)),
  };
}

/** 先抓一张普通站点页的顶栏，再按动态发现结果强制重抓每张系列 source。 */
export async function collectAlternateTitles(
  http: HttpClient,
  baseUrl: string,
  opts: {
    discoveryPath?: string;
    knownWikidotIds?: ReadonlyMap<string, number>;
    concurrency?: number;
  } = {},
): Promise<AlternateTitleScan> {
  let discovery: CollectResult<SeriesDiscovery>;
  try {
    const path = opts.discoveryPath ?? '/';
    const page = await http.get(new URL(path, `${baseUrl.replace(/\/+$/, '')}/`).toString(), 'm6:series-discovery', {
      maxAttempts: 3,
    });
    discovery = discoverSeriesPages(page.text());
  } catch (err) {
    discovery = failed(`系列页发现请求失败：${String(err)}`);
  }
  if (discovery.status === 'failed') {
    return {
      discovery,
      sources: new Map(),
      pages: new Map(),
      result: failed(discovery.error),
    };
  }

  const sources = await fetchConventionSources(
    http,
    baseUrl,
    discovery.data.sourcePageSlugs,
    opts.knownWikidotIds,
    opts.concurrency ?? 4,
  );
  const pages = new Map<string, CollectResult<AlternateTitleSourceSnapshot>>();
  const entries: AlternateTitleEntry[] = [];
  const listedSlugs: string[] = [];
  const rejectedRows: RejectedConventionRow[] = [];
  const sourceHashes: Record<string, string> = {};
  const failures: string[] = [];
  let partialPages = 0;

  for (const slug of discovery.data.sourcePageSlugs) {
    const source = sources.get(slug);
    let parsed: CollectResult<AlternateTitleSourceSnapshot>;
    if (source === undefined || source.status === 'failed') {
      parsed = failed(source?.error ?? `${slug}: 内部错误，source Map 缺项。`);
    } else {
      sourceHashes[slug] = source.data.sha256Hex;
      parsed = parseAlternateTitleSource(source.data.source, slug);
    }
    pages.set(slug, parsed);
    if (parsed.status === 'failed') {
      failures.push(`${slug}: ${parsed.error}`);
      continue;
    }
    if (parsed.status === 'partial') partialPages++;
    entries.push(...parsed.data.entries);
    listedSlugs.push(...parsed.data.listedSlugs);
    rejectedRows.push(...parsed.data.rejectedRows);
  }

  const data: AlternateTitleCollection = {
    discovery: discovery.data,
    entries,
    listedSlugs: [...new Set(listedSlugs)],
    rejectedRows,
    sourceHashes,
  };
  if (failures.length > 0 || partialPages > 0) {
    return {
      discovery,
      sources,
      pages,
      result: partial(
        data,
        `系列页不完整：failed=${failures.length}, partial=${partialPages}；` +
          `失败样例=${failures.slice(0, 3).join('；') || '-'}。禁止 absence 清空。`,
        diagnostics(discovery.data.sourcePageSlugs.length, pages.size),
      ),
    };
  }
  return {
    discovery,
    sources,
    pages,
    result: ok(
      data,
      diagnostics(discovery.data.sourcePageSlugs.length, pages.size),
    ),
  };
}

export type PageLifeKind = 'created' | 'deleted' | 'restored';

export interface AttributionLifeEvent {
  kind: PageLifeKind;
  occurredAt: string;
}

export interface AttributionPageCandidate {
  pageId: number;
  wikidotId: number;
  life: AttributionLifeEvent[];
}

export type AttributionPageResolution =
  | {
      status: 'resolved';
      pageId: number;
      wikidotId: number;
      reason: 'unique_slug' | 'dated_lifecycle';
    }
  | {
      status: 'rejected';
      reason:
        | 'slug_not_found'
        | 'reused_slug_without_day_date'
        | 'date_outside_all_lifecycles'
        | 'date_matches_multiple_lifecycles';
      candidatePageIds: number[];
    };

function utcDate(iso: string): string | null {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}

/**
 * 日期是 date 粒度，因此生命周期边界按日闭区间比较。
 * 同一天旧页删除、新页创建会同时命中两个候选并被拒绝，而不是擅自猜站内先后时刻。
 */
function lifeContainsDate(events: readonly AttributionLifeEvent[], atDate: string): boolean {
  const ordered = events
    .map((event) => ({ ...event, date: utcDate(event.occurredAt) }))
    .filter((event): event is AttributionLifeEvent & { date: string } => event.date !== null)
    .sort(
      (a, b) =>
        Date.parse(a.occurredAt) - Date.parse(b.occurredAt) ||
        lifeKindRank(a.kind) - lifeKindRank(b.kind),
    );
  for (let i = 0; i < ordered.length; i++) {
    const start = ordered[i]!;
    if (start.kind !== 'created' && start.kind !== 'restored') continue;
    const nextDeleted = ordered.slice(i + 1).find((event) => event.kind === 'deleted');
    if (atDate >= start.date && (nextDeleted === undefined || atDate <= nextDeleted.date)) {
      return true;
    }
  }
  return false;
}

function lifeKindRank(kind: PageLifeKind): number {
  return kind === 'created' ? 0 : kind === 'restored' ? 1 : 2;
}

/**
 * 新解析署名的唯一 by-slug 裁决入口。
 *
 * 单候选时可无日期；多候选时没有日精度日期即拒绝，命中 0/2+ 生命周期也拒绝。
 */
export function resolveAttributionPage(
  entry: Pick<ParsedAttributionEntry, 'atDate' | 'datePrecision'>,
  candidatesInput: readonly AttributionPageCandidate[],
): AttributionPageResolution {
  const candidates = [
    ...new Map(candidatesInput.map((candidate) => [candidate.pageId, candidate])).values(),
  ];
  if (candidates.length === 0) {
    return { status: 'rejected', reason: 'slug_not_found', candidatePageIds: [] };
  }
  if (candidates.length === 1) {
    const only = candidates[0]!;
    return {
      status: 'resolved',
      pageId: only.pageId,
      wikidotId: only.wikidotId,
      reason: 'unique_slug',
    };
  }
  if (entry.datePrecision !== 'day' || entry.atDate === null) {
    return {
      status: 'rejected',
      reason: 'reused_slug_without_day_date',
      candidatePageIds: candidates.map((candidate) => candidate.pageId),
    };
  }
  const matching = candidates.filter((candidate) => lifeContainsDate(candidate.life, entry.atDate!));
  if (matching.length === 1) {
    return {
      status: 'resolved',
      pageId: matching[0]!.pageId,
      wikidotId: matching[0]!.wikidotId,
      reason: 'dated_lifecycle',
    };
  }
  return {
    status: 'rejected',
    reason:
      matching.length === 0
        ? 'date_outside_all_lifecycles'
        : 'date_matches_multiple_lifecycles',
    candidatePageIds: candidates.map((candidate) => candidate.pageId),
  };
}

export interface ResolvedAttributionEntry extends ParsedAttributionEntry {
  pageId: number;
  wikidotId: number;
  actorId: number;
  pageResolution: 'unique_slug' | 'dated_lifecycle';
}

export interface AttributionResolutionRejection {
  entry: ParsedAttributionEntry;
  reason: string;
  candidatePageIds: number[];
  candidateActorIds: number[];
}

export interface NewAttributionResolution {
  resolved: ResolvedAttributionEntry[];
  rejected: AttributionResolutionRejection[];
}

async function loadAttributionPageCandidates(
  pool: Pool,
  slugs: readonly string[],
): Promise<Map<string, AttributionPageCandidate[]>> {
  const normalized = [...new Set(slugs.map((slug) => slug.toLowerCase()))];
  const out = new Map<string, AttributionPageCandidate[]>(
    normalized.map((slug) => [slug, []]),
  );
  if (normalized.length === 0) return out;
  const rows = await query<{
    slug: string;
    page_id: number;
    wikidot_id: number;
    kind: PageLifeKind | null;
    occurred_epoch_ms: string | null;
  }>(
    pool,
    'm6.attribution:page_candidates',
    `WITH candidate AS (
       SELECT DISTINCT lower(h.slug) AS slug, h.page_id
         FROM ingest.page_slug_history h
        WHERE lower(h.slug) = ANY($1::text[])
     )
     SELECT c.slug, p.id AS page_id, p.wikidot_id,
            e.kind,
            CASE WHEN e.occurred_at IS NULL THEN NULL
                 ELSE (extract(epoch FROM e.occurred_at) * 1000)::bigint::text END AS occurred_epoch_ms
       FROM candidate c
       JOIN ingest.page p ON p.id = c.page_id
       LEFT JOIN ingest.page_life_event e
         ON e.page_id = c.page_id AND e.kind IN ('created','deleted','restored')
      ORDER BY c.slug, p.id, e.occurred_at NULLS LAST, e.seq`,
    [normalized],
  );
  const byKey = new Map<string, AttributionPageCandidate>();
  for (const row of rows.rows) {
    const key = `${row.slug}\n${row.page_id}`;
    let candidate = byKey.get(key);
    if (candidate === undefined) {
      candidate = {
        pageId: Number(row.page_id),
        wikidotId: Number(row.wikidot_id),
        life: [],
      };
      byKey.set(key, candidate);
      const list = out.get(row.slug);
      if (list !== undefined) list.push(candidate);
    }
    if (row.kind !== null && row.occurred_epoch_ms !== null) {
      candidate.life.push({
        kind: row.kind,
        occurredAt: new Date(Number(row.occurred_epoch_ms)).toISOString(),
      });
    }
  }
  return out;
}

async function loadAttributionActorCandidates(
  pool: Pool,
  names: readonly string[],
): Promise<Map<string, number[]>> {
  const normalized = [...new Set(names.map(normalizeUserLookupKey))];
  const out = new Map<string, number[]>(normalized.map((name) => [name, []]));
  if (normalized.length === 0) return out;
  const rows = await query<{ lookup_key: string; actor_id: number }>(
    pool,
    'm6.attribution:actor_candidates',
    `WITH requested AS (
       SELECT DISTINCT unnest($1::text[]) AS lookup_key
     ), matched AS (
       SELECT r.lookup_key, u.id AS actor_id
         FROM requested r JOIN ingest."user" u
           ON lower(btrim(u.display_name)) = r.lookup_key
       UNION
       SELECT r.lookup_key, u.id
         FROM requested r JOIN ingest."user" u
           ON lower(btrim(u.username)) = r.lookup_key
       UNION
       SELECT r.lookup_key, u.id
         FROM requested r JOIN ingest."user" u
           ON lower(btrim(u.wikidot_unix_name)) = r.lookup_key
     )
     SELECT lookup_key, actor_id FROM matched ORDER BY lookup_key, actor_id`,
    [normalized],
  );
  for (const row of rows.rows) {
    const list = out.get(row.lookup_key);
    if (list !== undefined && !list.includes(Number(row.actor_id))) {
      list.push(Number(row.actor_id));
    }
  }
  return out;
}

function normalizeUserLookupKey(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

/**
 * 仅供“已确认是新行”的署名使用。调用方不得把全量存量 source 直接传进来。
 * 用户名只在三个现存身份字段中唯一命中才接受；零命中/多命中都不铸派生身份。
 */
export async function resolveNewAttributionEntriesBySlug(
  pool: Pool,
  newEntries: readonly ParsedAttributionEntry[],
): Promise<NewAttributionResolution> {
  const pages = await loadAttributionPageCandidates(
    pool,
    newEntries.map((entry) => entry.pageSlug),
  );
  const actors = await loadAttributionActorCandidates(
    pool,
    newEntries.map((entry) => entry.userName),
  );
  const resolved: ResolvedAttributionEntry[] = [];
  const rejected: AttributionResolutionRejection[] = [];

  for (const entry of newEntries) {
    const page = resolveAttributionPage(entry, pages.get(entry.pageSlug) ?? []);
    const actorIds = actors.get(normalizeUserLookupKey(entry.userName)) ?? [];
    if (page.status === 'rejected' || actorIds.length !== 1) {
      rejected.push({
        entry,
        reason:
          page.status === 'rejected'
            ? page.reason
            : actorIds.length === 0
              ? 'actor_not_found'
              : 'actor_name_ambiguous',
        candidatePageIds:
          page.status === 'rejected' ? page.candidatePageIds : [page.pageId],
        candidateActorIds: actorIds,
      });
      continue;
    }
    resolved.push({
      ...entry,
      pageId: page.pageId,
      wikidotId: page.wikidotId,
      actorId: actorIds[0]!,
      pageResolution: page.reason,
    });
  }
  return { resolved, rejected };
}

export interface MappedAttributionEntry {
  /** v2 ingest.page.id；存量必须由 v1 PageVersion.pageId 映射得到。 */
  pageId: number;
  wikidotId: number;
  actorId: number;
  role: AttributionRole | string;
  ord: number;
  atDate: string | null;
  /** 存量审计键；证明调用方持有 pageVerId，而不是从 slug 猜 pageId。 */
  v1PageVersionId?: number;
}

export interface ApplyMappedAttributionOptions {
  observedAt: string;
  runId: number | null;
  source: string;
  /**
   * 只有调用方证明传入了每个目标页的完整集合时才可为 true。
   * 新增 by-slug 行入口永远不替调用方作这个决定。
   */
  isComplete: boolean;
  /**
   * 完整快照里“现在为 0 行”的页面。没有这个显式目标时，空数组不携带 page 身份，
   * 本函数绝不猜该清空谁。
   */
  emptyTargets?: ReadonlyArray<{ pageId: number; wikidotId: number }>;
}

export interface ApplyMappedAttributionSummary {
  pages: number;
  entries: number;
  added: number;
  updated: number;
  removed: number;
  results: Record<string, Record<string, unknown>>;
}

function assertMappedAttributionRows(rows: readonly MappedAttributionEntry[]): void {
  for (const [index, row] of rows.entries()) {
    const raw = row as MappedAttributionEntry & { slug?: unknown; pageSlug?: unknown };
    if (raw.slug !== undefined || raw.pageSlug !== undefined) {
      throw new Error(
        `mapped attribution 第 ${index + 1} 行含 slug/pageSlug；` +
          '存量入口禁止按 slug 重解析，必须先用 v1 pageVerId → PageVersion.pageId 映射。',
      );
    }
    if (
      !Number.isSafeInteger(row.pageId) ||
      row.pageId <= 0 ||
      !Number.isSafeInteger(row.wikidotId) ||
      row.wikidotId <= 0 ||
      !Number.isSafeInteger(row.actorId) ||
      row.actorId <= 0 ||
      !Number.isInteger(row.ord) ||
      row.ord < 0 ||
      row.role.trim() === ''
    ) {
      throw new Error(`mapped attribution 第 ${index + 1} 行身份/role/ord 非法。`);
    }
    if (row.v1PageVersionId !== undefined && row.v1PageVersionId <= 0) {
      throw new Error(`mapped attribution 第 ${index + 1} 行 v1PageVersionId 非法。`);
    }
  }
}

/**
 * 已有 pageId 映射的署名快照应用入口；存量结转与以后持久化过映射的新行共用。
 * 只调 apply_attribution_snapshot，不直写 ingest/serve。
 */
export async function applyMappedAttributionSnapshots(
  pool: Pool,
  rows: readonly MappedAttributionEntry[],
  opts: ApplyMappedAttributionOptions,
): Promise<ApplyMappedAttributionSummary> {
  assertMappedAttributionRows(rows);
  const observed = toPgTimestamptz(opts.observedAt);
  const groups = new Map<
    number,
    { wikidotId: number; rows: MappedAttributionEntry[] }
  >();
  for (const row of rows) {
    const group = groups.get(row.pageId);
    if (group === undefined) {
      groups.set(row.pageId, { wikidotId: row.wikidotId, rows: [row] });
    } else {
      if (group.wikidotId !== row.wikidotId) {
        throw new Error(`page_id=${row.pageId} 对应多个 wikidotId，拒绝应用。`);
      }
      group.rows.push(row);
    }
  }
  for (const target of opts.emptyTargets ?? []) {
    if (
      !Number.isSafeInteger(target.pageId) ||
      target.pageId <= 0 ||
      !Number.isSafeInteger(target.wikidotId) ||
      target.wikidotId <= 0
    ) {
      throw new Error('mapped attribution emptyTargets 含非法 pageId/wikidotId。');
    }
    const existing = groups.get(target.pageId);
    if (existing !== undefined) {
      if (existing.wikidotId !== target.wikidotId) {
        throw new Error(
          `emptyTargets 的 page_id=${target.pageId} 与条目中的 wikidotId 不一致。`,
        );
      }
    } else {
      groups.set(target.pageId, { wikidotId: target.wikidotId, rows: [] });
    }
  }

  const summary: ApplyMappedAttributionSummary = {
    pages: groups.size,
    entries: rows.length,
    added: 0,
    updated: 0,
    removed: 0,
    results: {},
  };
  for (const [pageId, group] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const payload = group.rows
      .map((row) => ({
        actor_id: row.actorId,
        role: row.role.toUpperCase(),
        ord: row.ord,
        at_date: row.atDate,
      }))
      .sort(
        (a, b) =>
          a.role.localeCompare(b.role) ||
          a.ord - b.ord ||
          a.actor_id - b.actor_id,
      );
    const result = await query<{ applied: Record<string, unknown> }>(
      pool,
      'm6.attribution:apply_mapped',
      `SELECT ingest.apply_attribution_snapshot(
         p_page        => $1::int,
         p_entries     => $2::jsonb,
         p_is_complete => $3::boolean,
         p_observed    => $4::timestamptz,
         p_source      => $5::text,
         p_run         => $6::bigint,
         p_wikidot_id  => $7::int
       ) AS applied`,
      [
        pageId,
        toPgJson(payload, `m6.attribution.payload:${pageId}`),
        opts.isComplete,
        observed,
        opts.source,
        opts.runId,
        group.wikidotId,
      ],
    );
    const applied = result.rows[0]?.applied ?? {};
    summary.results[String(pageId)] = applied;
    summary.added += numberField(applied, 'added');
    summary.updated += numberField(applied, 'updated');
    summary.removed += numberField(applied, 'removed');
  }
  return summary;
}

function numberField(value: Record<string, unknown>, key: string): number {
  const n = Number(value[key] ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export interface ApplyNewAttributionOptions {
  observedAt: string;
  runId: number | null;
  source?: string;
}

export interface ApplyNewAttributionSummary {
  resolution: NewAttributionResolution;
  applied: ApplyMappedAttributionSummary;
  quarantined: number;
}

/**
 * 明确新增行的 by-slug 入口。
 *
 * p_is_complete 固定 false：这些行只证明“新增存在”，不能证明某页完整署名集合，
 * 因而只允许 added/updated，不允许借局部输入产生 removed。
 */
export async function applyNewAttributionEntriesBySlug(
  pool: Pool,
  newEntries: readonly ParsedAttributionEntry[],
  opts: ApplyNewAttributionOptions,
): Promise<ApplyNewAttributionSummary> {
  const resolution = await resolveNewAttributionEntriesBySlug(pool, newEntries);
  await quarantineAttributionRejections(
    pool,
    resolution.rejected,
    opts.runId,
    opts.observedAt,
    opts.source ?? 'wikidot_conventions',
  );
  const applied = await applyMappedAttributionSnapshots(
    pool,
    resolution.resolved.map((entry) => ({
      pageId: entry.pageId,
      wikidotId: entry.wikidotId,
      actorId: entry.actorId,
      role: entry.role,
      ord: entry.ord,
      atDate: entry.atDate,
    })),
    {
      observedAt: opts.observedAt,
      runId: opts.runId,
      source: opts.source ?? 'wikidot_conventions',
      isComplete: false,
    },
  );
  return { resolution, applied, quarantined: resolution.rejected.length };
}

async function quarantineAttributionRejections(
  pool: Pool,
  rejected: readonly AttributionResolutionRejection[],
  runId: number | null,
  observedAt: string,
  source: string,
): Promise<void> {
  if (rejected.length === 0) return;
  await query(
    pool,
    'm6.attribution:quarantine',
    `INSERT INTO meta.fact_quarantine
       (domain, page_id, natural_key, raw, reason, source, run_id, observed_at)
     SELECT 'attribution',
            NULLIF(r.page_id, 0),
            r.natural_key,
            r.raw,
            r.reason,
            $2::text,
            $3::bigint,
            $4::timestamptz
       FROM jsonb_to_recordset($1::jsonb) AS r(
         page_id int, natural_key text, raw jsonb, reason text
       )`,
    [
      toPgJson(
        rejected.map((item) => ({
          page_id: item.candidatePageIds.length === 1 ? item.candidatePageIds[0] : 0,
          natural_key: attributionFingerprint(item.entry),
          raw: {
            entry: item.entry,
            candidatePageIds: item.candidatePageIds,
            candidateActorIds: item.candidateActorIds,
          },
          reason: item.reason,
        })),
        'm6.attribution.quarantine',
      ),
      source,
      runId,
      toPgTimestamptz(observedAt),
    ],
  );
}

export function attributionFingerprint(entry: ParsedAttributionEntry): string {
  return createHash('sha256')
    .update(
      [
        entry.pageSlug,
        normalizeUserLookupKey(entry.userName),
        entry.role,
        entry.rawDate,
        String(entry.ord),
      ].join('\n'),
      'utf8',
    )
    .digest('hex');
}

export interface ResolvedAlternateTitle {
  pageId: number;
  wikidotId: number;
  pageSlug: string;
  alternateTitle: string;
  sourceSlug: string;
  line: number;
}

export interface AlternateTitleResolution {
  resolved: ResolvedAlternateTitle[];
  rejected: Array<{
    entry: AlternateTitleEntry;
    reason: string;
    candidatePageIds: number[];
  }>;
}

/**
 * 备用标题是当前态列表：优先唯一 live 页；没有 live 时仅在总候选唯一时接受。
 * 多个已删页复用同 slug 且无日期可裁决，宁可拒绝也不猜。
 */
export async function resolveAlternateTitles(
  pool: Pool,
  entries: readonly AlternateTitleEntry[],
): Promise<AlternateTitleResolution> {
  const slugs = [...new Set(entries.map((entry) => entry.pageSlug))];
  const rows =
    slugs.length === 0
      ? { rows: [] as Array<{
          slug: string;
          page_id: number;
          wikidot_id: number;
          status: string;
        }> }
      : await query<{
          slug: string;
          page_id: number;
          wikidot_id: number;
          status: string;
        }>(
          pool,
          'm6.alternate_title:candidates',
          `SELECT lower(slug) AS slug, page_id, wikidot_id, status
             FROM serve.page_current
            WHERE lower(slug) = ANY($1::text[])
            ORDER BY lower(slug), (status = 'live') DESC, deleted_at DESC NULLS LAST, page_id`,
          [slugs],
        );
  const candidates = new Map<string, typeof rows.rows>();
  for (const row of rows.rows) {
    const list = candidates.get(row.slug);
    if (list === undefined) candidates.set(row.slug, [row]);
    else list.push(row);
  }

  const resolved: ResolvedAlternateTitle[] = [];
  const rejected: AlternateTitleResolution['rejected'] = [];
  const bySlug = new Map<string, AlternateTitleEntry[]>();
  for (const entry of entries) {
    const list = bySlug.get(entry.pageSlug);
    if (list === undefined) bySlug.set(entry.pageSlug, [entry]);
    else list.push(entry);
  }
  for (const [slug, sameSlugEntries] of bySlug) {
    const titles = [...new Set(sameSlugEntries.map((entry) => entry.alternateTitle))];
    const pageCandidates = candidates.get(slug) ?? [];
    const live = pageCandidates.filter((candidate) => candidate.status === 'live');
    const chosen =
      live.length === 1
        ? live[0]
        : live.length === 0 && pageCandidates.length === 1
          ? pageCandidates[0]
          : undefined;
    if (titles.length !== 1 || chosen === undefined) {
      const reason =
        titles.length !== 1
          ? 'conflicting_alternate_titles'
          : pageCandidates.length === 0
            ? 'slug_not_found'
            : 'slug_ambiguous';
      for (const entry of sameSlugEntries) {
        rejected.push({
          entry,
          reason,
          candidatePageIds: pageCandidates.map((candidate) => Number(candidate.page_id)),
        });
      }
      continue;
    }
    const first = sameSlugEntries[0]!;
    resolved.push({
      pageId: Number(chosen.page_id),
      wikidotId: Number(chosen.wikidot_id),
      pageSlug: slug,
      alternateTitle: titles[0]!,
      sourceSlug: first.sourceSlug,
      line: first.line,
    });
  }
  return { resolved, rejected };
}

export interface ApplyAlternateTitleSummary {
  resolved: number;
  rejected: number;
  changed: number;
}

/**
 * 只应用列表中明确出现的正观测，不因任一系列页失败而清空缺席标题。
 * 每页先独立写 meta.page_scan 证据，再调 apply_page_meta，R10 冻结不会吞掉采集证据。
 */
export async function applyAlternateTitleObservations(
  pool: Pool,
  scan: CollectResult<AlternateTitleCollection>,
  opts: {
    observedAt: string;
    runId: number | null;
    source?: string;
  },
): Promise<ApplyAlternateTitleSummary> {
  if (scan.status === 'failed') {
    return { resolved: 0, rejected: 0, changed: 0 };
  }
  const resolution = await resolveAlternateTitles(pool, scan.data.entries);
  let changed = 0;
  const observed = toPgTimestamptz(opts.observedAt);
  for (const entry of resolution.resolved) {
    const hash = createHash('sha256')
      .update(`${entry.pageSlug}\n${entry.alternateTitle}`, 'utf8')
      .digest();
    await recordPageScan(
      pool,
      {
        runId: opts.runId,
        pageId: entry.pageId,
        kind: 'meta',
        status: 'ok',
        fetchedTotal: 1,
        resultHash: hash,
      },
    );
    const applied = await query<{ result: Record<string, unknown> }>(
      pool,
      'm6.alternate_title:apply_page_meta',
      `SELECT ingest.apply_page_meta(
         p_page       => $1::int,
         p_attrs      => jsonb_build_object('alternate_title', $2::text),
         p_observed   => $3::timestamptz,
         p_source     => $4::text,
         p_run        => $5::bigint,
         p_wikidot_id => $6::int
       ) AS result`,
      [
        entry.pageId,
        entry.alternateTitle,
        observed,
        opts.source ?? 'wikidot_conventions',
        opts.runId,
        entry.wikidotId,
      ],
    );
    changed += numberField(applied.rows[0]?.result ?? {}, 'attr_changes');
  }
  return {
    resolved: resolution.resolved.length,
    rejected: resolution.rejected.length,
    changed,
  };
}
