/**
 * 当前源码与历史修订全文采集。
 *
 * 当前态写入走来源可追溯的 `ingest.apply_current_page_source()`：它内部调用
 * `put_content_blob()` 并落 `page_source(observation_source, run_id)`，同时把渲染正文写入
 * `serve.page_current.search_text`。历史修订由独立低优先队列逐个 revision_id 调用
 * PageSourceModule；这里仍只负责显式目标列表，不自行展开全站。
 */

import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { amcRequest } from '../http/amc.js';
import type { HttpClient } from '../http/client.js';
import {
  RESTRICTED_STABLE_PROXY_URL,
  type RestrictedSourceSession,
} from '../http/restrictedSession.js';
import { extractPageIdentity, slugToUrl } from '../page/identity.js';
import { query, toPgTimestamptz, withTransaction } from '../store/db.js';
import { recordPageScan } from '../store/meta.js';
import {
  sanitizePgText,
  sanitizePgValue,
  textWasSanitized,
  toPgJson,
} from '../store/pgText.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import {
  extractPageImages,
  imageCandidateToJson,
  type ExtractedImageCandidate,
} from '../content/extractImages.js';
import {
  decodeEntities,
  extractSearchText,
  type ExtractResult,
} from '../content/extractText.js';
import {
  assertUniqueKeys,
  diagnostics,
  failed,
  ok,
  type CollectResult,
  type PageCollectTarget,
} from './result.js';
import type { RestrictedRenderedContent } from './restrictedListPages.js';

export interface SourceSnapshot {
  pageId: number;
  wikidotId: number;
  source: string;
  sha256Hex: string;
  /** AMC JSON 中 body（模块 HTML）的 UTF-8 字节数，用于长期回填带宽审计。 */
  responseBytes?: number;
  /** AMC JSON 中 body 原字节的 sha256；与源码 sha 分开，防止混淆两个口径。 */
  responseSha256Hex?: string;
}

export interface CurrentContentSnapshot extends SourceSnapshot {
  slug: string;
  textContent: string;
  textExtraction: ExtractResult;
  images: ExtractedImageCandidate[];
}

export interface RestrictedCurrentContentTarget extends PageCollectTarget {
  slug: string;
  rendered: RestrictedRenderedContent;
}

export interface RevisionSourceTarget extends PageCollectTarget {
  revisionId: number;
}

export interface RevisionSourceSnapshot extends SourceSnapshot {
  revisionId: number;
}

export type AuthenticatedRevisionSourceResult =
  | CollectResult<RevisionSourceSnapshot>
  | {
      status: 'unavailable';
      reason: 'authenticated_no_permission';
      error: string;
    };

const PAGE_SOURCE_DIV_RE = /<div\b([^>]*)>([\s\S]*?)<\/div\s*>/gi;

function classTokens(attrs: string): string[] {
  const m = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(attrs);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').split(/\s+/).filter(Boolean);
}

function fragmentText(innerHtml: string): string {
  // 先处理真实 HTML 标签，再解码实体；顺序不能反，否则源码里的 `&lt;div&gt;`
  // 会被误当成包装标签删掉。
  const withoutMarkup = innerHtml
    .replace(/<br\b[^>]*\/?>/gi, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(withoutMarkup.replace(/&nbsp;/gi, ' '))
    .replace(/\u00a0/g, ' ')
    // wikidot 两个源码模块的包装空白不同：ViewSource 是 "\n\t<source>\n"，
    // PageSource 是 "\n<source>\n"。按现有库的 `.text().trim()` 口径剥包装，
    // 否则同一最新 revision 会得到两个不同 sha。
    .trim()
    .replace(/^\t/, '');
}

/**
 * 解析 `div.page-source`。
 *
 * 合法空源码必须有容器，只是文本为空；缺容器/HTML 错误页则是 failed。
 */
export function parseSourceBody(
  body: string,
  identity: { pageId: number; wikidotId: number },
): CollectResult<SourceSnapshot> {
  PAGE_SOURCE_DIV_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PAGE_SOURCE_DIV_RE.exec(body)) !== null) {
    if (!classTokens(m[1] ?? '').includes('page-source')) continue;
    const source = fragmentText(m[2] ?? '');
    return ok(
      {
        pageId: identity.pageId,
        wikidotId: identity.wikidotId,
        source,
        sha256Hex: createHash('sha256').update(source, 'utf8').digest('hex'),
      },
      diagnostics(null, 1),
    );
  }
  return failed(
    '响应中没有 div.page-source；这不是合法空源码，可能是 no_page/WAF 页面或解析结构已变。',
    diagnostics(null, 0),
  );
}

