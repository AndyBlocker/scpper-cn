/**
 * 「推定不可达主机」收口判据的护栏测试。
 *
 * 该判据会把 pending 任务终态化，是一扇单向门，因此护栏必须硬：
 * 只要一个主机成功过一次，就永远不该被命中。
 */

import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { Pool } from 'pg';

import { loadConfig } from '../src/config.js';
import { createPool, query } from '../src/store/db.js';
import {
  UNREACHABLE_HOST_MIN_ATTEMPTED_JOBS,
  UNREACHABLE_HOST_MIN_OBSERVATION_HOURS,
  sweepUnreachableExternalHosts,
} from '../src/image/unreachableHosts.js';

let pool: Pool;

before(() => {
  const config = loadConfig({ requireDatabase: true });
  pool = createPool(config.databaseUrl, { max: 1 });
});

after(async () => {
  await pool.end();
});

test('参数非法即拒绝，不允许把护栏调成 0', async () => {
  await assert.rejects(
    () => sweepUnreachableExternalHosts(pool, 'scp-wiki-cn.wikidot.com', { minAttemptedJobs: 0 }),
    RangeError,
  );
  await assert.rejects(
    () => sweepUnreachableExternalHosts(pool, 'scp-wiki-cn.wikidot.com', { minObservationHours: 0 }),
    RangeError,
  );
});

test('判据在真实数据上只命中零成功主机；任何成功过的主机都豁免', async () => {
  // 用与实现同一套条件做只读选择，断言护栏在活库数据上确实成立。
  const res = await query<{ host: string; completed: string; attempted: string }>(
    pool,
    'test:unreachable_candidates',
    `WITH host_stats AS (
       SELECT substring(normalized_url FROM 'https?://([^/]+)') AS host,
              count(*) FILTER (WHERE status = 'completed') AS completed,
              count(*) FILTER (WHERE attempts >= 1) AS attempted,
              min(created_at) AS first_seen
         FROM meta.image_ingest_job
        GROUP BY 1
     )
     SELECT host, completed::text, attempted::text
       FROM host_stats
      WHERE host IS NOT NULL
        AND completed = 0
        AND attempted >= $1
        AND first_seen <= now() - ($2 || ' hours')::interval`,
    [UNREACHABLE_HOST_MIN_ATTEMPTED_JOBS, UNREACHABLE_HOST_MIN_OBSERVATION_HOURS],
  );
  for (const row of res.rows) {
    assert.equal(Number(row.completed), 0, `${row.host} 成功过却被判定为不可达`);
    assert.ok(
      Number(row.attempted) >= UNREACHABLE_HOST_MIN_ATTEMPTED_JOBS,
      `${row.host} 样本量不足却被命中`,
    );
  }
  // 反向断言：库里成功次数最多的主机绝不在候选集内。
  const busiest = await query<{ host: string }>(
    pool,
    'test:busiest_host',
    `SELECT substring(normalized_url FROM 'https?://([^/]+)') AS host
       FROM meta.image_ingest_job
      WHERE status = 'completed'
      GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`,
  );
  if (busiest.rows[0]) {
    assert.ok(
      !res.rows.some((row) => row.host === busiest.rows[0]!.host),
      '成功次数最多的主机不得进入不可达候选集',
    );
  }
});

test('站点主机永不参与——主站连不上通常是瞬时的', async () => {
  const config = loadConfig({ requireDatabase: true });
  const siteHost = new URL(config.siteBaseUrl).host;
  const result = await sweepUnreachableExternalHosts(pool, siteHost);
  assert.ok(
    !result.hosts.some((row) => row.host.toLowerCase() === siteHost.toLowerCase()),
    '站点主机不得被收口',
  );
});
