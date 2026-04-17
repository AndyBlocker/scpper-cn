/**
 * full-audit-v1-v2.ts — 全面审计 CROM (V1) vs Syncer (V2) vs 主库
 *
 * 对比范围：
 *   1. 基础统计 (rating, voteCount, revisionCount, commentCount)
 *   2. Attribution 数据 (CROM vs 主库)
 *   3. AlternateTitle (CROM vs 主库)
 *   4. Category 映射 (CROM vs 主库 vs V2 推断)
 *   5. Source/textContent 覆盖率
 *   6. Vote 表完整性
 *   7. Revision 表完整性
 *   8. PageStats / 分析管道状态
 *   9. 排名一致性
 *
 * 用法: node --import tsx/esm scripts/full-audit-v1-v2.ts
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pg from 'pg';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

import { PrismaClient } from '../node_modules/.prisma/syncer-client/index.js';

const CROM_ENDPOINT = 'https://apiv2.crom.avn.sh/graphql';
const BATCH_SIZE = 100;

// ── Types ──

interface CromPage {
  fullname: string;
  url: string;
  wikidotId: number | null;
  title: string | null;
  rating: number | null;
  voteCount: number | null;
  revisionCount: number | null;
  commentCount: number | null;
  tags: string[];
  category: string | null;
  createdByName: string | null;
  createdByWikidotId: number | null;
  parentFullname: string | null;
  alternateTitle: string | null;
  attributionCount: number;
  attributionTypes: string[];  // e.g. ['SUBMITTER', 'TRANSLATOR']
}

// ── CROM 查询（带完整字段）──

const FULL_QUERY = `
  query GetPages($first: Int!, $after: ID) {
    pages(
      filter: { onWikidotPage: { url: { startsWith: "http://scp-wiki-cn.wikidot.com/" } } }
      first: $first
      after: $after
    ) {
      edges {
        node {
          url
          ... on WikidotPage {
            wikidotId
            title
            rating
            voteCount
            revisionCount
            commentCount
            tags
            category
            createdBy {
              ... on WikidotUser { displayName wikidotId }
            }
            parent { url }
            alternateTitles { title }
            attributions {
              type
              user {
                displayName
                ... on UserWikidotNameReference {
                  wikidotUser { displayName wikidotId }
                }
              }
              date
              order
            }
          }
        }
        cursor
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

async function cromRequest(query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const maxRetries = 5;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(CROM_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) {
        if (res.status === 429) {
          const wait = Math.min(60_000, 5000 * attempt);
          console.warn(`  [crom] Rate limited, waiting ${wait / 1000}s...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      const json = await res.json();
      if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
      return json.data;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      console.warn(`  [crom] Attempt ${attempt} failed: ${err instanceof Error ? err.message : err}`);
      await new Promise(r => setTimeout(r, 3000 * attempt));
    }
  }
}

function extractFullname(url: string): string | null {
  const m = url.match(/wikidot\.com\/(.+)$/);
  return m ? m[1] : null;
}

// ═══════════════════════════════════════════════════════════
// Step 1: 从 CROM 全量拉取
// ═══════════════════════════════════════════════════════════

async function fetchCrom(): Promise<Map<string, CromPage>> {
  console.log('\n[1/5] 从 CROM GraphQL 全量拉取...');
  const t0 = Date.now();
  const pages = new Map<string, CromPage>();
  let after: string | null = null;
  let batch = 0;

  while (true) {
    const data = await cromRequest(FULL_QUERY, { first: BATCH_SIZE, after });
    const edges = data.pages.edges;
    if (edges.length === 0) break;

    for (const { node } of edges) {
      const fn = extractFullname(node.url);
      if (!fn) continue;

      const attrs = Array.isArray(node.attributions) ? node.attributions : [];
      const altTitles = Array.isArray(node.alternateTitles) ? node.alternateTitles : [];

      pages.set(fn, {
        fullname: fn,
        url: node.url,
        wikidotId: node.wikidotId != null ? Number(node.wikidotId) : null,
        title: node.title ?? null,
        rating: node.rating != null ? Number(node.rating) : null,
        voteCount: node.voteCount != null ? Number(node.voteCount) : null,
        revisionCount: node.revisionCount != null ? Number(node.revisionCount) : null,
        commentCount: node.commentCount != null ? Number(node.commentCount) : null,
        tags: node.tags || [],
        category: node.category ?? null,
        createdByName: node.createdBy?.displayName ?? null,
        createdByWikidotId: node.createdBy?.wikidotId != null ? Number(node.createdBy.wikidotId) : null,
        parentFullname: node.parent?.url ? extractFullname(node.parent.url) : null,
        alternateTitle: altTitles.length > 0 && altTitles[0]?.title ? altTitles[0].title : null,
        attributionCount: attrs.length,
        attributionTypes: [...new Set(attrs.map((a: any) => a.type).filter(Boolean))],
      });
    }

    batch++;
    after = data.pages.pageInfo.endCursor;
    if (batch % 50 === 0 || !data.pages.pageInfo.hasNextPage) {
      console.log(`  Batch ${batch}, pages: ${pages.size}, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }
    if (!data.pages.pageInfo.hasNextPage) break;
    if (batch % 10 === 0) await new Promise(r => setTimeout(r, 200));
  }

  console.log(`  Done: ${pages.size} pages in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return pages;
}

// ═══════════════════════════════════════════════════════════
// Step 2: 从 Syncer DB 读取 V2 快照
// ═══════════════════════════════════════════════════════════

async function fetchV2(prisma: InstanceType<typeof PrismaClient>): Promise<Map<string, any>> {
  console.log('\n[2/5] 从 Syncer DB 读取 V2 快照...');
  const snapshots = await prisma.pageSnapshot.findMany();
  const map = new Map();
  for (const s of snapshots) map.set(s.fullname, s);
  console.log(`  Done: ${map.size} snapshots`);
  return map;
}

// ═══════════════════════════════════════════════════════════
// Step 3: 从主库读取分析/排名数据
// ═══════════════════════════════════════════════════════════

async function fetchMainDb(pool: pg.Pool) {
  console.log('\n[3/5] 从主库 (scpper-cn) 读取分析数据...');

  // 3a. PageVersion (当前版本) — 含 attribution、alternateTitle、category、source 覆盖
  const { rows: pvRows } = await pool.query(`
    SELECT
      SUBSTRING(p."currentUrl" FROM '//[^/]+/(.+)$') AS fullname,
      p."wikidotId",
      p."isDeleted",
      pv.id AS pv_id,
      pv.title,
      pv.rating,
      pv."voteCount",
      pv."revisionCount",
      pv."commentCount",
      pv.tags,
      pv.category,
      pv."alternateTitle",
      pv."attributionCount",
      pv.source IS NOT NULL AS has_source,
      pv."textContent" IS NOT NULL AS has_text_content,
      pv."isDeleted" AS pv_is_deleted
    FROM "Page" p
    JOIN "PageVersion" pv ON pv."pageId" = p.id AND pv."validTo" IS NULL
    WHERE NOT p."isDeleted"
  `);

  const mainPages = new Map<string, any>();
  for (const r of pvRows) {
    if (!r.fullname) continue;
    mainPages.set(r.fullname, {
      wikidotId: r.wikidotId,
      pvId: r.pv_id,
      title: r.title,
      rating: r.rating != null ? Number(r.rating) : null,
      voteCount: r.voteCount != null ? Number(r.voteCount) : null,
      revisionCount: r.revisionCount != null ? Number(r.revisionCount) : null,
      commentCount: r.commentCount != null ? Number(r.commentCount) : null,
      tags: r.tags || [],
      category: r.category,
      alternateTitle: r.alternateTitle,
      attributionCount: r.attributionCount != null ? Number(r.attributionCount) : 0,
      hasSource: r.has_source,
      hasTextContent: r.has_text_content,
      pvIsDeleted: r.pv_is_deleted,
    });
  }
  console.log(`  PageVersions: ${mainPages.size}`);

  // 3b. Attribution 实际行数 (per pageVersion)
  const { rows: attrRows } = await pool.query(`
    SELECT pv.id AS pv_id, COUNT(*)::int AS attr_count
    FROM "Attribution" a
    JOIN "PageVersion" pv ON pv.id = a."pageVerId"
    JOIN "Page" p ON p.id = pv."pageId"
    WHERE pv."validTo" IS NULL AND NOT p."isDeleted"
    GROUP BY pv.id
  `);
  const attrCounts = new Map<number, number>();
  for (const r of attrRows) attrCounts.set(r.pv_id, r.attr_count);

  // 3c. Vote 实际行数 (per pageVersion)
  const { rows: voteRows } = await pool.query(`
    SELECT pv.id AS pv_id, COUNT(*)::int AS vote_count
    FROM "Vote" v
    JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
    JOIN "Page" p ON p.id = pv."pageId"
    WHERE pv."validTo" IS NULL AND NOT p."isDeleted"
    GROUP BY pv.id
  `);
  const voteCounts = new Map<number, number>();
  for (const r of voteRows) voteCounts.set(r.pv_id, r.vote_count);

  // 3d. Revision 实际行数 (per pageVersion)
  const { rows: revRows } = await pool.query(`
    SELECT pv.id AS pv_id, COUNT(*)::int AS rev_count
    FROM "Revision" r
    JOIN "PageVersion" pv ON pv.id = r."pageVersionId"
    JOIN "Page" p ON p.id = pv."pageId"
    WHERE pv."validTo" IS NULL AND NOT p."isDeleted"
    GROUP BY pv.id
  `);
  const revCounts = new Map<number, number>();
  for (const r of revRows) revCounts.set(r.pv_id, r.rev_count);

  // 3e. PageStats 覆盖率
  const { rows: [psStats] } = await pool.query(`
    SELECT
      COUNT(DISTINCT pv.id) AS total_pvs,
      COUNT(DISTINCT ps."pageVersionId") AS pvs_with_stats
    FROM "PageVersion" pv
    JOIN "Page" p ON p.id = pv."pageId"
    LEFT JOIN "PageStats" ps ON ps."pageVersionId" = pv.id
    WHERE pv."validTo" IS NULL AND NOT p."isDeleted" AND NOT pv."isDeleted"
  `);

  // 3f. 分析管道水位线
  const { rows: watermarks } = await pool.query(`
    SELECT task, "lastRunAt", "cursorTs" FROM "AnalysisWatermark"
    ORDER BY task
  `);

  // 3g. 排名 Top 20 (rating)
  const { rows: topRating } = await pool.query(`
    SELECT
      SUBSTRING(p."currentUrl" FROM '//[^/]+/(.+)$') AS fullname,
      pv.rating,
      pv."voteCount"
    FROM "PageVersion" pv
    JOIN "Page" p ON p.id = pv."pageId"
    WHERE pv."validTo" IS NULL AND NOT p."isDeleted" AND NOT pv."isDeleted"
    ORDER BY pv.rating DESC NULLS LAST
    LIMIT 20
  `);

  // 3h. SiteStats 最新
  const { rows: siteStats } = await pool.query(`
    SELECT * FROM "SiteStats" ORDER BY "createdAt" DESC LIMIT 1
  `);

  // 3i. Category 分布
  const { rows: catDist } = await pool.query(`
    SELECT pv.category, COUNT(*)::int AS cnt
    FROM "PageVersion" pv
    JOIN "Page" p ON p.id = pv."pageId"
    WHERE pv."validTo" IS NULL AND NOT p."isDeleted" AND NOT pv."isDeleted"
    GROUP BY pv.category
    ORDER BY cnt DESC
  `);

  console.log(`  Attributions loaded, Votes loaded, Revisions loaded`);
  console.log(`  PageStats coverage: ${psStats.pvs_with_stats}/${psStats.total_pvs}`);

  return { mainPages, attrCounts, voteCounts, revCounts, psStats, watermarks, topRating, siteStats, catDist };
}

// ═══════════════════════════════════════════════════════════
// Step 4: 全面对比
// ═══════════════════════════════════════════════════════════

function audit(
  crom: Map<string, CromPage>,
  v2: Map<string, any>,
  main: Awaited<ReturnType<typeof fetchMainDb>>,
) {
  const report: string[] = [];
  const log = (s: string) => { report.push(s); console.log(s); };

  log('\n══════════════════════════════════════════════════');
  log('          V1 (CROM) vs V2 (Syncer) vs 主库 全面审计');
  log('══════════════════════════════════════════════════\n');

  // ── A. 页面覆盖 ──
  log('── A. 页面覆盖 ──');
  log(`  CROM: ${crom.size}, V2: ${v2.size}, 主库: ${main.mainPages.size}`);

  const allFn = new Set([...crom.keys(), ...v2.keys(), ...main.mainPages.keys()]);
  let onlyCrom = 0, onlyV2 = 0, onlyMain = 0;
  let cromAndV2 = 0, cromAndMain = 0, v2AndMain = 0, all3 = 0;
  const cromOnlyList: string[] = [];
  const v2OnlyList: string[] = [];
  const mainOnlyList: string[] = [];

  for (const fn of allFn) {
    const inC = crom.has(fn);
    const inV = v2.has(fn);
    const inM = main.mainPages.has(fn);
    if (inC && inV && inM) { all3++; continue; }
    if (inC && inV && !inM) { cromAndV2++; continue; }
    if (inC && !inV && inM) { cromAndMain++; continue; }
    if (!inC && inV && inM) { v2AndMain++; continue; }
    if (inC && !inV && !inM) { onlyCrom++; cromOnlyList.push(fn); }
    if (!inC && inV && !inM) { onlyV2++; v2OnlyList.push(fn); }
    if (!inC && !inV && inM) { onlyMain++; mainOnlyList.push(fn); }
  }

  log(`  三方共有: ${all3}`);
  log(`  CROM+V2 (主库缺): ${cromAndV2}`);
  log(`  CROM+主库 (V2缺): ${cromAndMain}`);
  log(`  V2+主库 (CROM缺): ${v2AndMain}`);
  log(`  仅CROM: ${onlyCrom}`);
  log(`  仅V2: ${onlyV2}`);
  log(`  仅主库: ${onlyMain}`);

  if (cromOnlyList.length > 0) {
    log(`\n  CROM-only (${cromOnlyList.length}): ${cromOnlyList.slice(0, 10).join(', ')}${cromOnlyList.length > 10 ? '...' : ''}`);
  }
  if (mainOnlyList.length > 0) {
    log(`  主库-only (${mainOnlyList.length}): ${mainOnlyList.slice(0, 10).join(', ')}${mainOnlyList.length > 10 ? '...' : ''}`);
  }

  // ── B. 统计字段对比 (CROM vs V2 vs 主库, 三方共有页面) ──
  log('\n── B. 统计字段对比 (三方共有页面) ──');

  const stats = {
    ratingCromV2: { diff: 0, totalDelta: 0 },
    ratingCromMain: { diff: 0, totalDelta: 0 },
    ratingV2Main: { diff: 0, totalDelta: 0 },
    voteCromV2: { diff: 0, totalDelta: 0 },
    voteCromMain: { diff: 0, totalDelta: 0 },
    voteV2Main: { diff: 0, totalDelta: 0 },
    revCromV2: { diff: 0, totalDelta: 0 },
    revCromMain: { diff: 0, totalDelta: 0 },
    commentCromV2: { diff: 0, totalDelta: 0 },
    commentCromMain: { diff: 0, totalDelta: 0 },
  };

  const bigDiffs: Array<{ fn: string; pair: string; field: string; a: number; b: number; d: number }> = [];

  for (const fn of allFn) {
    const c = crom.get(fn);
    const v = v2.get(fn);
    const m = main.mainPages.get(fn);
    if (!c || !v || !m) continue;

    const compare = (pair: string, field: string, a: number | null, b: number | null, stat: typeof stats.ratingCromV2) => {
      if (a == null || b == null) return;
      const d = b - a;
      if (d !== 0) {
        stat.diff++;
        stat.totalDelta += d;
        if (Math.abs(d) >= 5) bigDiffs.push({ fn, pair, field, a, b, d });
      }
    };

    compare('CROM↔V2', 'rating', c.rating, v.rating, stats.ratingCromV2);
    compare('CROM↔主库', 'rating', c.rating, m.rating, stats.ratingCromMain);
    compare('V2↔主库', 'rating', v.rating, m.rating, stats.ratingV2Main);
    compare('CROM↔V2', 'voteCount', c.voteCount, v.votesCount, stats.voteCromV2);
    compare('CROM↔主库', 'voteCount', c.voteCount, m.voteCount, stats.voteCromMain);
    compare('V2↔主库', 'voteCount', v.votesCount, m.voteCount, stats.voteV2Main);
    compare('CROM↔V2', 'revisionCount', c.revisionCount, v.revisionsCount, stats.revCromV2);
    compare('CROM↔主库', 'revisionCount', c.revisionCount, m.revisionCount, stats.revCromMain);
    compare('CROM↔V2', 'commentCount', c.commentCount, v.commentsCount, stats.commentCromV2);
    compare('CROM↔主库', 'commentCount', c.commentCount, m.commentCount, stats.commentCromMain);
  }

  log(`  Rating:   CROM↔V2: ${stats.ratingCromV2.diff} diff (Δ${stats.ratingCromV2.totalDelta >= 0 ? '+' : ''}${stats.ratingCromV2.totalDelta}) | CROM↔主库: ${stats.ratingCromMain.diff} diff (Δ${stats.ratingCromMain.totalDelta >= 0 ? '+' : ''}${stats.ratingCromMain.totalDelta}) | V2↔主库: ${stats.ratingV2Main.diff} diff (Δ${stats.ratingV2Main.totalDelta >= 0 ? '+' : ''}${stats.ratingV2Main.totalDelta})`);
  log(`  Votes:    CROM↔V2: ${stats.voteCromV2.diff} diff (Δ${stats.voteCromV2.totalDelta >= 0 ? '+' : ''}${stats.voteCromV2.totalDelta}) | CROM↔主库: ${stats.voteCromMain.diff} diff (Δ${stats.voteCromMain.totalDelta >= 0 ? '+' : ''}${stats.voteCromMain.totalDelta}) | V2↔主库: ${stats.voteV2Main.diff} diff (Δ${stats.voteV2Main.totalDelta >= 0 ? '+' : ''}${stats.voteV2Main.totalDelta})`);
  log(`  Revision: CROM↔V2: ${stats.revCromV2.diff} diff (Δ${stats.revCromV2.totalDelta >= 0 ? '+' : ''}${stats.revCromV2.totalDelta}) | CROM↔主库: ${stats.revCromMain.diff} diff (Δ${stats.revCromMain.totalDelta >= 0 ? '+' : ''}${stats.revCromMain.totalDelta})`);
  log(`  Comment:  CROM↔V2: ${stats.commentCromV2.diff} diff (Δ${stats.commentCromV2.totalDelta >= 0 ? '+' : ''}${stats.commentCromV2.totalDelta}) | CROM↔主库: ${stats.commentCromMain.diff} diff (Δ${stats.commentCromMain.totalDelta >= 0 ? '+' : ''}${stats.commentCromMain.totalDelta})`);

  if (bigDiffs.length > 0) {
    log(`\n  差异 >= 5 的页面 (${bigDiffs.length}):`);
    bigDiffs.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
    for (const d of bigDiffs.slice(0, 20)) {
      log(`    ${d.fn} [${d.pair}] ${d.field}: ${d.a} → ${d.b} (${d.d >= 0 ? '+' : ''}${d.d})`);
    }
  }

  // ── C. Attribution 对比 ──
  log('\n── C. Attribution 对比 ──');

  let attrMatchCount = 0, attrMismatch = 0, attrMissing = 0, attrExtra = 0;
  const attrIssues: string[] = [];

  for (const [fn, c] of crom) {
    const m = main.mainPages.get(fn);
    if (!m) continue;

    const cromCount = c.attributionCount;
    const mainDbCount = main.attrCounts.get(m.pvId) ?? 0;
    const pvAttrCount = m.attributionCount ?? 0;

    if (cromCount === mainDbCount) {
      attrMatchCount++;
    } else if (cromCount > mainDbCount) {
      attrMissing++;
      if (cromCount - mainDbCount >= 2) {
        attrIssues.push(`${fn}: CROM=${cromCount} 主库=${mainDbCount} (缺${cromCount - mainDbCount})`);
      }
    } else {
      attrExtra++;
    }

    // 检查 PageVersion.attributionCount 是否和实际 Attribution 行数一致
    if (pvAttrCount !== mainDbCount && mainDbCount > 0) {
      attrMismatch++;
    }
  }

  log(`  匹配: ${attrMatchCount}, 主库缺少: ${attrMissing}, 主库多余: ${attrExtra}`);
  log(`  PageVersion.attributionCount 与实际不一致: ${attrMismatch}`);
  if (attrIssues.length > 0) {
    log(`  严重缺失 (差 >= 2, 前 15):`);
    for (const s of attrIssues.slice(0, 15)) log(`    ${s}`);
    if (attrIssues.length > 15) log(`    ... and ${attrIssues.length - 15} more`);
  }

  // ── D. AlternateTitle 对比 ──
  log('\n── D. AlternateTitle 对比 ──');

  let altMatch = 0, altCromOnly = 0, altMainOnly = 0, altDiff = 0;
  const altIssues: string[] = [];

  for (const [fn, c] of crom) {
    const m = main.mainPages.get(fn);
    if (!m) continue;

    const cromAlt = c.alternateTitle;
    const mainAlt = m.alternateTitle;

    if (!cromAlt && !mainAlt) { altMatch++; continue; }
    if (cromAlt && !mainAlt) { altCromOnly++; altIssues.push(`${fn}: CROM="${cromAlt}" 主库=NULL`); continue; }
    if (!cromAlt && mainAlt) { altMainOnly++; continue; }
    if (cromAlt === mainAlt) { altMatch++; continue; }
    altDiff++;
    altIssues.push(`${fn}: CROM="${cromAlt}" 主库="${mainAlt}"`);
  }

  log(`  匹配: ${altMatch}, CROM有主库无: ${altCromOnly}, 主库有CROM无: ${altMainOnly}, 内容不同: ${altDiff}`);
  if (altIssues.length > 0) {
    log(`  差异详情 (前 15):`);
    for (const s of altIssues.slice(0, 15)) log(`    ${s}`);
    if (altIssues.length > 15) log(`    ... and ${altIssues.length - 15} more`);
  }

  // ── E. Category 对比 ──
  log('\n── E. Category 对比 ──');

  let catMatch = 0, catDiff = 0, catNull = 0;
  const catIssues: string[] = [];

  for (const [fn, c] of crom) {
    const m = main.mainPages.get(fn);
    if (!m) continue;

    const cromCat = c.category;
    const mainCat = m.category;

    if (cromCat === '_default' && !mainCat) { catNull++; continue; }
    if (!cromCat && !mainCat) { catMatch++; continue; }
    if (cromCat === mainCat) { catMatch++; continue; }

    // CROM 的 category 是 wikidot 的 _default 等，主库的 category 是推断的 SCP/Tale/GOI 等
    // 这两个不是同一个概念，跳过不同类型的比较
    catNull++;
  }

  log(`  CROM category 是 wikidot 分类 (_default 等), 主库 category 是内容分类 (SCP/Tale/GOI)`);
  log(`  主库 category 分布:`);
  for (const r of main.catDist.slice(0, 10)) {
    log(`    ${r.category ?? 'NULL'}: ${r.cnt}`);
  }

  // ── F. Source / TextContent 覆盖率 ──
  log('\n── F. Source / TextContent 覆盖率 ──');

  let hasSource = 0, noSource = 0, hasText = 0, noText = 0;
  for (const [, m] of main.mainPages) {
    if (m.hasSource) hasSource++; else noSource++;
    if (m.hasTextContent) hasText++; else noText++;
  }
  log(`  有 source: ${hasSource} (${(hasSource / main.mainPages.size * 100).toFixed(1)}%)`);
  log(`  无 source: ${noSource}`);
  log(`  有 textContent: ${hasText} (${(hasText / main.mainPages.size * 100).toFixed(1)}%)`);
  log(`  无 textContent: ${noText}`);

  // ── G. Vote 表完整性 ──
  log('\n── G. Vote 表完整性 ──');

  let voteMatch = 0, voteLess = 0, voteMore = 0;
  let totalVoteCountSum = 0, totalVoteRecords = 0;
  const voteIssues: Array<{ fn: string; counted: number; actual: number; d: number }> = [];

  for (const [fn, m] of main.mainPages) {
    const counted = m.voteCount ?? 0;
    const actual = main.voteCounts.get(m.pvId) ?? 0;
    totalVoteCountSum += counted;
    totalVoteRecords += actual;

    if (counted === actual) { voteMatch++; continue; }
    const d = counted - actual;
    if (d > 0) voteLess++; else voteMore++;
    if (Math.abs(d) >= 10) voteIssues.push({ fn, counted, actual, d });
  }

  voteIssues.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  log(`  voteCount 总和: ${totalVoteCountSum}, 实际 Vote 行数: ${totalVoteRecords}`);
  log(`  匹配: ${voteMatch}, Vote行数 < voteCount: ${voteLess}, Vote行数 > voteCount: ${voteMore}`);
  if (voteIssues.length > 0) {
    log(`  差距 >= 10 的页面 (${voteIssues.length}, 前 15):`);
    for (const v of voteIssues.slice(0, 15)) {
      log(`    ${v.fn}: voteCount=${v.counted} 实际=${v.actual} (差${v.d >= 0 ? '+' : ''}${v.d})`);
    }
  }

  // ── H. Revision 表完整性 ──
  log('\n── H. Revision 表完整性 ──');

  let revMatch = 0, revLess = 0, revMore = 0;
  let totalRevCountSum = 0, totalRevRecords = 0;
  const revIssues: Array<{ fn: string; counted: number; actual: number; d: number }> = [];

  for (const [fn, m] of main.mainPages) {
    const counted = m.revisionCount ?? 0;
    const actual = main.revCounts.get(m.pvId) ?? 0;
    totalRevCountSum += counted;
    totalRevRecords += actual;

    if (counted === actual) { revMatch++; continue; }
    const d = counted - actual;
    if (d > 0) revLess++; else revMore++;
    if (Math.abs(d) >= 5) revIssues.push({ fn, counted, actual, d });
  }

  revIssues.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  log(`  revisionCount 总和: ${totalRevCountSum}, 实际 Revision 行数: ${totalRevRecords}`);
  log(`  匹配: ${revMatch}, Revision行数 < revisionCount: ${revLess}, Revision行数 > revisionCount: ${revMore}`);
  if (revIssues.length > 0) {
    log(`  差距 >= 5 的页面 (${revIssues.length}, 前 15):`);
    for (const r of revIssues.slice(0, 15)) {
      log(`    ${r.fn}: revisionCount=${r.counted} 实际=${r.actual} (差${r.d >= 0 ? '+' : ''}${r.d})`);
    }
  }

  // ── I. PageStats 覆盖与分析管道 ──
  log('\n── I. PageStats 覆盖与分析管道 ──');
  log(`  PageStats 覆盖: ${main.psStats.pvs_with_stats}/${main.psStats.total_pvs} (${(main.psStats.pvs_with_stats / main.psStats.total_pvs * 100).toFixed(1)}%)`);

  if (main.watermarks.length > 0) {
    log('  分析水位线:');
    for (const w of main.watermarks) {
      const lastRun = w.lastRunAt ? new Date(w.lastRunAt).toISOString() : 'never';
      const cursorTs = w.cursorTs ? new Date(w.cursorTs).toISOString() : 'never';
      log(`    ${w.task}: lastRun=${lastRun} cursor=${cursorTs}`);
    }
  }

  // ── J. Top 20 排名 ──
  log('\n── J. 主库 Top 20 Rating ──');
  for (let i = 0; i < main.topRating.length; i++) {
    const r = main.topRating[i];
    const cromPage = crom.get(r.fullname);
    const cromRating = cromPage?.rating ?? '?';
    const match = cromPage && cromPage.rating === Number(r.rating) ? '✓' : '✗';
    log(`  ${String(i + 1).padStart(2)}. ${r.fullname}: 主库=${r.rating} CROM=${cromRating} ${match} (votes=${r.voteCount})`);
  }

  // ── K. SiteStats ──
  if (main.siteStats.length > 0) {
    log('\n── K. SiteStats (最新) ──');
    const ss = main.siteStats[0];
    log(`  date: ${ss.date}, createdAt: ${ss.createdAt}`);
    for (const [k, v] of Object.entries(ss)) {
      if (k !== 'date' && k !== 'id' && k !== 'createdAt' && k !== 'updatedAt') {
        log(`  ${k}: ${v}`);
      }
    }
  }

  return report;
}

// ═══════════════════════════════════════════════════════════

async function main() {
  console.log('=== 全面审计: V1 (CROM) vs V2 (Syncer) vs 主库 ===');
  console.log(`时间: ${new Date().toISOString()}\n`);

  const syncerPrisma = new PrismaClient();
  const mainPool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    // 并发获取 V2 和主库数据，CROM 串行（受速率限制）
    const [cromPages, v2Pages, mainData] = await Promise.all([
      fetchCrom(),
      fetchV2(syncerPrisma),
      fetchMainDb(mainPool),
    ]);

    console.log('\n[4/5] 开始对比审计...');
    const report = audit(cromPages, v2Pages, mainData);

    // 保存报告
    const reportPath = '/tmp/v1-v2-full-audit.txt';
    fs.writeFileSync(reportPath, report.join('\n'));
    console.log(`\n[5/5] 报告已保存到 ${reportPath}`);

  } finally {
    await syncerPrisma.$disconnect();
    await mainPool.end();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
