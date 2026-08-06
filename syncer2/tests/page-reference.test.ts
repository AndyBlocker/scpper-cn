process.env.TZ = 'Asia/Shanghai';
process.env.SYNCER2_LOG_LEVEL = 'error';

import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool, PoolClient } from 'pg';

import {
  extractPageReferences,
  normalizePageReferenceTarget,
} from '../src/content/extractPageReferences.js';
import { loadConfig } from '../src/config.js';
import { projectPageReference } from '../src/project/pageReference.js';
import type { ProjectionWindow } from '../src/project/types.js';
import { createPool, query } from '../src/store/db.js';

const FROM_PAGE = 968_810_001;
const REUSED_DELETED = 968_810_002;
const REUSED_LIVE = 968_810_003;
const AMBIGUOUS_A = 968_810_004;
const AMBIGUOUS_B = 968_810_005;
const CREATED_TARGET = 968_810_006;
const WID_OFFSET = 10_000;

let pool: Pool;

before(() => {
  const config = loadConfig();
  assert.equal(
    decodeURIComponent(new URL(config.databaseUrl).pathname.slice(1)),
    'scpper-v2',
    'page-reference 测试只允许写 scpper-v2',
  );
  pool = createPool(config.databaseUrl, { max: 1 });
});

after(async () => {
  await pool?.end().catch(() => undefined);
});

function projectionWindow(seq: number): ProjectionWindow {
  return {
    fromSeq: seq,
    toSeq: seq,
    previousSeq: Math.max(0, seq - 1),
    rebuild: false,
    includeDeletedPages: false,
  };
}

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

describe('page-reference 纯解析（零网络）', () => {
  it('TRIPLE / SHORT / DIRECT 往返，fragment 与十个显示变体按目标聚合', () => {
    const displays = Array.from(
      { length: 12 },
      (_, i) => `[[[SCP CN 1#Section|显示 ${i + 1}]]]`,
    ).join('\n');
    const source = `${displays}
      [/short-target 短链接]
      https://scp-wiki-cn.wikidot.com/direct-target#anchor
      [[[//www.scp-wiki-cn.wikidot.com/protocol-relative|协议相对]]]`;

    const refs = extractPageReferences(source);
    const triple = refs.find((ref) => ref.kind === 'TRIPLE' && ref.targetSlug === 'scp-cn-1');
    assert.ok(triple);
    assert.equal(triple.targetFragment, 'Section');
    assert.equal(triple.occurrence, 12);
    assert.equal(triple.displayTexts.length, 10);
    assert.equal(triple.rawTarget, 'SCP CN 1#Section');

    const short = refs.find((ref) => ref.kind === 'SHORT');
    assert.deepEqual(
      short && [short.targetSlug, short.displayTexts[0]],
      ['short-target', '短链接'],
    );
    const direct = refs.find((ref) => ref.kind === 'DIRECT');
    assert.deepEqual(
      direct && [direct.targetSlug, direct.targetFragment],
      ['direct-target', 'anchor'],
    );
    assert.ok(refs.some((ref) => ref.targetSlug === 'protocol-relative'));
  });

  it('站外 http(s) 保留；javascript/mailto/local--files 与其他 scheme 排除', () => {
    const refs = extractPageReferences(`
      [https://outside.example/a?q=1#part 外站短链]
      https://outside.example/b#raw
      [javascript:alert(1) JS]
      [mailto:test@example.com 邮件]
      [[[local--files/example/file.png|附件]]]
      [[[https://scp-wiki-cn.wikidot.com/local--files/example/file.png|本站附件]]]
      [ftp://outside.example/file FTP]
    `);
    assert.equal(refs.filter((ref) => ref.targetScope === 'external').length, 2);
    assert.ok(refs.some((ref) => ref.kind === 'SHORT' && ref.targetFragment === 'part'));
    assert.ok(refs.some((ref) => ref.kind === 'DIRECT' && ref.targetFragment === 'raw'));
    assert.ok(refs.every((ref) => !/javascript:|mailto:|local--files|ftp:/i.test(ref.rawTarget)));
  });

  it('SHORT 不吞 Wikidot 双括号指令（v1 会误报 div/include/module）', () => {
    const refs = extractPageReferences(`
      [[div class="content"]]
      [[include component:example |name=value]]
      [[module CSS]]
      [real-target 真正短链]
    `);
    assert.deepEqual(
      refs.map((ref) => [ref.kind, ref.targetSlug]),
      [['SHORT', 'real-target']],
    );
  });

  it('本站域名剥离、星号、query 和 NFKC/slug 归一稳定', () => {
    assert.deepEqual(normalizePageReferenceTarget('* SCP CN 4860?x=1#片段'), {
      scope: 'internal',
      key: 'scp-cn-4860',
      path: '/scp-cn-4860',
      slug: 'scp-cn-4860',
      fragment: '片段',
      rawTarget: '* SCP CN 4860?x=1#片段',
    });
  });
});

