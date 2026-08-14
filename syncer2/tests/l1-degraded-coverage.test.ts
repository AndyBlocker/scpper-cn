import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { ADAPTIVE_EGRESS_POLICY } from '../src/http/adaptiveEgress.js';
import { createPool, query } from '../src/store/db.js';
import { upsertL1VoteObservationStates } from '../src/store/l1PartialVotes.js';
import { persistL1PartialCoverage } from '../src/work/l1PartialCoverage.js';
import {
  PAGE_WID_LO,
  TEST_RUN_SOURCE,
  cleanupAll,
} from './helpers/fixture.js';
import { openSess, resolveTestDatabaseUrl } from './helpers/pg.js';

const pool = createPool(resolveTestDatabaseUrl(), { max: 3 });
const COVERED_SLUG = 'ts2test:l1-degraded-covered';
const UNCOVERED_SLUG = 'ts2test:l1-degraded-uncovered';

before(async () => {
  const sess = await openSess('l1-degraded-cleanup-before');
  try {
    await cleanupAll(sess);
  } finally {
    await sess.end();
  }
});

after(async () => {
  const sess = await openSess('l1-degraded-cleanup-after');
  try {
    await cleanupAll(sess);
  } finally {
    await sess.end();
    await pool.end();
  }
});

test('2/3 档仍沿用全站 gate：180 秒 permit 上限显著低于 0 档且保持非零', () => {
  const permitCapacity = (level: 0 | 2 | 3): number => {
    const interval = ADAPTIVE_EGRESS_POLICY.tiers.find((tier) => tier.level === level)!.minIntervalMs;
    return Math.floor(180_000 / interval);
  };
  assert.equal(permitCapacity(0), 540);
  assert.equal(permitCapacity(2), 90);
  assert.equal(permitCapacity(3), 22);
  assert.ok(permitCapacity(2) > 0 && permitCapacity(2) < permitCapacity(0));
  assert.ok(permitCapacity(3) > 0 && permitCapacity(3) < permitCapacity(2));
});

