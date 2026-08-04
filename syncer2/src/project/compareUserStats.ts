/**
 * M8 v1 public."UserStats" ↔ v2 serve.user_stats 只读逐字段对账。
 *
 * 两个连接都显式开启 REPEATABLE READ READ ONLY；v1 URL 只替换 v2 URL 的数据库名，
 * 不打印连接串。stdout 是一份可保存进交付证据的 JSON，stderr 只写日志。
 */

import { Command } from 'commander';
import pg from 'pg';
import { loadConfig } from '../config.js';
import { emitSummary, redirectConsoleToStderr } from '../util/log.js';

redirectConsoleToStderr();

const INTEGER_FIELDS = [
  'votes_received_up',
  'votes_received_down',
  'total_rating',
  'votes_cast_up',
  'votes_cast_down',
  'rating_scp',
  'count_scp',
  'rank_scp',
  'rating_translation',
  'count_translation',
  'rank_translation',
  'rating_goi',
  'count_goi',
  'rank_goi',
  'rating_story',
  'count_story',
  'rank_story',
  'rating_wanderers',
  'count_wanderers',
  'rank_wanderers',
  'rating_art',
  'count_art',
  'rank_art',
  'page_count',
  'rank_total',
] as const;
const FLOAT_FIELDS = ['overall_rating'] as const;
const RANK_FIELDS = new Set<string>([
  'rank_total',
  'rank_scp',
  'rank_translation',
  'rank_goi',
  'rank_story',
  'rank_wanderers',
  'rank_art',
]);
const CLASSIFICATIONS = [
  'scp',
  'translation',
  'goi',
  'story',
  'wanderers',
  'art',
] as const;

type IntegerField = (typeof INTEGER_FIELDS)[number];
type FloatField = (typeof FLOAT_FIELDS)[number];
type SharedField = IntegerField | FloatField;

interface StatsRow extends Record<SharedField, number | null> {
  user_id: number;
}

interface PageRow {
  page_id: number;
  slug: string;
  status_deleted: boolean;
  version_deleted?: boolean;
  tags: string[];
  category: string | null;
  rating: number;
}

interface UserPageRow {
  user_id: number;
  page_id: number;
}

interface CliOptions {
  v1DatabaseName: string;
  sampleLimit: number;
  floatTolerance: number;
}

function parseArgs(): CliOptions {
  const program = new Command();
  program
    .name('project:compare-v1')
    .description('只读逐字段对账 v1 UserStats 与 v2 serve.user_stats')
    .option('--v1-database-name <name>', 'v1 数据库名，默认 scpper-cn', 'scpper-cn')
    .option('--sample-limit <n>', '每字段最多输出几个差异 user_id，默认 12', Number, 12)
    .option('--float-tolerance <n>', 'overall_rating 绝对误差容忍，默认 0.0001', Number, 0.0001);
  program.parse(process.argv);
  const raw = program.opts<CliOptions>();
  if (!/^[A-Za-z0-9_-]+$/.test(raw.v1DatabaseName)) {
    throw new Error(`--v1-database-name 含非法字符：${raw.v1DatabaseName}`);
  }
  if (!Number.isSafeInteger(raw.sampleLimit) || raw.sampleLimit < 1 || raw.sampleLimit > 100) {
    throw new RangeError(`--sample-limit 必须在 1..100，收到 ${raw.sampleLimit}`);
  }
  if (
    !Number.isFinite(raw.floatTolerance)
    || raw.floatTolerance < 0
    || raw.floatTolerance > 0.1
  ) {
    throw new RangeError(`--float-tolerance 必须在 0..0.1，收到 ${raw.floatTolerance}`);
  }
  return raw;
}

function databaseUrl(base: string, databaseName: string, applicationName: string): string {
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  url.searchParams.set('application_name', applicationName);
  return url.toString();
}

function asNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`非数值字段：${String(value)}`);
  return parsed;
}

function containsAll(tags: readonly string[], required: readonly string[]): boolean {
  return required.every((tag) => tags.includes(tag));
}

