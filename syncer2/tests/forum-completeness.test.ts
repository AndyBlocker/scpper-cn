import assert from 'node:assert/strict';
import test from 'node:test';

import { OBSERVED_ISO, PAGE_WID_LO, createRun, registerPage } from './helpers/fixture.js';
import { openSess } from './helpers/pg.js';

test('论坛定向与完整枚举共享写入口，但只有完整枚举授权 absence', async () => {
  const db = await openSess('forum-completeness');
  await db.begin();
  try {
    const pageId = await registerPage(db, 19_531, 'fix2-forum-completeness');
    const wikidotId = PAGE_WID_LO + 19_531;
    const categoryId = 8_005_301;
    const threadId = 8_005_302;
    await db.q(
      'link-thread',
      `SELECT ingest.apply_page_meta(
         $1::int,
         jsonb_build_object('discussion_thread_id', $2::bigint),
         $3::timestamptz,
         'test',
         NULL,
         $4::int
       )`,
      [pageId, threadId, OBSERVED_ISO, wikidotId],
    );

    const category = JSON.stringify([{
      id: categoryId,
      title: 'FIX2 category',
      description: null,
      thread_count: 1,
      post_count: 0,
    }]);
    const thread = JSON.stringify([{
      id: threadId,
      category_id: categoryId,
      title: 'FIX2 thread',
      created_at: OBSERVED_ISO,
      post_count: 0,
      is_deleted: false,
    }]);

    const targetedRun = await createRun(db);
    await db.q(
      'apply-targeted',
      `SELECT ingest.apply_forum_batch(
         $1::jsonb, $2::jsonb, '[]'::jsonb, $3::timestamptz,
         'test', $4::bigint, '[]'::jsonb
       )`,
      [category, thread, OBSERVED_ISO, targetedRun],
    );
    const targeted = await db.one<{
      status: string;
      forum_completeness: string;
      absence_authorized: boolean;
    }>(
      'targeted-evidence',
      `SELECT status, forum_completeness, absence_authorized
         FROM meta.page_scan
        WHERE run_id=$1 AND page_id=$2 AND kind='forum'`,
      [targetedRun, pageId],
    );
    assert.deepEqual(targeted, {
      status: 'ok',
      forum_completeness: 'targeted',
      absence_authorized: false,
    });

    const completeRun = await createRun(db);
    await db.q(
      'apply-complete',
      `SELECT ingest.apply_forum_batch(
         $1::jsonb, $2::jsonb, '[]'::jsonb, $3::timestamptz,
         'test', $4::bigint, jsonb_build_array($5::bigint)
       )`,
      [category, thread, OBSERVED_ISO, completeRun, threadId],
    );
    const complete = await db.one<{
      status: string;
      forum_completeness: string;
      absence_authorized: boolean;
    }>(
      'complete-evidence',
      `SELECT status, forum_completeness, absence_authorized
         FROM meta.page_scan
        WHERE run_id=$1 AND page_id=$2 AND kind='forum'`,
      [completeRun, pageId],
    );
    assert.deepEqual(complete, {
      status: 'ok',
      forum_completeness: 'complete',
      absence_authorized: true,
    });

    const blocked = await db.expectError(
      'cannot-authorize-targeted',
      `UPDATE meta.page_scan
          SET forum_completeness='targeted', absence_authorized=true
        WHERE run_id=$1 AND page_id=$2 AND kind='forum'`,
      [completeRun, pageId],
      true,
    );
    assert.equal(blocked.sqlstate, '23514');
  } finally {
    await db.rollback().catch(() => undefined);
    await db.end();
  }
});
