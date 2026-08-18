/**
 * M7 删除协议与解析健康熔断测试。
 *
 * 网络测试只打本机 HTTP server；数据库测试只写 meta.*，并在末尾按 run id 精确清理。
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import {
  DELETION_ABSENCE_MAX_PAGES,
  DELETION_ABSENCE_MAX_RATIO,
  confirmDeletedPages,
  evaluateAbsenceCircuit,
  inferDeletionCandidates,
  intersectConsecutiveAbsences,
  isDeletionScopeSlug,
  validateDeletionRunPair,
  type DeletionEnumerationRun,
} from '../src/collect/deletion.js';
import {
  DEFAULT_PARSE_HEALTH_POLICIES,
  freezeDomainsForMetric,
  metricCurrentEventCount,
  PARSE_HEALTH_MIN_RARE_EVENT_COUNT,
  PARSE_HEALTH_METRIC_CLASSIFICATION,
  REQUIRED_PARSE_FINGERPRINT_KEYS,
  evaluateMetric,
  evaluateParseHealth,
  normalizeParseFingerprint,
  parseHealthPoliciesForStratum,
} from '../src/health/parseHealth.js';
import { HttpClient } from '../src/http/client.js';
import { createPool, query } from '../src/store/db.js';
import { finishIngestRun, startIngestRun } from '../src/store/meta.js';
import { resolveTestDatabaseUrl } from './helpers/pg.js';

const pool = createPool(resolveTestDatabaseUrl(), { max: 2 });
const TEST_MARKER = 'm7_deletion_test';
const createdRunIds: number[] = [];

let server: http.Server;
let baseUrl = '';

before(async () => {
  server = http.createServer((req, res) => {
    const slug = (req.url ?? '/').split('/')[1] ?? '';
    if (slug === 'gone') {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('not found');
      return;
    }
    if (slug === 'broken') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><title>WAF soft error</title></html>');
      return;
    }
    const pageId = slug === 'live' ? 700001 : 700099;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`
      <script>
      WIKIREQUEST.info.pageId = ${pageId};
      WIKIREQUEST.info.pageUnixName = "${slug}";
      </script>
      <div id="page-content">ok</div>
    `);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('本地测试服未监听');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (createdRunIds.length > 0) {
    await query(
      pool,
      'test:m7:cleanup_tasks',
      `DELETE FROM meta.scan_task
        WHERE kind = 'confirm_deleted'
          AND reasons && ARRAY[$1]::text[]`,
      [TEST_MARKER],
    );
    await query(
      pool,
      'test:m7:cleanup_runs',
      `DELETE FROM meta.ingest_run WHERE id = ANY($1::bigint[])`,
      [createdRunIds],
    );
  }
  await query(
    pool,
    'test:m7:cleanup_health_baseline',
    `DELETE FROM meta.parse_health_baseline
      WHERE source IN (
        'test_m7_health',
        'test_m7_empty_queue',
        'test_m7_health_modes',
        'test_m7_health_populations',
        'test_m7_write_freeze'
      )`,
  );
  await query(
    pool,
    'test:m7:cleanup_production_test_stratum',
    `DELETE FROM meta.parse_health_baseline
      WHERE source = 'wikidot_tier2'
        AND mode = 'test_write_freeze'
        AND population_type = 'test_write_freeze'`,
  );
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await pool.end();
});

function run(
  id: number,
  kind: 'sitemap' | 'listpages',
  at: string,
): DeletionEnumerationRun {
  return {
    id,
    source: kind === 'sitemap' ? 'wikidot_sitemap' : 'wikidot',
    mode: kind === 'sitemap' ? 'full' : 'tier1',
    pageScanPolicy: kind === 'sitemap' ? 'all' : null,
    usedFallback: false,
    status: 'ok',
    startedAt: at,
    finishedAt: at,
    pagesEnumerated: kind === 'sitemap' ? 35_983 : 36_173,
    remoteTotal: kind === 'sitemap' ? 35_983 : 36_173,
    remoteTotalSource: kind === 'sitemap' ? 'sitemap' : 'listpages_total',
    coverageRatio: 1,
    batchesFailed: 0,
  };
}

describe('M7 删除推断四道门', () => {
  it('双源完整门必须同时通过，fallback/0.97/failed 任一项都拒绝', () => {
    const pair = {
      sitemap: run(1, 'sitemap', '2026-07-27T04:00:00.000Z'),
      listpages: run(2, 'listpages', '2026-07-27T03:30:00.000Z'),
    };
    assert.deepEqual(validateDeletionRunPair(pair), { ok: true, reasons: [] });

    const fallback = {
      ...pair,
      sitemap: { ...pair.sitemap, usedFallback: true },
    };
    assert.equal(validateDeletionRunPair(fallback).ok, false);
    assert.match(validateDeletionRunPair(fallback).reasons.join(' '), /fallback/);

    const short = {
      ...pair,
      listpages: { ...pair.listpages, coverageRatio: 0.97 },
    };
    assert.equal(validateDeletionRunPair(short).ok, false);
    assert.match(validateDeletionRunPair(short).reasons.join(' '), /0.97/);

    const failed = {
      ...pair,
      sitemap: { ...pair.sitemap, status: 'failed' },
    };
    assert.equal(validateDeletionRunPair(failed).ok, false);

    const incompleteEvidence = {
      ...pair,
      sitemap: { ...pair.sitemap, pageScanPolicy: 'changed' },
    };
    assert.equal(validateDeletionRunPair(incompleteEvidence).ok, false);
    assert.match(validateDeletionRunPair(incompleteEvidence).reasons.join(' '), /page_scan=changed/);
  });

  it('L1 单轮漏页不构成连续缺席，现代 L1 partial/降档覆盖不能提供负证据', () => {
    const page = { pageId: 42, wikidotId: 700042, slug: 'scp-cn-42' };
    assert.deepEqual(intersectConsecutiveAbsences([page], []), []);
    assert.deepEqual(intersectConsecutiveAbsences([], [page]), []);
    assert.deepEqual(intersectConsecutiveAbsences([page], [page]), [page]);

    const sitemap = run(10, 'sitemap', '2026-07-27T04:00:00.000Z');
    const modernL1: DeletionEnumerationRun = {
      ...run(11, 'listpages', '2026-07-27T03:30:00.000Z'),
      source: 'wikidot_listpages',
      mode: 'l1_votes',
    };
    assert.deepEqual(validateDeletionRunPair({ sitemap, listpages: modernL1 }), {
      ok: true,
      reasons: [],
    });

    const degraded = {
      sitemap,
      listpages: { ...modernL1, status: 'partial', coverageRatio: 0.4 },
    };
    const gate = validateDeletionRunPair(degraded);
    assert.equal(gate.ok, false);
    assert.match(gate.reasons.join(' '), /status=partial/);
    assert.match(gate.reasons.join(' '), /coverage=0.4/);
  });

  it('absence >500 或 >1.5% 任一条件立即整轮熔断，边界值本身放行', () => {
    assert.equal(
      evaluateAbsenceCircuit(DELETION_ABSENCE_MAX_PAGES, 100_000).tripped,
      false,
    );
    assert.equal(evaluateAbsenceCircuit(501, 100_000).tripped, true);
    assert.equal(evaluateAbsenceCircuit(15, 1_000).tripped, false);
    assert.equal(evaluateAbsenceCircuit(16, 1_000).tripped, true);
    assert.equal(DELETION_ABSENCE_MAX_RATIO, 0.015);
  });

  it('sitemap 系统性排除分类与隐藏页永不进入删除候选', () => {
    for (const slug of [
      'deleted:x',
      'forum:x',
      'adult:x',
      'wanderers-adult:x',
      '_hidden',
      'component:_hidden',
    ]) {
      assert.equal(isDeletionScopeSlug(slug), false, slug);
    }
    assert.equal(isDeletionScopeSlug('scp-cn-1000'), true);
    assert.equal(isDeletionScopeSlug('component:image-block'), true);
  });

  it('合法存在、单点 404 与解析失败显式可区分，失败项不会从 Map 消失', async () => {
    const client = new HttpClient({
      userAgent: 'syncer2-m7-test',
      referer: `${baseUrl}/`,
      timeoutMs: 2_000,
      maxAttempts: 1,
      breaker503: 5,
      breakerReset: 5,
    });
    try {
      const results = await confirmDeletedPages(
        client,
        baseUrl,
        [
          { pageId: 1, wikidotId: 700001, slug: 'live' },
          { pageId: 2, wikidotId: 700002, slug: 'gone' },
          { pageId: 3, wikidotId: 700003, slug: 'broken' },
        ],
        2,
      );
      assert.equal(results.size, 3);
      assert.deepEqual(results.get(1), {
        status: 'ok',
        data: { deleted: false, httpStatus: 200, evidence: 'page_exists' },
      });
      assert.deepEqual(results.get(2), {
        status: 'ok',
        data: { deleted: true, httpStatus: 404, evidence: 'http_404' },
      });
      const broken = results.get(3);
      assert.equal(broken?.status, 'failed');
      assert.match(
        broken?.status === 'failed' ? broken.error : '',
        /解析不出 WIKIREQUEST\.info\.pageId/,
      );
    } finally {
      await client.close();
    }
  });

  it('真实 meta 证据链中当前或上一组 12.5% absence 都会熔断且不下任务', async () => {
    const live = await query<{ page_id: number; slug: string }>(
      pool,
      'test:m7:live_pages',
      `SELECT page_id, slug FROM serve.page_current WHERE status='live' ORDER BY page_id`,
    );
    const scoped = live.rows.filter((row) => isDeletionScopeSlug(row.slug));
    if (scoped.length === 0) return;

    const times = [
      '2026-07-27T01:00:00.000Z',
      '2026-07-27T02:00:00.000Z',
      '2026-07-27T05:00:00.000Z',
      '2026-07-27T06:00:00.000Z',
    ];
    const ids = [];
    for (let i = 0; i < 4; i++) {
      const sitemap = i % 2 === 1;
      const inserted = await query<{ id: string }>(
        pool,
        'test:m7:insert_run',
        `INSERT INTO meta.ingest_run
           (source, started_at, finished_at, status, pages_enumerated, remote_total,
            remote_total_source, batches_total, batches_failed, stats)
         VALUES (
           $1, $2::timestamptz, $2::timestamptz, 'ok', $3, $3, $4, $5, 0,
           jsonb_build_object(
             'mode',$6::text,
             'pageScanPolicy',CASE WHEN $6::text='full' THEN 'all' ELSE NULL END,
             'm7Test',$7::text
           )
         )
         RETURNING id::text`,
        [
          sitemap ? 'wikidot_sitemap' : 'wikidot',
          times[i],
          sitemap ? 35_983 : 36_173,
          sitemap ? 'sitemap' : 'listpages_total',
          sitemap ? 5 : 145,
          sitemap ? 'full' : 'tier1',
          TEST_MARKER,
        ],
      );
      ids.push(Number(inserted.rows[0]!.id));
    }
    createdRunIds.push(...ids);

    // 每组顺序是 ListPages → sitemap。当前组刻意漏一页；上一组全见。
    const allIds = scoped.map((row) => Number(row.page_id));
    const currentSeen = allIds.slice(1);
    for (const [runId, pageIds] of [
      [ids[0]!, allIds],
      [ids[1]!, allIds],
      [ids[2]!, currentSeen],
      [ids[3]!, currentSeen],
    ] as const) {
      if (pageIds.length === 0) continue;
      await query(
        pool,
        'test:m7:insert_scans',
        `INSERT INTO meta.page_scan(run_id,page_id,kind,status)
         SELECT $1, unnest($2::int[]), 'meta', 'ok'
         ON CONFLICT DO NOTHING`,
        [runId, pageIds],
      );
    }

    const report = await inferDeletionCandidates(pool, ids[3]!);
    const expectedRatio = 1 / scoped.length;
    assert.equal(report.currentAbsent, 1);
    assert.equal(report.currentAbsentRatio, expectedRatio);
    assert.equal(report.circuitTripped, expectedRatio > 0.015);
    assert.equal(report.tasksEnqueued, 0);

    if (expectedRatio > 0.015) {
      // 交换缺席位置：当前组重新看见该页，上一组改为缺席。若实现只查当前轮，
      // 这里会错误放行上一组的坏基线。
      await query(
        pool,
        'test:m7:remove_previous_sightings',
        `DELETE FROM meta.page_scan
          WHERE run_id = ANY($1::bigint[]) AND page_id = $2`,
        [[ids[0]!, ids[1]!], allIds[0]],
      );
      await query(
        pool,
        'test:m7:add_current_sightings',
        `INSERT INTO meta.page_scan(run_id,page_id,kind,status)
         SELECT unnest($1::bigint[]), $2, 'meta', 'ok'
         ON CONFLICT DO NOTHING`,
        [[ids[2]!, ids[3]!], allIds[0]],
      );
      const previousCircuit = await inferDeletionCandidates(pool, ids[3]!);
      assert.equal(previousCircuit.currentAbsent, 0);
      assert.equal(previousCircuit.circuitTripped, true);
      assert.match(previousCircuit.reason, /上一组 absence 熔断/);
      assert.equal(previousCircuit.tasksEnqueued, 0);
    }
  });
});

describe('M7 解析健康指纹与判定', () => {
  it('每轮指纹显式包含十项原始证据和两项完整性比率，未观测值为 null 而不是 0', () => {
    const fingerprint = normalizeParseFingerprint(
      {
        avg_votes_per_page: 3,
        http_status_dist: { 200: 9, transport: 1 },
      },
      { byIp: { '203.0.113.10': 2 } },
    );
    for (const key of REQUIRED_PARSE_FINGERPRINT_KEYS) {
      assert.equal(Object.hasOwn(fingerprint, key), true, key);
    }
    assert.equal(fingerprint.avg_votes_per_page, 3);
    assert.equal(fingerprint.avg_source_len, null);
    assert.equal(fingerprint.fetched_claimed_ratio, null);
    assert.deepEqual(fingerprint.exit_ip_dist, { '203.0.113.10': 2 });
    assert.deepEqual(
      normalizeParseFingerprint({}, {
        byIp: {
          '203.0.113.11': { probes: 3, lastSeenAt: '2026-07-29T00:00:00Z' },
        },
      }).exit_ip_dist,
      { '203.0.113.11': 3 },
    );
  });

  it('population-sensitive 指标只留作证据，不进入默认熔断策略', () => {
    for (const metric of [
      'revision_type_dist',
      'avg_votes_per_page',
      'avg_tags_len',
      'avg_source_len',
      'avg_body_len',
    ] as const) {
      assert.equal(
        PARSE_HEALTH_METRIC_CLASSIFICATION[metric].populationSensitivity,
        'sensitive',
      );
      assert.equal(
        DEFAULT_PARSE_HEALTH_POLICIES.some((policy) => policy.metric === metric),
        false,
        metric,
      );
    }
  });

  it('12 项指标的统计语义完整分类，四类稀有事件率共用坏事件门槛', () => {
    const expected = {
      revision_type_dist: 'distribution_drift',
      avg_votes_per_page: 'stable_mean',
      avg_tags_len: 'stable_mean',
      avg_source_len: 'stable_mean',
      avg_body_len: 'stable_mean',
      http_status_dist: 'rare_event_rate',
      exit_ip_dist: 'concentration',
      transport_failure_rate: 'rare_event_rate',
      parse_drop_rate: 'rare_event_rate',
      selector_empty_rate: 'rare_event_rate',
      fetched_claimed_ratio: 'bounded_ratio',
      checksum_ok_rate: 'bounded_ratio',
    } as const;
    assert.deepEqual(
      Object.fromEntries(
        REQUIRED_PARSE_FINGERPRINT_KEYS.map((metric) => [
          metric,
          PARSE_HEALTH_METRIC_CLASSIFICATION[metric].statisticType,
        ]),
      ),
      expected,
    );
    assert.equal(PARSE_HEALTH_MIN_RARE_EVENT_COUNT, 5);
    assert.equal(
      metricCurrentEventCount(
        { http_status_dist: { 200: 41, 500: 1 } },
        'http_status_dist',
      ),
      1,
    );
    assert.equal(
      metricCurrentEventCount(
        {
          selector_empty_rate: { title: 0.02, author: 0.1 },
          sample_counts: { selector_empty_rate: 50 },
        },
        'selector_empty_rate',
      ),
      5,
    );
  });

  it('run 2699 回归：极小基线、42 请求、1 次 500 不走相对判定', () => {
    const result = evaluateMetric(
      { http_status_dist: { 200: 41, 500: 1 } },
      {
        metric: 'http_status_dist',
        sample_count: 7,
        baseline_value: 0.000129938,
        baseline_stddev: null,
        lower_bound: null,
        upper_bound: 0.1,
        max_rel_deviation: 1,
        direction: 'up',
        action: 'freeze_write',
      },
      [],
    );
    assert.equal(result.currentSampleCount, 42);
    assert.equal(result.currentEventCount, 1);
    assert.equal(result.relativeDecisionEligible, false);
    assert.equal(result.thresholdExceeded, false);
    assert.equal(result.immediateBreach, false);
    assert.equal(result.breached, false);
    assert.deepEqual(result.reasons, []);
  });

  it('传输失败、丢行、selector 空值同样不能用单个坏事件做相对判定', () => {
    for (const fixture of [
      {
        metric: 'transport_failure_rate',
        fingerprint: {
          transport_failure_rate: 1 / 42,
          http_status_dist: { 200: 41, transport: 1 },
        },
      },
      {
        metric: 'parse_drop_rate',
        fingerprint: {
          parse_drop_rate: 1 / 200,
          sample_counts: { parse_drop_rate: 200 },
        },
      },
    ] as const) {
      const result = evaluateMetric(
        fixture.fingerprint,
        {
          metric: fixture.metric,
          sample_count: 7,
          baseline_value: 0.000129938,
          baseline_stddev: null,
          lower_bound: null,
          upper_bound: null,
          max_rel_deviation: 1,
          direction: 'up',
          action: 'freeze_write',
        },
        [],
      );
      assert.equal(result.currentEventCount, 1, fixture.metric);
      assert.equal(result.relativeDecisionEligible, false, fixture.metric);
      assert.equal(result.thresholdExceeded, false, fixture.metric);
      assert.deepEqual(result.reasons, [], fixture.metric);
    }

    const selector = evaluateMetric(
      {
        selector_empty_rate: { author: 0.05 },
        sample_counts: { selector_empty_rate: 20 },
      },
      {
        metric: 'selector_empty_rate',
        sample_count: 7,
        baseline_value: 0.0001,
        baseline_stddev: null,
        lower_bound: null,
        upper_bound: null,
        max_rel_deviation: 1,
        direction: 'up',
        action: 'freeze_write',
      },
      [0.001, 0.002, 0.003].map((rate, id) => ({
        id: String(id),
        fingerprint: {
          selector_empty_rate: { author: rate },
          sample_counts: { selector_empty_rate: 20 },
        },
      })),
    );
    assert.equal(selector.decisionEligible, true);
    assert.equal(selector.currentEventCount, 1);
    assert.equal(selector.relativeDecisionEligible, false);
    assert.equal(selector.thresholdExceeded, false);
    assert.deepEqual(selector.reasons, []);
  });

  it('真实 HTTP 退化回归：500 请求中 15% 非 2xx 仍命中健康 breach', () => {
    const result = evaluateMetric(
      { http_status_dist: { 200: 425, 500: 75 } },
      {
        metric: 'http_status_dist',
        sample_count: 7,
        baseline_value: 0.000129938,
        baseline_stddev: null,
        lower_bound: null,
        upper_bound: 0.1,
        max_rel_deviation: 1,
        direction: 'up',
        action: 'freeze_write',
      },
      [],
    );
    assert.equal(result.currentSampleCount, 500);
    assert.equal(result.currentEventCount, 75);
    assert.equal(result.relativeDecisionEligible, true);
    assert.equal(result.thresholdExceeded, true);
    assert.equal(result.immediateBreach, true);
    assert.equal(result.breached, true);
    assert.equal(result.action, 'warn');
    assert.match(result.reasons.join(' '), /above:0.1/);
    assert.match(result.reasons.join(' '), /relative_up/);
  });

  it('定向批次全是高票页时完整性比率仍为 1，不因 cohort 均值误报', () => {
    const highVotePages = [708, 676, 400, 341];
    const fingerprint = normalizeParseFingerprint({
      avg_votes_per_page:
        highVotePages.reduce((sum, value) => sum + value, 0) / highVotePages.length,
      http_status_dist: { 200: highVotePages.length },
      transport_failure_rate: 0,
      parse_drop_rate: 0,
      fetched_claimed_ratio: 1,
      checksum_ok_rate: 1,
    });
    const breaches = DEFAULT_PARSE_HEALTH_POLICIES
      .map((policy) =>
        evaluateMetric(
          fingerprint,
          {
            metric: policy.metric,
            sample_count: 0,
            baseline_value: null,
            baseline_stddev: null,
            lower_bound: policy.lowerBound ?? null,
            upper_bound: policy.upperBound ?? null,
            max_rel_deviation: policy.maxRelDeviation ?? null,
            direction: policy.direction,
            action: policy.action,
          },
          [],
        ),
      )
      .filter((evaluation) => evaluation.breached);
    assert.deepEqual(breaches, []);
  });

  it('定向差异队列的聚合 checksum/fetched 比率只告警，逐页门控负责拒绝采用', () => {
    const policies = parseHealthPoliciesForStratum(
      'wikidot_tier2',
      'targeted_queue',
      'tier2',
    );
    for (const metric of ['fetched_claimed_ratio', 'checksum_ok_rate'] as const) {
      const policy = policies.find((candidate) => candidate.metric === metric);
      assert.equal(policy?.action, 'warn', metric);
    }
    assert.equal(
      policies.find((policy) => policy.metric === 'transport_failure_rate')?.action,
      'warn',
    );
    assert.equal(
      policies.find((policy) => policy.metric === 'exit_ip_dist')?.action,
      'warn',
    );
    assert.equal(
      parseHealthPoliciesForStratum('wikidot', 'full_scan', 'tier1')
        .some((policy) => policy.metric === 'checksum_ok_rate'),
      false,
    );
    assert.equal(
      parseHealthPoliciesForStratum(
        'wikidot_tier2',
        'acceptance_replay',
        'tier2_replay',
      )
        .find((policy) => policy.metric === 'checksum_ok_rate')?.action,
      'warn',
    );
  });

  it('生产者的固定批量上限达不到判别分辨率时只留证，不登记永久暖机的假 gate', () => {
    assert.deepEqual(
      parseHealthPoliciesForStratum(
        'wikidot_listpages',
        'l0_updated_at_window',
        'l0_content',
      ),
      [],
    );
    assert.equal(
      parseHealthPoliciesForStratum(
        'wikidot_forum',
        'targeted_queue',
        'forum',
      ).some((policy) => policy.metric === 'parse_drop_rate'),
      false,
    );
    assert.deepEqual(
      parseHealthPoliciesForStratum(
        'wikidot_sitemap',
        'l2_sitemap_absence',
        'full',
      ).map((policy) => policy.metric),
      ['parse_drop_rate'],
    );
    assert.deepEqual(
      parseHealthPoliciesForStratum(
        'wikidot_tier2',
        'revision_source_full',
        'revision_source_backfill',
      ).map((policy) => policy.metric),
      ['http_status_dist', 'transport_failure_rate'],
    );
  });

  it('高基线 population 不继承全局 0.5% 红线；revision source 丢弃率只留证', () => {
    const result = evaluateMetric(
      {
        parse_drop_rate: 0.31,
        sample_counts: { parse_drop_rate: 300 },
      },
      {
        metric: 'parse_drop_rate',
        sample_count: 7,
        baseline_value: 0.3,
        baseline_stddev: 0.01,
        lower_bound: null,
        upper_bound: null,
        max_rel_deviation: 1,
        direction: 'up',
        action: 'freeze_write',
      },
      [],
    );
    assert.equal(result.decisionEligible, true);
    assert.equal(result.thresholdExceeded, false);
    assert.equal(result.breached, false);
  });

  it('未审计的新 mode/population 不会仅因复用已有 source 自动继承 gate', () => {
    assert.deepEqual(
      parseHealthPoliciesForStratum(
        'wikidot_forum',
        'new_population',
        'forum',
      ),
      [],
    );
    assert.deepEqual(
      parseHealthPoliciesForStratum(
        'wikidot_forum',
        'targeted_queue',
        'new_mode',
      ),
      [],
    );
  });

  it('真实解析漂移令 fetched/claimed 跌到 0.5 时仍作 freeze_write 判定', () => {
    const result = evaluateMetric(
      {
        fetched_claimed_ratio: 0.5,
        sample_counts: { fetched_claimed_ratio: 20 },
      },
      {
        metric: 'fetched_claimed_ratio',
        sample_count: 3,
        baseline_value: 1,
        baseline_stddev: null,
        lower_bound: 0.98,
        upper_bound: 1.02,
        max_rel_deviation: null,
        direction: 'both',
        action: 'freeze_write',
      },
      [],
    );
    assert.equal(result.breached, true);
    assert.equal(result.action, 'freeze_write');
    assert.deepEqual(result.reasons, ['below:0.98']);
  });

  it('有 7 日基线时相对骤降越界；不足 3 个样本时不拿单点噪声冻结', () => {
    const baseline = {
      metric: 'avg_tags_len',
      sample_count: 7,
      baseline_value: 4,
      baseline_stddev: 0.2,
      lower_bound: null,
      upper_bound: null,
      max_rel_deviation: 0.25,
      direction: 'both' as const,
      action: 'freeze_write' as const,
    };
    const breach = evaluateMetric(
      { avg_tags_len: 1, sample_counts: { avg_tags_len: 20 } },
      baseline,
      [],
    );
    assert.equal(breach.breached, true);
    assert.match(breach.reasons.join(' '), /relative/);

    const warming = evaluateMetric(
      { avg_tags_len: 1, sample_counts: { avg_tags_len: 20 } },
      { ...baseline, sample_count: 1, baseline_value: 4 },
      [],
    );
    assert.equal(warming.breached, false);
  });

  it('绝对丢行率红线也必须等待同分层基线暖机', () => {
    const result = evaluateMetric(
      { parse_drop_rate: 0.006, sample_counts: { parse_drop_rate: 200 } },
      {
        metric: 'parse_drop_rate',
        sample_count: 0,
        baseline_value: null,
        baseline_stddev: null,
        lower_bound: null,
        upper_bound: 0.005,
        max_rel_deviation: null,
        direction: 'up',
        action: 'freeze_write',
      },
      [],
    );
    assert.equal(result.baselineReady, false);
    assert.equal(result.decisionEligible, false);
    assert.equal(result.breached, false);
    assert.deepEqual(result.reasons, []);
  });

  it('0.667% 临界抖动首轮只告警；整体坍缩仍立即冻结', () => {
    const policy = {
      metric: 'parse_drop_rate',
      sample_count: 7,
      baseline_value: 0,
      baseline_stddev: 0,
      lower_bound: null,
      upper_bound: 0.005,
      max_rel_deviation: 1,
      direction: 'up' as const,
      action: 'freeze_write' as const,
    };
    const edge = evaluateMetric(
      {
        parse_drop_rate: 4 / 600,
        sample_counts: { parse_drop_rate: 600 },
      },
      policy,
      [],
    );
    assert.equal(edge.thresholdExceeded, true);
    assert.equal(edge.immediateBreach, false);
    assert.equal(edge.breached, false);

    const collapse = evaluateMetric(
      {
        parse_drop_rate: 1,
        sample_counts: { parse_drop_rate: 600 },
      },
      policy,
      [],
    );
    assert.equal(collapse.immediateBreach, true);
    assert.equal(collapse.breached, true);
  });

  it('论坛异常只冻结 forum 域；隐式分层与 probe 没有自动熔断资格', () => {
    assert.deepEqual(
      freezeDomainsForMetric(
        'wikidot_forum',
        'forum',
        'targeted_queue',
        'parse_drop_rate',
      ),
      ['forum'],
    );
    assert.deepEqual(
      freezeDomainsForMetric(
        'wikidot_forum',
        'unspecified',
        'unspecified',
        'parse_drop_rate',
      ),
      [],
    );
    assert.deepEqual(
      freezeDomainsForMetric(
        'wikidot_forum:probe',
        'forum',
        'probe',
        'parse_drop_rate',
      ),
      [],
    );
    assert.deepEqual(
      freezeDomainsForMetric(
        'wikidot_tier2',
        'revision_source_backfill',
        'revision_source_full',
        'http_status_dist',
        {
          byKind: {
            content: { claimed: 10 },
            votes_full: { claimed: 10 },
            revisions_full: { claimed: 10 },
          },
        },
      ),
      [],
    );
    assert.deepEqual(
      freezeDomainsForMetric(
        'wikidot_tier2',
        'tier2',
        'targeted_queue',
        'exit_ip_dist',
        { byKind: { votes_full: { claimed: 10 } } },
      ),
      [],
    );
  });

  it('本轮 n=2 且一次瞬时传输失败只留证；n 足够且失败率越线仍形成 breach 告警', () => {
    const policy = {
      metric: 'transport_failure_rate',
      sample_count: 7,
      baseline_value: 0,
      baseline_stddev: 0,
      lower_bound: null,
      upper_bound: 0.1,
      max_rel_deviation: null,
      direction: 'up' as const,
      action: 'freeze_write' as const,
    };
    const tiny = evaluateMetric(
      {
        transport_failure_rate: 0.5,
        http_status_dist: { 200: 1, transport: 1 },
      },
      policy,
      [],
    );
    assert.equal(tiny.measured, true);
    assert.equal(tiny.currentSampleCount, 2);
    assert.equal(tiny.decisionEligible, false);
    assert.equal(tiny.breached, false);
    assert.deepEqual(tiny.reasons, []);

    const representative = evaluateMetric(
      {
        transport_failure_rate: 0.15,
        http_status_dist: { 200: 17, transport: 3 },
      },
      policy,
      [],
    );
    assert.equal(representative.currentSampleCount, 20);
    assert.equal(representative.decisionEligible, true);
    assert.equal(representative.thresholdExceeded, true);
    assert.equal(representative.breached, false);
    assert.equal(representative.consecutiveBreachCount, 1);
    assert.deepEqual(representative.reasons, ['above:0.1']);

    const sustained = evaluateMetric(
      {
        transport_failure_rate: 0.15,
        http_status_dist: { 200: 17, transport: 3 },
      },
      policy,
      [1, 2, 3].map((id) => ({
        id: String(id),
        fingerprint: {
          transport_failure_rate: 0.15,
          http_status_dist: { 200: 17, transport: 3 },
        },
      })),
    );
    assert.equal(sustained.breached, true);
    assert.equal(sustained.consecutiveBreachCount, 4);
  });

  it('冻结写入证据完全排除完整性指标分子分母，不产生二次健康越界', async () => {
    const page = await query<{ page_id: number }>(
      pool,
      'test:m7:freeze_page',
      `SELECT page_id FROM serve.page_current WHERE status='live' LIMIT 1`,
    );
    if (page.rows.length === 0) return;

    const history = await query<{ id: string }>(
      pool,
      'test:m7:freeze_history',
      `INSERT INTO meta.ingest_run(
         source,status,started_at,finished_at,parse_fingerprint,stats
       )
       SELECT
         'wikidot_tier2','ok',now()-make_interval(hours=>age_hours),
         now()-make_interval(hours=>age_hours),
         jsonb_build_object(
           'fetched_claimed_ratio',1,
           'checksum_ok_rate',1,
           'sample_counts',jsonb_build_object(
             'fetched_claimed_ratio',20,'checksum_ok_rate',20
           )
         ),
         jsonb_build_object(
           'mode','test_write_freeze',
           'population_type','test_write_freeze'
         )
       FROM generate_series(1,3) AS age_hours
       RETURNING id::text`,
    );
    createdRunIds.push(...history.rows.map((row) => Number(row.id)));
    await query(
      pool,
      'test:m7:freeze_baseline',
      `INSERT INTO meta.parse_health_baseline(
         source,mode,population_type,metric,sample_count,baseline_value,
         lower_bound,direction,action
       ) VALUES
       ('wikidot_tier2','test_write_freeze','test_write_freeze',
        'fetched_claimed_ratio',3,1,0.98,'down','freeze_write'),
       ('wikidot_tier2','test_write_freeze','test_write_freeze',
        'checksum_ok_rate',3,1,0.99,'down','freeze_write')`,
    );
    const runId = await startIngestRun(
      pool,
      'wikidot_tier2',
      new Date().toISOString(),
    );
    assert.notEqual(runId, null);
    createdRunIds.push(runId!);
    await query(
      pool,
      'test:m7:freeze_page_scan',
      `INSERT INTO meta.page_scan(
         run_id,page_id,kind,status,claimed_total,fetched_total,checksum_ok,error
       ) VALUES ($1,$2,'votes','failed',100,0,false,'write_frozen:vote — PGF01')`,
      [runId, page.rows[0]!.page_id],
    );

    const report = await finishIngestRun(pool, runId, {
      status: 'partial',
      finishedAt: new Date().toISOString(),
      pagesEnumerated: 0,
      remoteTotal: null,
      batchesTotal: 0,
      batchesFailed: 0,
      populationType: 'test_write_freeze',
      stats: {
        mode: 'test_write_freeze',
        population_type: 'test_write_freeze',
        byKind: { votes_full: { claimed: 1 } },
        healthExclusions: { write_freeze: 1 },
      },
    });
    assert.notEqual(report, null);
    assert.equal(report!.fingerprint.fetched_claimed_ratio, null);
    assert.equal(report!.fingerprint.checksum_ok_rate, null);
    assert.equal(report!.fingerprint.sample_counts.fetched_claimed_ratio, 0);
    assert.equal(report!.fingerprint.sample_counts.checksum_ok_rate, 0);
    assert.equal(report!.breaches.length, 0);
    assert.equal(report!.frozen, false);
  });

  it('空队列且无业务请求整轮只落指纹，显式跳过健康判定', async () => {
    const runId = await startIngestRun(
      pool,
      'test_m7_empty_queue',
      new Date().toISOString(),
    );
    assert.notEqual(runId, null);
    createdRunIds.push(runId!);
    await query(
      pool,
      'test:m7:empty_queue_baseline',
      `INSERT INTO meta.parse_health_baseline
         (source,mode,population_type,metric,sample_count,baseline_value,
          upper_bound,direction,action)
       VALUES (
         'test_m7_empty_queue','tier2','targeted_queue',
         'transport_failure_rate',7,0,0.1,'up','warn'
       )`,
    );
    const report = await finishIngestRun(pool, runId, {
      status: 'ok',
      finishedAt: new Date().toISOString(),
      pagesEnumerated: 0,
      remoteTotal: null,
      batchesTotal: 0,
      batchesFailed: 0,
      transportFailureRate: 0.5,
      parseFingerprint: {
        http_status_dist: {},
        transport_failure_rate: 0.5,
      },
      stats: {
        mode: 'tier2',
        domain: 'work_queue',
        httpHealth: {
          business: { requests: 0 },
          probe: { requests: 1, attempts: 2, transportFailures: 0 },
        },
      },
    });
    assert.equal(report?.decisionSkipped, true);
    assert.equal(report?.decisionSkipReason, 'empty_queue_no_business_requests');
    assert.equal(report?.warnings.length, 0);
    assert.equal(report?.frozen, false);

    const stored = await query<{
      decision: Record<string, unknown>;
      transport: string | number | null;
    }>(
      pool,
      'test:m7:empty_queue_stored',
      `SELECT stats->'parseHealthDecision' AS decision,
              parse_fingerprint->>'transport_failure_rate' AS transport
         FROM meta.ingest_run
        WHERE id=$1`,
      [runId],
    );
    assert.equal(stored.rows[0]!.decision['skipped'], true);
    assert.equal(Number(stored.rows[0]!.transport), 0.5);
  });

  it('真实数据库按预置 warn 阈值比较并完整写 parse_fingerprint，不冻结写入', async () => {
    const inserted = await query<{ id: string }>(
      pool,
      'test:m7:health_run',
      `INSERT INTO meta.ingest_run(source,status,started_at,finished_at)
       VALUES ('test_m7_health','running',now(),now())
       RETURNING id::text`,
    );
    const runId = Number(inserted.rows[0]!.id);
    createdRunIds.push(runId);
    const history = await query<{ id: string }>(
      pool,
      'test:m7:health_history',
      `INSERT INTO meta.ingest_run
         (source,status,started_at,finished_at,parse_fingerprint,stats)
       SELECT
         'test_m7_health',
         'ok',
         now() - make_interval(hours => age_hours),
         now() - make_interval(hours => age_hours),
         jsonb_build_object(
           'parse_drop_rate', 0,
           'sample_counts', jsonb_build_object('parse_drop_rate', 200)
         ),
         jsonb_build_object('mode','test_mode','population_type','test_population')
       FROM generate_series(1,3) AS age_hours
       RETURNING id::text`,
    );
    createdRunIds.push(...history.rows.map((row) => Number(row.id)));
    await query(
      pool,
      'test:m7:health_baseline',
      `INSERT INTO meta.parse_health_baseline
         (source,mode,population_type,metric,sample_count,baseline_value,
          upper_bound,direction,action)
       VALUES (
         'test_m7_health','test_mode','test_population',
         'parse_drop_rate',3,0,0.005,'up','warn'
       )`,
    );
    const report = await evaluateParseHealth(pool, {
      runId,
      source: 'test_m7_health',
      mode: 'test_mode',
      populationType: 'test_population',
      fingerprint: {
        parse_drop_rate: 0.1,
        sample_counts: { parse_drop_rate: 200 },
      },
      ensurePolicies: false,
    });
    assert.equal(report.frozen, false);
    assert.equal(report.warnings.length, 1);
    const stored = await query<{ fingerprint: Record<string, unknown> }>(
      pool,
      'test:m7:health_stored',
      `SELECT parse_fingerprint AS fingerprint FROM meta.ingest_run WHERE id=$1`,
      [runId],
    );
    for (const key of REQUIRED_PARSE_FINGERPRINT_KEYS) {
      assert.equal(Object.hasOwn(stored.rows[0]!.fingerprint, key), true, key);
    }
  });

  it('同 source 的 full/category 七日样本按 mode 隔离，不互相污染基线', async () => {
    const history = await query<{ id: string }>(
      pool,
      'test:m7:mode_history',
      `INSERT INTO meta.ingest_run
         (source,status,started_at,finished_at,parse_fingerprint,stats)
       SELECT
         'test_m7_health_modes',
         'ok',
         now() - make_interval(hours => age_hours),
         now() - make_interval(hours => age_hours),
         jsonb_build_object(
           'avg_tags_len', metric_value,
           'sample_counts', jsonb_build_object('avg_tags_len', 20)
         ),
         jsonb_build_object(
           'mode', mode,
           'population_type',
           CASE WHEN mode='full' THEN 'full_scan' ELSE 'scoped_scan' END
         )
       FROM (VALUES
         (4, 'full',     20.0),
         (3, 'category',  2.0),
         (2, 'category',  2.0),
         (1, 'category',  2.0)
       ) AS v(age_hours, mode, metric_value)
       RETURNING id::text`,
    );
    createdRunIds.push(...history.rows.map((row) => Number(row.id)));
    const current = await query<{ id: string }>(
      pool,
      'test:m7:mode_current',
      `INSERT INTO meta.ingest_run(source,status,started_at,stats)
       VALUES (
         'test_m7_health_modes',
         'running',
         now(),
         jsonb_build_object('mode','category','population_type','scoped_scan')
       )
       RETURNING id::text`,
    );
    const runId = Number(current.rows[0]!.id);
    createdRunIds.push(runId);
    await query(
      pool,
      'test:m7:mode_baseline',
      `INSERT INTO meta.parse_health_baseline
         (source,mode,population_type,metric,sample_count,baseline_value,
          max_rel_deviation,direction,action)
       VALUES (
         'test_m7_health_modes','category','scoped_scan',
         'avg_tags_len',99,20,0.25,'both','warn'
       )`,
    );

    const report = await evaluateParseHealth(pool, {
      runId,
      source: 'test_m7_health_modes',
      mode: 'category',
      populationType: 'scoped_scan',
      fingerprint: {
        avg_tags_len: 2.1,
        sample_counts: { avg_tags_len: 20 },
      },
      ensurePolicies: false,
    });
    assert.equal(report.warnings.length, 0);
    assert.equal(report.frozen, false);
    assert.equal(report.measured, 1);
  });

  it('同 source/mode 的 full_scan 与 targeted_queue 基线也严格隔离', async () => {
    const history = await query<{ id: string }>(
      pool,
      'test:m7:population_history',
      `INSERT INTO meta.ingest_run
         (source,status,started_at,finished_at,parse_fingerprint,stats)
       SELECT
         'test_m7_health_populations',
         'ok',
         now() - make_interval(hours => age_hours),
         now() - make_interval(hours => age_hours),
         jsonb_build_object(
           'avg_tags_len', metric_value,
           'sample_counts', jsonb_build_object('avg_tags_len', 20)
         ),
         jsonb_build_object('mode','tier2','population_type',population_type)
       FROM (VALUES
         (4, 'full_scan',      20.0),
         (3, 'targeted_queue',  2.0),
         (2, 'targeted_queue',  2.0),
         (1, 'targeted_queue',  2.0)
       ) AS v(age_hours, population_type, metric_value)
       RETURNING id::text`,
    );
    createdRunIds.push(...history.rows.map((row) => Number(row.id)));
    const current = await query<{ id: string }>(
      pool,
      'test:m7:population_current',
      `INSERT INTO meta.ingest_run(source,status,started_at,stats)
       VALUES (
         'test_m7_health_populations',
         'running',
         now(),
         jsonb_build_object('mode','tier2','population_type','targeted_queue')
       )
       RETURNING id::text`,
    );
    const runId = Number(current.rows[0]!.id);
    createdRunIds.push(runId);
    await query(
      pool,
      'test:m7:population_baseline',
      `INSERT INTO meta.parse_health_baseline
         (source,mode,population_type,metric,sample_count,baseline_value,
          max_rel_deviation,direction,action)
       VALUES (
         'test_m7_health_populations','tier2','targeted_queue',
         'avg_tags_len',99,20,0.25,'both','warn'
       )`,
    );

    const report = await evaluateParseHealth(pool, {
      runId,
      source: 'test_m7_health_populations',
      mode: 'tier2',
      populationType: 'targeted_queue',
      fingerprint: {
        avg_tags_len: 2.1,
        sample_counts: { avg_tags_len: 20 },
      },
      ensurePolicies: false,
    });
    assert.equal(report.warnings.length, 0);
    assert.equal(report.frozen, false);
    assert.equal(report.mode, 'tier2');
    assert.equal(report.populationType, 'targeted_queue');
  });
});
