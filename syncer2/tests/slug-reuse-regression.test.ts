import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OBSERVED_ISO,
  PAGE_WID_LO,
  createRun,
  registerPage,
} from './helpers/fixture.js';
import { openSess } from './helpers/pg.js';

test('修订倒退确认 wikidotId 不同：注册 successor、保留旧 deleted、记录 lineage 候选', async () => {
  const sess = await openSess('slug-reuse-regression');
  await sess.begin();
  try {
    const slug = 'ts2test:slug-reuse-regression';
    const predecessor = await registerPage(sess, 9_501, slug);
    const predecessorWid = PAGE_WID_LO + 9_501;
    const successorWid = PAGE_WID_LO + 9_502;
    const runId = await createRun(sess);

    await sess.q(
      'delete-predecessor',
      `SELECT ingest.apply_page_life(
         $1::int, 'deleted', $2::timestamptz, 'inferred', $2::timestamptz,
         'operator', NULL, $3::int
       )`,
      [predecessor, OBSERVED_ISO, predecessorWid],
    );
    await sess.q(
      'seed-incremental-state',
      `INSERT INTO meta.incremental_page_state(
         slug, page_id, last_l0_revision, last_l0_updated_at, last_l0_seen_at,
         last_l1_revision, last_l1_rating, last_l1_rating_votes, last_l1_seen_at,
         last_l1_run_id
       )
       VALUES (
         $1, $2, 3, $3::timestamptz, $3::timestamptz,
         3, 0, 0, $3::timestamptz, $4
       )
       ON CONFLICT (slug) DO UPDATE SET
         page_id=EXCLUDED.page_id,
         last_l0_revision=EXCLUDED.last_l0_revision,
         last_l0_updated_at=EXCLUDED.last_l0_updated_at,
         last_l0_seen_at=EXCLUDED.last_l0_seen_at,
         last_l1_revision=EXCLUDED.last_l1_revision,
         last_l1_rating=EXCLUDED.last_l1_rating,
         last_l1_rating_votes=EXCLUDED.last_l1_rating_votes,
         last_l1_seen_at=EXCLUDED.last_l1_seen_at,
         last_l1_run_id=EXCLUDED.last_l1_run_id`,
      [slug, predecessor, OBSERVED_ISO, runId],
    );

    const applied = await sess.val<Record<string, unknown>>(
      'apply-slug-reuse',
      `SELECT ingest.apply_slug_reuse_identity(
         $1::int, $2::int, $3::text, $4::timestamptz, $5::bigint
       )`,
      [predecessor, successorWid, slug, OBSERVED_ISO, runId],
    );
    const successor = Number(applied['successor_id']);
    assert.notEqual(successor, predecessor);
    assert.equal(applied['successor_wikidot_id'], successorWid);

    const identity = await sess.one<{
      old_status: string;
      new_status: string;
      new_wid: number;
      deleted_events: string;
      created_events: string;
      lineage: string;
      state_page_id: number;
      state_l0: number | null;
      state_l1: number | null;
    }>(
      'verify-reuse',
      `SELECT
         old_pc.status AS old_status,
         new_pc.status AS new_status,
         new_pc.wikidot_id AS new_wid,
         (SELECT count(*) FROM ingest.page_life_event
           WHERE page_id=$1 AND kind='deleted')::text AS deleted_events,
         (SELECT count(*) FROM ingest.page_life_event
           WHERE page_id=$2 AND kind='created')::text AS created_events,
         (SELECT count(*) FROM ingest.page_lineage
           WHERE predecessor_id=$1 AND successor_id=$2
             AND decided_by='rule:same-slug-wikidot-id-change')::text AS lineage,
         ips.page_id AS state_page_id,
         ips.last_l0_revision AS state_l0,
         ips.last_l1_revision AS state_l1
       FROM serve.page_current old_pc
       JOIN serve.page_current new_pc ON new_pc.page_id=$2
       JOIN meta.incremental_page_state ips ON ips.slug=$3
      WHERE old_pc.page_id=$1`,
      [predecessor, successor, slug],
    );
    assert.equal(identity.old_status, 'deleted');
    assert.equal(identity.new_status, 'live');
    assert.equal(identity.new_wid, successorWid);
    assert.equal(Number(identity.deleted_events), 1);
    assert.equal(Number(identity.created_events), 1);
    assert.equal(Number(identity.lineage), 1);
    assert.equal(identity.state_page_id, successor);
    assert.equal(identity.state_l0, null);
    assert.equal(identity.state_l1, null);
  } finally {
    await sess.rollback().catch(() => undefined);
    await sess.end();
  }
});
