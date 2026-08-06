import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  extractPageReferences,
  type PageReferenceCandidate,
} from '../content/extractPageReferences.js';
import { query } from '../store/db.js';
import { sanitizePgText } from '../store/pgText.js';
import { asNumber, exec, rows } from './sql.js';
import type { ProjectionApplyResult, ProjectionWindow } from './types.js';

interface CountRow {
  n: string;
}

interface SourceRow {
  page_id: number;
  source_sha: Buffer;
  source: string;
}

interface CandidateJson {
  from_page_id: number;
  source_sha: string;
  kind: PageReferenceCandidate['kind'];
  target_scope: PageReferenceCandidate['targetScope'];
  reference_key: string;
  target_key: string;
  target_path: string;
  target_slug: string | null;
  target_fragment: string;
  raw_target: string;
  raw_text: string;
  display_texts: string[];
  occurrence: number;
}

const SOURCE_BATCH = 500;
const CANDIDATE_INSERT_BATCH = 1_000;

function pgText(value: string): string {
  return sanitizePgText(value, { trace: false }).value;
}

function referenceKey(scope: string, targetKey: string, targetFragment: string): string {
  return createHash('sha256')
    .update(JSON.stringify([
      scope,
      targetKey,
      targetFragment,
    ]))
    .digest('hex');
}

function toCandidateJson(
  pageId: number,
  sourceSha: Buffer,
  candidate: PageReferenceCandidate,
): CandidateJson {
  const targetKey = pgText(candidate.targetKey);
  const targetFragment = pgText(candidate.targetFragment);
  return {
    from_page_id: pageId,
    source_sha: sourceSha.toString('hex'),
    kind: candidate.kind,
    target_scope: candidate.targetScope,
    reference_key: referenceKey(candidate.targetScope, targetKey, targetFragment),
    target_key: targetKey,
    target_path: pgText(candidate.targetPath),
    target_slug: candidate.targetSlug === null ? null : pgText(candidate.targetSlug),
    target_fragment: targetFragment,
    raw_target: pgText(candidate.rawTarget),
    raw_text: pgText(candidate.rawText),
    display_texts: candidate.displayTexts.map(pgText),
    occurrence: candidate.occurrence,
  };
}

async function createWorkingTables(client: PoolClient): Promise<void> {
  await exec(
    client,
    'project.page_reference:working_tables',
    `DROP TABLE IF EXISTS pg_temp.page_reference_candidate;
     DROP TABLE IF EXISTS pg_temp.page_reference_affected;
     DROP TABLE IF EXISTS pg_temp.page_reference_changed_target;

     CREATE TEMP TABLE page_reference_affected (
       page_id int PRIMARY KEY
     ) ON COMMIT DROP;

     CREATE TEMP TABLE page_reference_changed_target (
       page_id int PRIMARY KEY
     ) ON COMMIT DROP;

     CREATE TEMP TABLE page_reference_candidate (
       from_page_id             int         NOT NULL,
       source_sha               bytea       NOT NULL,
       kind                     text        NOT NULL,
       target_scope             text        NOT NULL,
       reference_key            bytea       NOT NULL,
       target_key               text        NOT NULL,
       target_path              text        NOT NULL,
       target_slug              text,
       target_fragment          text        NOT NULL,
       raw_target               text        NOT NULL,
       raw_text                 text        NOT NULL,
       display_texts            text[]      NOT NULL,
       occurrence               int         NOT NULL,
       to_page_id               int,
       resolution_status        text        NOT NULL,
       candidate_page_ids       int[]       NOT NULL,
       live_candidate_page_ids  int[]       NOT NULL,
       identity_candidate_count int         NOT NULL,
       live_candidate_count     int         NOT NULL,
       slug_reused              boolean     NOT NULL,
       PRIMARY KEY (from_page_id, kind, reference_key)
     ) ON COMMIT DROP;`,
  );
}

