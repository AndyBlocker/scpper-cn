/**
 * Reproducible, scripted replacement for the S3 deleted-page manual sign-off.
 *
 * v1 scpper-cn is opened read-only.  The archive is restored into a random,
 * short-lived scratch database on the same PostgreSQL server and dropped in
 * finally.  No v2 fact table is touched.
 */

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import dotenv from 'dotenv';
import { Pool } from 'pg';

import { PROJECT_ROOT } from '../config.js';

interface CurrentRow {
  page_id: number;
  wikidot_id: number;
  slug: string;
  v1_rating: number;
  v1_active: number;
  last_observation_at: string | null;
  pageversion_rating: number | null;
  correction_abs: number;
  legacy_rating: number | null;
  legacy_active: number | null;
}

interface ArchiveRow {
  page_id: number;
  archive_rating: number;
  archive_active: number;
}

interface SignoffRow {
  pageId: number;
  wikidotId: number;
  slug: string;
  stratum: string;
  forcedTopCorrection: boolean;
  correctionAbs: number;
  pageVersionRating: number | null;
  v1: { rating: number; active: number };
  legacy: { rating: number; active: number } | null;
  archive: { rating: number; active: number } | null;
  ratingAgreement: boolean | null;
  stateAgreement: boolean | null;
  attribution: string;
  lastObservationAt: string | null;
}

const ARCHIVE_OBSERVED_AT = Date.parse('2026-04-27T10:42:51+08:00');
const SAMPLE_SEED = 's3-deleted-signoff-2026-07-28';
const STRATUM_TARGETS = new Map([
  ['0', 10],
  ['1-9', 25],
  ['10-49', 25],
  ['50-199', 25],
  ['200+', 15],
]);

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function stratum(active: number): string {
  if (active === 0) return '0';
  if (active < 10) return '1-9';
  if (active < 50) return '10-49';
  if (active < 200) return '50-199';
  return '200+';
}

function stableKey(pageId: number): string {
  return createHash('sha256').update(`${SAMPLE_SEED}:${pageId}`).digest('hex');
}

function same(
  left: { rating: number; active: number },
  right: { rating: number; active: number },
): boolean {
  return left.rating === right.rating && left.active === right.active;
}

function classify(row: Omit<SignoffRow, 'attribution'>): string {
  const { v1, legacy, archive } = row;
  if (legacy && archive && same(v1, legacy) && same(v1, archive)) return 'all_three_equal';
  if (!legacy && archive && same(v1, archive)) return 'legacy_unavailable_current_archive_equal';
  if (!archive && legacy && same(v1, legacy)) return 'archive_unavailable_current_legacy_equal';
  if (!legacy && !archive) return 'both_external_sources_unavailable';
  if (!legacy) {
    return row.lastObservationAt !== null &&
      Date.parse(row.lastObservationAt) > ARCHIVE_OBSERVED_AT
      ? 'page_changed_after_dump_legacy_unavailable'
      : 'legacy_unavailable_archive_differs';
  }
  if (!archive) return 'archive_unavailable_legacy_differs';
  const currentLegacy = same(v1, legacy);
  const currentArchive = same(v1, archive);
  const legacyArchive = same(legacy, archive);
  if (currentLegacy && !currentArchive) {
    return row.lastObservationAt !== null &&
      Date.parse(row.lastObservationAt) > ARCHIVE_OBSERVED_AT
      ? 'archive_stale_page_changed_after_dump'
      : 'archive_pre_vote_resync_snapshot_confirmed_by_legacy';
  }
  if (currentArchive && !currentLegacy) return 'legacy_coverage_or_cutoff_gap';
  if (legacyArchive && !currentLegacy) return 'v1_folded_state_differs_from_both_external';
  if (
    row.lastObservationAt !== null &&
    Date.parse(row.lastObservationAt) > ARCHIVE_OBSERVED_AT
  ) {
    return 'all_differ_page_changed_after_dump';
  }
  return 'all_three_differ_needs_parser_review';
}

