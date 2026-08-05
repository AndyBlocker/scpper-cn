import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Pool, PoolClient } from 'pg';

import {
  applyCollectedVoteSnapshot,
  collectVoteSnapshots,
  gateParsedVotes,
  isOversizedVotePage,
  parseWhoRatedPage,
  prepareVoteSnapshot,
  timeoutForVoteCount,
  voteIdentityKey,
  voteSnapshotContradictionHash,
  type ParsedVoteEntry,
  type VoteTarget,
} from '../src/collect/votes.js';
import { HttpClient } from '../src/http/client.js';
import {
  isShortLivedTaskActive,
  NEW_PAGE_INTERVAL_HOURS,
  NEW_PAGE_WINDOW_DAYS,
  WORK_QUEUE_LIMIT_MAX,
  type ClaimedVoteTask,
} from '../src/store/workQueue.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(here, 'fixtures', 'votes');
let mixed = '';
let empty = '';
let mismatched = '';

before(async () => {
  [mixed, empty, mismatched] = await Promise.all([
    readFile(path.join(fixtureDir, 'mixed.html'), 'utf8'),
    readFile(path.join(fixtureDir, 'empty.html'), 'utf8'),
    readFile(path.join(fixtureDir, 'mismatched.html'), 'utf8'),
  ]);
});

