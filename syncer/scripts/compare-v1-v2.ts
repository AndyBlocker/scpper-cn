/**
 * compare-v1-v2.ts — 从 CROM GraphQL (V1 数据源) 拉取全站数据，与 V2 syncer DB 对比
 *
 * 用法: node --import tsx/esm scripts/compare-v1-v2.ts
 *
 * 不修改任何生产数据库，结果输出到 /tmp/v1-v2-comparison.json
 */

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

import { PrismaClient } from '../node_modules/.prisma/syncer-client/index.js';

const CROM_ENDPOINT = 'https://apiv2.crom.avn.sh/graphql';
const BATCH_SIZE = 100;

// ── Types ──

interface CromPage {
  url: string;
  wikidotId: string | null;
  title: string | null;
  rating: number | null;
  voteCount: number | null;
  revisionCount: number | null;
  commentCount: number | null;
  tags: string[];
  category: string | null;
}

interface PageDiff {
  fullname: string;
  field: string;
  v1Value: unknown;
  v2Value: unknown;
  delta?: number;
}

// ── CROM GraphQL 查询 ──

const PHASE_A_QUERY = `
  query GetPagesBasic($first: Int!, $after: ID) {
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
          }
        }
        cursor
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

async function cromRequest(query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const maxRetries = 3;
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
          const wait = Math.min(30_000, 5000 * attempt);
          console.warn(`[crom] Rate limited, waiting ${wait / 1000}s...`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      const json = await res.json();
      if (json.errors) {
        throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
      }
      return json.data;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      console.warn(`[crom] Attempt ${attempt} failed: ${err instanceof Error ? err.message : err}, retrying...`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

// ── Step 1: 拉取 CROM 全量数据 ──

async function fetchAllCromPages(): Promise<Map<string, CromPage>> {
  console.log('[crom] Fetching all pages from CROM GraphQL...');
  const t0 = Date.now();
  const pages = new Map<string, CromPage>();
  let after: string | null = null;
  let batch = 0;

  while (true) {
    const data = await cromRequest(PHASE_A_QUERY, { first: BATCH_SIZE, after });
    const edges = data.pages.edges;
    if (edges.length === 0) break;

    for (const { node } of edges) {
      const fullname = extractFullname(node.url);
      if (!fullname) continue;
      pages.set(fullname, {
        url: node.url,
        wikidotId: node.wikidotId,
        title: node.title,
        rating: node.rating != null ? Number(node.rating) : null,
        voteCount: node.voteCount != null ? Number(node.voteCount) : null,
        revisionCount: node.revisionCount != null ? Number(node.revisionCount) : null,
        commentCount: node.commentCount != null ? Number(node.commentCount) : null,
        tags: node.tags || [],
        category: node.category,
      });
    }

    batch++;
    const hasNext = data.pages.pageInfo.hasNextPage;
    after = data.pages.pageInfo.endCursor;

    if (batch % 50 === 0 || !hasNext) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[crom] Batch ${batch}, pages: ${pages.size}, elapsed: ${elapsed}s`);
    }

    if (!hasNext) break;

    // 小延迟避免速率限制
    if (batch % 10 === 0) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[crom] Done: ${pages.size} pages in ${elapsed}s\n`);
  return pages;
}

// ── Step 2: 从 V2 syncer DB 读取数据 ──

async function fetchAllV2Pages(): Promise<Map<string, {
  fullname: string;
  wikidotId: number | null;
  title: string | null;
  rating: number;
  votesCount: number;
  revisionsCount: number;
  commentsCount: number;
  tags: string[];
}>> {
  console.log('[v2] Fetching all snapshots from syncer DB...');
  const prisma = new PrismaClient();
  try {
    const snapshots = await prisma.pageSnapshot.findMany();
    const map = new Map();
    for (const s of snapshots) {
      map.set(s.fullname, {
        fullname: s.fullname,
        wikidotId: s.wikidotId,
        title: s.title,
        rating: s.rating,
        votesCount: s.votesCount,
        revisionsCount: s.revisionsCount,
        commentsCount: s.commentsCount,
        tags: s.tags,
      });
    }
    console.log(`[v2] Done: ${map.size} snapshots\n`);
    return map;
  } finally {
    await prisma.$disconnect();
  }
}

// ── Step 3: 对比 ──

function compareData(
  cromPages: Map<string, CromPage>,
  v2Pages: Map<string, any>,
) {
  const cromOnly: string[] = [];
  const v2Only: string[] = [];
  const diffs: PageDiff[] = [];

  // V1-only
  for (const fn of cromPages.keys()) {
    if (!v2Pages.has(fn)) cromOnly.push(fn);
  }

  // V2-only
  for (const fn of v2Pages.keys()) {
    if (!cromPages.has(fn)) v2Only.push(fn);
  }

  // 共有页面对比
  const fieldMap: Array<{ v1Key: string; v2Key: string; label: string }> = [
    { v1Key: 'rating', v2Key: 'rating', label: 'rating' },
    { v1Key: 'voteCount', v2Key: 'votesCount', label: 'voteCount' },
    { v1Key: 'revisionCount', v2Key: 'revisionsCount', label: 'revisionCount' },
    { v1Key: 'commentCount', v2Key: 'commentsCount', label: 'commentCount' },
  ];

  const summary = {
    common: 0,
    ratingDiff: 0,
    voteDiff: 0,
    revisionDiff: 0,
    commentDiff: 0,
    totalRatingDelta: 0,
    totalVoteDelta: 0,
    totalRevisionDelta: 0,
    totalCommentDelta: 0,
  };

  for (const [fn, v1] of cromPages) {
    const v2 = v2Pages.get(fn);
    if (!v2) continue;
    summary.common++;

    for (const { v1Key, v2Key, label } of fieldMap) {
      const v1Val = (v1 as any)[v1Key];
      const v2Val = (v2 as any)[v2Key];
      if (v1Val == null || v2Val == null) continue;

      const delta = Number(v2Val) - Number(v1Val);
      if (delta !== 0) {
        if (label === 'rating') { summary.ratingDiff++; summary.totalRatingDelta += delta; }
        if (label === 'voteCount') { summary.voteDiff++; summary.totalVoteDelta += delta; }
        if (label === 'revisionCount') { summary.revisionDiff++; summary.totalRevisionDelta += delta; }
        if (label === 'commentCount') { summary.commentDiff++; summary.totalCommentDelta += delta; }

        if (Math.abs(delta) >= 3) {
          diffs.push({ fullname: fn, field: label, v1Value: v1Val, v2Value: v2Val, delta });
        }
      }
    }
  }

  return { cromOnly, v2Only, diffs, summary };
}

// ── Helpers ──

function extractFullname(url: string): string | null {
  const match = url.match(/wikidot\.com\/(.+)$/);
  return match ? match[1] : null;
}

// ── Main ──

async function main() {
  console.log('=== V1 (CROM) vs V2 (Syncer) 数据对比 ===\n');

  const [cromPages, v2Pages] = await Promise.all([
    fetchAllCromPages(),
    fetchAllV2Pages(),
  ]);

  const { cromOnly, v2Only, diffs, summary } = compareData(cromPages, v2Pages);

  // 输出汇总
  console.log('═══════════════════════════════════════');
  console.log(`CROM (V1) 总页面: ${cromPages.size}`);
  console.log(`Syncer (V2) 总页面: ${v2Pages.size}`);
  console.log(`共有页面: ${summary.common}`);
  console.log(`V1-only (CROM 有但 V2 没有): ${cromOnly.length}`);
  console.log(`V2-only (V2 有但 CROM 没有): ${v2Only.length}`);
  console.log('');

  console.log('── 统计字段差异汇总 ──');
  console.log(`rating 差异页面: ${summary.ratingDiff}  (总 delta: ${summary.totalRatingDelta >= 0 ? '+' : ''}${summary.totalRatingDelta})`);
  console.log(`voteCount 差异页面: ${summary.voteDiff}  (总 delta: ${summary.totalVoteDelta >= 0 ? '+' : ''}${summary.totalVoteDelta})`);
  console.log(`revisionCount 差异页面: ${summary.revisionDiff}  (总 delta: ${summary.totalRevisionDelta >= 0 ? '+' : ''}${summary.totalRevisionDelta})`);
  console.log(`commentCount 差异页面: ${summary.commentDiff}  (总 delta: ${summary.totalCommentDelta >= 0 ? '+' : ''}${summary.totalCommentDelta})`);

  // 大差异详情
  if (diffs.length > 0) {
    console.log('\n── 差异 >= 3 的页面 (按 |delta| 降序) ──');
    diffs.sort((a, b) => Math.abs(b.delta!) - Math.abs(a.delta!));

    const byField = new Map<string, PageDiff[]>();
    for (const d of diffs) {
      const list = byField.get(d.field) || [];
      list.push(d);
      byField.set(d.field, list);
    }

    for (const [field, fieldDiffs] of byField) {
      console.log(`\n  [${field}] (${fieldDiffs.length} pages with diff >= 3):`);
      for (const d of fieldDiffs.slice(0, 15)) {
        console.log(`    ${d.fullname}: V1=${d.v1Value} V2=${d.v2Value} (${d.delta! >= 0 ? '+' : ''}${d.delta})`);
      }
      if (fieldDiffs.length > 15) {
        console.log(`    ... and ${fieldDiffs.length - 15} more`);
      }
    }
  }

  // V1-only 页面
  if (cromOnly.length > 0) {
    console.log(`\n── V1-only 页面 (前 30) ──`);
    cromOnly.sort();
    for (const fn of cromOnly.slice(0, 30)) {
      const p = cromPages.get(fn)!;
      console.log(`  ${fn} (wid=${p.wikidotId}, rating=${p.rating}, votes=${p.voteCount})`);
    }
    if (cromOnly.length > 30) console.log(`  ... and ${cromOnly.length - 30} more`);
  }

  // V2-only 页面
  if (v2Only.length > 0) {
    console.log(`\n── V2-only 页面 (前 30) ──`);
    v2Only.sort();
    for (const fn of v2Only.slice(0, 30)) {
      const p = v2Pages.get(fn)!;
      console.log(`  ${fn} (wid=${p.wikidotId ?? 'null'}, rating=${p.rating}, votes=${p.votesCount})`);
    }
    if (v2Only.length > 30) console.log(`  ... and ${v2Only.length - 30} more`);
  }

  // 保存完整结果到 JSON
  const output = {
    timestamp: new Date().toISOString(),
    cromTotal: cromPages.size,
    v2Total: v2Pages.size,
    summary,
    cromOnly: cromOnly.map(fn => ({ fullname: fn, ...cromPages.get(fn)! })),
    v2Only: v2Only.map(fn => ({ fullname: fn, ...v2Pages.get(fn)! })),
    significantDiffs: diffs,
  };

  const fs = await import('fs');
  fs.writeFileSync('/tmp/v1-v2-comparison.json', JSON.stringify(output, null, 2));
  console.log('\n完整结果已保存到 /tmp/v1-v2-comparison.json');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
