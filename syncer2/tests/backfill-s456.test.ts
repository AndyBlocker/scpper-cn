import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  buildAttributionCarryoverPlan,
  buildPageLifePlan,
  buildVersionMap,
  type V1AttributionRow,
  type V1PageLifeRow,
} from '../src/backfill/s456-model.js';
import {
  anonymousActorSafety,
  V2_RESERVED_ANONYMOUS_ACTOR_ID_START,
} from '../src/backfill/id-policy.js';

const baseAttribution: V1AttributionRow = {
  id: 1,
  page_version_id: 101,
  page_id: 10,
  page_wikidot_id: 1001,
  user_id: 20,
  anon_key: null,
  role: 'SUBMITTER',
  ord: 0,
  at_date: null,
};

test('S4：pageVerId→pageId 显式结转、匿名 key 原样保留、重复版本只折叠当前自然键', () => {
  const rows: V1AttributionRow[] = [
    baseAttribution,
    { ...baseAttribution, id: 2, page_version_id: 102, ord: 1 },
    {
      ...baseAttribution,
      id: 3,
      user_id: null,
      anon_key: 'anon:(user deleted)#42',
      role: 'AUTHOR',
      ord: 2,
    },
  ];
  const plan = buildAttributionCarryoverPlan(rows, [], 282_570_576);

  assert.equal(plan.mappedRows.length, 3, '逐条映射审计不丢 v1 行');
  assert.deepEqual(plan.anonymousActors, [{
    id: V2_RESERVED_ANONYMOUS_ACTOR_ID_START,
    anonKey: 'anon:(user deleted)#42',
    displayName: '(user deleted)#42',
  }]);
  assert.equal(plan.currentRows.length, 2, '相同 page/role/actor 的跨版本副本折叠');
  assert.equal(
    plan.currentRows.find((row) => row.role === 'SUBMITTER')?.isDisplay,
    false,
    '出现 AUTHOR 后才抑制 SUBMITTER',
  );
  assert.equal(
    plan.currentRows.find((row) => row.role === 'AUTHOR')?.anonKey,
    'anon:(user deleted)#42',
  );
});

test('S4：保留段分配不取 v1/目标当前低位上界，且接续保留段已交付水位', () => {
  const first = buildAttributionCarryoverPlan(
    [{
      ...baseAttribution,
      user_id: null,
      anon_key: 'anon:first',
    }],
    [],
    283_404_101,
  );
  assert.equal(first.anonymousActors[0]?.id, V2_RESERVED_ANONYMOUS_ACTOR_ID_START);

  const next = buildAttributionCarryoverPlan(
    [{
      ...baseAttribution,
      user_id: null,
      anon_key: 'anon:next',
    }],
    [],
    V2_RESERVED_ANONYMOUS_ACTOR_ID_START + 411,
  );
  assert.equal(
    next.anonymousActors[0]?.id,
    V2_RESERVED_ANONYMOUS_ACTOR_ID_START + 412,
  );
});

test('S4：匿名 actor 安全系数是硬断言，不接受仅仅高于当前 v1 上界', () => {
  assert.equal(
    anonymousActorSafety(
      [V2_RESERVED_ANONYMOUS_ACTOR_ID_START],
      283_404_101,
    ).ok,
    true,
  );
  assert.equal(
    anonymousActorSafety(
      [V2_RESERVED_ANONYMOUS_ACTOR_ID_START],
      300_000_000,
    ).ok,
    false,
  );
});

test('S4：只有 SUBMITTER 的页面保持 is_display=true，且已有 anon actor 幂等复用', () => {
  const plan = buildAttributionCarryoverPlan(
    [{
      ...baseAttribution,
      user_id: null,
      anon_key: 'anon:archived-name',
    }],
    [{ id: 900, anon_key: 'anon:archived-name' }],
    1_000,
  );
  assert.equal(plan.anonymousActors.length, 0);
  assert.equal(plan.currentRows[0]?.actorId, 900);
  assert.equal(plan.currentRows[0]?.isDisplay, true);
});

