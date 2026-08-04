import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRun, ensureUsers, OBSERVED_ISO, registerPage } from './helpers/fixture.js';
import { openSess, type Sess } from './helpers/pg.js';

interface Entry {
  voter_id: number;
  direction: -1 | 1;
  source_ordinal: number;
  identity_key: string;
}

async function applySnapshot(
  s: Sess,
  page: number,
  run: number,
  entries: Entry[],
): Promise<Record<string, unknown>> {
  return s.val<Record<string, unknown>>(
    'vote-multiplicity:apply',
    `SELECT ingest.apply_vote_snapshot(
       $1, $2::jsonb, true, $3, $4, ARRAY['wikidot']::text[],
       $5::timestamptz, 'test_multiplicity', $6, NULL,
       'candidate', 500, 0.20::real
     )`,
    [
      page,
      JSON.stringify(entries),
      entries.length,
      entries.reduce((sum, row) => sum + row.direction, 0),
      OBSERVED_ISO,
      run,
    ],
  );
}

async function state(s: Sess, page: number): Promise<Record<string, number>> {
  const row = await s.one<Record<string, string>>(
    'vote-multiplicity:state',
    `SELECT pc.rating::text,
            pc.unique_voter_rating::text,
            pc.unique_voter_count::text,
            count(vc.*)::text AS rows,
            count(*) FILTER (WHERE vc.direction=1)::text AS up,
            count(*) FILTER (WHERE vc.direction=-1)::text AS down
       FROM serve.page_current pc
       LEFT JOIN serve.vote_current vc ON vc.page_id=pc.page_id
      WHERE pc.page_id=$1
      GROUP BY pc.page_id`,
    [page],
  );
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
}

test('WhoRated 多重集：重复、冲突、幂等、整体替换与普通页', async () => {
  const s = await openSess('vote-multiplicity');
  await s.begin();
  try {
    const run = await createRun(s);
    const voters = await ensureUsers(s, 'wikidot', 71_000, 6);
    const [a, b, c, d, e] = voters as [number, number, number, number, number];

    const same = await registerPage(s, 971_001, 'ts2test:multi-same');
    const sameResult = await applySnapshot(s, same, run, [
      { voter_id: a, direction: 1, source_ordinal: 1, identity_key: 'wikidot:71000' },
      { voter_id: a, direction: 1, source_ordinal: 2, identity_key: 'wikidot:71000' },
    ]);
    assert.equal(sameResult['scan_status'], 'ok');
    assert.deepEqual(await state(s, same), {
      rating: 2,
      unique_voter_rating: 1,
      unique_voter_count: 1,
      rows: 2,
      up: 2,
      down: 0,
    });

    const opposite = await registerPage(s, 971_002, 'ts2test:multi-opposite');
    const oppositeResult = await applySnapshot(s, opposite, run, [
      { voter_id: a, direction: 1, source_ordinal: 1, identity_key: 'wikidot:71000' },
      { voter_id: a, direction: -1, source_ordinal: 2, identity_key: 'wikidot:71000' },
    ]);
    assert.equal(oppositeResult['scan_status'], 'ok');
    assert.deepEqual(await state(s, opposite), {
      rating: 0,
      unique_voter_rating: 0,
      unique_voter_count: 1,
      rows: 2,
      up: 1,
      down: 1,
    });

    const idempotent = await registerPage(s, 971_003, 'ts2test:multi-idempotent');
    const three: Entry[] = [
      { voter_id: a, direction: 1, source_ordinal: 1, identity_key: 'wikidot:71000' },
      { voter_id: a, direction: 1, source_ordinal: 2, identity_key: 'wikidot:71000' },
      { voter_id: b, direction: -1, source_ordinal: 3, identity_key: 'wikidot:71001' },
    ];
    const markerBefore = await s.num(
      'vote-multiplicity:marker-before',
      `SELECT count(*) FROM ingest.vote_snapshot_event WHERE page_id=$1`,
      [idempotent],
    );
    const replays = [];
    for (let i = 0; i < 3; i++) replays.push(await applySnapshot(s, idempotent, run, three));
    assert.equal(replays[0]?.['snapshot_replaced'], true);
    assert.equal(replays[1]?.['idempotent_replay'], true);
    assert.equal(replays[2]?.['idempotent_replay'], true);
    assert.deepEqual(await state(s, idempotent), {
      rating: 1,
      unique_voter_rating: 0,
      unique_voter_count: 2,
      rows: 3,
      up: 2,
      down: 1,
    });
    assert.equal(
      await s.num(
        'vote-multiplicity:marker-after',
        `SELECT count(*) FROM ingest.vote_snapshot_event WHERE page_id=$1`,
        [idempotent],
      ),
      markerBefore + 1,
      '同一快照重放三次只允许一个 snapshot marker',
    );

    const shrinking = await registerPage(s, 971_004, 'ts2test:multi-shrink');
    const five: Entry[] = [a, b, c, d, e].map((voter_id, index) => ({
      voter_id,
      direction: 1,
      source_ordinal: index + 1,
      identity_key: `wikidot:${71_000 + index}`,
    }));
    await applySnapshot(s, shrinking, run, five);
    await applySnapshot(s, shrinking, run, five.slice(0, 3));
    assert.deepEqual(await state(s, shrinking), {
      rating: 3,
      unique_voter_rating: 3,
      unique_voter_count: 3,
      rows: 3,
      up: 3,
      down: 0,
    });

    const normal = await registerPage(s, 971_005, 'ts2test:multi-normal');
    await applySnapshot(s, normal, run, [
      { voter_id: a, direction: 1, source_ordinal: 1, identity_key: 'wikidot:71000' },
      { voter_id: b, direction: 1, source_ordinal: 2, identity_key: 'wikidot:71001' },
      { voter_id: c, direction: -1, source_ordinal: 3, identity_key: 'wikidot:71002' },
    ]);
    assert.deepEqual(await state(s, normal), {
      rating: 1,
      unique_voter_rating: 1,
      unique_voter_count: 3,
      rows: 3,
      up: 2,
      down: 1,
    });
  } finally {
    await s.rollback();
    await s.end();
  }
});