async function fetchSource(
  http: HttpClient,
  baseUrl: string,
  target: PageCollectTarget,
  moduleName: 'viewsource/ViewSourceModule' | 'history/PageSourceModule',
  revisionId?: number,
): Promise<CollectResult<SourceSnapshot>> {
  try {
    const res = await amcRequest(http, baseUrl, {
      moduleName,
      params:
        moduleName === 'viewsource/ViewSourceModule'
          ? { page_id: target.wikidotId }
          : { revision_id: revisionId! },
      mode:
        moduleName === 'viewsource/ViewSourceModule'
          ? 'tier2:source'
          : 'tier2:revision-source-on-demand',
      // 批级传输失败至少尝试 3 次后才允许把该页判 failed；503/429 仍由 HttpClient 零重试。
      maxAttempts: 3,
    });
    if (res.status !== 'ok') {
      return failed(
        `${moduleName} 返回 status=${res.status}（message=${res.message ?? '-'}），不解释为空源码。`,
      );
    }
    if (res.body === null) {
      return failed(`${moduleName} status=ok 但 body 缺失，不解释为空源码。`);
    }
    const parsed = parseSourceBody(res.body.replace(/&nbsp;/gi, ' '), target);
    if (parsed.status !== 'ok') return parsed;
    return ok(
      {
        ...parsed.data,
        responseBytes: Buffer.byteLength(res.body, 'utf8'),
        responseSha256Hex: createHash('sha256').update(res.body, 'utf8').digest('hex'),
      },
      parsed.diagnostics,
    );
  } catch (err) {
    return failed(`${moduleName} 请求失败：${String(err)}`);
  }
}

/** 当前源码批量抓取；每个输入页在 Map 中恰有一条显式结果。 */
export async function scanSources(
  http: HttpClient,
  baseUrl: string,
  targets: readonly PageCollectTarget[],
  concurrency = 4,
): Promise<Map<number, CollectResult<SourceSnapshot>>> {
  assertUniqueKeys(targets, (t) => t.pageId);
  const pairs = await mapWithConcurrency(targets, concurrency, async (target) => [
    target.pageId,
    await fetchSource(http, baseUrl, target, 'viewsource/ViewSourceModule'),
  ] as const);
  return new Map(pairs);
}

/**
 * 当前源码 + 渲染正文。正常整页必须回显与任务一致的 wikidotId；
 * 错页身份即使正文能解析也拒绝应用。
 *
 * search_text 必须来自整页 HTML 的 `extractTextContent()`，不能从 wikitext 猜正文：
 * 实测 76.3% 的活页含 [[include]] / [[module]]，且 1,654 页的渲染正文比源码还长，
 * 其中 623 页超过 3 倍。若用源码口径，hub / 系列 / 中心页会塌到近空，直接造成
 * 检索归零、字数近 0、摘要为空。整页本来就要为 wikidotId 身份守卫抓取，因此正文
 * 与身份从同一次 GET 取得，禁止为正文再发第二次请求。
 */