test('S4：userId IS NULL 时不从名字猜 actor，非 anon: 原始键硬失败', () => {
  assert.throws(
    () => buildAttributionCarryoverPlan(
      [{ ...baseAttribution, user_id: null, anon_key: '(user deleted)' }],
      [],
      100,
    ),
    /不是 anon: 原始键/,
  );
});

const baseLife: V1PageLifeRow = {
  page_id: 10,
  wikidot_id: 1010,
  current_slug: 'scp-10',
  page_is_deleted: true,
  current_version_is_deleted: true,
  first_published_at: '2020-01-01T00:00:00.000Z',
  page_created_at: '2025-11-01T00:00:00.000Z',
  tombstone_at: '2021-01-01T00:00:00.000Z',
  last_vote_at: '2022-02-01T00:00:00.000Z',
  last_revision_at: '2022-01-01T00:00:00.000Z',
  legacy_fingerprint: true,
  current_version_id: 100,
  title: 'SCP-10',
  alternate_title: null,
  tags: ['scp'],
  category: 'scp',
  search_text: 'body',
};

test('S5：不可信 tombstone 用 GREATEST(末票,末修订)，legacy source 单列且标 inferred', () => {
  const plan = buildPageLifePlan(baseLife);
  assert.equal(plan.usedActivityFallback, true);
  assert.equal(plan.deletedAt, '2022-02-01T00:00:00.000Z');
  assert.equal(plan.deletedPrecision, 'inferred');
  assert.equal(plan.deletionSource, 'legacy_import_2025_11');
});

test('S5：双 isDeleted 原值发散被显式标审计，裁决值来自一次性 life event 输入', () => {
  const plan = buildPageLifePlan({
    ...baseLife,
    legacy_fingerprint: false,
    page_is_deleted: true,
    current_version_is_deleted: false,
  });
  assert.equal(plan.divergent, true);
  assert.equal(plan.resolvedDeleted, true);
  assert.equal(plan.deletionSource, 'v1_backfill');
});

test('S5/B5：deleted:/old: 归档活页仍生成完整页面计划，不做前缀过滤', () => {
  for (const slug of ['deleted:scp-10', 'old:scp-10']) {
    const plan = buildPageLifePlan({
      ...baseLife,
      current_slug: slug,
      page_is_deleted: false,
      current_version_is_deleted: false,
      tombstone_at: null,
      legacy_fingerprint: false,
    });
    assert.equal(plan.current_slug, slug);
    assert.equal(plan.resolvedDeleted, false);
    assert.equal(plan.deletedAt, null);
  }
});

test('S6：v1_version_map 每页按 validFrom/id 稳定生成从 1 开始的展示序号', () => {
  const mapped = buildVersionMap([
    {
      id: 12,
      page_id: 2,
      valid_from: '2020-01-02T00:00:00Z',
      valid_to: null,
      is_deleted: false,
      title: 'b',
      alternate_title: null,
      tags: null,
      category: null,
    },
    {
      id: 11,
      page_id: 2,
      valid_from: '2020-01-01T00:00:00Z',
      valid_to: '2020-01-02T00:00:00Z',
      is_deleted: false,
      title: 'a',
      alternate_title: null,
      tags: null,
      category: null,
    },
  ]);
  assert.deepEqual(mapped.map((row) => [row.id, row.versionNo]), [[11, 1], [12, 2]]);
});

test('S4 静态红线：存量 SQL 只经 pageVerId/PageVersion.pageId，不查询 slug 解析署名', () => {
  const source = readFileSync(
    path.resolve(import.meta.dirname, '../src/backfill/s456.ts'),
    'utf8',
  );
  const attributionQuery = source.slice(
    source.indexOf('SELECT a.id,'),
    source.indexOf('ORDER BY a.id`'),
  );
  assert.match(attributionQuery, /a\."pageVerId"/);
  assert.match(attributionQuery, /pv\."pageId" AS page_id/);
  assert.doesNotMatch(attributionQuery, /slug|currentUrl|urlHistory/i);
});
