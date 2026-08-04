/**
 * M5 · 论坛采集。
 *
 * 五个读取模块全部经既有 `amcRequest()` 匿名调用：
 *   · ForumStartModule             分类当前态
 *   · ForumViewCategoryModule      单个分类的指定页（只作定向诊断，不做全站遍历）
 *   · ForumViewThreadModule        单主题元数据 + 帖子第一页
 *   · ForumViewThreadPostsModule   帖子后续分页
 *   · ForumCommentsListModule      页面讨论区 thread id
 *
 * 本文件刻意不 import `@ukwhatn/wikidot`。那个库可以从环境变量创建登录会话，
 * 而论坛读取完全免登录；轮换出口上携带登录 session 会形成同一账号跨 49 个 IP 横跳。
 *
 * 论坛三表不是 append-only 事实表：它们是上游原生 id 为主键的当前态表，
 * 编辑就地 upsert。帖子只有在完整翻页、计数校验成功后，才把本地/远端集合差
 * 转成显式 `is_deleted` tombstone；partial/failed 的缺席永远不会变成删除。
 */

import { createHash } from 'node:crypto';
import { load, type CheerioAPI } from 'cheerio';
import type { Pool, PoolClient } from 'pg';

import { amcRequest } from '../http/amc.js';
import type { HttpClient } from '../http/client.js';
import { query, toPgTimestamptz, withTransaction } from '../store/db.js';
import { recordPageScan } from '../store/meta.js';
import { sanitizePgValue, toPgJson } from '../store/pgText.js';
import { chunk, mapWithConcurrency } from '../util/concurrency.js';
import {
  assertUniqueKeys,
  diagnostics,
  failed,
  ok,
  partial,
  type CollectResult,
  type PageCollectTarget,
} from './result.js';

const SELECTOR_RESIDUE_RE = /%%[^%\r\n]+%%/;
const CATEGORY_MODULE = 'forum/ForumViewCategoryModule';
const THREAD_MODULE = 'forum/ForumViewThreadModule';
const POSTS_MODULE = 'forum/ForumViewThreadPostsModule';
const COMMENTS_MODULE = 'forum/ForumCommentsListModule';

export type ForumAuthorKind = 'wikidot' | 'deleted' | 'guest' | 'anonymous' | 'system';

export interface ForumAuthor {
  kind: ForumAuthorKind;
  /** 只有正整数才可交给 ensure_user；wid≤0 只保留 displayName 快照。 */
  wikidotId: number | null;
  displayName: string;
  unixName: string | null;
}

export interface ForumCategoryRecord {
  id: number;
  title: string;
  description: string | null;
  threadCount: number;
  postCount: number;
}

export interface ForumThreadRecord {
  id: number;
  categoryId: number;
  title: string;
  description: string | null;
  createdBy: ForumAuthor | null;
  createdAt: string;
  postCount: number;
  /** 只接受上游明确证据；解析到的存活主题恒为 false。 */
  isDeleted: boolean;
}

export interface ForumPostRecord {
  id: number;
  threadId: number;
  parentPostId: number | null;
  author: ForumAuthor | null;
  title: string | null;
  textHtml: string;
  textPlain: string;
  createdAt: string;
  editedAt: string | null;
  /** 解析出的可见帖子恒为 false；完整快照集合差在写入层另造 tombstone。 */
  isDeleted: boolean;
}

export interface ForumPager {
  pageNo: number;
  totalPages: number;
}

export interface ForumStartSnapshot {
  categories: ForumCategoryRecord[];
}

export interface ForumCategoryPage {
  categoryId: number;
  categoryTitle: string;
  categoryDescription: string | null;
  claimedThreadCount: number;
  claimedPostCount: number;
  pager: ForumPager;
  threads: ForumThreadRecord[];
}

export interface ForumPostsPage {
  threadId: number;
  pager: ForumPager;
  posts: ForumPostRecord[];
}

export interface ForumThreadSnapshot {
  thread: ForumThreadRecord;
  posts: ForumPostRecord[];
  totalPages: number;
  pagesFetched: number;
}

export interface ForumCategorySnapshot {
  category: ForumCategoryRecord;
  threads: ForumThreadRecord[];
  totalPages: number;
  pagesFetched: number;
}

export interface ForumDiscussionTarget extends PageCollectTarget {
  claimedTotal: number | null;
  /** 已知 thread id 时必须回显一致；首次发现可为 null。 */
  expectedThreadId?: number | null;
  /** forum 与 discussion 是两条独立页级队列，证据 kind 不得互相顶替。 */
  scanKind?: 'forum' | 'discussion';
}

export interface ForumCommentsPage {
  pageId: number;
  wikidotId: number;
  threadId: number;
  pager: ForumPager;
  posts: ForumPostRecord[];
}

export interface ForumDiscussionSnapshot {
  pageId: number;
  wikidotId: number;
  threadId: number;
  thread: ForumThreadRecord;
  posts: ForumPostRecord[];
  claimedTotal: number | null;
}

export interface ForumBatch {
  categories: ForumCategoryRecord[];
  threads: ForumThreadRecord[];
  posts: ForumPostRecord[];
}

export interface ApplyForumBatchOptions {
  /**
   * 只有完整翻完且计数校验成功的 thread 才能列在这里。
   * 对这些 thread，本地仍存活但远端完整快照缺席的 post 会写显式 is_deleted tombstone。
   */
  completeThreadIds?: readonly number[];
}

export interface ApplyForumCategorySnapshotOptions {
  /**
   * 只有 category sitemap 明确列出该分类，且分类分页完整时才能为 true。
   * 分类整体不在 sitemap 时必须 false：这类 partial coverage 不授权 absence→deleted。
   */
  allowThreadDeletion: boolean;
}

type Q = ReturnType<CheerioAPI>;

function loadFragment(body: string): CheerioAPI {
  return load(body, null, false);
}