describe('WhoRated 解析', () => {
  test('四类身份全部保留，id=0 的匿名/已删用户不会塌缩', () => {
    const result = parseWhoRatedPage(mixed);
    if (result.status === 'failed') assert.fail(result.error);
    assert.equal(result.status, 'ok');

    assert.equal(result.data.rawEntries, 7);
    assert.equal(result.data.entries.length, 7);
    assert.equal(result.data.checksum, 1);
    assert.deepEqual(result.data.identityKinds, {
      wikidot: 1,
      deleted: 3,
      guest: 1,
      anonymous: 2,
    });
    assert.equal(new Set(result.data.entries.map((entry) => entry.identityKey)).size, 7);
    assert.deepEqual(
      result.data.entries
        .filter((entry) => entry.identity.kind === 'deleted')
        .map((entry) => entry.identityKey),
      ['deleted:202', 'deleted:unresolved:2', 'deleted:unresolved:3'],
    );
    assert.deepEqual(
      result.data.entries
        .filter((entry) => entry.identity.kind === 'anonymous')
        .map((entry) => entry.identityKey),
      ['anonymous:203.0.113.7', 'anonymous:198.51.100.9'],
    );
  });

  test('合法空结果是 status=ok + entries=[]，不是解析失败', () => {
    const result = parseWhoRatedPage(empty);
    if (result.status === 'failed') assert.fail(result.error);
    assert.equal(result.status, 'ok');
    assert.equal(result.data.entries.length, 0);
    assert.equal(result.data.isComplete, true);
  });

  test('用户/方向数量错位是 failed，与合法空结果可区分', () => {
    const result = parseWhoRatedPage(mismatched);
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') return;
    assert.match(result.error, /数量错位/);
  });

  test('同身份同页 +/− 保留两行，按全部行求 checksum，不再判整页 failed', async () => {
    const body =
      '<h2>Who rated?</h2><div style="column-count:2">' +
      '<span class="printuser" data-id="101"><a onclick="WIKIDOT.page.listeners.userInfo(101)">A</a></span>' +
      '<span style="color:green">+</span>' +
      '<span class="printuser" data-id="101"><a onclick="WIKIDOT.page.listeners.userInfo(101)">A</a></span>' +
      '<span style="color:red">-</span>' +
      '<span class="printuser" data-id="202"><a onclick="WIKIDOT.page.listeners.userInfo(202)">B</a></span>' +
      '<span style="color:green">+</span></div>';
    const outcome = gateParsedVotes(
      { pageId: 1, wikidotId: 10, claimedTotal: 3, claimedRating: 1 },
      parseWhoRatedPage(body),
    );
    assert.equal(outcome.status, 'ok');
    assert.deepEqual(
      outcome.data?.entries.map((entry) => [entry.identityKey, entry.direction]),
      [['wikidot:101', 1], ['wikidot:101', -1], ['wikidot:202', 1]],
    );
    assert.equal(outcome.data?.checksum, 1);
    assert.equal(outcome.data?.duplicateEntries, 1);
    assert.equal(outcome.data?.isComplete, true);

    let appliedEntries: Array<{
      voter_id: number;
      direction: number;
      source_ordinal: number;
      identity_key: string;
    }> = [];
    const fakeClient = {
      query: async (sql: string, params?: readonly unknown[]) => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('ingest.ensure_user')) {
          const users = JSON.parse(String(params?.[0])) as Array<{
            ordinal: number;
            wikidot_id: number;
          }>;
          return {
            rows: users.map((row) => ({ ordinal: row.ordinal, voter_id: 1000 + row.wikidot_id })),
            rowCount: users.length,
          };
        }
        if (sql.includes('ingest.apply_vote_snapshot')) {
          appliedEntries = JSON.parse(String(params?.[1])) as typeof appliedEntries;
          return {
            rows: [{ applied: { scan_status: 'ok', gate_is_complete: true } }],
            rowCount: 1,
          };
        }
        assert.fail(`未预期 SQL: ${sql}`);
      },
      release: () => undefined,
    };
    const fakePool = {
      connect: async () => fakeClient,
    } as unknown as Pool;
    const applied = await applyCollectedVoteSnapshot(
      fakePool,
      outcome,
      77,
      '2026-08-03T00:00:00.000Z',
    );
    assert.equal(applied.scanStatus, 'ok');
    assert.deepEqual(appliedEntries, [
      { voter_id: 1101, direction: 1, source_ordinal: 1, identity_key: 'wikidot:101' },
      { voter_id: 1101, direction: -1, source_ordinal: 2, identity_key: 'wikidot:101' },
      { voter_id: 1202, direction: 1, source_ordinal: 3, identity_key: 'wikidot:202' },
    ]);
  });

  test('同方向重复 +1/+1 保留两行，claimed_total 与 rating 都按原始行口径', () => {
    const body =
      '<h2>Who rated?</h2><div style="column-count:2">' +
      '<span class="printuser" data-id="101"><a onclick="userInfo(101)">A</a></span><span style="color:green">+</span>' +
      '<span class="printuser" data-id="101"><a onclick="userInfo(101)">A</a></span><span style="color:green">+</span></div>';
    const result = gateParsedVotes(
      { pageId: 1, wikidotId: 10, claimedTotal: 2, claimedRating: 2 },
      parseWhoRatedPage(body),
    );
    assert.equal(result.status, 'ok');
    assert.equal(result.data?.entries.length, 2);
    assert.equal(result.data?.checksum, 2);
    assert.equal(result.data?.duplicateEntries, 1);
  });

  test('全行 checksum 与 claimed_rating 不符使用稳定矛盾哈希，claimed 变化会换哈希', () => {
    const body =
      '<h2>Who rated?</h2><div style="column-count:2">' +
      '<span class="printuser" data-id="101"><a onclick="WIKIDOT.page.listeners.userInfo(101)">A</a></span>' +
      '<span style="color:green">+</span>' +
      '<span class="printuser" data-id="101"><a onclick="WIKIDOT.page.listeners.userInfo(101)">A</a></span>' +
      '<span style="color:green">+</span></div>';
    const parsed = parseWhoRatedPage(body);
    assert.equal(parsed.status, 'ok');
    if (parsed.status !== 'ok') return;
    const mismatch = gateParsedVotes(
      { pageId: 1, wikidotId: 10, claimedTotal: 2, claimedRating: 1 },
      parsed,
    );
    assert.notEqual(mismatch.status, 'ok');
    if (mismatch.data === undefined) return;
    const prepared = {
      entries: [
        { voter_id: 501, direction: 1 as const, source_ordinal: 1, identity_key: 'wikidot:101' },
        { voter_id: 501, direction: 1 as const, source_ordinal: 2, identity_key: 'wikidot:101' },
      ],
      quarantined: 0,
      identityCollisions: 0,
    };
    const first = voteSnapshotContradictionHash(mismatch.data, prepared, 'partial');
    const second = voteSnapshotContradictionHash(mismatch.data, prepared, 'partial');
    assert.equal(first.toString('hex'), second.toString('hex'));

    const changedClaim = {
      ...mismatch.data,
      target: { ...mismatch.data.target, claimedTotal: 3 },
    };
    assert.notEqual(
      first.toString('hex'),
      voteSnapshotContradictionHash(changedClaim, prepared, 'partial').toString('hex'),
    );
  });

  test('空响应、WAF HTML、selector 残留、未知方向分别 failed', () => {
    const bad = [
      '',
      '<html><title>Attention Required</title></html>',
      '<h2>x</h2><div style="column-count:3">%%rating%%</div>',
      '<h2>x</h2><div style="column-count:3"><span class="printuser deleted">(user deleted)</span><span style="color:#777">0</span></div>',
    ];
    for (const body of bad) {
      assert.equal(parseWhoRatedPage(body).status, 'failed', body);
    }
  });

  test('去重键含身份类型；相同数字材料不会跨类型碰撞', () => {
    assert.notEqual(
      voteIdentityKey({ kind: 'wikidot', wikidotId: 7, name: 'A', unixName: 'a' }, 0),
      voteIdentityKey({ kind: 'deleted', wikidotId: 7, name: '(user deleted)' }, 0),
    );
    assert.notEqual(
      voteIdentityKey({ kind: 'anonymous', ip: null, name: 'Anonymous' }, 1),
      voteIdentityKey({ kind: 'anonymous', ip: null, name: 'Anonymous' }, 2),
    );
  });
});

