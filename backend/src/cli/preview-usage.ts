import { Prisma, PrismaClient } from '@prisma/client';
import { disconnectPrisma, getPrismaClient } from '../utils/db-connection.js';

type UsageStats = {
  label: string;
  occurrences: bigint;
  rowsWithHits: bigint;
  pageVersionCount: bigint;
  pageCount: bigint;
  occurrencesWithPreviewParam: bigint;
  rowsWithPreviewParam: bigint;
  pageVersionsWithPreviewParam: bigint;
  pagesWithPreviewParam: bigint;
};

type LegacyStats = {
  label: string;
  occurrences: bigint;
  rowsWithHits: bigint;
  pageVersionCount: bigint;
  pageCount: bigint;
};

function formatCount(v: bigint | number | null | undefined): string {
  if (v == null) return '0';
  const s = typeof v === 'bigint' ? v.toString() : Math.trunc(v).toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

async function getModuleIncludeStatsFromPageVersion(prisma: PrismaClient): Promise<UsageStats> {
  const sql = Prisma.sql`
    WITH blocks AS (
      SELECT
        pv.id AS "rowId",
        pv.id AS "pageVersionId",
        pv."pageId" AS "pageId",
        match[1] AS content
      FROM "PageVersion" pv
      CROSS JOIN LATERAL regexp_matches(COALESCE(pv.source, ''), '\\[\\[include(.|\\n)*?scpper-tracking-module(.|\\n)*?\\]\\]', 'gi') AS match
    )
    SELECT
      'PageVersion.source'::text AS label,
      COUNT(*)::bigint AS occurrences,
      COUNT(DISTINCT "rowId")::bigint AS "rowsWithHits",
      COUNT(DISTINCT "pageVersionId")::bigint AS "pageVersionCount",
      COUNT(DISTINCT "pageId")::bigint AS "pageCount",
      COUNT(*) FILTER (WHERE content ~* 'scpper-preview\\s*=')::bigint AS "occurrencesWithPreviewParam",
      COUNT(DISTINCT "rowId") FILTER (WHERE content ~* 'scpper-preview\\s*=')::bigint AS "rowsWithPreviewParam",
      COUNT(DISTINCT "pageVersionId") FILTER (WHERE content ~* 'scpper-preview\\s*=')::bigint AS "pageVersionsWithPreviewParam",
      COUNT(DISTINCT "pageId") FILTER (WHERE content ~* 'scpper-preview\\s*=')::bigint AS "pagesWithPreviewParam"
    FROM blocks;
  `;
  const rows = await prisma.$queryRaw<UsageStats[]>(sql);
  return rows[0];
}

async function getModuleIncludeStatsFromSourceVersion(prisma: PrismaClient): Promise<UsageStats> {
  const sql = Prisma.sql`
    WITH blocks AS (
      SELECT
        sv.id AS "rowId",
        sv."pageVersionId" AS "pageVersionId",
        pv."pageId" AS "pageId",
        match[1] AS content
      FROM "SourceVersion" sv
      JOIN "PageVersion" pv ON pv.id = sv."pageVersionId"
      CROSS JOIN LATERAL regexp_matches(COALESCE(sv.source, ''), '\\[\\[include(.|\\n)*?scpper-tracking-module(.|\\n)*?\\]\\]', 'gi') AS match
    )
    SELECT
      'SourceVersion.source'::text AS label,
      COUNT(*)::bigint AS occurrences,
      COUNT(DISTINCT "rowId")::bigint AS "rowsWithHits",
      COUNT(DISTINCT "pageVersionId")::bigint AS "pageVersionCount",
      COUNT(DISTINCT "pageId")::bigint AS "pageCount",
      COUNT(*) FILTER (WHERE content ~* 'scpper-preview\\s*=')::bigint AS "occurrencesWithPreviewParam",
      COUNT(DISTINCT "rowId") FILTER (WHERE content ~* 'scpper-preview\\s*=')::bigint AS "rowsWithPreviewParam",
      COUNT(DISTINCT "pageVersionId") FILTER (WHERE content ~* 'scpper-preview\\s*=')::bigint AS "pageVersionsWithPreviewParam",
      COUNT(DISTINCT "pageId") FILTER (WHERE content ~* 'scpper-preview\\s*=')::bigint AS "pagesWithPreviewParam"
    FROM blocks;
  `;
  const rows = await prisma.$queryRaw<UsageStats[]>(sql);
  return rows[0];
}

async function getLegacyPreviewStatsFromPageVersion(prisma: PrismaClient): Promise<LegacyStats> {
  const sql = Prisma.sql`
    WITH matches AS (
      SELECT
        pv.id AS "rowId",
        pv.id AS "pageVersionId",
        pv."pageId" AS "pageId"
      FROM "PageVersion" pv
      CROSS JOIN LATERAL regexp_matches(COALESCE(pv.source, ''), 'SCPPER_CN_PREVIEW_BEGIN', 'gi') AS match
    )
    SELECT
      'PageVersion.source (legacy markers)'::text AS label,
      COUNT(*)::bigint AS occurrences,
      COUNT(DISTINCT "rowId")::bigint AS "rowsWithHits",
      COUNT(DISTINCT "pageVersionId")::bigint AS "pageVersionCount",
      COUNT(DISTINCT "pageId")::bigint AS "pageCount"
    FROM matches;
  `;
  const rows = await prisma.$queryRaw<LegacyStats[]>(sql);
  return rows[0];
}

async function getLegacyPreviewStatsFromSourceVersion(prisma: PrismaClient): Promise<LegacyStats> {
  const sql = Prisma.sql`
    WITH matches AS (
      SELECT
        sv.id AS "rowId",
        sv."pageVersionId" AS "pageVersionId",
        pv."pageId" AS "pageId"
      FROM "SourceVersion" sv
      JOIN "PageVersion" pv ON pv.id = sv."pageVersionId"
      CROSS JOIN LATERAL regexp_matches(COALESCE(sv.source, ''), 'SCPPER_CN_PREVIEW_BEGIN', 'gi') AS match
    )
    SELECT
      'SourceVersion.source (legacy markers)'::text AS label,
      COUNT(*)::bigint AS occurrences,
      COUNT(DISTINCT "rowId")::bigint AS "rowsWithHits",
      COUNT(DISTINCT "pageVersionId")::bigint AS "pageVersionCount",
      COUNT(DISTINCT "pageId")::bigint AS "pageCount"
    FROM matches;
  `;
  const rows = await prisma.$queryRaw<LegacyStats[]>(sql);
  return rows[0];
}

async function getSamplePagesMissingPreviewParam(prisma: PrismaClient, limit = 20): Promise<{ wikidotId: number | null; url: string | null }[]> {
  const sql = Prisma.sql`
    SELECT DISTINCT ON (pv."pageId")
      COALESCE(pv."wikidotId", p."wikidotId") AS "wikidotId",
      p."currentUrl" AS url
    FROM "PageVersion" pv
    JOIN "Page" p ON p.id = pv."pageId"
    WHERE COALESCE(pv.source, '') ~* '\\[\\[include(.|\\n)*?scpper-tracking-module(.|\\n)*?\\]\\]'
      AND COALESCE(pv.source, '') !~* 'scpper-preview\\s*='
    ORDER BY pv."pageId", pv."validFrom" DESC NULLS LAST, pv.id DESC
    LIMIT ${limit}
  `;
  const rows = await prisma.$queryRaw<{ wikidotId: number | null; url: string | null }[]>(sql);
  return rows;
}

async function getSamplePagesWithPreviewParam(prisma: PrismaClient, limit = 20): Promise<{ wikidotId: number | null; url: string | null }[]> {
  const sql = Prisma.sql`
    SELECT DISTINCT ON (pv."pageId")
      COALESCE(pv."wikidotId", p."wikidotId") AS "wikidotId",
      p."currentUrl" AS url
    FROM "PageVersion" pv
    JOIN "Page" p ON p.id = pv."pageId"
    WHERE COALESCE(pv.source, '') ~* '\\[\\[include(.|\\n)*?scpper-tracking-module(.|\\n)*?\\]\\]'
      AND COALESCE(pv.source, '') ~* 'scpper-preview\\s*='
    ORDER BY pv."pageId", pv."validFrom" DESC NULLS LAST, pv.id DESC
    LIMIT ${limit}
  `;
  return prisma.$queryRaw<{ wikidotId: number | null; url: string | null }[]>(sql);
}

function printUsageStats(rows: (UsageStats | LegacyStats)[], header: string) {
  console.log(`\n${header}`);
  if (!rows || rows.length === 0) {
    console.log('  (no data)');
    return;
  }
  for (const r of rows) {
    // Base
    const base = `  ${r.label}\n    - Rows: ${formatCount((r as any).rowsWithHits)}\n    - PageVersions: ${formatCount((r as any).pageVersionCount)}\n    - Pages: ${formatCount((r as any).pageCount)}\n    - Occurrences: ${formatCount((r as any).occurrences)}`;
    // Extended (only for include stats)
    const ext = (r as UsageStats).occurrencesWithPreviewParam !== undefined
      ? `\n    - With scpper-preview (occurrences): ${formatCount((r as UsageStats).occurrencesWithPreviewParam)}\n    - With scpper-preview (pageVersions): ${formatCount((r as UsageStats).pageVersionsWithPreviewParam)}\n    - With scpper-preview (pages): ${formatCount((r as UsageStats).pagesWithPreviewParam)}`
      : '';
    console.log(base + ext);
  }
}

export async function previewUsage(): Promise<void> {
  const prisma = getPrismaClient();
  try {
    console.log('Analyzing scpper-tracking-module and preview usage...');

    const [
      pvInclude, svInclude,
      pvLegacy, svLegacy,
    ] = await Promise.all([
      getModuleIncludeStatsFromPageVersion(prisma),
      getModuleIncludeStatsFromSourceVersion(prisma),
      getLegacyPreviewStatsFromPageVersion(prisma),
      getLegacyPreviewStatsFromSourceVersion(prisma),
    ]);

    printUsageStats([pvInclude, svInclude], 'Include: scpper-tracking-module usage');
    printUsageStats([pvLegacy, svLegacy], 'Legacy preview markers usage');

    const missingSamples = await getSamplePagesMissingPreviewParam(prisma, 20);
    console.log('\nSample pages missing scpper-preview param (up to 20):');
    if (missingSamples.length === 0) {
      console.log('  (none found)');
    } else {
      for (const r of missingSamples) {
        const id = r.wikidotId != null ? String(r.wikidotId) : '?';
        console.log(`  - ${id} | ${r.url ?? ''}`);
      }
    }

    const presentSamples = await getSamplePagesWithPreviewParam(prisma, 10);
    console.log('\nSample pages with scpper-preview param (up to 10):');
    if (presentSamples.length === 0) {
      console.log('  (none found)');
    } else {
      for (const r of presentSamples) {
        const id = r.wikidotId != null ? String(r.wikidotId) : '?';
        console.log(`  - ${id} | ${r.url ?? ''}`);
      }
    }

  } catch (error: any) {
    console.error('Failed to compute preview/module usage:', error?.message ?? error);
    process.exitCode = 1;
  } finally {
    await disconnectPrisma();
  }
}

// When executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  previewUsage();
}