function normalizeCurrent(row: Record<string, unknown>): CurrentRow {
  const nullableNumber = (value: unknown): number | null =>
    value === null ? null : Number(value);
  return {
    page_id: Number(row.page_id),
    wikidot_id: Number(row.wikidot_id),
    slug: String(row.slug),
    v1_rating: Number(row.v1_rating),
    v1_active: Number(row.v1_active),
    last_observation_at:
      row.last_observation_at === null
        ? null
        : new Date(String(row.last_observation_at)).toISOString(),
    pageversion_rating: nullableNumber(row.pageversion_rating),
    correction_abs: Number(row.correction_abs),
    legacy_rating: nullableNumber(row.legacy_rating),
    legacy_active: nullableNumber(row.legacy_active),
  };
}

async function restoreArchive(
  sourceUrl: string,
  archiveFile: string,
): Promise<{ rows: Map<number, ArchiveRow>; scratchDatabase: string; restoreSeconds: number }> {
  const parsed = new URL(sourceUrl);
  const adminUrl = new URL(sourceUrl);
  adminUrl.pathname = '/postgres';
  const scratchDatabase = `s3_signoff_${process.pid}_${Date.now()}`;
  if (!/^s3_signoff_\d+_\d+$/.test(scratchDatabase)) {
    throw new Error(`拒绝不安全的 scratch 名称：${scratchDatabase}`);
  }
  const admin = new Pool({ connectionString: adminUrl.toString(), max: 1 });
  let created = false;
  let scratch: Pool | null = null;
  const startedAt = Date.now();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdent(scratchDatabase)}`);
    created = true;
    const scratchUrl = new URL(sourceUrl);
    scratchUrl.pathname = `/${scratchDatabase}`;
    scratch = new Pool({ connectionString: scratchUrl.toString(), max: 1 });
    const source = new Pool({
      connectionString: sourceUrl,
      max: 1,
      options: '-c default_transaction_read_only=on -c statement_timeout=0',
    });
    try {
      const columns = await source.query<{ table_name: string; column_name: string }>(
        `SELECT table_name,column_name
           FROM information_schema.columns
          WHERE table_schema='public'
            AND table_name=ANY($1::text[])
          ORDER BY table_name,ordinal_position`,
        [['Page', 'PageVersion', 'Vote']],
      );
      for (const table of ['Page', 'PageVersion', 'Vote']) {
        const definitions = columns.rows
          .filter((row) => row.table_name === table)
          .map((row) => `${quoteIdent(row.column_name)} text`)
          .join(',');
        if (!definitions) throw new Error(`无法读取 ${table} 列定义`);
        await scratch.query(`CREATE TABLE ${quoteIdent(table)}(${definitions})`);
      }
    } finally {
      await source.end();
    }

    const args = [
      '--data-only',
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
      '--table=Page',
      '--table=PageVersion',
      '--table=Vote',
      '--host',
      parsed.hostname,
      '--port',
      parsed.port || '5432',
      '--username',
      decodeURIComponent(parsed.username),
      '--dbname',
      scratchDatabase,
      archiveFile,
    ];
    await new Promise<void>((resolve, reject) => {
      const child = spawn('pg_restore', args, {
        env: {
          ...process.env,
          PGPASSWORD: decodeURIComponent(parsed.password),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (data: Buffer) => {
        stderr = `${stderr}${data.toString()}`.slice(-12_000);
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`pg_restore exit ${String(code)}: ${stderr}`));
      });
    });

    const result = await scratch.query<ArchiveRow>(
      `WITH ranked AS MATERIALIZED (
         SELECT pv."pageId"::int AS page_id,
                coalesce(v."userId",'a:'||v."anonKey",'row:'||v.id) AS voter,
                sign(v.direction::int)::int AS dir,
                row_number() OVER (
                  PARTITION BY pv."pageId",
                    coalesce(v."userId",'a:'||v."anonKey",'row:'||v.id)
                  ORDER BY v.timestamp::timestamp DESC,v.id::int DESC
                ) AS rn
           FROM "Vote" v
           JOIN "PageVersion" pv ON pv.id=v."pageVersionId"
       ),
       state AS (
         SELECT page_id,coalesce(sum(dir),0)::int AS archive_rating,
                count(*) FILTER (WHERE dir<>0)::int AS archive_active
           FROM ranked WHERE rn=1 GROUP BY page_id
       )
       SELECT p.id::int AS page_id,coalesce(s.archive_rating,0)::int AS archive_rating,
              coalesce(s.archive_active,0)::int AS archive_active
         FROM "Page" p LEFT JOIN state s ON s.page_id=p.id::int`,
    );
    return {
      rows: new Map(
        result.rows.map((row) => [
          Number(row.page_id),
          {
            page_id: Number(row.page_id),
            archive_rating: Number(row.archive_rating),
            archive_active: Number(row.archive_active),
          },
        ]),
      ),
      scratchDatabase,
      restoreSeconds: (Date.now() - startedAt) / 1_000,
    };
  } finally {
    if (scratch) await scratch.end();
    if (created) {
      await admin.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname=$1 AND pid<>pg_backend_pid()`,
        [scratchDatabase],
      );
      await admin.query(`DROP DATABASE ${quoteIdent(scratchDatabase)}`);
    }
    await admin.end();
  }
}