interface ReferenceRow {
  kind: string;
  target_slug: string | null;
  target_scope: string;
  target_fragment: string;
  to_page_id: number | null;
  resolution_status: string;
  candidate_page_ids: number[];
  live_candidate_page_ids: number[];
  identity_candidate_count: number;
  live_candidate_count: number;
  slug_reused: boolean;
  source_sha: Buffer;
  computed_at: Date;
}

async function seedPage(
  client: PoolClient,
  pageId: number,
  slug: string,
  status: 'live' | 'deleted',
  sourceSha: Buffer | null = null,
): Promise<void> {
  await query(
    client,
    'test.page_reference:page',
    `INSERT INTO ingest.page(id, wikidot_id) VALUES ($1, $2)`,
    [pageId, pageId + WID_OFFSET],
  );
  await query(
    client,
    'test.page_reference:page_current',
    `INSERT INTO serve.page_current(page_id, wikidot_id, slug, status, source_sha)
     VALUES ($1, $2, $3, $4, $5)`,
    [pageId, pageId + WID_OFFSET, slug, status, sourceSha],
  );
}

async function insertSource(
  client: PoolClient,
  pageId: number,
  revNo: number,
  source: string,
): Promise<{ sha: Buffer; seq: number }> {
  const sha = createHash('sha256').update(source).digest();
  await query(
    client,
    'test.page_reference:blob',
    `INSERT INTO ingest.content_blob(sha256, source, byte_len, text_len)
     VALUES ($1, $2, $3, $4)`,
    [sha, source, Buffer.byteLength(source), source.length],
  );
  const inserted = await query<{ change_seq: string }>(
    client,
    'test.page_reference:source',
    `INSERT INTO ingest.page_source(page_id, rev_no, blob_sha, observed_at)
     VALUES ($1, $2, $3, '2026-08-06T00:00:00Z'::timestamptz)
     RETURNING change_seq::text`,
    [pageId, revNo, sha],
  );
  await query(
    client,
    'test.page_reference:set_effective_source',
    `UPDATE serve.page_current SET source_sha = $2 WHERE page_id = $1`,
    [pageId, sha],
  );
  return { sha, seq: Number(inserted.rows[0]!.change_seq) };
}

async function readReferences(client: PoolClient): Promise<ReferenceRow[]> {
  const result = await query<ReferenceRow>(
    client,
    'test.page_reference:read',
    `SELECT kind, target_slug, target_scope, target_fragment, to_page_id,
            resolution_status, candidate_page_ids, live_candidate_page_ids,
            identity_candidate_count, live_candidate_count, slug_reused,
            source_sha, computed_at
       FROM serve.page_reference
      WHERE from_page_id = $1
      ORDER BY kind, target_scope, target_slug NULLS LAST, target_fragment`,
    [FROM_PAGE],
  );
  return result.rows;
}

