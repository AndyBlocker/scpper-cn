#!/usr/bin/env node
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.ts';

const TARGET_SUBSTRING = 'local--files';
const IMAGE_EXTENSION_PATTERN = '(?:jpe?g|png|gif|webp|bmp|tiff?|ico|svgz?|avif|apng|heic|heif|jfif|pjpeg)';

function parseTopLimit(): number {
  const args = process.argv.slice(2);
  for (const arg of args) {
    if (arg.startsWith('--top=')) {
      const value = Number.parseInt(arg.slice('--top='.length), 10);
      if (!Number.isNaN(value) && value > 0) return value;
    }
    if (/^\d+$/.test(arg)) {
      const value = Number.parseInt(arg, 10);
      if (!Number.isNaN(value) && value > 0) return value;
    }
  }
  return 20;
}

async function main() {
  const prisma = getPrismaClient();
  const topLimit = parseTopLimit();
  const matchPattern = `%${TARGET_SUBSTRING}%`;

  type AggregateRow = {
    total_rows: bigint;
    matched_rows: bigint;
    total_hits: bigint;
  };

  const aggregateResult = await prisma.$queryRaw<AggregateRow[]>`
    SELECT
      COUNT(*)::bigint AS total_rows,
      COUNT(*) FILTER (WHERE pv.source LIKE ${matchPattern})::bigint AS matched_rows,
      COALESCE(SUM((length(pv.source) - length(replace(pv.source, ${TARGET_SUBSTRING}, ''))) / NULLIF(length(${TARGET_SUBSTRING}), 0)), 0)::bigint AS total_hits
    FROM "PageVersion" pv
  `;

  const aggregate = aggregateResult[0];
  if (!aggregate) {
    console.log('No PageVersion records found.');
    return;
  }

  console.log('=== local--files occurrences in PageVersion.source ===');
  console.log(`Total PageVersion rows   : ${aggregate.total_rows.toString()}`);
  console.log(`Rows containing substring: ${aggregate.matched_rows.toString()}`);
  console.log(`Total occurrences        : ${aggregate.total_hits.toString()}`);

  type TopRow = {
    id: number;
    pageId: number;
    wikidotId: number | null;
    title: string | null;
    hits: number;
  };

  if (aggregate.matched_rows > 0n) {
    const topRows = await prisma.$queryRaw<TopRow[]>`
      SELECT
        pv.id,
        pv."pageId",
        pv."wikidotId",
        pv.title,
        ((length(pv.source) - length(replace(pv.source, ${TARGET_SUBSTRING}, ''))) / NULLIF(length(${TARGET_SUBSTRING}), 0))::int AS hits
      FROM "PageVersion" pv
      WHERE pv.source LIKE ${matchPattern}
      ORDER BY hits DESC, pv.id DESC
      LIMIT ${topLimit}
    `;

    if (topRows.length > 0) {
      console.log(`\nTop ${topRows.length} PageVersions by substring occurrences:`);
      console.table(topRows.map(row => ({
        pageVersionId: row.id,
        pageId: row.pageId,
        wikidotId: row.wikidotId ?? '-',
        title: row.title ?? '(untitled)',
        hits: row.hits
      })));
    }
  }

  // Extract, normalise, and classify URL-like tokens (handles missing protocols and inline data URIs)
  const sharedUrlExtractionCte = String.raw`
WITH raw_candidates AS (
  SELECT pv.id AS page_version_id,
         m.matches[1] AS raw_url
  FROM "PageVersion" pv
  CROSS JOIN LATERAL regexp_matches(
    pv.source,
    E'((?:https?://[^\\s"''<>]+|//[^\\s"''<>]+|(?:[A-Za-z0-9-]+\\.)+[A-Za-z]{2,63}(?::\\d+)?/[^\\s"''<>]+|local--files[^\\s"''<>]+|data:image/[^,]+,[^\\s"''<>]+))',
    'g'
  ) AS m(matches)
  WHERE pv.source ~ E'(https?://|//|\\b(?:[A-Za-z0-9-]+\\.)+[A-Za-z]{2,63}/|local--files|data:image/)'
),
sanitized AS (
  SELECT
    page_version_id,
    regexp_replace(
      regexp_replace(raw_url, E'^[\\[({<"''“”‘’]+', ''),
      E'[\\])}>"''“”‘’.,;:!?|]+$',
      ''
    ) AS sanitized_url
  FROM raw_candidates
  WHERE raw_url IS NOT NULL AND raw_url <> ''
),
normed AS (
  SELECT
    page_version_id,
    sanitized_url,
    lower(
      regexp_replace(
        regexp_replace(sanitized_url, E'[?#][^\\s"''<>]*$', ''),
        E'[\\])}>"''“”‘’.,;:!?|]+$',
        ''
      )
    ) AS normalized_base
  FROM sanitized
  WHERE sanitized_url <> ''
),
canonical AS (
  SELECT
    n.page_version_id,
    n.sanitized_url,
    CASE
      WHEN n.normalized_base ~ '^data:image/' THEN n.normalized_base
      WHEN n.normalized_base ~ '^local--files/' THEN 'https://scp-wiki-cn.wdfiles.com/' || n.normalized_base
      WHEN n.normalized_base ~ '^https?://' THEN regexp_replace(n.normalized_base, '^http://', 'https://')
      WHEN n.normalized_base ~ '^//' THEN regexp_replace(n.normalized_base, '^//', 'https://')
      WHEN n.normalized_base ~ '^(?:[a-z0-9-]+\\.)+[a-z]{2,63}(?::\\d+)?/.*'
        THEN 'https://' || n.normalized_base
      ELSE n.normalized_base
    END AS normalized_url,
    CASE
      WHEN n.sanitized_url ~ '^data:image/' THEN n.sanitized_url
      WHEN n.sanitized_url ~ '^https?://'
        THEN regexp_replace(n.sanitized_url, '^http://', 'https://')
      WHEN n.sanitized_url ~ '^//'
        THEN 'https:' || n.sanitized_url
      WHEN n.sanitized_url ~ '^local--files/' THEN 'https://scp-wiki-cn.wdfiles.com/' || n.sanitized_url
      WHEN n.sanitized_url ~ '^(?:[A-Za-z0-9-]+\\.)+[A-Za-z]{2,63}(?::\\d+)?/.*'
        THEN 'https://' || n.sanitized_url
      ELSE n.sanitized_url
    END AS display_url
  FROM normed n
),
filtered AS (
  SELECT
    page_version_id,
    sanitized_url,
    display_url,
    normalized_url
  FROM canonical
  WHERE normalized_url <> ''
    AND (
      normalized_url LIKE 'https://scp-wiki-cn.wdfiles.com/local--files/%'
      OR normalized_url LIKE '%/local--files/%'
      OR normalized_url ~ E'\\.${IMAGE_EXTENSION_PATTERN}$'
    )
)`;

  type UrlSummaryRow = {
    unique_count: bigint;
    total_occurrences: bigint;
    image_unique_without_local: bigint;
    image_occurrences_without_local: bigint;
  };

  const urlSummaryQuery = `${sharedUrlExtractionCte}
SELECT
  COUNT(DISTINCT normalized_url)::bigint AS unique_count,
  COUNT(*)::bigint AS total_occurrences,
  COUNT(DISTINCT normalized_url) FILTER (
    WHERE normalized_url ~ E'\\.${IMAGE_EXTENSION_PATTERN}$'
      AND normalized_url NOT LIKE 'https://scp-wiki-cn.wdfiles.com/local--files/%'
      AND normalized_url NOT LIKE '%/local--files/%'
  )::bigint AS image_unique_without_local,
  COUNT(*) FILTER (
    WHERE normalized_url ~ E'\\.${IMAGE_EXTENSION_PATTERN}$'
      AND normalized_url NOT LIKE 'https://scp-wiki-cn.wdfiles.com/local--files/%'
      AND normalized_url NOT LIKE '%/local--files/%'
  )::bigint AS image_occurrences_without_local
FROM filtered;`;

  const urlSummaryResult = await prisma.$queryRawUnsafe<UrlSummaryRow[]>(urlSummaryQuery);
  const urlSummary = urlSummaryResult[0];

  if (urlSummary) {
    console.log('\n=== Deduped URLs (local--files or image assets) ===');
    console.log(`Total unique URLs         : ${urlSummary.unique_count.toString()}`);
    console.log(`Total occurrences         : ${urlSummary.total_occurrences.toString()}`);
    console.log(`Image URLs w/o local--files : ${urlSummary.image_unique_without_local.toString()} unique / ${urlSummary.image_occurrences_without_local.toString()} hits`);

    if (urlSummary.unique_count > 0n) {
      type UrlTopRow = {
        normalized_url: string;
        canonical_url: string;
        original_url: string;
        occurrences: bigint;
        page_versions: bigint;
      };

      const urlTopQuery = `${sharedUrlExtractionCte}
SELECT
  normalized_url,
  (ARRAY_AGG(display_url ORDER BY (display_url ~ '^https://')::int DESC, (display_url ~ '^http://')::int DESC, (display_url ~ '^local--files/')::int ASC, char_length(display_url), display_url))[1] AS canonical_url,
  (ARRAY_AGG(sanitized_url ORDER BY (sanitized_url ~ '^https?://')::int DESC, (sanitized_url ~ '^//')::int DESC, char_length(sanitized_url), sanitized_url))[1] AS original_url,
  COUNT(*)::bigint AS occurrences,
  COUNT(DISTINCT page_version_id)::bigint AS page_versions
FROM filtered
GROUP BY normalized_url
ORDER BY occurrences DESC, normalized_url ASC
LIMIT ${topLimit};`;

      const urlTopRows = await prisma.$queryRawUnsafe<UrlTopRow[]>(urlTopQuery);
      if (urlTopRows.length > 0) {
        console.log(`\nTop ${urlTopRows.length} URLs by occurrence count:`);
        console.table(urlTopRows.map(row => ({
          canonicalUrl: row.canonical_url,
          originalUrl: row.original_url,
          occurrences: Number(row.occurrences),
          pageVersions: Number(row.page_versions)
        })));
      }
    }
  }
}

main().catch(error => {
  console.error('Failed to scan PageVersion source:', error);
  process.exitCode = 1;
}).finally(async () => {
  try {
    await disconnectPrisma();
  } catch (disconnectError) {
    console.error('Failed to disconnect Prisma client:', disconnectError);
  }
});
