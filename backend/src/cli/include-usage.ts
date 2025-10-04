import { Prisma, PrismaClient } from '@prisma/client';
import { disconnectPrisma, getPrismaClient } from '../utils/db-connection.js';

const DEFAULT_SITE = 'scp-wiki-cn';
const INCLUDE_PATTERN = String.raw`\[\[include\s*:(?:([a-zA-Z0-9_-]+):)?components?(?::[^\]\r\n]+)?\]\]`;

type ComponentIncludeStatsRow = {
  site: string;
  occurrences: bigint;
  rowsWithHits: bigint;
  pageVersionCount: bigint;
  pageCount: bigint;
};

type DatasetStats = {
  label: string;
  rows: ComponentIncludeStatsRow[];
};

function formatCount(value: bigint | number | null | undefined): string {
  if (value === null || value === undefined) {
    return '0';
  }
  const raw = typeof value === 'bigint' ? value.toString() : Math.trunc(value).toString();
  return raw.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function sumBigInt(rows: ComponentIncludeStatsRow[], selector: (row: ComponentIncludeStatsRow) => bigint): bigint {
  return rows.reduce((total, row) => total + selector(row), 0n);
}

async function getSourceVersionComponentStats(
  prisma: PrismaClient,
  pattern: string,
  defaultSite: string
): Promise<ComponentIncludeStatsRow[]> {
  const query = Prisma.sql`
    WITH matches AS (
      SELECT
        COALESCE(NULLIF(match[1], ''), ${defaultSite}) AS site,
        sv.id AS "rowId",
        sv."pageVersionId",
        pv."pageId"
      FROM "SourceVersion" sv
      JOIN "PageVersion" pv ON pv.id = sv."pageVersionId"
      CROSS JOIN LATERAL regexp_matches(COALESCE(sv.source, ''), ${pattern}, 'gi') AS match
    )
    SELECT
      site,
      COUNT(*)::bigint AS "occurrences",
      COUNT(DISTINCT "rowId")::bigint AS "rowsWithHits",
      COUNT(DISTINCT "pageVersionId")::bigint AS "pageVersionCount",
      COUNT(DISTINCT "pageId")::bigint AS "pageCount"
    FROM matches
    GROUP BY site
    ORDER BY "occurrences" DESC, site ASC;
  `;
  return prisma.$queryRaw<ComponentIncludeStatsRow[]>(query);
}

async function getPageVersionComponentStats(
  prisma: PrismaClient,
  pattern: string,
  defaultSite: string,
  column: 'source' | 'textContent'
): Promise<ComponentIncludeStatsRow[]> {
  const columnRef = column === 'source' ? Prisma.raw('pv.source') : Prisma.raw('pv."textContent"');

  const query = Prisma.sql`
    WITH matches AS (
      SELECT
        COALESCE(NULLIF(match[1], ''), ${defaultSite}) AS site,
        pv.id AS "rowId",
        pv.id AS "pageVersionId",
        pv."pageId"
      FROM "PageVersion" pv
      CROSS JOIN LATERAL regexp_matches(COALESCE(${columnRef}, ''), ${pattern}, 'gi') AS match
    )
    SELECT
      site,
      COUNT(*)::bigint AS "occurrences",
      COUNT(DISTINCT "rowId")::bigint AS "rowsWithHits",
      COUNT(DISTINCT "pageVersionId")::bigint AS "pageVersionCount",
      COUNT(DISTINCT "pageId")::bigint AS "pageCount"
    FROM matches
    GROUP BY site
    ORDER BY "occurrences" DESC, site ASC;
  `;

  return prisma.$queryRaw<ComponentIncludeStatsRow[]>(query);
}

function printDatasetStats({ label, rows }: DatasetStats): void {
  console.log(`\n${label}`);
  if (!rows.length) {
    console.log('  (no matches)');
    return;
  }

  const siteColWidth = 28;
  const colWidth = 14;
  const header =
    `  ${'Site'.padEnd(siteColWidth)}` +
    `${'Rows'.padStart(colWidth)}` +
    `${'PageVersions'.padStart(colWidth)}` +
    `${'Pages'.padStart(colWidth)}` +
    `${'Occurrences'.padStart(colWidth)}`;

  console.log(header);
  console.log('  '.padEnd(siteColWidth + colWidth * 4, '-'));

  for (const row of rows) {
    console.log(
      `  ${row.site.padEnd(siteColWidth)}` +
      `${formatCount(row.rowsWithHits).padStart(colWidth)}` +
      `${formatCount(row.pageVersionCount).padStart(colWidth)}` +
      `${formatCount(row.pageCount).padStart(colWidth)}` +
      `${formatCount(row.occurrences).padStart(colWidth)}`
    );
  }

  const totalRows = formatCount(sumBigInt(rows, (row) => row.rowsWithHits));
  const totalPageVersions = formatCount(sumBigInt(rows, (row) => row.pageVersionCount));
  const totalPages = formatCount(sumBigInt(rows, (row) => row.pageCount));
  const totalOccurrences = formatCount(sumBigInt(rows, (row) => row.occurrences));

  console.log('  '.padEnd(siteColWidth + colWidth * 4, '-'));
  console.log(
    `  ${'Total'.padEnd(siteColWidth)}` +
    `${totalRows.padStart(colWidth)}` +
    `${totalPageVersions.padStart(colWidth)}` +
    `${totalPages.padStart(colWidth)}` +
    `${totalOccurrences.padStart(colWidth)}`
  );
}

export async function countComponentIncludeUsage(options: { defaultSite?: string } = {}): Promise<void> {
  const defaultSite = (options.defaultSite ?? DEFAULT_SITE).trim() || DEFAULT_SITE;
  const prisma = getPrismaClient();

  try {
    console.log(`Analyzing [[include :site:components]] usage (default site: ${defaultSite})`);

    const [sourceVersionStats, pageVersionSourceStats, pageVersionTextStats] = await Promise.all([
      getSourceVersionComponentStats(prisma, INCLUDE_PATTERN, defaultSite),
      getPageVersionComponentStats(prisma, INCLUDE_PATTERN, defaultSite, 'source'),
      getPageVersionComponentStats(prisma, INCLUDE_PATTERN, defaultSite, 'textContent')
    ]);

    printDatasetStats({ label: 'SourceVersion.source', rows: sourceVersionStats });
    printDatasetStats({ label: 'PageVersion.source', rows: pageVersionSourceStats });
    printDatasetStats({ label: 'PageVersion.textContent', rows: pageVersionTextStats });
  } catch (error) {
    console.error('Failed to compute component include usage statistics:', error);
    process.exitCode = 1;
  } finally {
    await disconnectPrisma();
  }
}