describe('effective page-reference 数据库投影', () => {
  it('live slug 裁决、歧义/缺页/站外保留、目标增量解析、轮动与幂等同时成立', async () => {
    await rollbackFixture(async (client) => {
      // page_current 的迁移逃生舱只限本测试事务；生产写仍只能经 ingest.apply_*。
      await client.query(`SET LOCAL scpper.bypass_guard = 'on'`);
      await seedPage(client, REUSED_DELETED, 'pageref-reused', 'deleted');
      await seedPage(client, REUSED_LIVE, 'pageref-reused', 'live');
      await seedPage(client, AMBIGUOUS_A, 'pageref-ambiguous', 'live');
      await seedPage(client, AMBIGUOUS_B, 'pageref-ambiguous', 'live');

      const source = `
        [[[pageref-reused#triple-fragment|复用目标]]]
        [/pageref-missing 缺页目标]
        https://scp-wiki-cn.wikidot.com/pageref-ambiguous
        [https://outside.example/reference#external-fragment 站外目标]
      `;
      await seedPage(client, FROM_PAGE, 'pageref-source', 'live');
      const first = await insertSource(client, FROM_PAGE, 1, source);
      const projected = await projectPageReference(client, projectionWindow(first.seq));
      assert.equal(projected.affectedKeys, 1);

      const refs = await readReferences(client);
      assert.equal(refs.length, 4, '三种链接形态 + 站外都应落库');

      const reused = refs.find((row) => row.target_slug === 'pageref-reused');
      assert.ok(reused);
      assert.equal(reused.kind, 'TRIPLE');
      assert.equal(reused.target_fragment, 'triple-fragment');
      assert.equal(reused.to_page_id, REUSED_LIVE, '只能命中唯一 current live 身份');
      assert.equal(reused.resolution_status, 'resolved');
      assert.deepEqual(reused.candidate_page_ids, [REUSED_DELETED, REUSED_LIVE]);
      assert.deepEqual(reused.live_candidate_page_ids, [REUSED_LIVE]);
      assert.equal(reused.slug_reused, true, '即使可唯一解析，也显式记录 slug 复用');

      const missing = refs.find((row) => row.target_slug === 'pageref-missing');
      assert.ok(missing);
      assert.equal(missing.kind, 'SHORT');
      assert.equal(missing.to_page_id, null);
      assert.equal(missing.resolution_status, 'missing');
      assert.deepEqual(missing.candidate_page_ids, []);

      const ambiguous = refs.find((row) => row.target_slug === 'pageref-ambiguous');
      assert.ok(ambiguous);
      assert.equal(ambiguous.kind, 'DIRECT');
      assert.equal(ambiguous.to_page_id, null, '多条 live 候选绝不任选');
      assert.equal(ambiguous.resolution_status, 'ambiguous');
      assert.deepEqual(ambiguous.live_candidate_page_ids, [AMBIGUOUS_A, AMBIGUOUS_B]);

      const external = refs.find((row) => row.target_scope === 'external');
      assert.ok(external);
      assert.equal(external.resolution_status, 'external');
      assert.equal(external.to_page_id, null);
      assert.equal(external.target_fragment, 'external-fragment');

      // 缺页变 live：只消费 life_event，原源码没有 page_source 变化也会重解析目标身份。
      await seedPage(client, CREATED_TARGET, 'pageref-missing', 'live');
      const life = await query<{ seq: string }>(
        client,
        'test.page_reference:new_target_life',
        `INSERT INTO ingest.page_life_event(
           page_id, kind, occurred_at, occurred_precision, observed_at, source
         ) VALUES (
           $1, 'created', '2026-08-06T00:01:00Z'::timestamptz, 'exact',
           '2026-08-06T00:01:00Z'::timestamptz, 'test_page_reference'
         ) RETURNING seq::text`,
        [CREATED_TARGET],
      );
      const targetRefresh = await projectPageReference(
        client,
        projectionWindow(Number(life.rows[0]!.seq)),
      );
      assert.equal(targetRefresh.affectedKeys, 1);
      const resolvedMissing = (await readReferences(client))
        .find((row) => row.target_slug === 'pageref-missing');
      assert.equal(resolvedMissing?.resolution_status, 'resolved');
      assert.equal(resolvedMissing?.to_page_id, CREATED_TARGET);

      // effective 轮动：新 source 只剩一个目标，旧四行必须原子失效而不是并存。
      const secondSource = '[[[pageref-new|新版本唯一引用]]]';
      const second = await query<{ source_sha: string }>(
        client,
        'test.page_reference:rotate_source',
        `SELECT ingest.apply_page_meta(
           $1,
           jsonb_build_object('source_wikitext', $2::text, 'rev_no', 2),
           '2026-08-06T00:02:00Z'::timestamptz,
           'test_page_reference',
           NULL,
           $3
         ) ->> 'source_sha' AS source_sha`,
        [FROM_PAGE, secondSource, FROM_PAGE + WID_OFFSET],
      );
      const secondSeq = await query<{ change_seq: string }>(
        client,
        'test.page_reference:second_seq',
        `SELECT change_seq::text
           FROM ingest.page_source
          WHERE page_id = $1 AND rev_no = 2`,
        [FROM_PAGE],
      );
      const rotated = await projectPageReference(
        client,
        projectionWindow(Number(secondSeq.rows[0]!.change_seq)),
      );
      assert.equal(rotated.rowsDeleted, 4);
      const afterRotation = await readReferences(client);
      assert.equal(afterRotation.length, 1);
      assert.equal(afterRotation[0]!.target_slug, 'pageref-new');
      assert.equal(afterRotation[0]!.source_sha.toString('hex'), second.rows[0]!.source_sha);

      // 同一源码窗口重放：语义行和 computed_at 均不变化。
      const computedAt = afterRotation[0]!.computed_at.getTime();
      const replay = await projectPageReference(
        client,
        projectionWindow(Number(secondSeq.rows[0]!.change_seq)),
      );
      assert.equal(replay.rowsWritten, 0);
      assert.equal(replay.rowsDeleted, 0);
      assert.equal((await readReferences(client))[0]!.computed_at.getTime(), computedAt);
    });
  });
});