export async function scanCurrentContents(
  http: HttpClient,
  baseUrl: string,
  targets: readonly (PageCollectTarget & { slug: string })[],
  concurrency = 4,
): Promise<Map<number, CollectResult<CurrentContentSnapshot>>> {
  assertUniqueKeys(targets, (t) => t.pageId);
  const pairs = await mapWithConcurrency(targets, concurrency, async (target) => {
    const sourcePromise = fetchSource(http, baseUrl, target, 'viewsource/ViewSourceModule');
    const pageUrl = slugToUrl(baseUrl, target.slug);
    const pagePromise = http.get(pageUrl, 'tier2:rendered-content', {
      maxAttempts: 3,
    });

    try {
      const [sourceResult, page] = await Promise.all([sourcePromise, pagePromise]);
      if (sourceResult.status !== 'ok') {
        return [
          target.pageId,
          failed<CurrentContentSnapshot>(sourceResult.error, sourceResult.diagnostics),
        ] as const;
      }

      const html = page.text();
      const identity = extractPageIdentity(html);
      if (identity === null) {
        return [
          target.pageId,
          failed<CurrentContentSnapshot>(
            `整页 HTTP ${page.status} 但未回显 WIKIREQUEST.info.pageId，拒绝提取 search_text。`,
          ),
        ] as const;
      }
      if (identity.wikidotId !== target.wikidotId) {
        return [
          target.pageId,
          failed<CurrentContentSnapshot>(
            `定向抓取身份不一致：任务 wikidotId=${target.wikidotId}，响应=${identity.wikidotId}。`,
          ),
        ] as const;
      }

      const text = extractSearchText(html);
      if (text.status === 'failed') {
        return [target.pageId, failed<CurrentContentSnapshot>(text.error)] as const;
      }
      const images = extractPageImages({
        html,
        source: sourceResult.data.source,
        pageUrl,
        slug: target.slug,
      });
      return [
        target.pageId,
        ok({
          ...sourceResult.data,
          slug: target.slug,
          textContent: text.data.text,
          textExtraction: text.data,
          images,
        }),
      ] as const;
    } catch (err) {
      // sourcePromise 内部已经收敛为结果；这里主要承接整页 GET 的传输/HTTP 错误。
      return [
        target.pageId,
        failed<CurrentContentSnapshot>(`当前内容抓取失败：${String(err)}`),
      ] as const;
    }
  });
  return new Map(pairs);
}

/**
 * 受限页当前源码：只有 ViewSource 带登录 session；ListPages 渲染正文仍来自匿名结果。
 * session 自身与这里的第二道断言共同保证不会回落 7891。
 */
export async function scanRestrictedCurrentContents(
  session: RestrictedSourceSession,
  baseUrl: string,
  targets: readonly RestrictedCurrentContentTarget[],
  concurrency = 1,
): Promise<Map<number, CollectResult<CurrentContentSnapshot>>> {
  if (session.http.proxyUrl !== RESTRICTED_STABLE_PROXY_URL) {
    throw new Error(
      `受限源码只允许 ${RESTRICTED_STABLE_PROXY_URL}，收到 ${String(session.http.proxyUrl)}`,
    );
  }
  assertUniqueKeys(targets, (target) => target.pageId);
  const pairs = await mapWithConcurrency(targets, concurrency, async (target) => {
    try {
      const response = await session.fetchCurrentSource(target.slug, target.wikidotId);
      if (response.status !== 'ok') {
        return [
          target.pageId,
          failed<CurrentContentSnapshot>(
            `authenticated ViewSourceModule status=${response.status}` +
              `（message=${response.message ?? '-'}）；emptyResult=false`,
          ),
        ] as const;
      }
      if (response.body === null) {
        return [
          target.pageId,
          failed<CurrentContentSnapshot>(
            'authenticated ViewSourceModule status=ok 但 body 缺失；emptyResult=false',
          ),
        ] as const;
      }
      const parsed = parseSourceBody(response.body.replace(/&nbsp;/gi, ' '), target);
      if (parsed.status !== 'ok') {
        return [
          target.pageId,
          failed<CurrentContentSnapshot>(`${parsed.error}；emptyResult=false`, parsed.diagnostics),
        ] as const;
      }
      const pageUrl = slugToUrl(baseUrl, target.slug);
      const renderedHtml = `<div id="page-content">${target.rendered.contentHtml}</div>`;
      return [
        target.pageId,
        ok({
          ...parsed.data,
          responseBytes: Buffer.byteLength(response.body, 'utf8'),
          responseSha256Hex: createHash('sha256').update(response.body, 'utf8').digest('hex'),
          slug: target.slug,
          textContent: target.rendered.textContent,
          textExtraction: target.rendered.textExtraction,
          images: extractPageImages({
            html: renderedHtml,
            source: parsed.data.source,
            pageUrl,
            slug: target.slug,
          }),
        }),
      ] as const;
    } catch (err) {
      return [
        target.pageId,
        failed<CurrentContentSnapshot>(
          `authenticated ViewSourceModule 请求失败：${String(err)}；emptyResult=false`,
        ),
      ] as const;
    }
  });
  return new Map(pairs);
}