function positiveInt(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null || !/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeInt(raw: string, label: string): number {
  const cleaned = raw.replace(/[\s,]/g, '');
  if (!/^\d+$/.test(cleaned)) throw new Error(`${label} 不是非负整数：${JSON.stringify(raw)}`);
  const value = Number(cleaned);
  if (!Number.isSafeInteger(value)) throw new Error(`${label} 超出安全整数范围：${raw}`);
  return value;
}

function normalizeText(raw: string): string {
  return raw.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function optionalText(raw: string): string | null {
  const text = normalizeText(raw);
  return text === '' ? null : text;
}

function isoFromOdate($node: Q, label: string): string {
  const classes = $node.attr('class') ?? '';
  const epochRaw = /\btime_(\d{9,12})\b/.exec(classes)?.[1];
  const epoch = Number(epochRaw);
  if (!Number.isSafeInteger(epoch) || epoch <= 0) {
    throw new Error(`${label} 缺少合法 span.odate time_<epoch>`);
  }
  return new Date(epoch * 1_000).toISOString();
}

function parseForumAuthor($node: Q): ForumAuthor | null {
  if ($node.length === 0) return null;
  const classes = new Set(($node.attr('class') ?? '').split(/\s+/).filter(Boolean));
  const displayName = normalizeText($node.text());
  const dataId = positiveInt($node.attr('data-id'));

  if (classes.has('deleted') || displayName === '(user deleted)' || displayName === '(account deleted)') {
    return {
      kind: 'deleted',
      wikidotId: dataId,
      displayName: displayName || '(user deleted)',
      unixName: null,
    };
  }

  if (classes.has('anonymous')) {
    const ip = normalizeText($node.find('span.ip').first().text()).replace(/[()]/g, '');
    return {
      kind: 'anonymous',
      wikidotId: null,
      displayName: ip === '' ? (displayName || 'Anonymous') : ip,
      unixName: null,
    };
  }

  const imageSrc = $node.find('img').first().attr('src') ?? '';
  if (classes.has('guest') || /gravatar\.com/i.test(imageSrc)) {
    return {
      kind: 'guest',
      wikidotId: null,
      displayName: displayName || 'Guest',
      unixName: null,
    };
  }

  if (displayName === 'Wikidot') {
    return {
      kind: 'system',
      wikidotId: null,
      displayName: 'Wikidot',
      unixName: 'wikidot',
    };
  }

  const $link = $node.find('a').last();
  if ($link.length === 0) {
    // 无链接 printuser 是站点的已注销形态；不得按显示名铸身份。
    return {
      kind: 'deleted',
      wikidotId: dataId,
      displayName: displayName || '(user deleted)',
      unixName: null,
    };
  }
  const onclick = $link.attr('onclick') ?? '';
  const wikidotId = positiveInt(/userInfo\((\d+)\)/.exec(onclick)?.[1]) ?? dataId;
  const href = $link.attr('href') ?? '';
  const unixRaw = /\/user:info\/([^/?#]+)\/?/i.exec(href)?.[1];
  let unixName: string | null = null;
  if (unixRaw !== undefined) {
    try {
      unixName = decodeURIComponent(unixRaw);
    } catch {
      unixName = unixRaw;
    }
  }
  return {
    kind: wikidotId === null ? 'deleted' : 'wikidot',
    wikidotId,
    displayName: normalizeText($link.text()) || displayName || '(user deleted)',
    unixName,
  };
}

function parsePager($: CheerioAPI, expectedPage: number): ForumPager {
  const $pager = $('div.pager').first();
  if ($pager.length === 0) {
    if (expectedPage !== 1) {
      throw new Error(`请求第 ${expectedPage} 页但响应没有 pager，无法证明页码正确`);
    }
    return { pageNo: 1, totalPages: 1 };
  }
  const pagerNo = normalizeText($pager.find('span.pager-no').first().text());
  const match = /^page\s+(\d+)\s+of\s+(\d+)$/i.exec(pagerNo);
  if (!match) throw new Error(`pager-no 无法解析：${JSON.stringify(pagerNo)}`);
  const pageNo = Number(match[1]);
  const totalPages = Number(match[2]);
  if (
    !Number.isSafeInteger(pageNo) ||
    !Number.isSafeInteger(totalPages) ||
    pageNo < 1 ||
    totalPages < pageNo ||
    pageNo !== expectedPage
  ) {
    throw new Error(
      `pager 页码不一致：请求=${expectedPage}, response=${pageNo}, total=${totalPages}`,
    );
  }
  return { pageNo, totalPages };
}

function rejectBrokenBody(body: string, moduleName: string): string | null {
  if (SELECTOR_RESIDUE_RE.test(body)) {
    return `${moduleName} body 含未替换的 %%selector%% 字面量`;
  }
  return null;
}

/** ForumStartModule：结构完整的空 forum-start-box 与坏 HTML 明确分流。 */
export function parseForumStart(body: string): CollectResult<ForumStartSnapshot> {
  const preflight = rejectBrokenBody(body, 'ForumStartModule');
  if (preflight !== null) return failed(preflight);
  if (body.trim() === '') return failed('ForumStartModule body 为空，不解释成 0 个分类');

  const $ = loadFragment(body);
  if ($('.forum-start-box').length !== 1) {
    return failed('ForumStartModule 缺少唯一 .forum-start-box；疑似 WAF/模板变形');
  }

  const categories: ForumCategoryRecord[] = [];
  const errors: string[] = [];
  $('.forum-start-box table tr').each((_i, row) => {
    const $row = $(row);
    if ($row.hasClass('head')) return;
    if ($row.find('td').length === 0) return;
    try {
      const $name = $row.find('td.name').first();
      const $link = $name.find('div.title a').first();
      const id = positiveInt(/\/forum\/c-(\d+)/i.exec($link.attr('href') ?? '')?.[1]);
      const title = normalizeText($link.text());
      if (id === null || title === '') throw new Error('category id/title 缺失');
      categories.push({
        id,
        title,
        description: optionalText($name.find('div.description').first().text()),
        threadCount: nonNegativeInt($row.find('td.threads').first().text(), `category ${id} thread_count`),
        postCount: nonNegativeInt($row.find('td.posts').first().text(), `category ${id} post_count`),
      });
    } catch (err) {
      errors.push(String(err));
    }
  });
  if (errors.length > 0) {
    return failed(
      `分类行解析失败 ${errors.length}/${categories.length + errors.length}：${errors
        .slice(0, 3)
        .join('；')}`,
      diagnostics(null, categories.length),
    );
  }
  const duplicate = firstDuplicate(categories.map((category) => category.id));
  if (duplicate !== null) {
    return failed(`ForumStartModule category id 重复：${duplicate}`, diagnostics(null, categories.length));
  }
  return ok({ categories }, diagnostics(null, categories.length));
}

function parseCategoryStats($: CheerioAPI): {
  title: string;
  description: string | null;
  threadCount: number;
  postCount: number;
} {
  const breadcrumbs = normalizeText($('.forum-category-box .forum-breadcrumbs').first().text());
  const parts = breadcrumbs.split('»').map((part) => part.trim()).filter(Boolean);
  const tail = parts.at(-1) ?? '';
  const title = tail.includes('/') ? tail.split('/').at(-1)!.trim() : tail;
  if (title === '') throw new Error('category breadcrumbs 中没有标题');

  const $description = $('.forum-category-box .description-block').first().clone();
  const statisticsText = normalizeText($description.find('.statistics').first().text());
  $description.find('.statistics').remove();
  const threadRaw = /主题帖数\s*:\s*([\d,]+)/.exec(statisticsText)?.[1];
  const postRaw = /文章数\s*:\s*([\d,]+)/.exec(statisticsText)?.[1];
  if (threadRaw === undefined || postRaw === undefined) {
    throw new Error(`category statistics 缺主题帖数/文章数：${statisticsText}`);
  }
  return {
    title,
    description: optionalText($description.text()),
    threadCount: nonNegativeInt(threadRaw, 'category thread_count'),
    postCount: nonNegativeInt(postRaw, 'category post_count'),
  };
}

function parseThreadRow($: CheerioAPI, $row: Q, categoryId: number): ForumThreadRecord {
  const $link = $row.find('td.name div.title a').first();
  const id = positiveInt(/\/forum\/t-(\d+)/i.exec($link.attr('href') ?? '')?.[1]);
  const title = normalizeText($link.text());
  if (id === null || title === '') throw new Error('thread id/title 缺失');
  const $started = $row.find('td.started').first();
  const createdAt = isoFromOdate($started.find('span.odate').first(), `thread ${id} created_at`);
  const postCount = nonNegativeInt($row.find('td.posts').first().text(), `thread ${id} post_count`);
  return {
    id,
    categoryId,
    title,
    description: optionalText($row.find('td.name div.description').first().text()),
    createdBy: parseForumAuthor($started.find('span.printuser').first()),
    createdAt,
    postCount,
    isDeleted: false,
  };
}

/**
 * ForumViewCategoryModule 只解析一个指定页。调用方若要翻页必须显式逐页调，
 * 常规 forum-scan 不调用它做全量枚举（category 675245 实测有 2,128 页）。
 */
export function parseForumCategoryPage(
  body: string,
  categoryId: number,
  expectedPage: number,
): CollectResult<ForumCategoryPage> {
  const preflight = rejectBrokenBody(body, 'ForumViewCategoryModule');
  if (preflight !== null) return failed(preflight);
  if (body.trim() === '') return failed('ForumViewCategoryModule body 为空，不解释成空分类页');
  if (!Number.isSafeInteger(categoryId) || categoryId <= 0) return failed(`categoryId 非法：${categoryId}`);

  const $ = loadFragment(body);
  if ($('.forum-category-box').length !== 1 || $('table.table').length !== 1) {
    return failed('ForumViewCategoryModule 缺 .forum-category-box 或唯一 table.table');
  }
  try {
    const stats = parseCategoryStats($);
    const pager = parsePager($, expectedPage);
    const threads: ForumThreadRecord[] = [];
    const errors: string[] = [];
    $('table.table tr').each((_i, row) => {
      const $row = $(row);
      if ($row.hasClass('head')) return;
      if ($row.find('td').length === 0) return;
      try {
        threads.push(parseThreadRow($, $row, categoryId));
      } catch (err) {
        errors.push(String(err));
      }
    });
    if (errors.length > 0) {
      return failed(
        `主题行解析失败 ${errors.length}/${threads.length + errors.length}：${errors.slice(0, 3).join('；')}`,
        diagnostics(stats.threadCount, threads.length),
      );
    }
    const duplicate = firstDuplicate(threads.map((thread) => thread.id));
    if (duplicate !== null) {
      return failed(`分类页 thread id 重复：${duplicate}`, diagnostics(stats.threadCount, threads.length));
    }
    return ok(
      {
        categoryId,
        categoryTitle: stats.title,
        categoryDescription: stats.description,
        claimedThreadCount: stats.threadCount,
        claimedPostCount: stats.postCount,
        pager,
        threads,
      },
      diagnostics(stats.threadCount, threads.length),
    );
  } catch (err) {
    return failed(`ForumViewCategoryModule 结构解析失败：${String(err)}`);
  }
}

function findParentPostId($post: Q): number | null {
  const $ownContainer = $post.closest('div.post-container').first();
  if ($ownContainer.length === 0) return null;
  const $parentContainer = $ownContainer.parent().closest('div.post-container').first();
  if ($parentContainer.length === 0) return null;
  return positiveInt(
    /^post-(\d+)$/.exec($parentContainer.children('div.post').first().attr('id') ?? '')?.[1],
  );
}

function parsePost($: CheerioAPI, $post: Q, threadId: number): ForumPostRecord {
  const id = positiveInt(/^post-(\d+)$/.exec($post.attr('id') ?? '')?.[1]);
  if (id === null) throw new Error(`post id 非法：${String($post.attr('id'))}`);
  const $long = $post.children('div.long').first();
  const $head = $long.children('div.head').first();
  const $info = $head.children('div.info').first();
  const $content = $long.children('div.content').first();
  if ($long.length === 0 || $head.length === 0 || $info.length === 0 || $content.length === 0) {
    throw new Error(`post ${id} 缺 long/head/info/content 结构`);
  }
  const createdAt = isoFromOdate($info.find('span.odate').first(), `post ${id} created_at`);
  const $editOdate = $long.find('div.changes span.odate').first();
  const editedAt =
    $editOdate.length === 0 ? null : isoFromOdate($editOdate, `post ${id} edited_at`);
  const textHtml = $content.html();
  if (textHtml === null) throw new Error(`post ${id} content.html() 返回 null`);
  return {
    id,
    threadId,
    parentPostId: findParentPostId($post),
    author: parseForumAuthor($info.find('span.printuser').first()),
    title: optionalText($head.children('div.title').first().text()),
    textHtml,
    textPlain: normalizeText($content.text()),
    createdAt,
    editedAt,
    isDeleted: false,
  };
}

function parsePostsFromDom(
  $: CheerioAPI,
  threadId: number,
): { posts: ForumPostRecord[]; errors: string[]; candidates: number } {
  const posts: ForumPostRecord[] = [];
  const errors: string[] = [];
  const candidates = $('div.post').length;
  $('div.post').each((_i, post) => {
    try {
      posts.push(parsePost($, $(post), threadId));
    } catch (err) {
      errors.push(String(err));
    }
  });
  return { posts, errors, candidates };
}

function assertPostIds(posts: readonly ForumPostRecord[]): string | null {
  const duplicate = firstDuplicate(posts.map((post) => post.id));
  return duplicate === null ? null : `post id 重复：${duplicate}`;
}

/**
 * ForumViewThreadPostsModule 单页解析。
 *
 * 该模块对“真实 0 帖 thread”实测返回仅 5 个换行符，没有结构锚点。因此只有同时持有
 * 独立的 claimed_total=0 且请求 page=1 时，空白 body 才是合法空集合；其它空白全部 failed。
 */
export function parseForumPostsPage(
  body: string,
  threadId: number,
  expectedPage: number,
  claimedTotal: number | null,
): CollectResult<ForumPostsPage> {
  const preflight = rejectBrokenBody(body, 'ForumViewThreadPostsModule');
  if (preflight !== null) return failed(preflight);
  if (body.trim() === '') {
    if (claimedTotal === 0 && expectedPage === 1) {
      return ok(
        { threadId, pager: { pageNo: 1, totalPages: 1 }, posts: [] },
        diagnostics(0, 0),
      );
    }
    return failed(
      `ForumViewThreadPostsModule body 为空白，但 claimed_total=${String(
        claimedTotal,
      )}, page=${expectedPage}；不解释成 0 帖`,
      diagnostics(claimedTotal, 0),
    );
  }
  const $ = loadFragment(body);
  const parsed = parsePostsFromDom($, threadId);
  if (parsed.errors.length > 0) {
    return failed(
      `帖子解析失败 ${parsed.errors.length}/${parsed.candidates}：${parsed.errors.slice(0, 3).join('；')}`,
      diagnostics(claimedTotal, parsed.posts.length),
    );
  }
  if (parsed.candidates === 0) {
    return failed(
      'ForumViewThreadPostsModule 非空 body 中没有 div.post；疑似 WAF/模板变形',
      diagnostics(claimedTotal, 0),
    );
  }
  const duplicateError = assertPostIds(parsed.posts);
  if (duplicateError !== null) return failed(duplicateError, diagnostics(claimedTotal, parsed.posts.length));
  try {
    return ok(
      { threadId, pager: parsePager($, expectedPage), posts: parsed.posts },
      diagnostics(claimedTotal, parsed.posts.length),
    );
  } catch (err) {
    return failed(`帖子 pager 解析失败：${String(err)}`, diagnostics(claimedTotal, parsed.posts.length));
  }
}

function parseThreadHeader($: CheerioAPI, threadId: number): ForumThreadRecord {
  const $box = $('.forum-thread-box').first();
  const $breadcrumbs = $box.find('.forum-breadcrumbs').first();
  const categoryId = positiveInt(
    /\/forum\/c-(\d+)/i.exec($breadcrumbs.find('a[href*="/forum/c-"]').last().attr('href') ?? '')?.[1],
  );
  const breadcrumbText = normalizeText($breadcrumbs.text());
  const title = breadcrumbText.split('»').at(-1)?.trim() ?? '';
  if (categoryId === null || title === '') throw new Error('thread breadcrumbs 缺 category id/title');

  const $description = $box.find('.description-block').first().clone();
  const $statistics = $description.find('.statistics').first();
  const statsText = normalizeText($statistics.text());
  const createdAt = isoFromOdate($statistics.find('span.odate').first(), `thread ${threadId} created_at`);
  const createdBy = parseForumAuthor($statistics.find('span.printuser').first());
  const postRaw = /文章数\s*:\s*([\d,]+)/.exec(statsText)?.[1];
  if (postRaw === undefined) throw new Error(`thread ${threadId} statistics 缺文章数：${statsText}`);
  $description.find('.statistics,.head').remove();
  return {
    id: threadId,
    categoryId,
    title,
    description: optionalText($description.text()),
    createdBy,
    createdAt,
    postCount: nonNegativeInt(postRaw, `thread ${threadId} post_count`),
    isDeleted: false,
  };
}

/** ForumViewThreadModule：元数据和第一页帖子一起解析。 */
export function parseForumThread(
  body: string,
  threadId: number,
): CollectResult<ForumThreadSnapshot> {
  const preflight = rejectBrokenBody(body, 'ForumViewThreadModule');
  if (preflight !== null) return failed(preflight);
  if (body.trim() === '') return failed('ForumViewThreadModule body 为空，不解释成空主题');
  const $ = loadFragment(body);
  if ($('.forum-thread-box').length !== 1) {
    return failed('ForumViewThreadModule 缺少唯一 .forum-thread-box');
  }
  try {
    const thread = parseThreadHeader($, threadId);
    const parsed = parsePostsFromDom($, threadId);
    if (parsed.errors.length > 0) {
      return failed(
        `主题内帖子解析失败 ${parsed.errors.length}/${parsed.candidates}：${parsed.errors
          .slice(0, 3)
          .join('；')}`,
        diagnostics(thread.postCount, parsed.posts.length),
      );
    }
    if (thread.postCount > 0 && parsed.posts.length === 0) {
      return failed(
        `thread 自报 post_count=${thread.postCount}，但第一页解析 0 帖`,
        diagnostics(thread.postCount, 0),
      );
    }
    const duplicateError = assertPostIds(parsed.posts);
    if (duplicateError !== null) {
      return failed(duplicateError, diagnostics(thread.postCount, parsed.posts.length));
    }
    const pager = parsePager($, 1);
    const snapshot: ForumThreadSnapshot = {
      thread,
      posts: parsed.posts,
      totalPages: pager.totalPages,
      pagesFetched: 1,
    };
    if (pager.totalPages === 1 && parsed.posts.length !== thread.postCount) {
      return partial(
        snapshot,
        `单页主题解析 ${parsed.posts.length} 帖 ≠ thread 自报 ${thread.postCount}`,
        diagnostics(thread.postCount, parsed.posts.length),
      );
    }
    return ok(snapshot, diagnostics(thread.postCount, parsed.posts.length));
  } catch (err) {
    return failed(`ForumViewThreadModule 结构解析失败：${String(err)}`);
  }
}

function parseCommentsThreadId(body: string): number | null {
  return (
    positiveInt(/\bWIKIDOT\.forumThreadId\s*=\s*(\d+)\s*;/i.exec(body)?.[1]) ??
    positiveInt(
      /\bWIKIDOT\.modules\.ForumViewThreadModule\.vars\.threadId\s*=\s*(\d+)/i.exec(body)?.[1],
    )
  );
}

/**
 * ForumCommentsListModule：页面讨论区的 thread id + 第一页。
 * 实站当前回显 `WIKIDOT.forumThreadId`；同时兼容库所期待的旧 vars.threadId 写法。
 */
export function parseForumComments(
  body: string,
  target: ForumDiscussionTarget,
): CollectResult<ForumCommentsPage> {
  const preflight = rejectBrokenBody(body, 'ForumCommentsListModule');
  if (preflight !== null) return failed(preflight);
  if (body.trim() === '') return failed('ForumCommentsListModule body 为空');
  const threadId = parseCommentsThreadId(body);
  if (threadId === null) {
    return failed('ForumCommentsListModule 没有回显 WIKIDOT.forumThreadId');
  }
  if (
    target.expectedThreadId !== undefined &&
    target.expectedThreadId !== null &&
    target.expectedThreadId !== threadId
  ) {
    return failed(
      `页面讨论 thread id 不一致：page_current=${target.expectedThreadId}, response=${threadId}`,
    );
  }
  const $ = loadFragment(body);
  if ($('#thread-container-posts').length !== 1) {
    return failed('ForumCommentsListModule 缺少唯一 #thread-container-posts 结构锚点');
  }
  const parsed = parsePostsFromDom($, threadId);
  if (parsed.errors.length > 0) {
    return failed(
      `页面评论解析失败 ${parsed.errors.length}/${parsed.candidates}：${parsed.errors
        .slice(0, 3)
        .join('；')}`,
      diagnostics(target.claimedTotal, parsed.posts.length),
    );
  }
  const duplicateError = assertPostIds(parsed.posts);
  if (duplicateError !== null) {
    return failed(duplicateError, diagnostics(target.claimedTotal, parsed.posts.length));
  }
  try {
    const pager = parsePager($, 1);
    if (parsed.posts.length === 0 && target.claimedTotal !== null && target.claimedTotal > 0) {
      return failed(
        `ForumCommentsListModule 第一页 0 帖，但 claimed_total=${target.claimedTotal}`,
        diagnostics(target.claimedTotal, 0),
      );
    }
    return ok(
      {
        pageId: target.pageId,
        wikidotId: target.wikidotId,
        threadId,
        pager,
        posts: parsed.posts,
      },
      diagnostics(target.claimedTotal, parsed.posts.length),
    );
  } catch (err) {
    return failed(`ForumCommentsListModule pager 解析失败：${String(err)}`);
  }
}

/** ForumStartModule 匿名抓取。 */
export async function scanForumStart(
  http: HttpClient,
  baseUrl: string,
): Promise<CollectResult<ForumStartSnapshot>> {
  try {
    const response = await amcRequest(http, baseUrl, {
      moduleName: 'forum/ForumStartModule',
      params: { hidden: 'true' },
      mode: 'forum:start',
      maxAttempts: 3,
    });
    if (response.status !== 'ok') {
      return failed(`ForumStartModule status=${response.status}（message=${response.message ?? '-'}）`);
    }
    if (response.body === null) return failed('ForumStartModule status=ok 但 body 缺失');
    return parseForumStart(response.body);
  } catch (err) {
    return failed(`ForumStartModule 请求失败：${String(err)}`);
  }
}

/** 指定 category 的指定页；不提供“自动遍历全部 category”入口。 */
export async function scanForumCategoryPage(
  http: HttpClient,
  baseUrl: string,
  categoryId: number,
  pageNo = 1,
): Promise<CollectResult<ForumCategoryPage>> {
  try {
    const response = await amcRequest(http, baseUrl, {
      moduleName: CATEGORY_MODULE,
      params: { c: categoryId, p: pageNo },
      mode: 'forum:category-page',
      maxAttempts: 3,
    });
    if (response.status !== 'ok') {
      return failed(`${CATEGORY_MODULE} status=${response.status}（message=${response.message ?? '-'}）`);
    }
    if (response.body === null) return failed(`${CATEGORY_MODULE} status=ok 但 body 缺失`);
    return parseForumCategoryPage(response.body, categoryId, pageNo);
  } catch (err) {
    return failed(`${CATEGORY_MODULE} 请求失败：${String(err)}`);
  }
}

async function scanOneForumCategory(
  http: HttpClient,
  baseUrl: string,
  categoryId: number,
  concurrency: number,
): Promise<CollectResult<ForumCategorySnapshot>> {
  const first = await scanForumCategoryPage(http, baseUrl, categoryId, 1);
  if (first.status !== 'ok') {
    return failed(first.error, first.diagnostics);
  }
  const category: ForumCategoryRecord = {
    id: categoryId,
    title: first.data.categoryTitle,
    description: first.data.categoryDescription,
    threadCount: first.data.claimedThreadCount,
    postCount: first.data.claimedPostCount,
  };
  const snapshot: ForumCategorySnapshot = {
    category,
    threads: [...first.data.threads],
    totalPages: first.data.pager.totalPages,
    pagesFetched: 1,
  };
  if (snapshot.totalPages === 1) {
    if (snapshot.threads.length !== category.threadCount) {
      return partial(
        snapshot,
        `分类完整页解析 ${snapshot.threads.length} 个 thread ≠ 自报 ${category.threadCount}`,
        diagnostics(category.threadCount, snapshot.threads.length),
      );
    }
    return ok(snapshot, diagnostics(category.threadCount, snapshot.threads.length));
  }

  const pages = await mapWithConcurrency(
    Array.from({ length: snapshot.totalPages - 1 }, (_unused, index) => index + 2),
    concurrency,
    (pageNo) => scanForumCategoryPage(http, baseUrl, categoryId, pageNo),
  );
  const errors: string[] = [];
  for (let index = 0; index < pages.length; index++) {
    const pageNo = index + 2;
    const page = pages[index]!;
    if (page.status !== 'ok') {
      errors.push(`page ${pageNo}: ${page.error}`);
      continue;
    }
    if (
      page.data.pager.totalPages !== snapshot.totalPages ||
      page.data.claimedThreadCount !== category.threadCount ||
      page.data.claimedPostCount !== category.postCount
    ) {
      errors.push(
        `page ${pageNo}: 分类计数/pager 漂移（pages=${page.data.pager.totalPages}, ` +
          `threads=${page.data.claimedThreadCount}, posts=${page.data.claimedPostCount}）`,
      );
      continue;
    }
    snapshot.pagesFetched++;
    snapshot.threads.push(...page.data.threads);
  }
  const duplicate = firstDuplicate(snapshot.threads.map((thread) => thread.id));
  if (duplicate !== null) errors.push(`跨页 thread id 重复：${duplicate}`);
  if (errors.length > 0) {
    return partial(
      snapshot,
      `分类分页不完整/不稳定 ${errors.length}/${snapshot.totalPages - 1}：${errors
        .slice(0, 3)
        .join('；')}`,
      diagnostics(category.threadCount, snapshot.threads.length, errors),
    );
  }
  if (snapshot.threads.length !== category.threadCount) {
    return partial(
      snapshot,
      `分类完整翻页解析 ${snapshot.threads.length} 个 thread ≠ 自报 ${category.threadCount}`,
      diagnostics(category.threadCount, snapshot.threads.length),
    );
  }
  return ok(snapshot, diagnostics(category.threadCount, snapshot.threads.length));
}

/**
 * 分类级 thread 枚举。thread sitemap 只做“发现新 id”，严禁拿全站反向差集判删除；
 * thread 存亡只能由本函数的单分类完整快照裁决。
 */
export async function scanForumCategories(
  http: HttpClient,
  baseUrl: string,
  categoryIds: readonly number[],
  concurrency = 4,
): Promise<Map<number, CollectResult<ForumCategorySnapshot>>> {
  assertUniqueKeys(categoryIds, (id) => id);
  const pairs = await mapWithConcurrency(categoryIds, 1, async (categoryId) => [
    categoryId,
    await scanOneForumCategory(http, baseUrl, categoryId, concurrency),
  ] as const);
  return new Map(pairs);
}

async function scanOneForumThread(
  http: HttpClient,
  baseUrl: string,
  threadId: number,
  concurrency: number,
): Promise<CollectResult<ForumThreadSnapshot>> {
  try {
    const response = await amcRequest(http, baseUrl, {
      moduleName: THREAD_MODULE,
      params: { t: threadId },
      mode: 'forum:thread',
      maxAttempts: 3,
    });
    if (response.status !== 'ok') {
      return failed(`${THREAD_MODULE} status=${response.status}（message=${response.message ?? '-'}）`);
    }
    if (response.body === null) return failed(`${THREAD_MODULE} status=ok 但 body 缺失`);
    const first = parseForumThread(response.body, threadId);
    if (first.status !== 'ok') return first;
    if (first.data.totalPages === 1) return first;

    const pageNumbers = Array.from(
      { length: first.data.totalPages - 1 },
      (_unused, index) => index + 2,
    );
    const pages = await mapWithConcurrency(pageNumbers, concurrency, async (pageNo) => {
      try {
        const pageResponse = await amcRequest(http, baseUrl, {
          moduleName: POSTS_MODULE,
          params: { t: threadId, pageNo },
          mode: 'forum:thread-posts',
          maxAttempts: 3,
        });
        if (pageResponse.status !== 'ok') {
          return failed<ForumPostsPage>(
            `${POSTS_MODULE} page=${pageNo} status=${pageResponse.status}（message=${
              pageResponse.message ?? '-'
            }）`,
          );
        }
        if (pageResponse.body === null) {
          return failed<ForumPostsPage>(`${POSTS_MODULE} page=${pageNo} status=ok 但 body 缺失`);
        }
        return parseForumPostsPage(
          pageResponse.body,
          threadId,
          pageNo,
          first.data.thread.postCount,
        );
      } catch (err) {
        return failed<ForumPostsPage>(`${POSTS_MODULE} page=${pageNo} 请求失败：${String(err)}`);
      }
    });

    const posts = [...first.data.posts];
    const pageErrors: string[] = [];
    for (let index = 0; index < pages.length; index++) {
      const pageNo = index + 2;
      const page = pages[index]!;
      if (page.status === 'ok') posts.push(...page.data.posts);
      else pageErrors.push(`page ${pageNo}: ${page.error}`);
    }
    const assembled: ForumThreadSnapshot = {
      thread: first.data.thread,
      posts,
      totalPages: first.data.totalPages,
      pagesFetched: first.data.totalPages - pageErrors.length,
    };
    if (pageErrors.length > 0) {
      return partial(
        assembled,
        `帖子分页不完整 ${pageErrors.length}/${first.data.totalPages - 1}：${pageErrors
          .slice(0, 3)
          .join('；')}`,
        diagnostics(first.data.thread.postCount, posts.length, pageErrors),
      );
    }
    const duplicateError = assertPostIds(posts);
    if (duplicateError !== null) {
      return failed(duplicateError, diagnostics(first.data.thread.postCount, posts.length));
    }
    if (posts.length !== first.data.thread.postCount) {
      return partial(
        assembled,
        `完整翻页解析 ${posts.length} 帖 ≠ thread 自报 ${first.data.thread.postCount}`,
        diagnostics(first.data.thread.postCount, posts.length),
      );
    }
    return ok(assembled, diagnostics(first.data.thread.postCount, posts.length));
  } catch (err) {
    return failed(`${THREAD_MODULE} 请求失败：${String(err)}`);
  }
}

/** thread sitemap 差集目标的批量抓取；每个 id 在 Map 中都有显式结果。 */
export async function scanForumThreads(
  http: HttpClient,
  baseUrl: string,
  threadIds: readonly number[],
  concurrency = 4,
): Promise<Map<number, CollectResult<ForumThreadSnapshot>>> {
  assertUniqueKeys(threadIds, (id) => id);
  const pairs = await mapWithConcurrency(threadIds, concurrency, async (threadId) => [
    threadId,
    await scanOneForumThread(http, baseUrl, threadId, concurrency),
  ] as const);
  return new Map(pairs);
}

/** 页面讨论区：CommentsList 发现 thread id，再用 ViewThread/Posts 做完整抓取。 */
export async function scanPageDiscussions(
  http: HttpClient,
  baseUrl: string,
  targets: readonly ForumDiscussionTarget[],
  concurrency = 4,
): Promise<Map<number, CollectResult<ForumDiscussionSnapshot>>> {
  assertUniqueKeys(targets, (target) => target.pageId);
  const pairs = await mapWithConcurrency(targets, concurrency, async (target) => {
    try {
      const response = await amcRequest(http, baseUrl, {
        moduleName: COMMENTS_MODULE,
        params: { pageId: target.wikidotId },
        mode: 'forum:comments',
        maxAttempts: 3,
      });
      if (response.status !== 'ok') {
        return [
          target.pageId,
          failed<ForumDiscussionSnapshot>(
            `${COMMENTS_MODULE} status=${response.status}（message=${response.message ?? '-'}）`,
          ),
        ] as const;
      }
      if (response.body === null) {
        return [target.pageId, failed<ForumDiscussionSnapshot>(`${COMMENTS_MODULE} body 缺失`)] as const;
      }
      const comments = parseForumComments(response.body, target);
      if (comments.status !== 'ok') {
        return [
          target.pageId,
          failed<ForumDiscussionSnapshot>(comments.error, comments.diagnostics),
        ] as const;
      }

      const thread = await scanOneForumThread(http, baseUrl, comments.data.threadId, concurrency);
      if (thread.status !== 'ok') {
        return [
          target.pageId,
          thread.status === 'partial'
            ? partial<ForumDiscussionSnapshot>(
                {
                  pageId: target.pageId,
                  wikidotId: target.wikidotId,
                  threadId: comments.data.threadId,
                  thread: thread.data.thread,
                  posts: thread.data.posts,
                  claimedTotal: target.claimedTotal,
                },
                thread.error,
                thread.diagnostics,
              )
            : failed<ForumDiscussionSnapshot>(thread.error, thread.diagnostics),
        ] as const;
      }

      const snapshot: ForumDiscussionSnapshot = {
        pageId: target.pageId,
        wikidotId: target.wikidotId,
        threadId: comments.data.threadId,
        thread: thread.data.thread,
        posts: thread.data.posts,
        claimedTotal: target.claimedTotal,
      };
      const firstPageIds = new Set(comments.data.posts.map((post) => post.id));
      const allIds = new Set(thread.data.posts.map((post) => post.id));
      const missingFirstPage = [...firstPageIds].filter((id) => !allIds.has(id));
      if (missingFirstPage.length > 0) {
        return [
          target.pageId,
          partial(
            snapshot,
            `CommentsList 第一页有 ${missingFirstPage.length} 个 post 未出现在完整 thread 抓取：${missingFirstPage
              .slice(0, 5)
              .join(',')}`,
            diagnostics(target.claimedTotal, thread.data.posts.length),
          ),
        ] as const;
      }
      if (target.claimedTotal !== null && thread.data.posts.length !== target.claimedTotal) {
        return [
          target.pageId,
          partial(
            snapshot,
            `完整 thread ${thread.data.posts.length} 帖 ≠ Tier1 claimed_total ${target.claimedTotal}`,
            diagnostics(target.claimedTotal, thread.data.posts.length),
          ),
        ] as const;
      }
      return [
        target.pageId,
        ok(snapshot, diagnostics(target.claimedTotal, thread.data.posts.length)),
      ] as const;
    } catch (err) {
      return [
        target.pageId,
        failed<ForumDiscussionSnapshot>(`页面讨论抓取失败：${String(err)}`),
      ] as const;
    }
  });
  return new Map(pairs);
}

function firstDuplicate(values: readonly number[]): number | null {
  const seen = new Set<number>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

function authorKey(author: ForumAuthor | null): string | null {
  return author !== null && author.wikidotId !== null && author.wikidotId > 0
    ? `wid:${author.wikidotId}`
    : null;
}

async function ensureForumAuthors(
  db: PoolClient,
  batch: ForumBatch,
): Promise<Map<string, number>> {
  const authors = new Map<string, ForumAuthor>();
  for (const thread of batch.threads) {
    const key = authorKey(thread.createdBy);
    if (key !== null && thread.createdBy !== null) authors.set(key, thread.createdBy);
  }
  for (const post of batch.posts) {
    const key = authorKey(post.author);
    if (key !== null && post.author !== null) authors.set(key, post.author);
  }

  const ids = new Map<string, number>();
  for (const [key, author] of authors) {
    const result = await query<{ user_id: number }>(
      db,
      'forum:ensure_user',
      `SELECT ingest.ensure_user(
         p_kind         => 'wikidot',
         p_wikidot_id   => $1,
         p_display_name => $2,
         p_unix_name    => $3
       ) AS user_id`,
      [
        author.wikidotId,
        // 已注销占位文本不得覆盖同一 wid 已知的真实姓名。
        author.kind === 'deleted' ? null : author.displayName,
        author.kind === 'deleted' ? null : author.unixName,
      ],
    );
    const id = result.rows[0]?.user_id;
    if (id === undefined) throw new Error(`ensure_user 未返回 id（${key}）`);
    ids.set(key, Number(id));
  }
  return ids;
}

function authorPayload(
  author: ForumAuthor | null,
  ids: ReadonlyMap<string, number>,
): { userId: number | null; name: string | null } {
  if (author === null) return { userId: null, name: null };
  const key = authorKey(author);
  if (key !== null) {
    const userId = ids.get(key);
    if (userId === undefined) throw new Error(`作者 ${key} 未完成 ensure_user`);
    return { userId, name: null };
  }
  return { userId: null, name: author.displayName || null };
}

async function applyForumBatchInTransaction(
  db: PoolClient,
  batch: ForumBatch,
  observedAt: string,
  runId: number | null,
  completeThreadIds: readonly number[] = [],
): Promise<Record<string, unknown>> {
  const stored = sanitizePgValue(batch, { context: 'forum.batch' });
  const safeBatch = stored.value;
  const ids = await ensureForumAuthors(db, safeBatch);
  const categories = safeBatch.categories.map((category) => ({
    id: category.id,
    title: category.title,
    description: category.description,
    thread_count: category.threadCount,
    post_count: category.postCount,
  }));
  const threads = safeBatch.threads.map((thread) => {
    const author = authorPayload(thread.createdBy, ids);
    return {
      id: thread.id,
      category_id: thread.categoryId,
      title: thread.title,
      description: thread.description,
      created_by_user_id: author.userId,
      created_by_name: author.name,
      created_at: thread.createdAt,
      post_count: thread.postCount,
      is_deleted: thread.isDeleted,
    };
  });
  const posts: Array<Record<string, unknown>> = safeBatch.posts.map((post) => {
    const author = authorPayload(post.author, ids);
    return {
      id: post.id,
      thread_id: post.threadId,
      parent_post_id: post.parentPostId,
      author_user_id: author.userId,
      author_name: author.name,
      created_by_type: post.author?.kind === 'wikidot' ? 'user' : post.author?.kind ?? null,
      title: post.title,
      text_html: post.textHtml,
      text_plain: post.textPlain,
      created_at: post.createdAt,
      edited_at: post.editedAt,
      is_deleted: post.isDeleted,
    };
  });
  let softDeleted = 0;
  if (completeThreadIds.length > 0) {
    const duplicateThread = firstDuplicate(completeThreadIds);
    if (duplicateThread !== null) {
      throw new Error(`completeThreadIds 重复：${duplicateThread}`);
    }
    const batchThreadIds = new Set(safeBatch.threads.map((thread) => thread.id));
    const unbacked = completeThreadIds.find((threadId) => !batchThreadIds.has(threadId));
    if (unbacked !== undefined) {
      throw new Error(`completeThreadIds 含不在本批 threads 中的 id：${unbacked}`);
    }
    const complete = new Set(completeThreadIds);
    const remotePostIds = safeBatch.posts
      .filter((post) => complete.has(post.threadId))
      .map((post) => post.id);
    const missing = await query<{ id: string; thread_id: string }>(
      db,
      'forum:find_missing_posts_after_complete_scan',
      `SELECT id::text, thread_id::text
         FROM ingest.forum_post
        WHERE thread_id = ANY($1::bigint[])
          AND NOT is_deleted
          AND id <> ALL($2::bigint[])
        ORDER BY thread_id, id`,
      [completeThreadIds.map(String), remotePostIds.map(String)],
    );
    for (const row of missing.rows) {
      posts.push({
        id: Number(row.id),
        thread_id: Number(row.thread_id),
        is_deleted: true,
      });
    }
    softDeleted = missing.rows.length;
  }
  const result = await query<{ result: Record<string, unknown> }>(
    db,
    'forum:apply_forum_batch',
    `SELECT ingest.apply_forum_batch(
       p_categories => $1::jsonb,
       p_threads    => $2::jsonb,
       p_posts      => $3::jsonb,
       p_observed   => $4::timestamptz,
       p_source     => 'wikidot',
       p_run        => $5
     ) AS result`,
    [
      toPgJson(categories, 'forum.categories'),
      toPgJson(threads, 'forum.threads'),
      toPgJson(posts, 'forum.posts'),
      toPgTimestamptz(observedAt),
      runId,
    ],
  );
  return {
    ...(result.rows[0]?.result ?? {}),
    soft_deleted: softDeleted,
    ...(stored.sanitation.stringsChanged > 0
      ? { text_sanitization: stored.sanitation }
      : {}),
  };
}

/** 论坛当前态唯一写入口：ensure_user + apply_forum_batch，同事务完成。 */
export async function applyForumBatch(
  pool: Pool,
  batch: ForumBatch,
  observedAt: string,
  runId: number | null,
  options: ApplyForumBatchOptions = {},
): Promise<Record<string, unknown>> {
  return withTransaction(pool, 'forum:apply', (db) =>
    applyForumBatchInTransaction(
      db,
      batch,
      observedAt,
      runId,
      options.completeThreadIds ?? [],
    ),
  );
}

/**
 * 应用一个完整的分类级枚举。
 *
 * 2026-07-27 对账：thread sitemap 86,900 id，而库内有 90,209 个活 thread，反向差集
 * 3,309 条全部可解释——翻译预定区 1,672（该分类 100% 缺席）、垃圾桶 674（100% 缺席）、
 * 单页讨论 950；前两个隐藏/归档分类还连着 13,122 帖。因此 sitemap 全站差集永远不在
 * 本函数出现。只有调用方同时证明“分类在 category sitemap 中”与“分类分页完整”，才把
 * 本分类的集合差写成 thread tombstone；否则只保存正面观测并返回 partial coverage。
 */
export async function applyForumCategorySnapshot(
  pool: Pool,
  snapshot: ForumCategorySnapshot,
  observedAt: string,
  runId: number | null,
  options: ApplyForumCategorySnapshotOptions,
): Promise<Record<string, unknown>> {
  return withTransaction(pool, `forum:category:${snapshot.category.id}`, async (db) => {
    const aggregate: Record<string, number | string | boolean | null> = {
      categories: 0,
      threads: 0,
      threads_linked: 0,
      posts: 0,
      quarantined: 0,
      soft_deleted: 0,
      soft_deleted_threads: 0,
      absence_status: options.allowThreadDeletion ? 'ok' : 'partial',
      absence_warning: options.allowThreadDeletion
        ? null
        : `category ${snapshot.category.id} 在 category sitemap 整体缺席；不从缺席推断 thread 删除`,
    };
    const parts = chunk(snapshot.threads, 500);
    if (parts.length === 0) parts.push([]);
    for (let index = 0; index < parts.length; index++) {
      const result = await applyForumBatchInTransaction(
        db,
        {
          categories: index === 0 ? [snapshot.category] : [],
          threads: parts[index]!,
          posts: [],
        },
        observedAt,
        runId,
      );
      for (const key of ['categories', 'threads', 'threads_linked', 'posts', 'quarantined']) {
        aggregate[key] = Number(aggregate[key] ?? 0) + Number(result[key] ?? 0);
      }
    }

    if (options.allowThreadDeletion) {
      const remoteIds = snapshot.threads.map((thread) => String(thread.id));
      const deleted = await query<{ id: string }>(
        db,
        'forum:soft_delete_threads_after_complete_category_scan',
        `UPDATE ingest.forum_thread
            SET is_deleted = true,
                last_synced_at = $3::timestamptz
          WHERE category_id = $1
            AND NOT is_deleted
            AND id <> ALL($2::bigint[])
          RETURNING id::text`,
        [snapshot.category.id, remoteIds, toPgTimestamptz(observedAt)],
      );
      aggregate['soft_deleted_threads'] = deleted.rows.length;
    }
    return aggregate;
  });
}

/** 归一化结果哈希，供队列 stable_count 使用；不把 HTML 属性顺序以外的本地状态混进来。 */
export function forumBatchResultHash(batch: ForumBatch): Buffer {
  return createHash('sha256')
    .update(JSON.stringify(batch), 'utf8')
    .digest();
}

export interface ApplyDiscussionResult {
  pageMeta: Record<string, unknown>;
  forum: Record<string, unknown>;
  resultHash: Buffer;
}

/**
 * 页面讨论区的写入顺序是硬约束：
 *   1. 独立事务写 page_scan(kind=discussion)；
 *   2. 同一事实事务先 apply_page_meta(discussion_thread_id)；
 *   3. 再 apply_forum_batch，让其通过 page_current.discussion_thread_id 反解 page_id。
 *
 * 全程没有 title-as-slug 分支。
 */
export async function applyForumDiscussion(
  pool: Pool,
  target: ForumDiscussionTarget,
  result: CollectResult<ForumDiscussionSnapshot>,
  categories: readonly ForumCategoryRecord[],
  observedAt: string,
  runId: number | null,
): Promise<ApplyDiscussionResult | null> {
  const scanKind = target.scanKind ?? 'discussion';
  const stored =
    result.status === 'failed'
      ? null
      : sanitizePgValue(result.data, {
          context: `forum.discussion:${target.pageId}`,
        });
  const sanitationMarker =
    stored !== null && stored.sanitation.stringsChanged > 0
      ? `forum_text_sanitized strings=${stored.sanitation.stringsChanged}` +
        ` nul=${stored.sanitation.nulCodeUnits}` +
        ` lone_surrogate=${stored.sanitation.loneSurrogates}`
      : null;
  const hash =
    result.status === 'failed'
      ? null
      : forumBatchResultHash({
          categories: [],
          threads: [stored!.value.thread],
          posts: stored!.value.posts,
        });
  await recordPageScan(
    pool,
    {
      runId,
      pageId: target.pageId,
      kind: scanKind,
      status: result.status,
      claimedTotal: target.claimedTotal,
      fetchedTotal: result.diagnostics.fetchedTotal,
      resultHash: hash,
      error: [
        result.status === 'ok' ? null : result.error,
        sanitationMarker,
      ].filter((value): value is string => value !== null).join('\n') || null,
    },
  );
  if (result.status !== 'ok') return null;

  const applied = await withTransaction(pool, `forum:discussion:${target.pageId}`, async (db) => {
    const pageMetaResult = await query<{ result: Record<string, unknown> }>(
      db,
      'forum:apply_page_meta_discussion_thread',
      `SELECT ingest.apply_page_meta(
         p_page       => $1,
         p_attrs      => $2::jsonb,
         p_observed   => $3::timestamptz,
         p_source     => 'wikidot',
         p_run        => $4,
         p_wikidot_id => $5
       ) AS result`,
      [
        target.pageId,
        toPgJson({
          discussion_thread_id: stored!.value.threadId,
          comment_count: stored!.value.posts.length,
        }, `forum.discussion_page_meta:${target.pageId}`),
        toPgTimestamptz(observedAt),
        runId,
        target.wikidotId,
      ],
    );
    // v1 回填结转了 33,633 条 title-as-slug 猜测（标 inferred），保留它们是为了避免
    // 回填窗口内最多 32,872 页讨论区和 PAGE_REPLY 同时断流。但 CommentsList 已经给出
    // 当前页的权威 thread id 后，旧猜测必须让位；verified/来源未知的既有值绝不在这里清。
    await query(
      db,
      'forum:clear_superseded_inferred_page_link',
      `UPDATE ingest.forum_thread
          SET page_id = NULL,
              page_id_source = NULL
        WHERE page_id = $1
          AND page_id_source = 'inferred'
          AND id <> $2`,
      [target.pageId, stored!.value.threadId],
    );
    const forum = await applyForumBatchInTransaction(
      db,
      {
        categories: [...categories],
        threads: [stored!.value.thread],
        posts: stored!.value.posts,
      },
      observedAt,
      runId,
      [stored!.value.threadId],
    );
    return {
      pageMeta: pageMetaResult.rows[0]?.result ?? {},
      forum,
      resultHash: hash!,
    };
  });
  if (scanKind === 'forum') {
    // apply_forum_batch 因没有完整性入参，会保守地把同一行覆盖成 partial。
    // 本入口已经完整翻页并核过 claimed_total，事务成功后恢复为真正的 ok 证据。
    await recordPageScan(
      pool,
      {
        runId,
        pageId: target.pageId,
        kind: 'forum',
        status: 'ok',
        claimedTotal: target.claimedTotal,
        fetchedTotal: result.diagnostics.fetchedTotal,
        resultHash: hash,
        error: sanitationMarker,
      },
    );
  }
  return applied;
}