async function seedAffectedPages(
  client: PoolClient,
  window: ProjectionWindow,
  fullSourceScan: boolean,
): Promise<{ sourcePages: number; changedTargets: number; affectedKeys: number }> {
  if (fullSourceScan) {
    await exec(
      client,
      'project.page_reference:all_effective_pages',
      `INSERT INTO pg_temp.page_reference_affected(page_id)
       SELECT page_id FROM serve.page_current WHERE source_sha IS NOT NULL`,
    );
  } else {
    await exec(
      client,
      'project.page_reference:changed_sources',
      `INSERT INTO pg_temp.page_reference_affected(page_id)
       SELECT DISTINCT page_id
         FROM ingest.page_source
        WHERE change_seq BETWEEN $1::bigint AND $2::bigint`,
      [window.fromSeq, window.toSeq],
    );
    await exec(
      client,
      'project.page_reference:changed_targets',
      `INSERT INTO pg_temp.page_reference_changed_target(page_id)
       SELECT DISTINCT page_id
         FROM ingest.page_life_event
        WHERE seq BETWEEN $1::bigint AND $2::bigint`,
      [window.fromSeq, window.toSeq],
    );
  }

  const counts = await rows<CountRow & { sources: string; targets: string }>(
    client,
    'project.page_reference:affected_counts',
    `SELECT (SELECT count(*) FROM pg_temp.page_reference_affected)::text AS sources,
            (SELECT count(*) FROM pg_temp.page_reference_changed_target)::text AS targets,
            (SELECT count(*) FROM (
               SELECT page_id FROM pg_temp.page_reference_affected
               UNION
               SELECT page_id FROM pg_temp.page_reference_changed_target
             ) u)::text AS n`,
  );
  const row = counts[0];
  return {
    sourcePages: asNumber(row?.sources, 'page_reference.source_pages'),
    changedTargets: asNumber(row?.targets, 'page_reference.changed_targets'),
    affectedKeys: asNumber(row?.n, 'page_reference.affected_keys'),
  };
}

async function insertCandidateBatch(
  client: PoolClient,
  candidates: readonly CandidateJson[],
): Promise<number> {
  if (candidates.length === 0) return 0;
  return exec(
    client,
    'project.page_reference:candidate_batch',
    `INSERT INTO pg_temp.page_reference_candidate (
       from_page_id, source_sha, kind, target_scope, reference_key,
       target_key, target_path, target_slug, target_fragment,
       raw_target, raw_text, display_texts, occurrence,
       to_page_id, resolution_status, candidate_page_ids,
       live_candidate_page_ids, identity_candidate_count,
       live_candidate_count, slug_reused
     )
     SELECT x.from_page_id,
            decode(x.source_sha, 'hex'),
            x.kind,
            x.target_scope,
            decode(x.reference_key, 'hex'),
            x.target_key,
            x.target_path,
            x.target_slug,
            x.target_fragment,
            x.raw_target,
            x.raw_text,
            x.display_texts,
            x.occurrence,
            NULL,
            CASE WHEN x.target_scope = 'external' THEN 'external' ELSE 'missing' END,
            '{}'::int[],
            '{}'::int[],
            0,
            0,
            false
       FROM jsonb_to_recordset($1::jsonb) AS x(
         from_page_id int,
         source_sha text,
         kind text,
         target_scope text,
         reference_key text,
         target_key text,
         target_path text,
         target_slug text,
         target_fragment text,
         raw_target text,
         raw_text text,
         display_texts text[],
         occurrence int
       )`,
    [JSON.stringify(candidates)],
  );
}