describe('四重门控与尾部红线', () => {
  const target = (
    claimedTotal: number | null,
    claimedRating: number | null,
  ): VoteTarget => ({ pageId: 1, wikidotId: 10, claimedTotal, claimedRating });

  test('四门全过才是 ok', () => {
    const result = gateParsedVotes(target(7, 1), parseWhoRatedPage(mixed));
    assert.equal(result.status, 'ok');
    assert.equal(result.data?.isComplete, true);
  });

  test('票数或 Σsign 不符只判 partial，仍携带单调 upsert 数据', () => {
    const countMismatch = gateParsedVotes(target(8, 1), parseWhoRatedPage(mixed));
    const checksumMismatch = gateParsedVotes(target(7, 99), parseWhoRatedPage(mixed));
    assert.equal(countMismatch.status, 'partial');
    assert.equal(checksumMismatch.status, 'partial');
    assert.equal(countMismatch.data?.entries.length, 7);
    assert.equal(checksumMismatch.data?.checksum, 1);
  });

  test('系统性 +1 仍精确判 partial，不用 ±1 容差掩盖时窗差', () => {
    const result = gateParsedVotes(target(6, 0), parseWhoRatedPage(mixed));
    assert.equal(result.status, 'partial');
    assert.equal(result.data?.entries.length, 7);
    assert.equal(result.data?.checksum, 1);
  });

  test('status=ok ∧ entries=0 ∧ claimed_total>0 强制 failed 且携带空快照证据', () => {
    const result = gateParsedVotes(target(42, 2), parseWhoRatedPage(empty));
    assert.equal(result.status, 'failed');
    assert.equal(result.data?.entries.length, 0);
    assert.match(result.status === 'failed' ? result.error : '', /强制 failed/);
  });

  test('真正 0 票需 claimed_total=0 且 claimed_rating=0 双重背书', () => {
    assert.equal(gateParsedVotes(target(0, 0), parseWhoRatedPage(empty)).status, 'ok');
    assert.equal(gateParsedVotes(target(null, 0), parseWhoRatedPage(empty)).status, 'failed');
    assert.equal(gateParsedVotes(target(0, null), parseWhoRatedPage(empty)).status, 'partial');
  });
});

describe('身份批量落库形状', () => {
  test('jsonb_to_recordset 参数使用 snake_case，四类身份字段不会静默变 NULL', async () => {
    let captured: Array<Record<string, unknown>> = [];
    const fakeClient = {
      query: async (_sql: string, params?: unknown[]) => {
        captured = JSON.parse(String(params?.[0])) as Array<Record<string, unknown>>;
        return {
          rows: captured.map((row) => ({
            ordinal: Number(row['ordinal']),
            voter_id: 1000 + Number(row['ordinal']),
          })),
          rowCount: captured.length,
          command: 'SELECT',
          oid: 0,
          fields: [],
        };
      },
    } as unknown as PoolClient;
    const entries: ParsedVoteEntry[] = [
      {
        identity: { kind: 'wikidot', wikidotId: 101, name: 'A', unixName: 'a' },
        direction: 1,
        identityKey: 'wikidot:101',
        ordinal: 0,
      },
      {
        identity: { kind: 'deleted', wikidotId: 102, name: '(user deleted)' },
        direction: -1,
        identityKey: 'deleted:102',
        ordinal: 1,
      },
      {
        identity: { kind: 'guest', name: 'Guest A', avatarUrl: null },
        direction: 1,
        identityKey: 'guest:Guest A',
        ordinal: 2,
      },
      {
        identity: { kind: 'anonymous', ip: '203.0.113.7', name: 'Anonymous' },
        direction: -1,
        identityKey: 'anonymous:203.0.113.7',
        ordinal: 3,
      },
    ];

    const prepared = await prepareVoteSnapshot(
      fakeClient,
      1,
      entries,
      '2026-07-27T00:00:00.000Z',
    );
    assert.equal(prepared.entries.length, 4);
    assert.equal(prepared.isComplete, true);
    assert.deepEqual(
      Object.keys(captured[0] ?? {}).sort(),
      [
        'anon_key',
        'direction',
        'display_name',
        'kind',
        'ordinal',
        'unix_name',
        'username',
        'wikidot_id',
      ],
    );
    assert.equal(captured[0]?.['wikidot_id'], 101);
    assert.equal(captured[3]?.['anon_key'], '203.0.113.7');
    assert.equal('wikidotId' in (captured[0] ?? {}), false);
  });
});

