process.env.SYNCER2_LOG_LEVEL = 'error';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { Pool } from 'pg';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyForumBatch,
  applyForumCategorySnapshot,
  applyForumDiscussionLink,
  isDiscussionCountInconsistent,
  parseForumCategoryPage,
  parseForumComments,
  parseForumPostsPage,
  parseForumStart,
  parseForumThread,
  scanForumCategories,
  scanForumCategoryPage,
  scanForumStart,
  scanForumThreads,
  scanPageDiscussionLinks,
  scanPageDiscussions,
} from '../src/collect/forum.js';
import { applyInferredForumLinks } from '../src/collect/forumLinks.js';
import {
  discoverChangedForumThreads,
  planForumIncrementalCategories,
  type ForumCategoryIncrementalState,
} from '../src/collect/forumIncremental.js';
import { ok } from '../src/collect/result.js';
import { HttpClient } from '../src/http/client.js';
import {
  finishDiscussionTask,
  seedForumDiscussionLinkTasks,
} from '../src/store/queues.js';
import { classifyWorkFailure, workFailureHash } from '../src/work/failurePolicy.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function fixture(name: string): string {
  return readFileSync(path.join(here, 'fixtures', name), 'utf8');
}

test('M5 ForumStart fixture：分类计数与合法空结构可解析', () => {
  const parsed = parseForumStart(fixture('forum-start.reconstructed.html'));
  assert.equal(parsed.status, 'ok');
  assert.deepEqual(
    parsed.data.categories.map((category) => [
      category.id,
      category.threadCount,
      category.postCount,
    ]),
    [
      [675245, 1234, 5678],
      [882982, 42, 96],
    ],
  );

  const empty = parseForumStart('<div class="forum-start-box"><table></table></div>');
  assert.equal(empty.status, 'ok');
  assert.deepEqual(empty.data.categories, []);
});

test('M5 ForumStart 负向：合法空结果与 WAF/残缺分类行不混淆', () => {
  const waf = parseForumStart('<html><title>Access denied</title></html>');
  assert.equal(waf.status, 'failed');
  assert.match(waf.error, /forum-start-box|WAF/);

  const broken = parseForumStart(`
    <div class="forum-start-box"><table><tr>
      <td class="name"><div class="title"><a>没 id</a></div></td>
      <td class="threads">0</td><td class="posts">0</td>
    </tr></table></div>`);
  assert.equal(broken.status, 'failed');
  assert.match(broken.error, /分类行解析失败/);
});

test('论坛增量：全局信号仅变化少数分类时，只分页这些分类并只深扫计数变化 thread', async () => {
  const categories = [
    {
      id: 1, title: '未变化', description: null, threadCount: 10, postCount: 20,
      lastPostAt: '2026-08-07T01:00:00.000Z', lastThreadId: 11, lastPostId: 21,
    },
    {
      id: 2, title: '有新回复', description: null, threadCount: 10, postCount: 21,
      lastPostAt: '2026-08-07T01:05:00.000Z', lastThreadId: 22, lastPostId: 32,
    },
  ];
  const state = (categoryId: number, postCount: number, lastPostAt: string): ForumCategoryIncrementalState => ({
    categoryId,
    sweptThreadCount: 10,
    sweptPostCount: postCount,
    sweptLastPostAt: lastPostAt,
    sweptLastThreadId: categoryId === 1 ? 11 : 22,
    sweptLastPostId: categoryId === 1 ? 21 : 31,
    sweptAt: '2026-08-07T01:00:10.000Z',
  });
  const states = new Map([
    [1, state(1, 20, '2026-08-07T01:00:00.000Z')],
    [2, state(2, 20, '2026-08-07T01:00:00.000Z')],
  ]);
  const calls: Array<[number, number]> = [];
  const results = await discoverChangedForumThreads(
    categories,
    states,
    new Map([[22, 4], [23, 3]]),
    async (categoryId, pageNo) => {
      calls.push([categoryId, pageNo]);
      return ok({
        categoryId,
        categoryTitle: '有新回复',
        categoryDescription: null,
        claimedThreadCount: 10,
        claimedPostCount: 21,
        pager: { pageNo: 1, totalPages: 1 },
        threads: [
          {
            id: 22, categoryId, title: 'changed', description: null, createdBy: null,
            createdAt: '2026-08-01T00:00:00.000Z', postCount: 5,
            lastPostAt: '2026-08-07T01:05:00.000Z', sticky: false, isDeleted: false,
          },
          {
            id: 23, categoryId, title: 'same', description: null, createdBy: null,
            createdAt: '2026-08-01T00:00:00.000Z', postCount: 3,
            lastPostAt: '2026-08-07T00:59:00.000Z', sticky: false, isDeleted: false,
          },
        ],
      });
    },
  );
  assert.deepEqual(calls, [[2, 1]], '不得为未变化分类发 category 请求');
  assert.equal(results.length, 1);
  assert.deepEqual(results[0]?.changedThreadIds, [22], '不得深扫 post_count 未变化 thread');
});