async function parseEffectiveSources(client: PoolClient): Promise<number> {
  let lastPageId = -2_147_483_648;
  let parsedCandidates = 0;
  for (;;) {
    const batch = await rows<SourceRow>(
      client,
      'project.page_reference:source_batch',
      `SELECT pc.page_id, pc.source_sha, cb.source
         FROM pg_temp.page_reference_affected a
         JOIN serve.page_current pc ON pc.page_id = a.page_id
         JOIN ingest.content_blob cb ON cb.sha256 = pc.source_sha
        WHERE pc.page_id > $1
          AND cb.source IS NOT NULL
        ORDER BY pc.page_id
        LIMIT $2`,
      [lastPageId, SOURCE_BATCH],
    );
    if (batch.length === 0) break;
    lastPageId = batch[batch.length - 1]!.page_id;

    let pending: CandidateJson[] = [];
    for (const row of batch) {
      for (const candidate of extractPageReferences(row.source)) {
        pending.push(toCandidateJson(row.page_id, row.source_sha, candidate));
        if (pending.length >= CANDIDATE_INSERT_BATCH) {
          parsedCandidates += await insertCandidateBatch(client, pending);
          pending = [];
        }
      }
    }
    parsedCandidates += await insertCandidateBatch(client, pending);
  }
  return parsedCandidates;
}

async function resolveWorkingCandidates(client: PoolClient): Promise<void> {
  await exec(
    client,
    'project.page_reference:resolve_candidates',
    `WITH wanted AS (
       SELECT DISTINCT target_slug
         FROM pg_temp.page_reference_candidate
        WHERE target_scope = 'internal'
     ),
     resolved AS (
       SELECT w.target_slug,
              COALESCE(
                array_agg(pc.page_id ORDER BY pc.page_id)
                  FILTER (WHERE pc.page_id IS NOT NULL),
                '{}'::int[]
              ) AS candidate_page_ids,
              COALESCE(
                array_agg(pc.page_id ORDER BY pc.page_id)
                  FILTER (WHERE pc.page_id IS NOT NULL AND pc.status = 'live'),
                '{}'::int[]
              ) AS live_candidate_page_ids
         FROM wanted w
         LEFT JOIN serve.page_current pc ON pc.slug = w.target_slug
        GROUP BY w.target_slug
     )
     UPDATE pg_temp.page_reference_candidate c SET
       candidate_page_ids = r.candidate_page_ids,
       live_candidate_page_ids = r.live_candidate_page_ids,
       identity_candidate_count = cardinality(r.candidate_page_ids),
       live_candidate_count = cardinality(r.live_candidate_page_ids),
       slug_reused = cardinality(r.candidate_page_ids) > 1,
       to_page_id = CASE
         WHEN cardinality(r.live_candidate_page_ids) = 1 THEN r.live_candidate_page_ids[1]
         ELSE NULL
       END,
       resolution_status = CASE
         WHEN cardinality(r.live_candidate_page_ids) = 0 THEN 'missing'
         WHEN cardinality(r.live_candidate_page_ids) = 1 THEN 'resolved'
         ELSE 'ambiguous'
       END
     FROM resolved r
     WHERE c.target_scope = 'internal'
       AND c.target_slug = r.target_slug`,
  );
}