function chooseSample(rows: CurrentRow[]): Set<number> {
  const selected = new Set(
    [...rows]
      .sort(
        (a, b) =>
          b.correction_abs - a.correction_abs ||
          stableKey(a.page_id).localeCompare(stableKey(b.page_id)),
      )
      .slice(0, 20)
      .map((row) => row.page_id),
  );
  for (const [label, target] of STRATUM_TARGETS) {
    const already = rows.filter(
      (row) => selected.has(row.page_id) && stratum(row.v1_active) === label,
    ).length;
    const candidates = rows
      .filter((row) => !selected.has(row.page_id) && stratum(row.v1_active) === label)
      .sort((a, b) => stableKey(a.page_id).localeCompare(stableKey(b.page_id)));
    for (const row of candidates.slice(0, Math.max(0, target - already))) {
      selected.add(row.page_id);
    }
  }
  if (selected.size < 100) {
    const candidates = rows
      .filter((row) => !selected.has(row.page_id))
      .sort((a, b) => stableKey(a.page_id).localeCompare(stableKey(b.page_id)));
    for (const row of candidates.slice(0, 100 - selected.size)) selected.add(row.page_id);
  }
  if (selected.size > 100) {
    throw new Error(`强制 C3 样本与分层配额产生 ${selected.size} 页，超过 100`);
  }
  return selected;
}

