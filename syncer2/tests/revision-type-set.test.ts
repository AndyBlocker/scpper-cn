process.env.SYNCER2_LOG_LEVEL = 'error';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Pool, type PoolClient } from 'pg';

import { PROJECT_ROOT, resolveTestDatabaseUrl } from './helpers/pg.js';

const MIGRATION = readFileSync(
  path.join(PROJECT_ROOT, 'migrations', '0034_revision_type_set.sql'),
  'utf8',
);

interface RevisionState {
  rows: string;
  typed_rows: string;
  null_rows: string;
  fingerprint: string;
}

let pool: Pool;

before(() => {
  pool = new Pool({
    connectionString: resolveTestDatabaseUrl(),
    application_name: 'syncer2-test:revision-type-set',
    max: 2,
  });
});

after(async () => {
  await pool.end();
});

async function revisionState(client: Pool | PoolClient = pool): Promise<RevisionState> {
  const result = await client.query<RevisionState>(
    `SELECT count(*)::text AS rows,
            count(type)::text AS typed_rows,
            count(*) FILTER (WHERE type IS NULL)::text AS null_rows,
            COALESCE(
              sum(hashtextextended(to_jsonb(r)::text, 3407)::numeric),
              0
            )::text AS fingerprint
       FROM ingest.revision r`,
  );
  return result.rows[0]!;
}

describe('revision.type text[] 数据库契约', () => {
  it('迁移连续重跑两次不改变任何事实行或内容', async () => {
    const beforeState = await revisionState();
    await pool.query(MIGRATION);
    const afterFirst = await revisionState();
    await pool.query(MIGRATION);
    const afterSecond = await revisionState();
    assert.deepEqual(afterFirst, beforeState);
    assert.deepEqual(afterSecond, afterFirst);
  });

  it('单元素/多元素集合经 apply_revision_batch 往返一致，标量输入被拒绝', async () => {
    const client = await pool.connect();
    const suffix = process.pid % 100_000;
    const pageId = 2_000_000_000 + suffix;
    const pageWikidotId = 2_010_000_000 + suffix;
    const revisionBase = 9_000_000_000_000 + process.pid * 10;
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL scpper.bypass_guard = 'on'`);
      await client.query(
        `INSERT INTO ingest.page(id, wikidot_id) VALUES ($1, $2)`,
        [pageId, pageWikidotId],
      );
      const payload = [
        {
          wikidot_revision_id: revisionBase + 1,
          rev_no: 0,
          type: ['PAGE_CREATED'],
          occurred_at: '2026-08-04T00:00:00.000Z',
        },
        {
          wikidot_revision_id: revisionBase + 2,
          rev_no: 1,
          type: ['SOURCE_CHANGED', 'TITLE_CHANGED'],
          occurred_at: '2026-08-04T00:01:00.000Z',
        },
      ];
      await client.query(
        `SELECT ingest.apply_revision_batch(
           $1::int, $2::jsonb, 1, '2026-08-04T00:02:00Z'::timestamptz,
           'test_revision_type_set', NULL, $3::int
         )`,
        [pageId, JSON.stringify(payload), pageWikidotId],
      );
      const stored = await client.query<{ type: string[] }>(
        `SELECT type FROM ingest.revision
          WHERE wikidot_revision_id IN ($1, $2)
          ORDER BY wikidot_revision_id`,
        [revisionBase + 1, revisionBase + 2],
      );
      assert.deepEqual(stored.rows.map((row) => row.type), [
        ['PAGE_CREATED'],
        ['SOURCE_CHANGED', 'TITLE_CHANGED'],
      ]);

      await client.query('SAVEPOINT bad_shape');
      await assert.rejects(
        client.query(
          `SELECT ingest.apply_revision_batch(
             $1::int, $2::jsonb, NULL, now(), 'test_revision_type_set', NULL, $3::int
           )`,
          [
            pageId,
            JSON.stringify([{
              wikidot_revision_id: revisionBase + 3,
              rev_no: 2,
              type: '["SOURCE_CHANGED"]',
              occurred_at: '2026-08-04T00:02:00.000Z',
            }]),
            pageWikidotId,
          ],
        ),
        /revision\.type 必须是 JSON array 或 null/,
      );
      await client.query('ROLLBACK TO SAVEPOINT bad_shape');
      const badRows = await client.query<{ count: string }>(
        `SELECT count(*)::text FROM ingest.revision WHERE wikidot_revision_id=$1`,
        [revisionBase + 3],
      );
      assert.equal(badRows.rows[0]!.count, '0');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('物理类型、CHECK 与 JSON 残留断言同时成立', async () => {
    const result = await pool.query<{
      udt_name: string;
      constraint_count: string;
      json_shape_rows: string;
      invalid_rows: string;
    }>(
      `SELECT c.udt_name,
              (SELECT count(*)::text FROM pg_constraint
                WHERE conrelid='ingest.revision'::regclass
                  AND conname='revision_type_set_ck') AS constraint_count,
              (SELECT count(*)::text FROM ingest.revision
                WHERE type::text LIKE '[%') AS json_shape_rows,
              (SELECT count(*)::text FROM ingest.revision
                WHERE type IS NOT NULL
                  AND NOT ingest.revision_types_valid(type)) AS invalid_rows
         FROM information_schema.columns c
        WHERE c.table_schema='ingest'
          AND c.table_name='revision'
          AND c.column_name='type'`,
    );
    assert.deepEqual(result.rows[0], {
      udt_name: '_text',
      constraint_count: '1',
      json_shape_rows: '0',
      invalid_rows: '0',
    });
  });
});