async function publishCandidates(
  client: PoolClient,
): Promise<{ rowsWritten: number; rowsDeleted: number }> {
  const rowsWritten = await exec(
    client,
    'project.page_reference:upsert',
    `INSERT INTO serve.page_reference (
       from_page_id, source_sha, kind, target_scope, reference_key,
       target_key, target_path, target_slug, target_fragment,
       raw_target, raw_text, display_texts, occurrence,
       to_page_id, resolution_status, candidate_page_ids,
       live_candidate_page_ids, identity_candidate_count,
       live_candidate_count, slug_reused, computed_at
     )
     SELECT from_page_id, source_sha, kind, target_scope, reference_key,
            target_key, target_path, target_slug, target_fragment,
            raw_target, raw_text, display_texts, occurrence,
            to_page_id, resolution_status, candidate_page_ids,
            live_candidate_page_ids, identity_candidate_count,
            live_candidate_count, slug_reused, now()
       FROM pg_temp.page_reference_candidate
     ON CONFLICT (from_page_id, kind, reference_key) DO UPDATE SET
       source_sha = EXCLUDED.source_sha,
       target_scope = EXCLUDED.target_scope,
       target_key = EXCLUDED.target_key,
       target_path = EXCLUDED.target_path,
       target_slug = EXCLUDED.target_slug,
       target_fragment = EXCLUDED.target_fragment,
       raw_target = EXCLUDED.raw_target,
       raw_text = EXCLUDED.raw_text,
       display_texts = EXCLUDED.display_texts,
       occurrence = EXCLUDED.occurrence,
       to_page_id = EXCLUDED.to_page_id,
       resolution_status = EXCLUDED.resolution_status,
       candidate_page_ids = EXCLUDED.candidate_page_ids,
       live_candidate_page_ids = EXCLUDED.live_candidate_page_ids,
       identity_candidate_count = EXCLUDED.identity_candidate_count,
       live_candidate_count = EXCLUDED.live_candidate_count,
       slug_reused = EXCLUDED.slug_reused,
       computed_at = now()
     WHERE (
       serve.page_reference.source_sha,
       serve.page_reference.target_scope,
       serve.page_reference.target_key,
       serve.page_reference.target_path,
       serve.page_reference.target_slug,
       serve.page_reference.target_fragment,
       serve.page_reference.raw_target,
       serve.page_reference.raw_text,
       serve.page_reference.display_texts,
       serve.page_reference.occurrence,
       serve.page_reference.to_page_id,
       serve.page_reference.resolution_status,
       serve.page_reference.candidate_page_ids,
       serve.page_reference.live_candidate_page_ids,
       serve.page_reference.identity_candidate_count,
       serve.page_reference.live_candidate_count,
       serve.page_reference.slug_reused
     ) IS DISTINCT FROM (
       EXCLUDED.source_sha,
       EXCLUDED.target_scope,
       EXCLUDED.target_key,
       EXCLUDED.target_path,
       EXCLUDED.target_slug,
       EXCLUDED.target_fragment,
       EXCLUDED.raw_target,
       EXCLUDED.raw_text,
       EXCLUDED.display_texts,
       EXCLUDED.occurrence,
       EXCLUDED.to_page_id,
       EXCLUDED.resolution_status,
       EXCLUDED.candidate_page_ids,
       EXCLUDED.live_candidate_page_ids,
       EXCLUDED.identity_candidate_count,
       EXCLUDED.live_candidate_count,
       EXCLUDED.slug_reused
     )`,
  );

  const rowsDeleted = await exec(
    client,
    'project.page_reference:delete_stale',
    `DELETE FROM serve.page_reference pr
      USING pg_temp.page_reference_affected a
      WHERE pr.from_page_id = a.page_id
        AND NOT EXISTS (
          SELECT 1
            FROM pg_temp.page_reference_candidate c
           WHERE c.from_page_id = pr.from_page_id
             AND c.kind = pr.kind
             AND c.reference_key = pr.reference_key
        )`,
  );
  return { rowsWritten, rowsDeleted };
}

/**
 * 新建/删除/恢复/改名只改变 target resolution，不需要重新解析任何源码。
 * 旧 slug 通过 to_page_id/candidate_page_ids 找回，新 slug 通过当前 pc.slug 找回。
 */