/**
 * 抓取一个或多个显式历史 revision 源码。全量枚举、退避、live 守卫与限速均由
 * revision-source-backfill 的独立低优先队列承担；本函数不接受页面后自动展开版本。
 */
export async function scanRevisionSourcesOnDemand(
  http: HttpClient,
  baseUrl: string,
  targets: readonly RevisionSourceTarget[],
  concurrency = 2,
): Promise<Map<number, CollectResult<RevisionSourceSnapshot>>> {
  assertUniqueKeys(targets, (t) => t.revisionId);
  const pairs = await mapWithConcurrency(targets, concurrency, async (target) => {
    const source = await fetchSource(
      http,
      baseUrl,
      target,
      'history/PageSourceModule',
      target.revisionId,
    );
    if (source.status !== 'ok') {
      return [
        target.revisionId,
        failed<RevisionSourceSnapshot>(source.error, source.diagnostics),
      ] as const;
    }
    return [
      target.revisionId,
      ok({
        ...source.data,
        revisionId: target.revisionId,
      }),
    ] as const;
  });
  return new Map(pairs);
}

/**
 * 固定 7890 登录态的历史源码。session 失效错误故意向上抛，让 worker 归还 claim 并
 * 显式降级；只有重登成功后目标仍 no_permission 才形成 unavailable 终态结果。
 */
export async function scanAuthenticatedRevisionSourcesOnDemand(
  session: RestrictedSourceSession,
  targets: readonly RevisionSourceTarget[],
  concurrency = 1,
): Promise<Map<number, AuthenticatedRevisionSourceResult>> {
  if (session.http.proxyUrl !== RESTRICTED_STABLE_PROXY_URL) {
    throw new Error(
      `账号历史源码只允许 ${RESTRICTED_STABLE_PROXY_URL}，收到 ${String(session.http.proxyUrl)}`,
    );
  }
  assertUniqueKeys(targets, (target) => target.revisionId);
  const pairs = await mapWithConcurrency(targets, concurrency, async (target) => {
    const response = await session.fetchRevisionSource(target.revisionId);
    if (response.status === 'no_permission') {
      return [
        target.revisionId,
        {
          status: 'unavailable',
          reason: 'authenticated_no_permission',
          error:
            `authenticated history/PageSourceModule revision=${target.revisionId} ` +
            `status=no_permission（message=${response.message ?? '-'}）；emptyResult=false`,
        },
      ] as const;
    }
    if (response.status !== 'ok') {
      return [
        target.revisionId,
        failed<RevisionSourceSnapshot>(
          `authenticated history/PageSourceModule revision=${target.revisionId} ` +
            `status=${response.status}（message=${response.message ?? '-'}）；emptyResult=false`,
        ),
      ] as const;
    }
    if (response.body === null) {
      return [
        target.revisionId,
        failed<RevisionSourceSnapshot>(
          `authenticated history/PageSourceModule revision=${target.revisionId} ` +
            'status=ok 但 body 缺失；emptyResult=false',
        ),
      ] as const;
    }
    const parsed = parseSourceBody(response.body.replace(/&nbsp;/gi, ' '), target);
    if (parsed.status !== 'ok') {
      return [
        target.revisionId,
        failed<RevisionSourceSnapshot>(`${parsed.error}；emptyResult=false`, parsed.diagnostics),
      ] as const;
    }
    return [
      target.revisionId,
      ok({
        ...parsed.data,
        revisionId: target.revisionId,
        responseBytes: Buffer.byteLength(response.body, 'utf8'),
        responseSha256Hex: createHash('sha256').update(response.body, 'utf8').digest('hex'),
      }),
    ] as const;
  });
  return new Map<number, AuthenticatedRevisionSourceResult>(pairs);
}

export interface ApplyCurrentContentOptions {
  observedAt: string;
  runId: number | null;
  revNo?: number | null;
  observationSource?: 'wikidot_anonymous' | 'wikidot_authenticated';
}