function classification(page: PageRow, name: (typeof CLASSIFICATIONS)[number]): boolean {
  switch (name) {
    case 'scp':
      return containsAll(page.tags, ['原创', 'scp']);
    case 'translation':
      return !containsAll(page.tags, ['原创'])
        && !containsAll(page.tags, ['作者'])
        && !containsAll(page.tags, ['掩盖页'])
        && !containsAll(page.tags, ['段落'])
        && !containsAll(page.tags, ['补充材料'])
        && !['log-of-anomalous-items-cn', 'short-stories'].includes(page.category ?? '');
    case 'goi':
      return containsAll(page.tags, ['原创', 'goi格式']);
    case 'story':
      return containsAll(page.tags, ['原创', '故事']);
    case 'wanderers':
      return containsAll(page.tags, ['原创', 'wanderers']);
    case 'art':
      return containsAll(page.tags, ['原创', '艺术作品']);
  }
}

function normalizedSlug(value: string): string {
  const withoutQuery = value.split(/[?#]/, 1)[0] ?? value;
  const slash = withoutQuery.lastIndexOf('/');
  return slash >= 0 ? withoutQuery.slice(slash + 1) : withoutQuery;
}

function isNoTagMeanException(slug: string): boolean {
  return slug.startsWith('log-of-anomalous-items-cn:')
    || slug.startsWith('short-stories:');
}

function meanEligible(page: PageRow, normalizeV1Url: boolean): boolean {
  if (page.tags.length > 0) return !page.tags.includes('段落');
  const slug = normalizeV1Url ? normalizedSlug(page.slug) : page.slug;
  return isNoTagMeanException(slug);
}

function serializeQueries(client: pg.Client) {
  let tail: Promise<unknown> = Promise.resolve();
  return <Row extends pg.QueryResultRow>(text: string, values?: unknown[]) => {
    const current = tail.then(() => client.query<Row>(text, values));
    tail = current.then(
      () => undefined,
      () => undefined,
    );
    return current;
  };
}

async function main(): Promise<void> {
  const options = parseArgs();
  const config = loadConfig();
  const v2Url = databaseUrl(config.databaseUrl, new URL(config.databaseUrl).pathname.slice(1), 'syncer2-project-compare-v2-ro');
  const v1Url = databaseUrl(config.databaseUrl, options.v1DatabaseName, 'syncer2-project-compare-v1-ro');
  const v1 = new pg.Client({ connectionString: v1Url });
  const v2 = new pg.Client({ connectionString: v2Url });
  await Promise.all([v1.connect(), v2.connect()]);
  try {
    await Promise.all([
      v1.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'),
      v2.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'),
    ]);
    // pg 8 曾把同一 Client 的并发 query 隐式排队；pg 9 会移除该兼容行为。
    // 两库仍可并行，但每个只读快照内部必须显式串行。
    const v1Query = serializeQueries(v1);
    const v2Query = serializeQueries(v2);
    const [
      v1Meta,
      v2Meta,
      v1Stats,
      v2Stats,
      v1Pages,
      v2Pages,
      v1UserPages,
      v2UserPages,
      cursors,
      consistency,
    ] = await Promise.all([
      v1Query<{ database: string; as_of: Date; stats_updated_at: Date }>(
        `SELECT current_database() AS database,
                now() AS as_of,
                max("ratingUpdatedAt") AS stats_updated_at
           FROM "UserStats"`,
      ),
      v2Query<{ database: string; as_of: Date; stats_updated_at: Date }>(
        `SELECT current_database() AS database,
                now() AS as_of,
                max(computed_at) AS stats_updated_at
           FROM serve.user_stats`,
      ),
      v1Query<StatsRow>(
        `SELECT "userId" AS user_id,
                "totalUp" AS votes_received_up,
                "totalDown" AS votes_received_down,
                "totalRating" AS total_rating,
                "votesCastUp" AS votes_cast_up,
                "votesCastDown" AS votes_cast_down,
                "scpRating"::double precision AS rating_scp,
                "scpPageCount" AS count_scp,
                "scpRank" AS rank_scp,
                "translationRating"::double precision AS rating_translation,
                "translationPageCount" AS count_translation,
                "translationRank" AS rank_translation,
                "goiRating"::double precision AS rating_goi,
                "goiPageCount" AS count_goi,
                "goiRank" AS rank_goi,
                "storyRating"::double precision AS rating_story,
                "storyPageCount" AS count_story,
                "storyRank" AS rank_story,
                "wanderersRating"::double precision AS rating_wanderers,
                "wanderersPageCount" AS count_wanderers,
                "wanderersRank" AS rank_wanderers,
                "artRating"::double precision AS rating_art,
                "artPageCount" AS count_art,
                "artRank" AS rank_art,
                "pageCount" AS page_count,
                "overallRank" AS rank_total,
                "overallRating"::double precision AS overall_rating
           FROM "UserStats"
          ORDER BY "userId"`,
      ),
      v2Query<StatsRow>(
        `SELECT user_id,
                votes_received_up,
                votes_received_down,
                total_rating,
                votes_cast_up,
                votes_cast_down,
                rating_scp,
                count_scp,
                rank_scp,
                rating_translation,
                count_translation,
                rank_translation,
                rating_goi,
                count_goi,
                rank_goi,
                rating_story,
                count_story,
                rank_story,
                rating_wanderers,
                count_wanderers,
                rank_wanderers,
                rating_art,
                count_art,
                rank_art,
                page_count,
                rank_total,
                overall_rating
           FROM serve.user_stats
          ORDER BY user_id`,
      ),
      v1Query<PageRow>(
        `SELECT p.id AS page_id,
                p."currentUrl" AS slug,
                p."isDeleted" AS status_deleted,
                pv."isDeleted" AS version_deleted,
                COALESCE(pv.tags, ARRAY[]::text[]) AS tags,
                pv.category,
                COALESCE(pv.rating, 0)::int AS rating
           FROM "Page" p
           JOIN "PageVersion" pv
             ON pv."pageId" = p.id AND pv."validTo" IS NULL`,
      ),
      v2Query<PageRow>(
        `SELECT page_id,
                slug,
                status = 'deleted' AS status_deleted,
                tags,
                category,
                rating
           FROM serve.page_current`,
      ),
      v1Query<UserPageRow>(
        `WITH effective AS (
           SELECT a.*,
                  bool_or(a.type <> 'SUBMITTER') OVER (
                    PARTITION BY a."pageVerId"
                  ) AS has_non_submitter
             FROM "Attribution" a
         )
         SELECT DISTINCT e."userId" AS user_id, pv."pageId" AS page_id
           FROM effective e
           JOIN "PageVersion" pv ON pv.id = e."pageVerId"
          WHERE e."userId" IS NOT NULL
            AND NOT (e.has_non_submitter AND e.type = 'SUBMITTER')
            AND pv."validTo" IS NULL
            AND NOT pv."isDeleted"`,
      ),
      v2Query<UserPageRow>(
        `SELECT user_id, page_id FROM serve.user_page`,
      ),
      v2Query<{ projection: string; last_seq: string; target_seq: string }>(
        `SELECT c.projection,
                c.last_seq::text,
                meta.safe_seq_watermark()::text AS target_seq
           FROM meta.projection_cursor c
          WHERE c.projection = ANY($1::text[])
          ORDER BY c.projection`,
        [[
          'serve.page_stats',
          'serve.vote_daily',
          'serve.user_attr_daily',
          'serve.user_page',
          'serve.user_stats',
          'serve.user_vote_interaction',
          'serve.user_tag_preference',
          'serve.page_daily_stats',
          'serve.site_stats',
          'serve.site_overview_daily',
        ]],
      ),
      v2Query<{ checked: string; mismatched: string }>(
        `WITH deleted_authors AS (
           SELECT DISTINCT ac.actor_id AS user_id
             FROM serve.page_current pc
             JOIN serve.attribution_current ac
               ON ac.page_id = pc.page_id AND ac.is_display
            WHERE pc.status = 'deleted'
              AND EXISTS (
                SELECT 1
                  FROM ingest.page_life_event ple
                 WHERE ple.page_id = pc.page_id AND ple.kind = 'deleted'
              )
         ),
         latest_curve AS (
           SELECT DISTINCT ON (uad.user_id)
                  uad.user_id, uad.cum_rating
             FROM serve.user_attr_daily uad
             JOIN deleted_authors da ON da.user_id = uad.user_id
            ORDER BY uad.user_id, uad.day DESC
         )
         SELECT count(*)::text AS checked,
                count(*) FILTER (
                  WHERE lc.cum_rating <> us.total_rating
                )::text AS mismatched
           FROM deleted_authors da
           JOIN latest_curve lc ON lc.user_id = da.user_id
           JOIN serve.user_stats us ON us.user_id = da.user_id`,
      ),
    ]);

    const v1ByUser = new Map(v1Stats.rows.map((row) => [row.user_id, row]));
    const v2ByUser = new Map(v2Stats.rows.map((row) => [row.user_id, row]));
    const v1ByPage = new Map(v1Pages.rows.map((row) => [row.page_id, row]));
    const v2ByPage = new Map(v2Pages.rows.map((row) => [row.page_id, row]));
    const sharedUserIds = [...v1ByUser.keys()].filter((id) => v2ByUser.has(id));
    const sharedPageIds = [...v1ByPage.keys()].filter((id) => v2ByPage.has(id));

    const statusDivergencePages = new Set<number>();
    for (const pageId of sharedPageIds) {
      const a = v1ByPage.get(pageId)!;
      const b = v2ByPage.get(pageId)!;
      if (
        a.status_deleted !== a.version_deleted
        || a.status_deleted !== b.status_deleted
        || a.version_deleted !== b.status_deleted
      ) {
        statusDivergencePages.add(pageId);
      }
    }
    const divergenceUsers = new Set<number>();
    for (const row of [...v1UserPages.rows, ...v2UserPages.rows]) {
      if (statusDivergencePages.has(row.page_id)) divergenceUsers.add(row.user_id);
    }

    const fieldComparisons = [...INTEGER_FIELDS, ...FLOAT_FIELDS].map((field) => {
      let mismatched = 0;
      let outsideStatusWhitelist = 0;
      let maxAbsDelta = 0;
      const samples: Array<{
        user_id: number;
        v1: number | null;
        v2: number | null;
        status_whitelisted: boolean;
      }> = [];
      for (const userId of sharedUserIds) {
        const a = v1ByUser.get(userId)![field];
        const b = v2ByUser.get(userId)![field];
        const equal =
          field === 'overall_rating'
            ? Math.abs(asNumber(a) - asNumber(b)) <= options.floatTolerance
            : a === b;
        if (equal) continue;
        mismatched += 1;
        const whitelisted = divergenceUsers.has(userId);
        if (!whitelisted) outsideStatusWhitelist += 1;
        maxAbsDelta = Math.max(maxAbsDelta, Math.abs(asNumber(a) - asNumber(b)));
        if (samples.length < options.sampleLimit) {
          samples.push({
            user_id: userId,
            v1: a,
            v2: b,
            status_whitelisted: whitelisted,
          });
        }
      }
      return {
        field,
        compared: sharedUserIds.length,
        matched: sharedUserIds.length - mismatched,
        mismatched,
        outside_status_whitelist: outsideStatusWhitelist,
        max_abs_delta: maxAbsDelta,
        rank_downstream_of_rating: RANK_FIELDS.has(field),
        samples,
      };
    });

    const pageRuleComparisons = CLASSIFICATIONS.map((name) => {
      let compared = 0;
      let mismatched = 0;
      const samples: number[] = [];
      for (const pageId of sharedPageIds) {
        const a = v1ByPage.get(pageId)!;
        const b = v2ByPage.get(pageId)!;
        if (
          a.version_deleted
          || b.status_deleted
          || statusDivergencePages.has(pageId)
        ) {
          continue;
        }
        compared += 1;
        if (classification(a, name) !== classification(b, name)) {
          mismatched += 1;
          if (samples.length < options.sampleLimit) samples.push(pageId);
        }
      }
      return { classification: name, compared, mismatched, sample_page_ids: samples };
    });

    let meanCompared = 0;
    let meanIntendedMismatch = 0;
    let meanV1LiteralMismatch = 0;
    let paragraphPages = 0;
    let noTagExceptions = 0;
    const meanIntendedSamples: number[] = [];
    const meanLiteralSamples: number[] = [];
    for (const pageId of sharedPageIds) {
      const a = v1ByPage.get(pageId)!;
      const b = v2ByPage.get(pageId)!;
      if (a.version_deleted || b.status_deleted || statusDivergencePages.has(pageId)) continue;
      meanCompared += 1;
      if (a.tags.includes('段落')) paragraphPages += 1;
      if (a.tags.length === 0 && isNoTagMeanException(normalizedSlug(a.slug))) {
        noTagExceptions += 1;
      }
      if (meanEligible(a, true) !== meanEligible(b, false)) {
        meanIntendedMismatch += 1;
        if (meanIntendedSamples.length < options.sampleLimit) {
          meanIntendedSamples.push(pageId);
        }
      }
      if (meanEligible(a, false) !== meanEligible(b, false)) {
        meanV1LiteralMismatch += 1;
        if (meanLiteralSamples.length < options.sampleLimit) {
          meanLiteralSamples.push(pageId);
        }
      }
    }

    const output = {
      ok: true,
      sources: {
        v1: v1Meta.rows[0],
        v2: v2Meta.rows[0],
        transactions: 'REPEATABLE READ READ ONLY',
      },
      population: {
        v1_user_stats: v1Stats.rowCount,
        v2_user_stats: v2Stats.rowCount,
        shared_users: sharedUserIds.length,
        v1_only_users: [...v1ByUser.keys()].filter((id) => !v2ByUser.has(id)).length,
        v2_only_users: [...v2ByUser.keys()].filter((id) => !v1ByUser.has(id)).length,
        shared_pages: sharedPageIds.length,
        v1_only_pages: [...v1ByPage.keys()].filter((id) => !v2ByPage.has(id)).length,
        v2_only_pages: [...v2ByPage.keys()].filter((id) => !v1ByPage.has(id)).length,
      },
      status_whitelist: {
        page_count: statusDivergencePages.size,
        page_ids: [...statusDivergencePages].sort((a, b) => a - b),
        affected_user_count: divergenceUsers.size,
      },
      business_rules: {
        total_rating_and_overall_rating_compared_separately: true,
        mean_eligibility: {
          compared_pages: meanCompared,
          paragraph_pages_excluded: paragraphPages,
          no_tag_prefix_exceptions: noTagExceptions,
          v2_vs_intended_normalized_v1_mismatched_pages: meanIntendedMismatch,
          intended_sample_page_ids: meanIntendedSamples,
          v2_vs_literal_current_url_predicate_mismatched_pages: meanV1LiteralMismatch,
          literal_sample_page_ids: meanLiteralSamples,
        },
        classifications: pageRuleComparisons,
      },
      fields: fieldComparisons,
      b2_b4_full_population: {
        checked: Number(consistency.rows[0]?.checked ?? 0),
        mismatched: Number(consistency.rows[0]?.mismatched ?? 0),
      },
      cursors: cursors.rows,
    };
    emitSummary(output);
    await Promise.all([v1.query('ROLLBACK'), v2.query('ROLLBACK')]);
  } finally {
    await Promise.allSettled([v1.end(), v2.end()]);
  }
}

main().catch((err) => {
  emitSummary({ ok: false, status: 'failed', error: String(err) });
  process.exitCode = 1;
});
