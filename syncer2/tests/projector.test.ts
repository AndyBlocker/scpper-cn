/**
 * M8 projector 回归：
 *   · safe watermark/冻结/登记契约由真实 scpper-v2 验证；
 *   · bootstrap 切日、page_daily_stats.views 不可触碰用事务内事实夹具验证；
 *   · B1–B5 前端口径与 B2/B4 末值自洽断言都真实跑通。
 *
 * 所有夹具都在一个显式事务里，末尾 ROLLBACK；只会推进不可回滚的 fact_seq，
 * 与现有 smoke/T5 测试相同，不留下任何业务行。
 */

process.env.TZ = 'Asia/Shanghai';
process.env.SYNCER2_LOG_LEVEL = 'error';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool, PoolClient } from 'pg';

import { loadConfig } from '../src/config.js';
import {
  projectPageDailyStats,
  projectUserAttrDaily,
  projectVoteDaily,
} from '../src/project/daily.js';
import { projectPageStats } from '../src/project/pageStats.js';
import {
  assertProjectionWritesAllowed,
  expandProjectionDependencies,
} from '../src/project/runner.js';
import {
  projectUserTagPreference,
  projectUserVoteInteraction,
} from '../src/project/social.js';
import {
  projectSiteOverviewDaily,
  projectSiteStats,
} from '../src/project/siteOverview.js';
import {
  L2_PROJECTIONS,
  normalizeProjectionName,
  type ProjectionWindow,
} from '../src/project/types.js';
import { projectUserPage } from '../src/project/userPage.js';
import { projectUserStats } from '../src/project/userStats.js';
import { createPool, query } from '../src/store/db.js';

let pool: Pool;

const PAGE_ID = 969_810_001;
const PAGE_WID = 969_820_001;
const AUTHOR_ID = 969_830_001;
const VOTER_1 = 969_830_002;
const VOTER_2 = 969_830_003;
const VOTER_3 = 969_830_004;

before(() => {
  const config = loadConfig();
  assert.equal(
    decodeURIComponent(new URL(config.databaseUrl).pathname.slice(1)),
    'scpper-v2',
    'projector 测试只允许写 scpper-v2；主库与用户库均只读',
  );
  pool = createPool(config.databaseUrl, { max: 1 });
});

after(async () => {
  await pool?.end().catch(() => undefined);
});