describe('抓取 Map 契约', () => {
  let server: http.Server;
  let baseUrl = '';
  let client: HttpClient;

  before(async () => {
    server = http.createServer(async (req, res) => {
      let requestBody = '';
      for await (const part of req) requestBody += String(part);
      const pageId = new URLSearchParams(requestBody).get('pageId');
      const body = pageId === '11' ? mixed : pageId === '12' ? empty : mismatched;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', body }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('测试服务器地址异常');
    baseUrl = `http://127.0.0.1:${address.port}`;
    client = new HttpClient({
      userAgent: 'syncer2-votes-test',
      referer: `${baseUrl}/`,
      proxyUrl: null,
      maxAttempts: 1,
      breaker503: 5,
      breakerReset: 5,
      connections: 2,
    });
  });

  after(async () => {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  test('成功、合法空、解析失败都显式留在 Map 中', async () => {
    const targets: VoteTarget[] = [
      { pageId: 1, wikidotId: 11, claimedTotal: 7, claimedRating: 1 },
      { pageId: 2, wikidotId: 12, claimedTotal: 0, claimedRating: 0 },
      { pageId: 3, wikidotId: 13, claimedTotal: 1, claimedRating: 1 },
    ];
    const result = await collectVoteSnapshots(client, baseUrl, targets, 2);
    assert.equal(result.size, 3);
    assert.equal(result.get(1)?.status, 'ok');
    assert.equal(result.get(2)?.status, 'ok');
    assert.equal(result.get(3)?.status, 'failed');
  });
});

describe('预算与短命页队列', () => {
  test('票数分档超时，>4000 单独队列', () => {
    assert.equal(timeoutForVoteCount(0), 20_000);
    assert.equal(timeoutForVoteCount(501), 30_000);
    assert.equal(timeoutForVoteCount(2_001), 45_000);
    assert.equal(timeoutForVoteCount(4_001), 60_000);
    assert.equal(isOversizedVotePage(4_000), false);
    assert.equal(isOversizedVotePage(4_001), true);
  });

  test('高频任务只活 7 天；first_published_at 缺失时以任务创建时刻兜底', () => {
    const now = Date.parse('2026-07-27T00:00:00.000Z');
    const base: ClaimedVoteTask = {
      taskId: 1,
      pageId: 1,
      wikidotId: 1,
      slug: 'test',
      kind: 'new_page_highfreq',
      attempts: 1,
      stableCount: 0,
      lastResultHash: null,
      reasons: [],
      firstPublishedAt: null,
      taskCreatedAt: '2026-07-26T00:00:00.000Z',
      claimedTotal: 0,
      claimedRating: 0,
      tier1RunId: 1,
    };
    assert.equal(isShortLivedTaskActive(base, now), true);
    assert.equal(
      isShortLivedTaskActive({ ...base, taskCreatedAt: '2026-07-19T00:00:00.000Z' }, now),
      false,
    );
    assert.equal(NEW_PAGE_INTERVAL_HOURS, 3);
    assert.equal(NEW_PAGE_WINDOW_DAYS, 7);
    assert.equal(WORK_QUEUE_LIMIT_MAX, 50);
  });

  test('队列 SQL 会退役并拒绝认领超过 7 天的残留高频任务', async () => {
    const source = await readFile(
      new URL('../src/store/workQueue.ts', import.meta.url),
      'utf8',
    );
    assert.match(source, /meta\.scan_task:retire_vote_highfreq/);
    assert.match(source, /DELETE FROM meta\.scan_task st[\s\S]+st\.kind = 'new_page_highfreq'/);
    assert.match(
      source,
      /st\.kind <> 'new_page_highfreq'[\s\S]+> now\(\) - \(\$[47]::integer \* interval '1 day'\)/,
    );
  });
});