test('部分 L1 只消费已覆盖页的正向投票变化，未覆盖页不能被推断删除', async () => {
  const observedAt = '2026-08-14T06:30:00.000Z';
  const baselineAt = '2026-08-14T06:00:00.000Z';
  const coveredPageId = await registerPage(PAGE_WID_LO + 8_801, COVERED_SLUG, baselineAt);
  const uncoveredPageId = await registerPage(PAGE_WID_LO + 8_802, UNCOVERED_SLUG, baselineAt);
  const baselineRunId = await insertRun('ok', baselineAt, 500, 500);
  const partialRunId = await insertRun('partial', observedAt, 250, null);
  const baselineRows = [
    { row: { fullname: COVERED_SLUG, rating: 0, ratingVotes: 0, revisions: 10 }, pageId: coveredPageId },
    { row: { fullname: UNCOVERED_SLUG, rating: 0, ratingVotes: 0, revisions: 10 }, pageId: uncoveredPageId },
  ];
  await query(
    pool,
    'test:l1-degraded:seed-full-state',
    `INSERT INTO meta.incremental_page_state(
       slug, page_id, last_l1_revision, last_l1_rating, last_l1_rating_votes,
       last_l1_seen_at, last_l1_run_id
     ) VALUES
       ($1, $2, 10, 0, 0, $5::timestamptz, $6),
       ($3, $4, 10, 0, 0, $5::timestamptz, $6)`,
    [COVERED_SLUG, coveredPageId, UNCOVERED_SLUG, uncoveredPageId, baselineAt, baselineRunId],
  );
  await upsertL1VoteObservationStates(pool, baselineRunId, baselineRows, baselineAt, 'full');

  const persisted = await persistL1PartialCoverage(
    pool,
    partialRunId,
    [{ fullname: COVERED_SLUG, rating: 1, ratingVotes: 1, revisions: 10 }],
    observedAt,
  );
  assert.equal(persisted.voteChanges, 1);
  assert.equal(persisted.voteStatesAdvanced, 1);
  assert.equal(persisted.absenceInference, 'forbidden_partial_positive_only');
  assert.equal(persisted.fullCoverageStateAdvanced, false);
  assert.equal(persisted.revisionCoverageRecorded, false);
  assert.equal(persisted.driftReconciliationPerformed, false);

  const evidence = await query<{
    covered_tasks: string;
    uncovered_tasks: string;
    covered_signals: string;
    uncovered_signals: string;
    page_scan_status: string;
    covered_full_rating: number;
    uncovered_full_rating: number;
    covered_partial_rating: number;
    uncovered_partial_rating: number;
    deleted_events: string;
    deleted_pages: string;
    revision_coverage: string;
  }>(
    pool,
    'test:l1-degraded:evidence',
    `SELECT
       (SELECT count(*) FROM meta.scan_task WHERE page_id=$1 AND kind='votes_full')::text AS covered_tasks,
       (SELECT count(*) FROM meta.scan_task WHERE page_id=$2 AND kind='votes_full')::text AS uncovered_tasks,
       (SELECT count(*) FROM meta.incremental_signal WHERE run_id=$3 AND page_id=$1 AND signal='vote_changed')::text AS covered_signals,
       (SELECT count(*) FROM meta.incremental_signal WHERE run_id=$3 AND page_id=$2)::text AS uncovered_signals,
       (SELECT status FROM meta.page_scan WHERE run_id=$3 AND page_id=$1 AND kind='meta') AS page_scan_status,
       (SELECT last_l1_rating FROM meta.incremental_page_state WHERE slug=$4) AS covered_full_rating,
       (SELECT last_l1_rating FROM meta.incremental_page_state WHERE slug=$5) AS uncovered_full_rating,
       (SELECT rating FROM meta.l1_partial_vote_state WHERE slug=$4) AS covered_partial_rating,
       (SELECT rating FROM meta.l1_partial_vote_state WHERE slug=$5) AS uncovered_partial_rating,
       (SELECT count(*) FROM ingest.page_life_event WHERE page_id IN ($1,$2) AND kind='deleted')::text AS deleted_events,
       (SELECT count(*) FROM serve.page_current WHERE page_id IN ($1,$2) AND status='deleted')::text AS deleted_pages,
       (SELECT count(*) FROM meta.revision_coverage_metric WHERE l1_run_id=$3)::text AS revision_coverage`,
    [coveredPageId, uncoveredPageId, partialRunId, COVERED_SLUG, UNCOVERED_SLUG],
  );
  assert.deepEqual(evidence.rows[0], {
    covered_tasks: '1',
    uncovered_tasks: '0',
    covered_signals: '1',
    uncovered_signals: '0',
    page_scan_status: 'partial',
    covered_full_rating: 0,
    uncovered_full_rating: 0,
    covered_partial_rating: 1,
    uncovered_partial_rating: 0,
    deleted_events: '0',
    deleted_pages: '0',
    revision_coverage: '0',
  });

  await assert.rejects(
    query(
      pool,
      'test:l1-degraded:phantom-delete-rejected',
      `SELECT ingest.apply_page_life(
         $1, 'deleted', $2::timestamptz, 'inferred', $2::timestamptz,
         'wikidot_listpages', $3, $4
       )`,
      [uncoveredPageId, observedAt, partialRunId, PAGE_WID_LO + 8_802],
    ),
    /status=partial|禁止任何删除推断/,
  );
  const status = await query<{ status: string }>(
    pool,
    'test:l1-degraded:uncovered-still-live',
    `SELECT status FROM serve.page_current WHERE page_id=$1`,
    [uncoveredPageId],
  );
  assert.equal(status.rows[0]?.status, 'live');
});

async function registerPage(wikidotId: number, slug: string, observedAt: string): Promise<number> {
  const result = await query<{ id: number }>(
    pool,
    'test:l1-degraded:register-page',
    `SELECT ingest.register_page(
       $1, $2, $3::timestamptz, 'test_wikidot', NULL, $3::timestamptz, NULL
     ) AS id`,
    [wikidotId, slug, observedAt],
  );
  return Number(result.rows[0]!.id);
}

async function insertRun(
  status: 'ok' | 'partial',
  startedAt: string,
  pagesEnumerated: number,
  remoteTotal: number | null,
): Promise<number> {
  const result = await query<{ id: string }>(
    pool,
    'test:l1-degraded:insert-run',
    `INSERT INTO meta.ingest_run(
       source, status, started_at, finished_at, pages_enumerated, remote_total,
       remote_total_source, batches_total, batches_failed, stats
     ) VALUES (
       $1, $2, $3::timestamptz, $3::timestamptz, $4, $5,
       CASE WHEN $5::int IS NULL THEN NULL ELSE 'listpages_total' END,
       2, 0, jsonb_build_object('layer','L1')
     ) RETURNING id::text`,
    [TEST_RUN_SOURCE, status, startedAt, pagesEnumerated, remoteTotal],
  );
  return Number(result.rows[0]!.id);
}