/**
 * 先独立落 `page_scan` 证据，再在同一事务内应用 page_meta + page_images。若 R10 冻结
 * 让 apply_* 抛 PGF01，抓取证据不会随事实事务一起回滚；正文与图片投影不会只成功一半。
 */
export async function applyCurrentContent(
  pool: Pool,
  target: PageCollectTarget,
  result: CollectResult<CurrentContentSnapshot>,
  opts: ApplyCurrentContentOptions,
): Promise<Record<string, unknown> | null> {
  const observed = toPgTimestamptz(opts.observedAt);
  const fetched = result.status === 'failed' ? 0 : 1;
  const stored =
    result.status === 'ok'
      ? prepareCurrentContentForPg(result.data, target.pageId)
      : null;
  const hash = stored?.hash ?? null;
  await recordPageScan(
    pool,
    {
      runId: opts.runId,
      pageId: target.pageId,
      kind: 'content',
      status: result.status,
      fetchedTotal: fetched,
      resultHash: hash,
      error:
        result.status === 'ok'
          ? stored?.evidenceMarker ?? null
          : result.error,
    },
  );

  if (result.status !== 'ok') return null;
  return withTransaction(pool, `m3.content:${target.pageId}`, async (db) => {
    const applied = await query<{ result: Record<string, unknown> }>(
      db,
      'm3.content:apply_current_page_source',
      `SELECT ingest.apply_current_page_source(
         $1::int, $2::text, $3::text, $4::timestamptz,
         $5::text, $6::bigint, $7::int, $8::int
       ) AS result`,
      [
        target.pageId,
        stored!.source,
        stored!.textContent,
        observed,
        opts.observationSource ?? 'wikidot_anonymous',
        opts.runId,
        target.wikidotId,
        opts.revNo ?? null,
      ],
    );
    const imageApplied = await query<{ result: Record<string, unknown> }>(
      db,
      'm3.content:apply_page_images',
      `SELECT ingest.apply_page_images(
         $1::int, $2::jsonb, $3::timestamptz, true
       ) AS result`,
      [
        target.pageId,
        toPgJson(stored!.images, `m3.content.images:${target.pageId}`),
        observed,
      ],
    );
    return {
      ...(applied.rows[0]?.result ?? {}),
      images: imageApplied.rows[0]?.result ?? {},
      ...(stored!.sanitized
        ? { text_sanitization: stored!.sanitation }
        : {}),
    };
  });
}

function prepareCurrentContentForPg(
  snapshot: CurrentContentSnapshot,
  pageId: number,
): {
  source: string;
  textContent: string;
  images: Record<string, unknown>[];
  hash: Buffer;
  sanitized: boolean;
  sanitation: Record<string, unknown>;
  evidenceMarker: string | null;
} {
  const source = sanitizePgText(snapshot.source, {
    context: `content.source_wikitext:${pageId}`,
  });
  const textContent = sanitizePgText(snapshot.textContent, {
    context: `content.text_content:${pageId}`,
  });
  const images = sanitizePgValue(
    snapshot.images.map(imageCandidateToJson),
    { context: `content.images:${pageId}` },
  );
  const sanitized =
    textWasSanitized(source.sanitation) ||
    textWasSanitized(textContent.sanitation) ||
    images.sanitation.stringsChanged > 0;
  const sanitation = {
    source_wikitext: source.sanitation,
    text_content: textContent.sanitation,
    images: images.sanitation,
  };
  return {
    source: source.value,
    textContent: textContent.value,
    images: images.value,
    hash: createHash('sha256').update(source.value, 'utf8').digest(),
    sanitized,
    sanitation,
    evidenceMarker: sanitized
      ? 'content_text_sanitized ' +
        `source_nul=${source.sanitation.nulCodeUnits} ` +
        `source_lone_surrogate=${source.sanitation.loneSurrogates} ` +
        `text_nul=${textContent.sanitation.nulCodeUnits} ` +
        `text_lone_surrogate=${textContent.sanitation.loneSurrogates} ` +
        `image_strings=${images.sanitation.stringsChanged}`
      : null,
  };
}
