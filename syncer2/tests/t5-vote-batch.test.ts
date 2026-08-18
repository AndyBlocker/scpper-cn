/**
 * T5.2 · WhoRated 页级多重集的规模与属性回归。
 *
 * 旧版以“snapshot = 逐 voter CAS”等价作为防累积证明；该等价会先按 voter 折叠，
 * 无法表达数据源单次快照内的多行。新防线是更强的页级 snapshot replace：
 * 同一规范化快照重放不增行，后一个快照严格覆盖前一个快照。
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRun, ensureUsers, OBSERVED_ISO, registerPage } from './helpers/fixture.js';
import { openSess, type Sess } from './helpers/pg.js';
import { Report, mulberry32, stable } from './helpers/report.js';

const SEED = Number(process.env.SYNCER2_TEST_SEED ?? 20260727);
const ITERATIONS = Number(process.env.SYNCER2_TEST_ITERATIONS ?? 60);
const BIG_PAGE_VOTES = 5575;

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
    't5:apply_snapshot',
    `SELECT ingest.apply_vote_snapshot(
       $1, $2::jsonb, true, $3, $4, ARRAY['wikidot']::text[],
       $5::timestamptz, 'test_wikidot', $6, NULL,
       'candidate', 1000000, 1.0::real
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

async function assertSnapshotState(
  s: Sess,
  page: number,
  entries: Entry[],
): Promise<string | null> {
  const expectedRating = entries.reduce((sum, row) => sum + row.direction, 0);
  const perVoter = new Map<number, number>();
  for (const row of entries) {
    perVoter.set(row.voter_id, (perVoter.get(row.voter_id) ?? 0) + row.direction);
  }
  const expectedUniqueRating = [...perVoter.values()].reduce(
    (sum, direction) => sum + Math.sign(direction),
    0,
  );
  const row = await s.one<Record<string, string>>(
    't5:state',
    `SELECT count(vc.*)::text AS rows,
            COALESCE(sum(vc.direction),0)::text AS rating,
            pc.rating::text AS page_rating,
            pc.unique_voter_count::text AS unique_count,
            pc.unique_voter_rating::text AS unique_rating,
            count(*) FILTER (WHERE vc.source_row_ordinal<=0)::text AS bad_ordinal,
            count(*) FILTER (WHERE vc.snapshot_hash IS NULL)::text AS missing_hash,
            md5(COALESCE(string_agg(
              vc.source_row_ordinal||':'||vc.voter_id||':'||vc.direction||':'||
                COALESCE(vc.source_identity_key,''), E'\n'
              ORDER BY vc.source_row_ordinal
            ),'')) AS fingerprint
       FROM serve.page_current pc
       LEFT JOIN serve.vote_current vc ON vc.page_id=pc.page_id
      WHERE pc.page_id=$1
      GROUP BY pc.page_id`,
    [page],
  );
  const mismatch = {
    rows: Number(row['rows']) === entries.length,
    rowRating: Number(row['rating']) === expectedRating,
    pageRating: Number(row['page_rating']) === expectedRating,
    uniqueCount: Number(row['unique_count']) === perVoter.size,
    uniqueRating: Number(row['unique_rating']) === expectedUniqueRating,
    ordinals: Number(row['bad_ordinal']) === 0,
    hashes: entries.length === 0 || Number(row['missing_hash']) === 0,
  };
  return Object.values(mismatch).every(Boolean) ? row['fingerprint'] : stable(mismatch);
}

test('T5.2 · 页级 snapshot replace：大页、重放与随机属性', async (t) => {
  const rep = new Report('T5.2 · 页级 snapshot replace 多重集不变式');
  const s = await openSess('t5');
  try {
    await t.test(`T5.2a ${BIG_PAGE_VOTES} 行大页重放三次不累积`, async () => {
      await s.begin();
      try {
        const run = await createRun(s);
        const page = await registerPage(s, 801, 'ts2test:t5-big-snapshot');
        const voters = await ensureUsers(s, 'wikidot', 10_000, BIG_PAGE_VOTES - 2);
        const entries: Entry[] = voters.map((voter_id, index) => ({
          voter_id,
          direction: index % 7 === 0 ? -1 : 1,
          source_ordinal: index + 1,
          identity_key: `wikidot:${10_000 + index}`,
        }));
        // 同一自然账号再出现两行：一条同向、一条反向。
        entries.push({
          voter_id: voters[0]!, direction: 1,
          source_ordinal: entries.length + 1, identity_key: 'wikidot:10000',
        });
        entries.push({
          voter_id: voters[1]!, direction: -1,
          source_ordinal: entries.length + 1, identity_key: 'wikidot:10001',
        });

        const first = await applySnapshot(s, page, run, entries);
        const replay2 = await applySnapshot(s, page, run, entries);
        const replay3 = await applySnapshot(s, page, run, entries);
        rep.eq('T5.2a', '首轮确实整体替换', first['snapshot_replaced'], true);
        rep.eq('T5.2a', '第二轮哈希短路', replay2['idempotent_replay'], true);
        rep.eq('T5.2a', '第三轮哈希短路', replay3['idempotent_replay'], true);
        rep.eq('T5.2a', '三轮后行数仍等于单次快照', Number(first['current_rows']), BIG_PAGE_VOTES);
        rep.eq('T5.2a', '当前态/页面/去重双口径逐项一致', await assertSnapshotState(s, page, entries),
          await s.val<string>('t5:fingerprint',
            `SELECT md5(COALESCE(string_agg(
               source_row_ordinal||':'||voter_id||':'||direction||':'||COALESCE(source_identity_key,''), E'\n'
               ORDER BY source_row_ordinal),'')) FROM serve.vote_current WHERE page_id=$1`, [page]));
        rep.eq('T5.2a', '只产生一个 snapshot marker',
          await s.num('t5:markers', `SELECT count(*) FROM ingest.vote_snapshot_event WHERE page_id=$1`, [page]), 1);
      } finally {
        await s.rollback();
      }
    });

    await t.test('T5.2a2 幂等快照为 legacy 有效票建立出身并保留撤销行/事实 seq', async () => {
      await s.begin();
      try {
        const run = await createRun(s);
        const page = await registerPage(s, 899, 'ts2test:t5-provenance-replay');
        const voters = await ensureUsers(s, 'wikidot', 19_000, 3);
        await s.q(
          't5:seed_legacy_current',
          `INSERT INTO serve.vote_current(
             page_id,voter_id,direction,first_voted_at,last_voted_at,
             last_precision,last_seq,source_row_ordinal
           ) VALUES
             ($1,$2, 1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','bootstrap',70001,0),
             ($1,$3,-1,NULL,                  '2026-01-02T00:00:00Z','bootstrap',70002,0),
             ($1,$4, 0,'2026-01-03T00:00:00Z','2026-01-03T00:00:00Z','bootstrap',70003,0)`,
          [page, voters[0], voters[1], voters[2]],
        );
        const entries: Entry[] = [
          {
            voter_id: voters[0]!, direction: 1, source_ordinal: 1,
            identity_key: 'wikidot:19000',
          },
          {
            voter_id: voters[1]!, direction: -1, source_ordinal: 2,
            identity_key: 'wikidot:19001',
          },
        ];

        const first = await applySnapshot(s, page, run, entries);
        const replay = await applySnapshot(s, page, run, entries);
        assert.equal(first['idempotent_replay'], true);
        assert.equal(first['provenance_established'], true);
        assert.equal(first['provenance_rows_written'], 2);
        assert.equal(replay['idempotent_replay'], true);
        assert.equal(replay['provenance_established'], false);
        assert.equal(replay['provenance_rows_written'], 0);

        const state = await s.one<Record<string, string | boolean>>(
          't5:provenance_state',
          `WITH active AS (
             SELECT count(*)::int AS n,
                    bool_and(source_row_ordinal>0) AS ordinalled,
                    count(DISTINCT snapshot_hash)::int AS hash_count,
                    min(encode(snapshot_hash,'hex')) AS hash_hex,
                    string_agg(last_seq::text,',' ORDER BY voter_id) AS seqs
               FROM serve.vote_current
              WHERE page_id=$1 AND direction<>0
           ), latest AS (
             SELECT claimed_total,fetched_total,checksum_ok,checksum_actual,
                    encode(result_hash,'hex') AS hash_hex
               FROM meta.page_scan
              WHERE page_id=$1 AND kind='votes'
              ORDER BY scanned_at DESC,run_id DESC LIMIT 1
           )
           SELECT (SELECT count(*) FROM serve.vote_current WHERE page_id=$1)::text AS rows,
                  (SELECT count(*) FROM serve.vote_current
                    WHERE page_id=$1 AND direction=0)::text AS revoked,
                  (SELECT count(*) FROM ingest.vote_snapshot_event
                    WHERE page_id=$1)::text AS markers,
                  active.seqs,
                  (latest.claimed_total=active.n
                   AND latest.fetched_total=active.n
                   AND latest.checksum_ok
                   AND latest.checksum_actual=0
                   AND active.ordinalled
                   AND active.hash_count=1
                   AND latest.hash_hex=active.hash_hex) AS verified
             FROM active CROSS JOIN latest`,
          [page],
        );
        assert.deepEqual(state, {
          rows: '3',
          revoked: '1',
          markers: '0',
          seqs: '70001,70002',
          verified: true,
        });
      } finally {
        await s.rollback();
      }
    });

    await t.test(`T5.2b 随机 ${ITERATIONS} 轮：后快照覆盖前快照`, async () => {
      await s.begin();
      try {
        const run = await createRun(s);
        const page = await registerPage(s, 802, 'ts2test:t5-random-snapshot');
        const voters = await ensureUsers(s, 'wikidot', 30_000, 80);
        const rnd = mulberry32(SEED);
        const failures: string[] = [];
        let replacements = 0;
        let duplicateRounds = 0;
        let oppositeRounds = 0;

        for (let iteration = 0; iteration < ITERATIONS; iteration++) {
          const rows = Math.floor(rnd() * 45);
          const entries: Entry[] = [];
          for (let ordinal = 1; ordinal <= rows; ordinal++) {
            const voterIndex = Math.floor(rnd() * voters.length);
            const voter_id = voters[voterIndex]!;
            entries.push({
              voter_id,
              direction: rnd() < 0.72 ? 1 : -1,
              source_ordinal: ordinal,
              identity_key: `wikidot:${30_000 + voterIndex}`,
            });
          }
          const grouped = new Map<number, Set<number>>();
          for (const row of entries) {
            const directions = grouped.get(row.voter_id) ?? new Set<number>();
            directions.add(row.direction);
            grouped.set(row.voter_id, directions);
          }
          if (grouped.size < entries.length) duplicateRounds++;
          if ([...grouped.values()].some((directions) => directions.size > 1)) oppositeRounds++;

          const applied = await applySnapshot(s, page, run, entries);
          if (applied['snapshot_replaced'] === true) replacements++;
          const checked = await assertSnapshotState(s, page, entries);
          const fingerprint = await s.val<string>(
            't5:random-fingerprint',
            `SELECT md5(COALESCE(string_agg(
               source_row_ordinal||':'||voter_id||':'||direction||':'||COALESCE(source_identity_key,''), E'\n'
               ORDER BY source_row_ordinal),'')) FROM serve.vote_current WHERE page_id=$1`,
            [page],
          );
          if (checked !== fingerprint) failures.push(`iteration=${iteration} ${checked}`);

          const replay = await applySnapshot(s, page, run, entries);
          if (replay['idempotent_replay'] !== true) {
            failures.push(`iteration=${iteration} replay 未短路`);
          }
          if (failures.length > 10) break;
        }

        rep.eq('T5.2b', '全部随机轮逐轮满足快照状态', failures, []);
        rep.chk('T5.2b', '覆盖同 voter 多行', duplicateRounds > 0, `${duplicateRounds} 轮`);
        rep.chk('T5.2b', '覆盖同 voter 正负冲突', oppositeRounds > 0, `${oppositeRounds} 轮`);
        rep.chk('T5.2b', '确实发生多次替换', replacements > 1, `${replacements} 次`);
      } finally {
        await s.rollback();
      }
    });
  } finally {
    await s.end();
  }
  rep.finish();
});