function markdownEscape(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function renderMarkdown(report: Record<string, unknown>, rows: SignoffRow[]): string {
  const summary = report.summary as Record<string, unknown>;
  const strata = report.sampleStrata as Record<string, number>;
  const categories = report.sampleAttributions as Record<string, number>;
  const archiveCategories = report.archiveMismatchAttributions as Record<string, number>;
  const lines = [
    '# S3 已删页脚本化签核（2026-07-28）',
    '',
    '固定种子 `s3-deleted-signoff-2026-07-28`，按有效票数量级分层抽样 100 页；',
    '强制覆盖 C3 `|A3 rating - last PageVersion rating|` 最大的 20 页。',
    'v1 连接以 `REPEATABLE READ READ ONLY` 运行；归档仅恢复到随机临时库，完成后已删除。',
    '',
    '## 结果',
    '',
    `- 样本：${rows.length} 页；分层 ${Object.entries(strata)
      .map(([key, value]) => `${key}=${value}`)
      .join('、')}。`,
    `- 三方 rating 全一致：${String(summary.sampleRatingAllEqual)}；三方 rating+active 全一致：${String(summary.sampleStateAllEqual)}。`,
    `- 全量已删页 legacy rating 对账：${String(summary.legacyMatched)}/${String(summary.legacyComparable)} (${String(summary.legacyMatchRate)}%)。`,
    `- 全量已删页归档 rating 对账：${String(summary.archiveMatched)}/${String(summary.archiveComparable)} (${String(summary.archiveMatchRate)}%)。`,
    `- 归档不一致 ${Number(summary.archiveComparable) - Number(summary.archiveMatched)} 页归因：${Object.entries(archiveCategories)
      .map(([key, value]) => `${key}=${value}`)
      .join('；')}。`,
    `- 样本归因：${Object.entries(categories)
      .map(([key, value]) => `${key}=${value}`)
      .join('；')}。`,
    '',
    '完整机器可读结果见 `s3-deleted-signoff-2026-07-28.json`。',
    '',
    '| page_id | slug | 层 | C3 | v1 r/a | legacy r/a | archive r/a | rating 一致 | state 一致 | 归因 |',
    '|---:|---|---|---:|---:|---:|---:|---|---|---|',
  ];
  for (const row of rows) {
    lines.push(
      `| ${row.pageId} | ${markdownEscape(row.slug)} | ${row.stratum} | ${row.correctionAbs} | ` +
        `${row.v1.rating}/${row.v1.active} | ` +
        `${row.legacy ? `${row.legacy.rating}/${row.legacy.active}` : 'N/A'} | ` +
        `${row.archive ? `${row.archive.rating}/${row.archive.active}` : 'N/A'} | ` +
        `${row.ratingAgreement === null ? 'N/A' : row.ratingAgreement ? 'yes' : 'no'} | ` +
        `${row.stateAgreement === null ? 'N/A' : row.stateAgreement ? 'yes' : 'no'} | ` +
        `${row.attribution} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

async function run(): Promise<void> {
  const program = new Command()
    .option('--archive <path>')
    .option('--json <path>')
    .option('--markdown <path>');
  program.parse(process.argv);
  const options = program.opts<{ archive?: string; json?: string; markdown?: string }>();
  dotenv.config({ path: path.resolve(PROJECT_ROOT, '../backend/.env'), quiet: true });
  dotenv.config({ path: path.resolve(PROJECT_ROOT, '.env'), quiet: true, override: false });
  const sourceUrl =
    process.env.SYNCER2_V1_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!sourceUrl) throw new Error('缺 v1 DATABASE_URL');
  const archiveFile =
    options.archive ??
    '/home/andyblocker/db-backups/scpper-cn-pre-vote-resync-20260427-104251.dump';
  if (!fs.existsSync(archiveFile)) throw new Error(`归档不存在：${archiveFile}`);
  const jsonFile =
    options.json ?? path.join(PROJECT_ROOT, 'docs', 's3-deleted-signoff-2026-07-28.json');
  const markdownFile =
    options.markdown ??
    path.join(PROJECT_ROOT, 'docs', 's3-deleted-signoff-2026-07-28.md');

  const source = new Pool({
    connectionString: sourceUrl,
    max: 1,
    options: '-c default_transaction_read_only=on -c statement_timeout=0',
  });
  let current: CurrentRow[];
  const client = await source.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query(`SET LOCAL TIME ZONE 'UTC'`);
    await client.query(`SET LOCAL work_mem='256MB'`);
    const sql = fs.readFileSync(
      path.join(PROJECT_ROOT, 'checks', 'backfill_s3_deleted_targets.sql'),
      'utf8',
    );
    const result = await client.query<Record<string, unknown>>(sql);
    current = result.rows.map(normalizeCurrent);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await source.end();
  }

  const archive = await restoreArchive(sourceUrl, archiveFile);
  const forced = new Set(
    [...current]
      .sort(
        (a, b) =>
          b.correction_abs - a.correction_abs ||
          stableKey(a.page_id).localeCompare(stableKey(b.page_id)),
      )
      .slice(0, 20)
      .map((row) => row.page_id),
  );
  const selected = chooseSample(current);
  const signoffRows = current
    .filter((row) => selected.has(row.page_id))
    .map((row): SignoffRow => {
      const archived = archive.rows.get(row.page_id);
      const base = {
        pageId: row.page_id,
        wikidotId: row.wikidot_id,
        slug: row.slug,
        stratum: stratum(row.v1_active),
        forcedTopCorrection: forced.has(row.page_id),
        correctionAbs: row.correction_abs,
        pageVersionRating: row.pageversion_rating,
        v1: { rating: row.v1_rating, active: row.v1_active },
        legacy:
          row.legacy_rating === null || row.legacy_active === null
            ? null
            : { rating: row.legacy_rating, active: row.legacy_active },
        archive: archived
          ? { rating: archived.archive_rating, active: archived.archive_active }
          : null,
        ratingAgreement:
          row.legacy_rating === null || !archived
            ? null
            : row.v1_rating === row.legacy_rating &&
              row.v1_rating === archived.archive_rating,
        stateAgreement:
          row.legacy_rating === null || row.legacy_active === null || !archived
            ? null
            : row.v1_rating === row.legacy_rating &&
              row.v1_rating === archived.archive_rating &&
              row.v1_active === row.legacy_active &&
              row.v1_active === archived.archive_active,
        lastObservationAt: row.last_observation_at,
      };
      return { ...base, attribution: classify(base) };
    })
    .sort((a, b) => a.pageId - b.pageId);

  const legacyComparable = current.filter((row) => row.legacy_rating !== null);
  const legacyMatched = legacyComparable.filter(
    (row) => row.v1_rating === row.legacy_rating,
  ).length;
  const archiveComparable = current.filter((row) => archive.rows.has(row.page_id));
  const archiveMatched = archiveComparable.filter(
    (row) => row.v1_rating === archive.rows.get(row.page_id)?.archive_rating,
  ).length;
  const countBy = (values: string[]): Record<string, number> =>
    Object.fromEntries(
      [...new Set(values)]
        .sort()
        .map((value) => [value, values.filter((candidate) => candidate === value).length]),
    );
  const archiveMismatchRows = archiveComparable
    .filter((row) => row.v1_rating !== archive.rows.get(row.page_id)?.archive_rating)
    .map((row) => {
      const archived = archive.rows.get(row.page_id)!;
      let attribution: string;
        if (row.legacy_rating !== null && row.v1_rating === row.legacy_rating) {
        attribution = 'archive_pre_vote_resync_snapshot_confirmed_by_legacy';
      } else if (
          row.last_observation_at !== null &&
          Date.parse(row.last_observation_at) > ARCHIVE_OBSERVED_AT
        ) {
        attribution = 'page_changed_after_dump';
      } else if (row.legacy_rating === null) {
        attribution = 'legacy_terminal_unavailable_pre_resync_delta';
      } else if (row.legacy_rating === archived.archive_rating) {
        attribution = 'legacy_vote_history_terminal_absent_from_votes_snapshot';
      } else {
        attribution = 'a3_archive_legacy_all_differ';
      }
      return {
        pageId: row.page_id,
        wikidotId: row.wikidot_id,
        slug: row.slug,
        v1Rating: row.v1_rating,
        legacyRating: row.legacy_rating,
        archiveRating: archived.archive_rating,
        lastObservationAt: row.last_observation_at,
        attribution,
      };
    });
  const archiveMismatchAttributions = countBy(
    archiveMismatchRows.map((row) => row.attribution),
  );
  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    reproducibility: {
      seed: SAMPLE_SEED,
      stratumTargets: Object.fromEntries(STRATUM_TARGETS),
      forcedLargestC3Corrections: 20,
      archiveFile,
      archiveObservedAt: new Date(ARCHIVE_OBSERVED_AT).toISOString(),
      sourceReadOnly: true,
      scratchDatabase: archive.scratchDatabase,
      scratchDropped: true,
      restoreSeconds: archive.restoreSeconds,
    },
    summary: {
      samplePages: signoffRows.length,
      sampleRatingAllEqual: signoffRows.filter((row) => row.ratingAgreement).length,
      sampleStateAllEqual: signoffRows.filter((row) => row.stateAgreement).length,
      legacyComparable: legacyComparable.length,
      legacyMatched,
      legacyMatchRate: Number(((legacyMatched / legacyComparable.length) * 100).toFixed(4)),
      archiveComparable: archiveComparable.length,
      archiveMatched,
      archiveMatchRate: Number(((archiveMatched / archiveComparable.length) * 100).toFixed(4)),
    },
    sampleStrata: countBy(signoffRows.map((row) => row.stratum)),
    sampleAttributions: countBy(signoffRows.map((row) => row.attribution)),
    archiveMismatchAttributions,
    archiveMismatches: archiveMismatchRows,
    sample: signoffRows,
  };
  fs.writeFileSync(jsonFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownFile, renderMarkdown(report, signoffRows), 'utf8');
  process.stdout.write(`${JSON.stringify(report.summary)}\n`);
}

run().catch((error: unknown) => {
  process.stderr.write(`[s3-deleted-signoff] ${String(error)}\n`);
  process.exitCode = 1;
});