async function rollbackFixture(fn: (client: PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

function window(fromSeq: number, toSeq: number, includeDeletedPages = false): ProjectionWindow {
  return {
    fromSeq,
    toSeq,
    previousSeq: Math.max(0, fromSeq - 1),
    rebuild: false,
    includeDeletedPages,
  };
}

async function seedFixture(client: PoolClient): Promise<{ minSeq: number; maxSeq: number }> {
  await query(
    client,
    'test.projector:users',
    `INSERT INTO ingest."user"
       (id, kind, wikidot_id, username, display_name)
     VALUES
       ($1, 'wikidot', $2, 'project_author', 'Project Author'),
       ($3, 'wikidot', $4, 'project_voter_1', 'Project Voter 1'),
       ($5, 'wikidot', $6, 'project_voter_2', 'Project Voter 2'),
       ($7, 'wikidot', $8, 'project_voter_3', 'Project Voter 3')`,
    [
      AUTHOR_ID,
      AUTHOR_ID,
      VOTER_1,
      VOTER_1,
      VOTER_2,
      VOTER_2,
      VOTER_3,
      VOTER_3,
    ],
  );
  await query(
    client,
    'test.projector:page',
    `INSERT INTO ingest.page(id, wikidot_id) VALUES ($1, $2)`,
    [PAGE_ID, PAGE_WID],
  );
  await query(
    client,
    'test.projector:page_current',
    `INSERT INTO serve.page_current
       (page_id, wikidot_id, slug, status, title, tags, category, first_published_at, rating)
     VALUES
       ($1, $2, 'projector-test-page', 'deleted', 'projector test',
        ARRAY['原创','scp']::text[], 'scp', '2020-01-01T00:00:00Z'::timestamptz, 5)`,
    [PAGE_ID, PAGE_WID],
  );
  await query(
    client,
    'test.projector:attribution_current',
    `INSERT INTO serve.attribution_current
       (page_id, role, actor_id, ord, at_date, is_display, last_seq)
     VALUES ($1, 'AUTHOR', $2, 0, '2020-01-01', true, 1)`,
    [PAGE_ID, AUTHOR_ID],
  );
  const inserted = await query<{ seq: string }>(
    client,
    'test.projector:facts',
    `WITH v1 AS (
       INSERT INTO ingest.vote_event
         (page_id, voter_id, kind, new_direction, occurred_at, observed_at,
          time_precision, source)
       VALUES
         ($1, $2, 'vote', -1, '2026-01-01T16:30:00Z'::timestamptz,
          '2026-01-01T16:30:00Z'::timestamptz, 'day', 'test_projector')
       RETURNING seq
     ),
     v2 AS (
       INSERT INTO ingest.vote_event
         (page_id, voter_id, kind, new_direction, occurred_at, observed_at,
          time_precision, source)
       VALUES
         ($1, $3, 'vote', 1, '2026-01-01T16:30:00Z'::timestamptz,
          '2026-01-01T16:30:00Z'::timestamptz, 'exact', 'test_projector')
       RETURNING seq
     ),
     vb AS (
       INSERT INTO ingest.vote_event
         (page_id, voter_id, kind, new_direction, occurred_at, observed_at,
          time_precision, source)
       VALUES
         ($1, $4, 'vote', 1, '2022-05-25T00:00:00Z'::timestamptz,
          '2022-05-25T00:00:00Z'::timestamptz, 'bootstrap', 'test_projector')
       RETURNING seq
     ),
     rv AS (
       INSERT INTO ingest.revision
         (page_id, wikidot_revision_id, rev_no, type, occurred_at, observed_at, source)
       VALUES
         ($1, 969840001, 1, ARRAY['SOURCE_CHANGED']::text[],
          '2026-01-01T10:00:00Z'::timestamptz,
          '2026-01-01T10:00:00Z'::timestamptz, 'test_projector')
       RETURNING seq
     )
     SELECT seq::text FROM v1
     UNION ALL SELECT seq::text FROM v2
     UNION ALL SELECT seq::text FROM vb
     UNION ALL SELECT seq::text FROM rv`,
    [PAGE_ID, VOTER_1, VOTER_2, VOTER_3],
  );
  const seqs = inserted.rows.map((row) => Number(row.seq));
  const minSeq = Math.min(...seqs);
  const maxSeq = Math.max(...seqs);
  await query(
    client,
    'test.projector:current_votes',
    `INSERT INTO serve.vote_current
       (page_id, voter_id, direction, first_voted_at, last_voted_at, last_precision, last_seq)
     VALUES
       ($1, $2, -1, '2026-01-01T16:30:00Z'::timestamptz,
        '2026-01-01T16:30:00Z'::timestamptz, 'day', $5),
       ($1, $3, 1, '2026-01-01T16:30:00Z'::timestamptz,
        '2026-01-01T16:30:00Z'::timestamptz, 'exact', $5),
       ($1, $4, 1, NULL,
        '2022-05-25T00:00:00Z'::timestamptz, 'bootstrap', $5)`,
    [PAGE_ID, VOTER_1, VOTER_2, VOTER_3, maxSeq],
  );
  return { minSeq, maxSeq };
}

describe('投影清单与依赖解析', () => {
  it('十张前端 L2 投影完整且短名/全名归一一致', () => {
    assert.equal(L2_PROJECTIONS.length, 10);
    assert.equal(normalizeProjectionName('page_stats'), 'serve.page_stats');
    assert.equal(normalizeProjectionName('serve.page_daily_stats'), 'serve.page_daily_stats');
    assert.equal(normalizeProjectionName('site_stats'), 'serve.site_stats');
    assert.throws(() => normalizeProjectionName(''), /未知 L2 投影/);
    assert.throws(() => normalizeProjectionName('not_a_projection'), /未知 L2 投影/);
  });

  it('单跑 user_stats 会显式补上 B4 曲线与 B2 作品集合前置依赖', () => {
    assert.deepEqual(expandProjectionDependencies(['serve.user_stats']), [
      'serve.user_attr_daily',
      'serve.user_page',
      'serve.user_stats',
    ]);
  });
});

describe('真实数据库契约', () => {
  it('rebuild_from 与 COMMENT 逐字一致，且安全水位来自函数', async () => {
    const result = await pool.query<{
      projection: string;
      same: boolean;
      watermark: string | null;
      last_value: string;
    }>(
      `SELECT c.projection,
              c.rebuild_from = obj_description(c.projection::regclass, 'pg_class') AS same,
              meta.safe_seq_watermark()::text AS watermark,
              pg_sequence_last_value('ingest.fact_seq'::regclass)::text AS last_value
         FROM meta.projection_cursor c
        WHERE c.projection = ANY($1::text[])
        ORDER BY c.projection`,
      [L2_PROJECTIONS],
    );
    assert.equal(result.rows.length, 10);
    assert.ok(result.rows.every((row) => row.same));
    assert.ok(result.rows.every((row) => row.watermark === null || Number(row.watermark) <= Number(row.last_value)));
  });

  it('projection 冻结在任何投影写入前以 PGF01 拒绝', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT meta.freeze_writes('projection', 'projector.test 冻结负向用例', 'node:test')`,
      );
      await assert.rejects(
        () => assertProjectionWritesAllowed(client),
        (err: unknown) => {
          assert.equal((err as { code?: string }).code, 'PGF01');
          return true;
        },
      );
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('纯页面元数据变化会分配安全 seq，并触发 tag 偏好增量重算', async () => {
    await rollbackFixture(async (client) => {
      const seeded = await seedFixture(client);
      const before = await query<{ cursor_seq: string }>(
        client,
        'test.projector:page_meta_signal_before',
        `SELECT cursor_seq::text
           FROM serve.page_current
          WHERE page_id = $1`,
        [PAGE_ID],
      );

      await query(
        client,
        'test.projector:page_meta_signal_apply',
        `SELECT ingest.apply_page_meta(
           $1,
           jsonb_build_object(
             'tags', jsonb_build_array('projector-signal'),
             'hidden_tags', jsonb_build_array('_projector-hidden')
           ),
           '2026-01-03T00:00:00Z'::timestamptz,
           'test_projector',
           NULL,
           $2
         )`,
        [PAGE_ID, PAGE_WID],
      );
      const after = await query<{ cursor_seq: string }>(
        client,
        'test.projector:page_meta_signal_after',
        `SELECT cursor_seq::text
           FROM serve.page_current
          WHERE page_id = $1`,
        [PAGE_ID],
      );
      const beforeSeq = Number(before.rows[0]?.cursor_seq);
      const afterSeq = Number(after.rows[0]?.cursor_seq);
      assert.ok(afterSeq > beforeSeq);
      assert.ok(afterSeq > seeded.maxSeq);

      const projected = await projectUserTagPreference(
        client,
        window(afterSeq, afterSeq),
      );
      assert.equal(projected.affectedKeys, 3);
      assert.equal(projected.rowsWritten, 0, 'B3：deleted 页标签不能进入偏好');

      const tags = await query<{ tag: string; up_count: number; down_count: number }>(
        client,
        'test.projector:page_meta_signal_result',
        `SELECT tag, up_count, down_count
           FROM serve.user_tag_preference
          WHERE user_id = $1
          ORDER BY tag`,
        [VOTER_1],
      );
      assert.deepEqual(tags.rows, []);
    });
  });
});

describe('逐日与当前态折叠', () => {
  it('精度分流、bootstrap 排除、Wilson/争议度与 views 守卫同时成立', async () => {
    await rollbackFixture(async (client) => {
      const seq = await seedFixture(client);
      const w = window(seq.minSeq, seq.maxSeq);

      const pageStats = await projectPageStats(client, w);
      assert.equal(pageStats.rowsWritten, 1);
      const stats = await query<{
        uv: number;
        dv: number;
        like_ratio: number;
        controversy: number;
      }>(
        client,
        'test.projector:page_stats_result',
        `SELECT uv, dv, like_ratio, controversy
           FROM serve.page_stats WHERE page_id = $1`,
        [PAGE_ID],
      );
      assert.deepEqual(
        { uv: stats.rows[0]?.uv, dv: stats.rows[0]?.dv },
        { uv: 2, dv: 1 },
        'bootstrap 是真票，必须参与总量 page_stats',
      );
      assert.ok(Math.abs(Number(stats.rows[0]?.like_ratio) - 2 / 3) < 1e-5);
      assert.ok(Math.abs(Number(stats.rows[0]?.controversy) - 8 / 9) < 1e-5);

      await projectVoteDaily(client, w);
      const daily = await query<{
        day: string;
        up: number;
        down: number;
        revoked: number;
        cum_rating: number;
      }>(
        client,
        'test.projector:vote_daily_result',
        `SELECT day::text, up, down, revoked, cum_rating
           FROM serve.vote_daily
          WHERE page_id = $1 ORDER BY day`,
        [PAGE_ID],
      );
      assert.deepEqual(daily.rows, [
        { day: '2026-01-01', up: 0, down: 1, revoked: 0, cum_rating: -1 },
        { day: '2026-01-02', up: 1, down: 0, revoked: 0, cum_rating: 0 },
      ]);

      await projectUserAttrDaily(client, w);
      const attrDaily = await query<{
        day: string;
        up: number;
        down: number;
        rating_delta: number;
        cum_rating: number;
      }>(
        client,
        'test.projector:user_attr_daily_result',
        `SELECT day::text, up, down, rating_delta, cum_rating
           FROM serve.user_attr_daily
          WHERE user_id = $1 ORDER BY day`,
        [AUTHOR_ID],
      );
      assert.deepEqual(attrDaily.rows, [
        { day: '2026-01-01', up: 0, down: 1, rating_delta: -1, cum_rating: -1 },
        { day: '2026-01-02', up: 1, down: 0, rating_delta: 1, cum_rating: 0 },
      ]);

      const interactions = await projectUserVoteInteraction(client, w);
      assert.equal(interactions.rowsWritten, 3, '当前态三名 voter 都形成一条作者交互');
      const interaction = await query<{ up_count: number; down_count: number; total: number }>(
        client,
        'test.projector:interaction_result',
        `SELECT sum(up_count)::int AS up_count,
                sum(down_count)::int AS down_count,
                sum(total)::int AS total
           FROM serve.user_vote_interaction
          WHERE to_user_id = $1`,
        [AUTHOR_ID],
      );
      assert.deepEqual(interaction.rows[0], { up_count: 2, down_count: 1, total: 3 });

      const tagPreference = await projectUserTagPreference(client, w);
      assert.equal(tagPreference.rowsWritten, 0, 'B3：deleted 页标签不进入可点击标签统计');

      await query(
        client,
        'test.projector:views_fixture',
        `INSERT INTO serve.page_daily_stats
           (page_id, date, views, votes_up, votes_down, unique_voters, revisions)
         VALUES ($1, '2026-01-01', 77, 9, 8, 7, 6)`,
        [PAGE_ID],
      );
      await projectPageDailyStats(client, { ...w, rebuild: true });
      const pageDaily = await query<{
        date: string;
        views: number;
        votes_up: number;
        votes_down: number;
        unique_voters: number;
        revisions: number;
      }>(
        client,
        'test.projector:page_daily_result',
        `SELECT date::text, views, votes_up, votes_down, unique_voters, revisions
           FROM serve.page_daily_stats
          WHERE page_id = $1 ORDER BY date`,
        [PAGE_ID],
      );
      assert.deepEqual(pageDaily.rows, [
        {
          date: '2026-01-01',
          views: 77,
          votes_up: 0,
          votes_down: 1,
          unique_voters: 1,
          revisions: 1,
        },
        {
          date: '2026-01-02',
          views: 0,
          votes_up: 1,
          votes_down: 0,
          unique_voters: 1,
          revisions: 0,
        },
      ]);
      assert.equal(
        pageDaily.rows.some((row) => row.date === '2022-05-25'),
        false,
        'bootstrap 假日期绝不能进入 page_daily_stats',
      );
    });
  });

  it('user_page/user_stats 的已删页开关两种口径都能跑', async () => {
    await rollbackFixture(async (client) => {
      const seq = await seedFixture(client);

      await projectUserPage(client, window(seq.minSeq, seq.maxSeq, false));
      let userPage = await query(
        client,
        'test.projector:user_page_excluded',
        `SELECT 1 FROM serve.user_page WHERE user_id=$1 AND page_id=$2`,
        [AUTHOR_ID, PAGE_ID],
      );
      assert.equal(userPage.rowCount, 0);

      await projectUserStats(client, window(seq.minSeq, seq.maxSeq, false));
      let stats = await query<{
        page_count: number;
        votes_cast_up: number;
        votes_received_up: number;
      }>(
        client,
        'test.projector:user_stats_excluded',
        `SELECT page_count, votes_cast_up, votes_received_up
           FROM serve.user_stats WHERE user_id=$1`,
        [AUTHOR_ID],
      );
      assert.equal(stats.rows[0]?.page_count, 0);
      assert.equal(stats.rows[0]?.votes_received_up, 0);

      await projectUserPage(client, window(seq.minSeq, seq.maxSeq, true));
      userPage = await query(
        client,
        'test.projector:user_page_included',
        `SELECT 1 FROM serve.user_page WHERE user_id=$1 AND page_id=$2`,
        [AUTHOR_ID, PAGE_ID],
      );
      assert.equal(userPage.rowCount, 1);

      await projectUserStats(client, window(seq.minSeq, seq.maxSeq, true));
      stats = await query(
        client,
        'test.projector:user_stats_included',
        `SELECT page_count, votes_cast_up, votes_received_up
           FROM serve.user_stats WHERE user_id=$1`,
        [AUTHOR_ID],
      );
      assert.equal(stats.rows[0]?.page_count, 1);
      assert.equal(stats.rows[0]?.votes_received_up, 2);
    });
  });

  it('B3 只算活页；B5 的 deleted:/old: 归档活页仍进入标签与作品投影', async () => {
    await rollbackFixture(async (client) => {
      const seq = await seedFixture(client);
      await query(
        client,
        'test.projector:b3_b5_live_archive',
        `UPDATE serve.page_current
            SET status = 'live',
                slug = 'deleted:projector-archive'
          WHERE page_id = $1`,
        [PAGE_ID],
      );

      const tags = await projectUserTagPreference(
        client,
        window(seq.minSeq, seq.maxSeq),
      );
      assert.equal(tags.rowsWritten, 6, 'B5：三名 voter × 两个 tag，前缀不能误杀活页');

      await projectUserPage(client, window(seq.minSeq, seq.maxSeq, false));
      const archiveWork = await query(
        client,
        'test.projector:b5_user_page',
        `SELECT 1 FROM serve.user_page WHERE user_id=$1 AND page_id=$2`,
        [AUTHOR_ID, PAGE_ID],
      );
      assert.equal(archiveWork.rowCount, 1);
    });
  });

  it('B4 在删除当天写完整负柱，且 B2/B4 曲线末值断言通过', async () => {
    await rollbackFixture(async (client) => {
      const seq = await seedFixture(client);
      await query(
        client,
        'test.projector:b4_page_vote_shape',
        `UPDATE serve.page_current
            SET rating = 1, vote_up = 2, vote_down = 1
          WHERE page_id = $1`,
        [PAGE_ID],
      );
      const deleted = await query<{ seq: string }>(
        client,
        'test.projector:b4_deleted_event',
        `INSERT INTO ingest.page_life_event
           (page_id, kind, occurred_at, occurred_precision, observed_at, source)
         VALUES (
           $1, 'deleted',
           '2026-01-03T10:00:00Z'::timestamptz,
           'exact',
           '2026-01-03T10:00:00Z'::timestamptz,
           'test_projector'
         )
         RETURNING seq::text`,
        [PAGE_ID],
      );
      const deletedSeq = Number(deleted.rows[0]?.seq);
      const w = window(seq.minSeq, deletedSeq, false);

      await projectUserAttrDaily(client, w);
      const curve = await query<{
        day: string;
        up: number;
        down: number;
        rating_delta: number;
        cum_rating: number;
      }>(
        client,
        'test.projector:b4_curve',
        `SELECT day::text, up, down, rating_delta, cum_rating
           FROM serve.user_attr_daily
          WHERE user_id = $1
          ORDER BY day`,
        [AUTHOR_ID],
      );
      assert.deepEqual(curve.rows, [
        { day: '2026-01-01', up: 0, down: 1, rating_delta: -1, cum_rating: 0 },
        { day: '2026-01-02', up: 1, down: 0, rating_delta: 1, cum_rating: 1 },
        { day: '2026-01-03', up: -2, down: -1, rating_delta: -1, cum_rating: 0 },
      ]);

      await projectUserPage(client, w);
      const statsResult = await projectUserStats(client, w);
      assert.ok(
        statsResult.notes?.some((note) => note.includes('抽样 1 位')),
        '必须真实执行 B2/B4 有已删作品作者抽样断言',
      );
      const end = await query<{ cum_rating: number; total_rating: number }>(
        client,
        'test.projector:b2_b4_end_value',
        `SELECT uad.cum_rating, us.total_rating
           FROM serve.user_stats us
           JOIN LATERAL (
             SELECT cum_rating
               FROM serve.user_attr_daily
              WHERE user_id = us.user_id
              ORDER BY day DESC
              LIMIT 1
           ) uad ON true
          WHERE us.user_id = $1`,
        [AUTHOR_ID],
      );
      assert.deepEqual(end.rows[0], { cum_rating: 0, total_rating: 0 });
    });
  });

  it('B2/B4 在同一 voter 多行的新口径下仍以行评分闭合', async () => {
    await rollbackFixture(async (client) => {
      const seeded = await seedFixture(client);
      const applied = await query<{ result: Record<string, unknown> }>(
        client,
        'test.projector:multiplicity_snapshot',
        `SELECT ingest.apply_vote_snapshot(
           $1,
           jsonb_build_array(
             jsonb_build_object('voter_id',$2::int,'direction',1,'source_ordinal',1,'identity_key','wikidot:multi'),
             jsonb_build_object('voter_id',$2::int,'direction',1,'source_ordinal',2,'identity_key','wikidot:multi')
           ),
           true, 2, 2, ARRAY['wikidot']::text[],
           '2026-01-02T08:00:00Z'::timestamptz,
           'test_projector', NULL, $3::int,
           'candidate', 500, 0.20::real
         ) AS result`,
        [PAGE_ID, VOTER_1, PAGE_WID],
      );
      assert.equal(applied.rows[0]?.result['scan_status'], 'ok');

      await query(
        client,
        'test.projector:duplicate_display_role',
        `INSERT INTO serve.attribution_current
           (page_id,role,actor_id,ord,at_date,is_display,last_seq)
         VALUES ($1,'REWRITER',$2,1,'2020-01-01',true,1)`,
        [PAGE_ID, AUTHOR_ID],
      );

      const deleted = await query<{ seq: string }>(
        client,
        'test.projector:multiplicity_deleted',
        `INSERT INTO ingest.page_life_event
           (page_id,kind,occurred_at,occurred_precision,observed_at,source)
         VALUES ($1,'deleted','2026-01-03T10:00:00Z','exact',
                 '2026-01-03T10:00:00Z','test_projector')
         RETURNING seq::text`,
        [PAGE_ID],
      );
      const toSeq = Number(deleted.rows[0]?.seq);
      await query(
        client,
        'test.projector:multiplicity_restored',
        `UPDATE serve.page_current
            SET status='live',deleted_at=NULL,deleted_at_precision=NULL
          WHERE page_id=$1`,
        [PAGE_ID],
      );
      const w = window(seeded.minSeq, toSeq, false);
      await projectUserAttrDaily(client, w);
      await projectUserPage(client, w);
      const statsResult = await projectUserStats(client, w);

      const closed = await query<{
        cum_rating: number;
        total_rating: number;
        votes_cast_up: number;
        voted_page_count: number;
      }>(
        client,
        'test.projector:multiplicity_closed',
        `SELECT curve.cum_rating,author_stats.total_rating,voter_stats.votes_cast_up,
                voter_stats.voted_page_count
           FROM serve.user_stats author_stats
           JOIN serve.user_stats voter_stats ON voter_stats.user_id=$2
           JOIN LATERAL (
             SELECT cum_rating FROM serve.user_attr_daily
              WHERE user_id=author_stats.user_id ORDER BY day DESC LIMIT 1
           ) curve ON true
          WHERE author_stats.user_id=$1`,
        [AUTHOR_ID, VOTER_1],
      );
      assert.deepEqual(closed.rows[0], {
        cum_rating: 2,
        total_rating: 2,
        votes_cast_up: 2,
        voted_page_count: 1,
      });
      assert.ok(
        statsResult.notes?.some((note) => note.includes('曲线末值全部等于 total_rating')),
      );
    });
  });

  it('B1 站点总览的页面、票、修订、作者全部计入已删页', async () => {
    await rollbackFixture(async (client) => {
      const seq = await seedFixture(client);
      const w = window(seq.minSeq, seq.maxSeq, false);
      await projectUserPage(client, w);
      await projectUserStats(client, w);
      await projectSiteStats(client, w);
      await projectSiteOverviewDaily(client, w);

      const stats = await query<{
        pages_match: boolean;
        votes_match: boolean;
        events_match: boolean;
      }>(
        client,
        'test.projector:b1_site_stats',
        `SELECT
           ss.total_pages = (SELECT count(*) FROM serve.page_current) AS pages_match,
           ss.total_votes_state = (
             SELECT count(*) FROM serve.vote_current WHERE direction <> 0
           ) AS votes_match,
           ss.total_votes_events = (
             SELECT count(*) FROM ingest.vote_event WHERE seq <= $1::bigint
           ) AS events_match
         FROM serve.site_stats ss
        WHERE ss.id = 1`,
        [seq.maxSeq],
      );
      assert.deepEqual(stats.rows[0], {
        pages_match: true,
        votes_match: true,
        events_match: true,
      });

      const overview = await query<{
        pages_match: boolean;
        authors_include_deleted_fixture: boolean;
        revisions_match: boolean;
      }>(
        client,
        'test.projector:b1_site_overview',
        `WITH latest AS (
           SELECT *
             FROM serve.site_overview_daily
            ORDER BY date DESC
            LIMIT 1
         )
         SELECT
           latest.pages_total = (SELECT count(*) FROM serve.page_current) AS pages_match,
           latest.users_authors >= 1 AS authors_include_deleted_fixture,
           (SELECT sum(revisions_total) FROM serve.site_overview_daily)
             = (SELECT count(*) FROM ingest.revision WHERE seq <= $1::bigint)
             AS revisions_match
         FROM latest`,
        [seq.maxSeq],
      );
      assert.deepEqual(overview.rows[0], {
        pages_match: true,
        authors_include_deleted_fixture: true,
        revisions_match: true,
      });
    });
  });
});