test('论坛增量：变化分类公平切分页预算并轮转首位，固定顺序不能饿死尾类', () => {
  const categories = Array.from({ length: 4 }, (_unused, index) => ({
    id: index + 1,
    title: `category-${index + 1}`,
    description: null,
    threadCount: 1,
    postCount: 1,
  }));
  const first = planForumIncrementalCategories(categories, 6, 0);
  assert.deepEqual(first.map((item) => [item.category.id, item.maxPages]), [
    [1, 2], [2, 2], [3, 1], [4, 1],
  ]);
  const rotated = planForumIncrementalCategories(categories, 2, 2);
  assert.deepEqual(rotated.map((item) => [item.category.id, item.maxPages]), [
    [3, 1], [4, 1],
  ]);
  assert.deepEqual(
    planForumIncrementalCategories(categories, 2, 0).map((item) => item.category.id),
    [1, 2],
  );
  // n=4、每轮2类时，offset 轮转使任一类最多两轮就获得至少一页。
});

test('论坛增量：一个分类耗时不能阻止另一分类启动第一页', async () => {
  const categories = [1, 2].map((id) => ({
    id,
    title: `category-${id}`,
    description: null,
    threadCount: 0,
    postCount: 0,
  }));
  const calls: number[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const pending = discoverChangedForumThreads(
    categories,
    new Map(),
    new Map(),
    async (categoryId) => {
      calls.push(categoryId);
      await barrier;
      return ok({
        categoryId,
        categoryTitle: `category-${categoryId}`,
        categoryDescription: null,
        claimedThreadCount: 0,
        claimedPostCount: 0,
        pager: { pageNo: 1, totalPages: 1 },
        threads: [],
      });
    },
    2,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [1, 2], '两类第一页必须都已启动，不能等待 category-1 完成');
  release();
  assert.equal((await pending).length, 2);
});

test('讨论串关联冷启动：28,389 个缺口可整批播种，link-only 正确连接已有论坛帖', async () => {
  let seedSql = '';
  const seedPool = {
    query: async (sql: string) => {
      seedSql = sql;
      return { rows: [], rowCount: 28_389 };
    },
  } as unknown as Pool;
  assert.equal(await seedForumDiscussionLinkTasks(seedPool), 28_389);
  assert.match(seedSql, /comment_count > 0/);
  assert.match(seedSql, /discussion_thread_id IS NULL/);
  assert.match(seedSql, /forum_link_initial_catchup/);
  assert.match(seedSql, /meta\.irreconcilable/, '开放终态不得被下一轮 seed 重建');

  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      if (/^(?:BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: null };
      if (sql.includes('ingest.apply_page_meta')) return { rows: [{ apply_page_meta: {} }], rowCount: 1 };
      if (sql.includes("page_id_source = 'inferred'") && sql.includes('id <> $2')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("page_id_source = 'verified'") && sql.includes('RETURNING id::text')) {
        return { rows: [{ id: '991' }], rowCount: 1 };
      }
      if (sql.includes('SELECT page_id, page_id_source')) {
        return { rows: [{ page_id: 31549, page_id_source: 'verified' }], rowCount: 1 };
      }
      throw new Error(`unexpected transaction SQL: ${sql}`);
    },
    release: () => undefined,
  };
  const pool = {
    connect: async () => client,
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes('meta.record_page_scan')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected pool SQL: ${sql}`);
    },
  } as unknown as Pool;
  const applied = await applyForumDiscussionLink(
    pool,
    { pageId: 31549, wikidotId: 1452770417, slug: 'x', claimedTotal: 3 },
    ok({
      pageId: 31549,
      wikidotId: 1452770417,
      threadId: 991,
      pager: { pageNo: 1, totalPages: 2 },
      posts: [],
    }),
    '2026-08-07T00:00:00.000Z',
    1,
  );
  assert.equal(applied?.threadId, 991);
  assert.equal(applied?.knownThreadLinked, true);
  assert.ok(statements.some((sql) => /page_id_source = 'verified'/.test(sql)));
  assert.ok(statements.some((sql) => sql.includes('meta.record_page_scan')));
});

test('M5 Category fixture：只解析指定单页，不提供全分类遍历', () => {
  const parsed = parseForumCategoryPage(
    fixture('forum-category.reconstructed.html'),
    882982,
    1,
  );
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.data.categoryTitle, '一般讨论');
  assert.equal(parsed.data.claimedThreadCount, 1);
  assert.equal(parsed.data.threads[0]?.id, 991);
  assert.equal(parsed.data.threads[0]?.createdBy?.wikidotId, 123);

  const empty = parseForumCategoryPage(`
    <div class="forum-category-box">
      <div class="forum-breadcrumbs">论坛 » 空分类</div>
      <div class="description-block"><div class="statistics">主题帖数: 0 | 文章数: 0</div></div>
    </div>
    <table class="table"><tr class="head"><th>主题</th></tr></table>`, 9, 1);
  assert.equal(empty.status, 'ok');
  assert.deepEqual(empty.data.threads, []);
});

test('M5 Category 负向：非空坏行不是空分类', () => {
  const broken = fixture('forum-category.reconstructed.html').replace(
    'href="/forum/t-991"',
    'href="/forum/not-a-thread"',
  );
  const parsed = parseForumCategoryPage(broken, 882982, 1);
  assert.equal(parsed.status, 'failed');
  assert.match(parsed.error, /主题行解析失败/);
});

test('C2 分类级完整枚举跨页组装；thread 存亡不依赖全站 sitemap 差集', async () => {
  const first = fixture('forum-category.reconstructed.html')
    .replace('主题帖数: 1', '主题帖数: 2')
    .concat('<div class="pager"><span class="pager-no">page 1 of 2</span></div>');
  const second = fixture('forum-category.reconstructed.html')
    .replace('主题帖数: 1', '主题帖数: 2')
    .replaceAll('991', '992')
    .replace('page 1 of 2', 'page 2 of 2')
    .concat('<div class="pager"><span class="pager-no">page 2 of 2</span></div>');
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const pageNo = form.get('p');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', body: pageNo === '2' ? second : first }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new HttpClient({
    userAgent: 'syncer2-category-test/1',
    referer: `${baseUrl}/`,
    proxyUrl: null,
    maxAttempts: 1,
    connections: 2,
  });
  try {
    const results = await scanForumCategories(client, baseUrl, [882982], 2);
    const result = results.get(882982);
    assert.equal(result?.status, 'ok');
    if (result?.status === 'ok') {
      assert.equal(result.data.pagesFetched, 2);
      assert.deepEqual(result.data.threads.map((thread) => thread.id), [991, 992]);
    }
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('C2 分类整体不在 sitemap 时只存正面观测、记 partial，绝不软删 thread', async () => {
  let deleteQueries = 0;
  const client = {
    query: async (sql: string) => {
      if (/^(?:BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: null };
      if (sql.includes('ingest.apply_forum_batch')) {
        return {
          rows: [{ result: { categories: 1, threads: 1, threads_linked: 0, posts: 0 } }],
          rowCount: 1,
        };
      }
      if (sql.includes('UPDATE ingest.forum_thread')) {
        deleteQueries++;
        return { rows: [{ id: '999' }], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release: () => undefined,
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const snapshot = {
    category: {
      id: 882986,
      title: '翻译预定区（归档）',
      description: null,
      threadCount: 1,
      postCount: 1,
    },
    threads: [{
      id: 991,
      categoryId: 882986,
      title: '仍存在',
      description: null,
      createdBy: null,
      createdAt: '2023-11-14T22:13:20.000Z',
      postCount: 1,
      isDeleted: false,
    }],
    totalPages: 1,
    pagesFetched: 1,
  };
  const partialApply = await applyForumCategorySnapshot(
    pool,
    snapshot,
    '2026-07-28T00:00:00.000Z',
    null,
    { allowThreadDeletion: false },
  );
  assert.equal(partialApply['absence_status'], 'partial');
  assert.equal(partialApply['soft_deleted_threads'], 0);
  assert.equal(deleteQueries, 0);

  const completeApply = await applyForumCategorySnapshot(
    pool,
    { ...snapshot, category: { ...snapshot.category, id: 882982 },
      threads: snapshot.threads.map((thread) => ({ ...thread, categoryId: 882982 })) },
    '2026-07-28T00:00:01.000Z',
    null,
    { allowThreadDeletion: true },
  );
  assert.equal(completeApply['absence_status'], 'ok');
  assert.equal(completeApply['soft_deleted_threads'], 1);
  assert.equal(deleteQueries, 1);
});

test('A4 inferred 回填 SQL 明确保护 verified 与无来源既有真值', async () => {
  let capturedSql = '';
  const pool = {
    query: async (sql: string) => {
      capturedSql = sql;
      return {
        rows: [{
          selected: 3,
          applied: 1,
          skipped_verified: 1,
          skipped_unmarked_existing: 1,
          missing_thread: 0,
          missing_page: 0,
          identity_mismatch: 0,
        }],
        rowCount: 1,
      };
    },
  } as unknown as Pool;
  const summary = await applyInferredForumLinks(pool, [
    { threadId: 1, pageId: 11, wikidotId: 111 },
    { threadId: 2, pageId: 12, wikidotId: 112 },
    { threadId: 3, pageId: 13, wikidotId: 113 },
  ]);
  assert.equal(summary.applied, 1);
  assert.equal(summary.skippedVerified, 1);
  assert.equal(summary.skippedUnmarkedExisting, 1);
  assert.match(capturedSql, /old_source = 'inferred'/);
  assert.match(capturedSql, /found_wikidot_id = c\.wikidot_id/);
});

test('M5 Thread fixture：作者、编辑时间与嵌套 parent_post_id', () => {
  const html = fixture('forum-thread.reconstructed.html');
  const parsed = parseForumThread(html, 991);
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.data.thread.categoryId, 882982);
  assert.equal(parsed.data.thread.createdBy?.kind, 'wikidot');
  assert.equal(parsed.data.posts.length, 2);
  assert.equal(parsed.data.posts[0]?.textPlain, '第一段 正文');
  assert.equal(parsed.data.posts[1]?.parentPostId, 7001);
  assert.equal(parsed.data.posts[1]?.author?.kind, 'guest');
  assert.equal(parsed.data.posts[1]?.editedAt, '2023-11-14T22:16:40.000Z');

  const newerThanHeader = parseForumThread(html.replace('文章数: 2', '文章数: 1'), 991);
  assert.equal(newerThanHeader.status, 'ok');
  assert.equal(
    newerThanHeader.status === 'ok' ? newerThanHeader.data.thread.postCount : null,
    2,
    '完整实际帖子是 header 的正向超集时，以实际计数更新 thread 当前态',
  );

  const missingFromPage = parseForumThread(html.replace('文章数: 2', '文章数: 3'), 991);
  assert.equal(missingFromPage.status, 'partial');
  assert.match(
    missingFromPage.status === 'partial' ? missingFromPage.error : '',
    /单页主题解析 2 帖 < thread 自报 3/,
  );

  const userTemplateLiteral = parseForumComments(
    `<script>WIKIDOT.forumThreadId = 991;</script>${html.replace(
      '第一段 <strong>正文</strong>',
      '把%%name%%换成%%title%%能达到更好的显示效果',
    )}`,
    { pageId: 25, wikidotId: 1452770417, claimedTotal: 2 },
  );
  assert.equal(userTemplateLiteral.status, 'ok', '用户评论里的 Wikidot 模板语法不是结构残留');
  assert.match(
    userTemplateLiteral.status === 'ok' ? userTemplateLiteral.data.posts[0]!.textPlain : '',
    /%%name%%换成%%title%%/,
  );

  const structuralTemplateResidue = parseForumComments(
    `<script>WIKIDOT.forumThreadId = 991;</script><div>%%selector%%</div>${html}`,
    { pageId: 25, wikidotId: 1452770417, claimedTotal: 2 },
  );
  assert.equal(structuralTemplateResidue.status, 'failed');
  assert.match(
    structuralTemplateResidue.status === 'failed' ? structuralTemplateResidue.error : '',
    /未替换的 %%selector%%/,
  );
});

test('M5 Thread/Posts 负向：空白只有独立 claimed_total=0 才是合法空帖', () => {
  const empty = parseForumPostsPage('\n\n\n\n\n', 18218218, 1, 0);
  assert.equal(empty.status, 'ok');
  assert.deepEqual(empty.data.posts, []);

  const unknown = parseForumPostsPage('\n\n\n\n\n', 18218218, 1, null);
  assert.equal(unknown.status, 'failed');
  assert.match(unknown.error, /不解释成 0 帖/);

  const brokenThread = parseForumThread('<div class="forum-thread-box"></div>', 991);
  assert.equal(brokenThread.status, 'failed');
  assert.match(brokenThread.error, /结构解析失败/);
});

test('M5 Comments fixture：实站 WIKIDOT.forumThreadId 形态与合法零评论', () => {
  const target = {
    pageId: 25,
    wikidotId: 1469054503,
    claimedTotal: 0,
    expectedThreadId: 18218218,
  };
  const parsed = parseForumComments(
    fixture('forum-comments-empty.reconstructed.html'),
    target,
  );
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.data.threadId, 18218218);
  assert.deepEqual(parsed.data.posts, []);

  const broken = parseForumComments('<div id="thread-container-posts"></div>', target);
  assert.equal(broken.status, 'failed');
  assert.match(broken.error, /没有回显/);
});

test('讨论关联：CommentsList ok+threadId 但折叠 0 帖，经 ViewThread=0 确认后进入终态', async () => {
  const threadId = 14_045_830;
  const comments = `<script>WIKIDOT.forumThreadId = ${threadId};</script>` +
    '<div id="thread-container-posts" style="display:none"></div>';
  const emptyThread = fixture('forum-thread.reconstructed.html')
    .replace('文章数: 2', '文章数: 0')
    .replace(
      /  <div id="thread-container-posts">[\s\S]*\n  <\/div>\n<\/div>/,
      '  <div id="thread-container-posts"></div>\n</div>',
    );
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const moduleName = form.get('moduleName');
      const payload = moduleName === 'forum/ForumCommentsListModule'
        ? { status: 'ok', body: comments }
        : moduleName === 'forum/ForumViewThreadModule'
          ? { status: 'ok', body: emptyThread }
          : { status: 'not_ok', message: `unexpected ${String(moduleName)}` };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const client = new HttpClient({
    userAgent: 'syncer2-forum-folded-test/1',
    referer: `${baseUrl}/`,
    proxyUrl: null,
    maxAttempts: 1,
    connections: 1,
  });
  try {
    const result = (await scanPageDiscussionLinks(
      client,
      baseUrl,
      [{ pageId: 23_030, wikidotId: 1_304_581_332, claimedTotal: 7 }],
      1,
    )).get(23_030);
    assert.equal(result?.status, 'partial');
    assert.equal(result === undefined ? false : isDiscussionCountInconsistent(result), true);
    if (result?.status !== 'partial') throw new Error('预期双模块计数矛盾 partial');
    assert.equal(result.data.threadId, threadId);
    assert.deepEqual(result.data.threadEvidence, { reportedPosts: 0, fetchedPosts: 0 });

    const policy = classifyWorkFailure('discussion', result.error);
    assert.equal(policy.signature, 'discussion:wikidot_discussion_count_inconsistent');
    const sql: string[] = [];
    const terminalPool = {
      query: async (statement: string) => {
        sql.push(statement);
        return { rows: [], rowCount: 1 };
      },
    } as unknown as Pool;
    const finished = await finishDiscussionTask(
      terminalPool,
      {
        taskId: 1,
        pageId: 23_030,
        wikidotId: 1_304_581_332,
        slug: 'scp-cn-2337',
        kind: 'discussion',
        claimedTotal: 7,
        expectedThreadId: null,
        attempts: 1,
        stableCount: 0,
        lastResultHash: null,
        reasons: ['test'],
        lane: 'catchup',
      },
      {
        workerId: 'forum-folded-test',
        status: 'partial',
        resultHash: workFailureHash(policy),
        terminalFailure: true,
        localValue: { discussion_thread_id: null },
        remoteValue: { thread_id: threadId, claimed_total: 7, thread_posts: 0 },
        now: '2026-08-25T00:35:42.392Z',
      },
    );
    assert.equal(finished.action, 'irreconcilable');
    assert.match(sql.join('\n'), /INSERT INTO meta\.irreconcilable/);
    assert.match(sql.join('\n'), /DELETE FROM meta\.scan_task/);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('M5 完整 thread 才生成缺席帖软删 tombstone，并仍走 apply_forum_batch', async () => {
  let postPayload: Array<Record<string, unknown>> = [];
  const completenessPayloads: number[][] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      if (/^(?:BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: null };
      if (sql.includes('FROM ingest.forum_post')) {
        return { rows: [{ id: '7002', thread_id: '991' }], rowCount: 1 };
      }
      if (sql.includes('ingest.apply_forum_batch')) {
        postPayload = JSON.parse(String(params?.[2])) as Array<Record<string, unknown>>;
        completenessPayloads.push(JSON.parse(String(params?.[5])) as number[]);
        return {
          rows: [{ result: { categories: 0, threads: 1, posts: 2 } }],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release: () => undefined,
  };
  const pool = { connect: async () => client } as unknown as Pool;
  const targeted = await applyForumBatch(
    pool,
    {
      categories: [],
      threads: [{
        id: 991,
        categoryId: 882982,
        title: '测试主题',
        description: null,
        createdBy: null,
        createdAt: '2023-11-14T22:13:20.000Z',
        postCount: 1,
        isDeleted: false,
      }],
      posts: [],
    },
    '2026-07-27T12:34:55.789Z',
    null,
  );
  assert.equal(targeted['soft_deleted'], 0);

  const result = await applyForumBatch(
    pool,
    {
      categories: [],
      threads: [{
        id: 991,
        categoryId: 882982,
        title: '测试主题',
        description: null,
        createdBy: null,
        createdAt: '2023-11-14T22:13:20.000Z',
        postCount: 1,
        isDeleted: false,
      }],
      posts: [{
        id: 7001,
        threadId: 991,
        parentPostId: null,
        author: null,
        title: null,
        textHtml: '<p>仍存在</p>',
        textPlain: '仍存在',
        createdAt: '2023-11-14T22:13:21.000Z',
        editedAt: null,
        isDeleted: false,
      }],
    },
    '2026-07-27T12:34:56.789Z',
    null,
    { completeThreadIds: [991] },
  );
  assert.equal(result['soft_deleted'], 1);
  assert.deepEqual(
    completenessPayloads,
    [[], [991]],
    '定向批必须显式传空完整集；只有完整翻页 thread 才进入 absence 授权声明',
  );
  assert.deepEqual(postPayload.map((post) => [post.id, post.is_deleted]), [
    [7001, false],
    [7002, true],
  ]);
});

test('M5 五个 AMC 模块（含真实评论 CommentsList）全部匿名，且失败 thread 不消失', async () => {
  const startHtml = fixture('forum-start.reconstructed.html');
  const categoryHtml = fixture('forum-category.reconstructed.html');
  const threadHtml = fixture('forum-thread.reconstructed.html');
  const pagedThread = `${threadHtml.replace('文章数: 2', '文章数: 3')}
    <div class="pager"><span class="pager-no">page 1 of 2</span></div>`;
  const secondPage = `
    <div class="post-container"><div class="post" id="post-7003"><div class="long">
      <div class="head"><div class="title">末帖</div><div class="info">
        <span class="printuser anonymous"><span class="ip">(127.0.0.1)</span></span>
        <span class="odate time_1700000300">14 Nov 2023</span>
      </div></div>
      <div class="content"><p>最后一帖</p></div>
    </div></div></div>
    <div class="pager"><span class="pager-no">page 2 of 2</span></div>`;
  const comments = `<script>WIKIDOT.forumThreadId = 991;</script>${pagedThread}`;
  const requests: Array<{
    moduleName: string;
    headers: http.IncomingHttpHeaders;
    form: URLSearchParams;
  }> = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      const moduleName = form.get('moduleName') ?? '';
      requests.push({ moduleName, headers: req.headers, form });
      let payload: Record<string, unknown>;
      if (moduleName === 'forum/ForumStartModule') {
        payload = { status: 'ok', body: startHtml };
      } else if (moduleName === 'forum/ForumViewCategoryModule') {
        payload = { status: 'ok', body: categoryHtml };
      } else if (moduleName === 'forum/ForumViewThreadModule' && form.get('t') === '1') {
        payload = { status: 'no_thread', message: 'No such thread' };
      } else if (moduleName === 'forum/ForumViewThreadModule') {
        payload = { status: 'ok', body: pagedThread };
      } else if (moduleName === 'forum/ForumViewThreadPostsModule') {
        payload = { status: 'ok', body: secondPage };
      } else if (moduleName === 'forum/ForumCommentsListModule') {
        payload = { status: 'ok', body: comments };
      } else {
        payload = { status: 'not_ok', message: `unexpected ${moduleName}` };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const client = new HttpClient({
    userAgent: 'syncer2-forum-test/1',
    referer: `${baseUrl}/`,
    proxyUrl: null,
    maxAttempts: 1,
    connections: 2,
  });

  try {
    assert.equal((await scanForumStart(client, baseUrl)).status, 'ok');
    assert.equal((await scanForumCategoryPage(client, baseUrl, 882982, 1)).status, 'ok');

    const threads = await scanForumThreads(client, baseUrl, [991, 1], 2);
    assert.equal(threads.size, 2);
    assert.equal(threads.get(991)?.status, 'ok');
    assert.equal(threads.get(1)?.status, 'failed');
    const validThread = threads.get(991);
    assert.equal(validThread?.status === 'ok' ? validThread.data.posts.length : null, 3);

    const discussions = await scanPageDiscussions(
      client,
      baseUrl,
      [{ pageId: 25, wikidotId: 1452770417, claimedTotal: 3 }],
      2,
    );
    const discussion = discussions.get(25);
    assert.equal(discussion?.status, 'ok');
    if (discussion?.status === 'ok') {
      assert.equal(discussion.data.threadId, 991, '必须从 CommentsList 解析真实 thread id');
      assert.equal(discussion.data.posts.length, 3);
      assert.deepEqual(
        discussion.data.posts.map((post) => post.textPlain),
        ['第一段 正文', '嵌套回复', '最后一帖'],
        '必须保存实际评论正文，不能把“显示评论”的折叠 UI 当帖子',
      );
    }

    const newerThanClaim = await scanPageDiscussions(
      client,
      baseUrl,
      [{ pageId: 26, wikidotId: 1452770417, claimedTotal: 2 }],
      2,
    );
    assert.equal(
      newerThanClaim.get(26)?.status,
      'ok',
      '完整 thread 是 Tier1 声明的正向超集时应接受，避免新增评论造成永久 partial',
    );

    const missingFromThread = await scanPageDiscussions(
      client,
      baseUrl,
      [{ pageId: 27, wikidotId: 1452770417, claimedTotal: 4 }],
      2,
    );
    const missingDiscussion = missingFromThread.get(27);
    assert.equal(missingDiscussion?.status, 'partial');
    assert.match(
      missingDiscussion?.status === 'partial'
        ? missingDiscussion.error
        : '',
      /完整 thread 3 帖 < Tier1 claimed_total 4/,
    );

    assert.deepEqual(
      new Set(requests.map((request) => request.moduleName)),
      new Set([
        'forum/ForumStartModule',
        'forum/ForumViewCategoryModule',
        'forum/ForumViewThreadModule',
        'forum/ForumViewThreadPostsModule',
        'forum/ForumCommentsListModule',
      ]),
    );
    for (const request of requests) {
      assert.ok(request.headers['user-agent']?.trim());
      assert.ok(request.headers.referer?.trim());
      assert.equal(request.headers.authorization, undefined);
      assert.doesNotMatch(request.headers.cookie ?? '', /WIKIDOT_SESSION_ID/);
      assert.match(request.headers.cookie ?? '', /^wikidot_token7=[0-9a-f]{16}$/);
      assert.ok(request.form.get('wikidot_token7'));
      assert.equal(request.form.get('username'), null);
      assert.equal(request.form.get('password'), null);
      assert.equal(request.form.get('session'), null);
    }
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