async function refreshChangedTargets(client: PoolClient): Promise<number> {
  return exec(
    client,
    'project.page_reference:refresh_targets',
    `WITH changed_ids AS (
       SELECT COALESCE(array_agg(page_id ORDER BY page_id), '{}'::int[]) AS ids
         FROM pg_temp.page_reference_changed_target
     ),
     impacted AS (
       SELECT DISTINCT pr.target_slug
         FROM serve.page_reference pr
         CROSS JOIN changed_ids ch
        WHERE pr.target_scope = 'internal'
          AND (
            pr.to_page_id = ANY(ch.ids)
            OR pr.candidate_page_ids && ch.ids
            OR EXISTS (
              SELECT 1
                FROM pg_temp.page_reference_changed_target ct
                JOIN serve.page_current pc ON pc.page_id = ct.page_id
               WHERE pc.slug = pr.target_slug
            )
          )
     ),
     resolved AS (
       SELECT i.target_slug,
              COALESCE(
                array_agg(pc.page_id ORDER BY pc.page_id)
                  FILTER (WHERE pc.page_id IS NOT NULL),
                '{}'::int[]
              ) AS candidate_page_ids,
              COALESCE(
                array_agg(pc.page_id ORDER BY pc.page_id)
                  FILTER (WHERE pc.page_id IS NOT NULL AND pc.status = 'live'),
                '{}'::int[]
              ) AS live_candidate_page_ids
         FROM impacted i
         LEFT JOIN serve.page_current pc ON pc.slug = i.target_slug
        GROUP BY i.target_slug
     ),
     next_value AS (
       SELECT r.*,
              cardinality(r.candidate_page_ids) AS identity_count,
              cardinality(r.live_candidate_page_ids) AS live_count
         FROM resolved r
     )
     UPDATE serve.page_reference pr SET
       candidate_page_ids = n.candidate_page_ids,
       live_candidate_page_ids = n.live_candidate_page_ids,
       identity_candidate_count = n.identity_count,
       live_candidate_count = n.live_count,
       slug_reused = n.identity_count > 1,
       to_page_id = CASE WHEN n.live_count = 1 THEN n.live_candidate_page_ids[1] ELSE NULL END,
       resolution_status = CASE
         WHEN n.live_count = 0 THEN 'missing'
         WHEN n.live_count = 1 THEN 'resolved'
         ELSE 'ambiguous'
       END,
       computed_at = now()
     FROM next_value n
     WHERE pr.target_scope = 'internal'
       AND pr.target_slug = n.target_slug
       AND (
         pr.candidate_page_ids,
         pr.live_candidate_page_ids,
         pr.identity_candidate_count,
         pr.live_candidate_count,
         pr.slug_reused,
         pr.to_page_id,
         pr.resolution_status
       ) IS DISTINCT FROM (
         n.candidate_page_ids,
         n.live_candidate_page_ids,
         n.identity_count,
         n.live_count,
         n.identity_count > 1,
         CASE WHEN n.live_count = 1 THEN n.live_candidate_page_ids[1] ELSE NULL END,
         CASE
           WHEN n.live_count = 0 THEN 'missing'
           WHEN n.live_count = 1 THEN 'resolved'
           ELSE 'ambiguous'
         END
       )`,
  );
}

/** 当前 effective 源码引用集合；同事务 upsert 新集合、删除旧集合并刷新目标身份。 */
export async function projectPageReference(
  client: PoolClient,
  window: ProjectionWindow,
): Promise<ProjectionApplyResult> {
  if (window.rebuild) {
    await exec(client, 'project.page_reference:truncate', `TRUNCATE TABLE serve.page_reference`);
  }
  const bootstrapRows = !window.rebuild && window.previousSeq === 0
    ? await rows<CountRow>(
        client,
        'project.page_reference:bootstrap_probe',
        `SELECT count(*)::text AS n FROM serve.page_reference`,
      )
    : [];
  const bootstrap = bootstrapRows.length > 0
    && asNumber(bootstrapRows[0]?.n, 'page_reference.bootstrap_rows') === 0;
  await createWorkingTables(client);
  const affected = await seedAffectedPages(client, window, window.rebuild || bootstrap);
  const parsedCandidates = await parseEffectiveSources(client);
  await resolveWorkingCandidates(client);
  const published = await publishCandidates(client);
  const targetRowsWritten = window.rebuild || affected.changedTargets === 0
    ? 0
    : await refreshChangedTargets(client);

  return {
    affectedKeys: affected.affectedKeys,
    rowsWritten: published.rowsWritten + targetRowsWritten,
    rowsDeleted: published.rowsDeleted,
    notes: [
      `effective 源码页=${affected.sourcePages}，解析候选=${parsedCandidates}`,
      bootstrap ? 'cursor=0 且目标表为空：自动执行首次 effective 全量，不依赖旧 page_source.change_seq' : '',
      `目标生命周期变化=${affected.changedTargets}，仅重解析 slug 身份、不重读源码`,
      '明细采用直接替换：同页旧 source_sha 引用不会与新集合并存；图历史由 snapshot 承担',
      'target 只在恰一条 current live 身份时 resolved；多 live 为 ambiguous 且 to_page_id=NULL',
    ].filter((note) => note !== ''),
  };
}
