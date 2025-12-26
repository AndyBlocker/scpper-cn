import { Prisma } from '@prisma/client';
import { prisma, disconnectPrisma } from '../src/utils/db-connection.ts';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ============ 导出类型定义 ============
export type TagLeader = {
  tag: string;
  period: string;
  userId: number;
  displayName: string | null;
  value: number;
  metric: string;
  pageId?: number | null;
};

const YEAR = 2025;

const BASE_TAGS = new Set([
  '原创',
  '作者',
  '段落',
  '补充材料',
  '页面',
  '重定向',
  '管理',
  '_cc',
  '指导'
]);
const BASE_TAGS_WITHOUT_ORIGINAL = Array.from(BASE_TAGS).filter((t) => t !== '原创');
const ORIGINAL_CATEGORY_TAGS = ['scp', 'goi格式', '故事', 'wanderers', '艺术作品', '文章'] as const;
const TRANSLATION_LANG_TAGS = [
  'en', 'int', 'ru', 'ko', 'fr', 'pl', 'es', 'th', 'jp', 'de', 'it', 'ua', 'pt', 'cs', 'vn', 'cy', 'el', 'eo', 'et', 'he', 'hu', 'id', 'la',
  'nd-da', 'nd-fo', 'nd-no', 'nd-sv', 'nl', 'ro', 'sl', 'tr'
] as const;
const CONTENT_TYPE_TAGS = ['scp', 'goi格式', 'wanderers', '故事', '文章'] as const;
const OBJECT_CLASS_TAGS = [
  'safe',
  'euclid',
  'keter',
  'thaumiel',
  'apollyon',
  'archon',
  'ticonderoga',
  '无效化',
  '被废除',
  '等待分级'
] as const;
const ORIGINAL_CATEGORY_TAG_SET = new Set<string>(ORIGINAL_CATEGORY_TAGS as readonly string[]);
const TRANSLATION_LANG_TAG_SET = new Set<string>(TRANSLATION_LANG_TAGS as readonly string[]);
const CONTENT_TYPE_TAG_SET = new Set<string>(CONTENT_TYPE_TAGS as readonly string[]);
const OBJECT_CLASS_TAG_SET = new Set<string>(OBJECT_CLASS_TAGS as readonly string[]);
const AUTHOR_TYPES = ['AUTHOR', 'SUBMITTER'];
const OUTPUT_PATH = path.join(process.cwd(), 'cache', `user-firsts-${YEAR}.json`);

// ============ 并发配置 ============
// 由于 max_connections=400，我们可以大幅提升并发度
// 默认模式: 50 并发（适合日常使用）
// Turbo 模式: 100 并发（激进优化，需要足够的连接池）
const TURBO_MODE = process.argv.includes('--turbo');
const DEFAULT_CONCURRENCY = 50;  // 从 6 提升到 50
const TURBO_CONCURRENCY = 100;   // turbo 模式使用 100
const QUERY_CONCURRENCY = Math.max(1, Math.floor(Number(
  process.env.USER_FIRSTS_CONCURRENCY || (TURBO_MODE ? TURBO_CONCURRENCY : DEFAULT_CONCURRENCY)
)));

const REVISION_PUBLISHED_JOIN = `LEFT JOIN LATERAL (
        SELECT
          MIN(timestamp) FILTER (WHERE type = 'PAGE_CREATED') AS created_ts,
          MIN(timestamp) AS any_ts
        FROM "Revision" r
        WHERE r."pageVersionId" = pv.id
      ) rev_time ON TRUE`;
const PUBLISHED_AT_EXPR = 'COALESCE(rev_time.created_ts, rev_time.any_ts, p."firstPublishedAt", pv."createdAt")';
const REVISION_PUBLISHED_JOIN_SQL = Prisma.raw(REVISION_PUBLISHED_JOIN);
const PUBLISHED_AT_SQL = Prisma.raw(PUBLISHED_AT_EXPR);

// ============ 预计算优化 ============
// 创建临时表存储基础数据，避免每个查询重复计算 published_at 和 Attribution JOIN
let TEMP_TABLE_CREATED = false;

async function createBaseTempTable(year: number): Promise<void> {
  if (TEMP_TABLE_CREATED) return;

  const startTime = Date.now();
  console.log('  [Precompute] Creating temp table for base page data...');

  const { startTzIso, endTzIso } = yearRange(year);

  // 创建包含所有必要字段的临时表
  await prisma.$executeRaw`
    CREATE TEMP TABLE IF NOT EXISTS year_pages AS
    SELECT
      pv.id AS pv_id,
      pv."pageId",
      p."wikidotId",
      pv.title,
      pv.tags,
      pv.rating,
      LENGTH(COALESCE(pv.source, '')) AS word_count,
      COALESCE(
        (SELECT MIN(timestamp) FILTER (WHERE type = 'PAGE_CREATED') FROM "Revision" r WHERE r."pageVersionId" = pv.id),
        (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id),
        p."firstPublishedAt",
        pv."createdAt"
      ) AS published_at,
      a."userId",
      u."displayName"
    FROM "PageVersion" pv
    JOIN "Page" p ON p.id = pv."pageId"
    JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
    LEFT JOIN "User" u ON u.id = a."userId"
    WHERE pv."validTo" IS NULL
      AND NOT pv."isDeleted"
      AND COALESCE(
        (SELECT MIN(timestamp) FILTER (WHERE type = 'PAGE_CREATED') FROM "Revision" r WHERE r."pageVersionId" = pv.id),
        (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id),
        p."firstPublishedAt",
        pv."createdAt"
      ) >= ${startTzIso}::timestamptz
      AND COALESCE(
        (SELECT MIN(timestamp) FILTER (WHERE type = 'PAGE_CREATED') FROM "Revision" r WHERE r."pageVersionId" = pv.id),
        (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id),
        p."firstPublishedAt",
        pv."createdAt"
      ) < ${endTzIso}::timestamptz
  `;

  // 创建索引加速查询
  await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS idx_year_pages_userid ON year_pages("userId")`;
  await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS idx_year_pages_published ON year_pages(published_at)`;
  await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS idx_year_pages_tags ON year_pages USING GIN(tags)`;

  // 统计行数
  const countResult = await prisma.$queryRaw<[{ count: bigint }]>`SELECT COUNT(*) as count FROM year_pages`;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`  [Precompute] Temp table created with ${countResult[0].count} rows in ${elapsed}s`);

  TEMP_TABLE_CREATED = true;
}

// 创建投票临时表
async function createVoteTempTable(year: number): Promise<void> {
  const startTime = Date.now();
  console.log('  [Precompute] Creating temp table for vote data...');

  const { startTzIso, endTzIso } = yearRange(year);

  await prisma.$executeRaw`
    CREATE TEMP TABLE IF NOT EXISTS year_votes AS
    SELECT
      v.id AS vote_id,
      v."userId" AS voter_id,
      v.direction,
      v.timestamp,
      v."pageVersionId" AS pv_id,
      pv.tags,
      pv."pageId"
    FROM "Vote" v
    JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
    WHERE v."userId" IS NOT NULL
      AND v.direction != 0
      AND v.timestamp >= ${startTzIso}::timestamptz
      AND v.timestamp < ${endTzIso}::timestamptz
      AND pv."validTo" IS NULL
      AND NOT pv."isDeleted"
  `;

  await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS idx_year_votes_voter ON year_votes(voter_id)`;
  await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS idx_year_votes_ts ON year_votes(timestamp)`;
  await prisma.$executeRaw`CREATE INDEX IF NOT EXISTS idx_year_votes_tags ON year_votes USING GIN(tags)`;

  const countResult = await prisma.$queryRaw<[{ count: bigint }]>`SELECT COUNT(*) as count FROM year_votes`;
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log(`  [Precompute] Vote temp table created with ${countResult[0].count} rows in ${elapsed}s`);
}

async function dropTempTables(): Promise<void> {
  try {
    await prisma.$executeRaw`DROP TABLE IF EXISTS year_pages`;
    await prisma.$executeRaw`DROP TABLE IF EXISTS year_votes`;
    TEMP_TABLE_CREATED = false;
  } catch {
    // 忽略错误
  }
}

const LEVEL_WEIGHT: Record<'year' | 'month' | 'week' | 'day', number> = {
  year: 4,
  month: 3,
  week: 2,
  day: 1
};

async function runInBatches<T>(
  tasks: Array<() => Promise<T>>,
  batchSize: number,
  label?: string
): Promise<T[]> {
  const results: T[] = [];
  const size = Math.max(1, Math.floor(batchSize));
  const totalBatches = Math.ceil(tasks.length / size);
  const startTime = Date.now();

  for (let i = 0; i < tasks.length; i += size) {
    const batchNum = Math.floor(i / size) + 1;
    const batch = tasks.slice(i, i + size).map(task => task());
    const batchStart = Date.now();
    const batchResults = await Promise.all(batch);
    results.push(...batchResults);

    // 进度报告
    if (label && totalBatches > 1) {
      const elapsed = ((Date.now() - batchStart) / 1000).toFixed(2);
      process.stdout.write(`\r  [${label}] Batch ${batchNum}/${totalBatches} (${batch.length} queries, ${elapsed}s)`);
    }
  }

  if (label && totalBatches > 1) {
    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\r  [${label}] Completed ${tasks.length} queries in ${totalElapsed}s                    `);
  }

  return results;
}

// 激进模式：所有独立查询同时运行（需要足够大的连接池）
async function runAllParallel<T>(
  tasks: Array<() => Promise<T>>,
  label?: string
): Promise<T[]> {
  const startTime = Date.now();
  if (label) {
    console.log(`  [${label}] Starting ${tasks.length} queries in parallel...`);
  }

  const results = await Promise.all(tasks.map(task => task()));

  if (label) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`  [${label}] Completed ${tasks.length} queries in ${elapsed}s`);
  }

  return results;
}

function yearRange(year: number) {
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-26`;
  const startTz = `${year}-01-01T00:00:00+08:00`;
  const endTz = `${year}-12-25T23:59:59+08:00`;
  return {
    startDate,
    endDate,
    startTzIso: new Date(startTz).toISOString(),
    endTzIso: new Date(endTz).toISOString()
  };
}

function applyPageTitle(text: string, title: string): string {
  const broadMatch = text.match(/你发布的[^，。]*页面/);
  if (broadMatch) {
    return text.replace(broadMatch[0], `你的《${title}》`);
  }
  const candidates = [
    '你的作品',
    '你的某篇页面',
    '你的页面',
    '你的某篇',
    '你发布的页面'
  ];
  for (const key of candidates) {
    if (text.includes(key)) {
      return text.replace(key, key === '你发布的页面' ? `你发布的《${title}》` : `你的《${title}》`);
    }
  }
  return `你的《${title}》：${text}`;
}

function buildComboNoun(tag: string | null): string {
  if (!tag) return '相关页面';
  const parts = tag.split('|');
  const origin = parts.shift();
  let lang: string | null = null;
  let content: string | null = null;
  let objClass: string | null = null;
  const extras: string[] = [];
  for (const p of parts) {
    if (TRANSLATION_LANG_TAG_SET.has(p as any)) lang = p;
    else if (CONTENT_TYPE_TAG_SET.has(p as any)) content = p;
    else if (OBJECT_CLASS_TAG_SET.has(p as any)) objClass = p;
    else extras.push(p);
  }
  const segments: string[] = [];
  if (origin) segments.push(origin);
  if (lang) segments.push(`${lang}分部`);
  if (content) segments.push(content);
  if (objClass) segments.push(`${objClass}等级`);
  segments.push(...extras);
  const phrase = segments.join('的');
  return `${phrase}${phrase ? '的' : ''}页面`;
}

const MIN_PAGES_FOR_AUTHOR_COUNT_MONTH = 1;
const MIN_RECEIVED_VOTES = 0;
export const METRIC_TEMPLATES: Record<
  string,
  { template: string; footnote?: string }
> = {
  // ===== 作者评分相关 =====
  // 按标签 + 年 / 月：某标签下，评分最高的一篇作品
  author_top_rating: {
    template: '在{{periodText}}发布的包含{{tagLabel}}标签的页面中，你的作品评分第一名'
  },
  // 每日全站评分最高的一篇
  author_top_rating_day: {
    template: '在{{periodText}}发布的所有新页面中，你的作品评分第一名'
  },
  // 每周：既有全站，也有按标签（tagLabel 为空时自然退化为“页面”）
  author_top_rating_week: {
    template: '在{{periodText}}发布的包含{{tagLabel}}标签的页面中，你的作品评分第一名'
  },

  // ===== 标签投票（年 / 月 汇总）=====（你投出的票）
  voter_most_votes: {
    template: '在{{periodText}}，你对包含{{tagLabel}}标签的页面投票最多',
    footnote: '统计该时段你对带有{{tagLabel}}标签页面的所有有效投票。'
  },

  // ===== 标签投票（日）=====（你投出的票）
  voter_tag_day_total: {
    template: '在{{periodText}}，你对包含{{tagLabel}}标签的页面投票最多',
    footnote: '统计当天你对带有{{tagLabel}}标签页面的所有有效投票。'
  },
  voter_tag_day_up: {
    template: '在{{periodText}}，你对包含{{tagLabel}}标签的页面投出好评最多',
    footnote: '统计当天你对带有{{tagLabel}}标签页面投出的所有好评票。'
  },
  voter_tag_day_down: {
    template: '在{{periodText}}，你对包含{{tagLabel}}标签的页面投出差评最多',
    footnote: '统计当天你对带有{{tagLabel}}标签页面投出的所有差评票。'
  },

  // ===== 全站投票（日）=====（你投出的票）
  voter_daily_total: {
    template: '在{{periodText}}，你是全站投票最多的读者',
    footnote: '统计当天你在全站投出的所有有效投票。'
  },
  voter_daily_up: {
    template: '在{{periodText}}，你是全站投出好评最多的读者'
  },
  voter_daily_down: {
    template: '在{{periodText}}，你是全站投出差评最多的读者'
  },

  // ===== 全站投票（周）=====（你投出的票）
  voter_weekly_total: {
    template: '在{{periodText}}，你是全站投票最多的读者',
    footnote: '统计当周你在全站投出的所有有效投票。'
  },
  voter_weekly_up: {
    template: '在{{periodText}}，你是全站投出好评最多的读者'
  },
  voter_weekly_down: {
    template: '在{{periodText}}，你是全站投出差评最多的读者'
  },

  // ===== 发文数量 / 长度 / 插图 / 评论 =====（你的页面表现）
  author_pages_count: {
    template: '在{{periodText}}，你发布的新页面数量全站第一'
  },
  author_page_length: {
    template: '在{{periodText}}发布的新页面中，你的某篇页面是字数最多的一篇',
    footnote: '字数按当前版本源代码字符数统计。'
  },
  author_page_shortest: {
    template: '在{{periodText}}发布的新页面中，你的某篇页面是字数最少的一篇',
    footnote: '字数按当前版本源代码字符数统计。'
  },
  author_images_count: {
    template: '在{{periodText}}，你在页面中插入的图片数量全站最多'
  },
  author_page_comments_max: {
    template: '在{{periodText}}发布的新页面中，你的某篇页面获得的评论最多'
  },

  // ===== 共著相关 =====
  coauthor_pages: {
    template: '在{{periodText}}，你参与合著的页面数量全站第一'
  },
  coauthor_partners: {
    template: '在{{periodText}}，与你合作写作的作者人数全站最多'
  },

  // ===== 原创 / 译文：篇数 =====（你的作品数量）
  author_creation_count: {
    template: '在{{periodText}}，你发布的包含{{tagLabel}}标签的原创篇数全站第一'
  },
  author_translation_count: {
    template: '在{{periodText}}，你翻译的包含{{tagLabel}}标签的页面数量全站第一'
  },

  // ===== 原创 / 译文：字数 =====（你的作品总字数）
  author_creation_words: {
    template: '在{{periodText}}，你发布的包含{{tagLabel}}标签的原创中的总字数全站第一',
    footnote: '字数按源代码字符数统计。'
  },
  author_original_category_rating_year: {
    template: '在{{periodText}}，你在包含{{tagLabel}}标签的原创作品的总评分全站第一',
    footnote: '统计当年所有带有{{tagLabel}}标签且标记为原创的页面评分总和。'
  },
  author_original_category_rating_month: {
    template: '在{{periodText}}，你在包含{{tagLabel}}标签的原创作品的总评分全站第一',
    footnote: '统计当月所有带有{{tagLabel}}标签且标记为原创的页面评分总和。'
  },
  author_translation_words: {
    template: '在{{periodText}}，你翻译的包含{{tagLabel}}标签的页面总字数全站第一',
    footnote: '字数按源代码字符数统计。'
  },
  translator_lang_count_year: {
    template: '在{{periodText}}，你翻译的{{tagName}}分部的页面数量全站第一'
  },
  translator_lang_count_month: {
    template: '在{{periodText}}，你翻译的{{tagName}}分部的页面数量全站第一'
  },
  translator_lang_words_year: {
    template: '在{{periodText}}，你翻译的{{tagName}}分部的页面总字数全站第一',
    footnote: '字数按源代码字符数统计。'
  },
  translator_lang_words_month: {
    template: '在{{periodText}}，你翻译的{{tagName}}分部的页面总字数全站第一',
    footnote: '字数按源代码字符数统计。'
  },
  combo_rating_best_year: {
    template: '在{{periodText}}，你发布的{{tagName}}页面中评分最高'
  },
  combo_rating_best_month: {
    template: '在{{periodText}}，你发布的{{tagName}}页面中评分最高'
  },
  combo_pages_count_year: {
    template: '在{{periodText}}，你发布的{{tagName}}页面数量全站第一'
  },
  combo_pages_count_month: {
    template: '在{{periodText}}，你发布的{{tagName}}页面数量全站第一'
  },
  combo_words_sum_year: {
    template: '在{{periodText}}，你发布的{{tagName}}页面总字数全站第一',
    footnote: '字数按源代码字符数统计。'
  },
  combo_words_sum_month: {
    template: '在{{periodText}}，你发布的{{tagName}}页面总字数全站第一',
    footnote: '字数按源代码字符数统计。'
  },
  combo_shortest_year: {
    template: '在{{periodText}}发布的{{tagName}}页面中，你的某篇是字数最少的一篇',
    footnote: '字数按当前版本源代码字符数统计。'
  },
  combo_shortest_month: {
    template: '在{{periodText}}发布的{{tagName}}页面中，你的某篇是字数最少的一篇',
    footnote: '字数按当前版本源代码字符数统计。'
  },

  // ===== 作品获得的票（年 / 月 / 周，按作者归属）=====
  // 注意：这里是“你的作品被投的票”，和上面的“你投出的票”区分开
  author_received_total_year: {
    template: '在{{periodText}}，你获得的总票数全站第一'
  },
  author_received_up_year: {
    template: '在{{periodText}}，你获得的好评数全站第一'
  },
  author_received_down_year: {
    template: '在{{periodText}}，你获得的差评数全站第一'
  },
  author_received_net_year: {
    template: '在{{periodText}}，你获得的净得分全站最高',
    footnote: '净票 = 好评 − 差评。'
  },

  author_received_total_month: {
    template: '在{{periodText}}，你获得的总票数全站第一'
  },
  author_received_up_month: {
    template: '在{{periodText}}，你获得的好评数全站第一'
  },
  author_received_down_month: {
    template: '在{{periodText}}，你获得的差评数全站第一'
  },
  author_received_net_month: {
    template: '在{{periodText}}，你获得的净得分全站最高',
    footnote: '净票 = 好评 − 差评。'
  },

  author_received_total_week: {
    template: '在{{periodText}}，你获得的总票数全站第一'
  },
  author_received_up_week: {
    template: '在{{periodText}}，你获得的好评数全站第一'
  },
  author_received_down_week: {
    template: '在{{periodText}}，你获得的差评数全站第一'
  },
  author_received_net_week: {
    template: '在{{periodText}}，你获得的净得分全站最高',
    footnote: '净票 = 好评 − 差评。'
  }
};


function fillTemplate(tpl: string, replacements: Record<string, string | number | null | undefined>) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = replacements[key];
    return v === null || v === undefined ? '' : String(v);
  });
}

function renderLeaderView(
  l: TagLeader,
  pageMetaMap?: Map<number, { wikidotId?: number; title?: string }>
): {
  text: string;
  footnote?: string;
  metric: string;
  tag: string;
  period: string;
  periodText: string;
  value: number;
  pageId: number | null | undefined;
  userId: number;
  displayName: string | null;
  pageMeta?: { pageId: number; wikidotId?: number; title?: string };
} {
  const tpl = METRIC_TEMPLATES[l.metric];
  const meta = l.pageId ? pageMetaMap?.get(l.pageId) : undefined;
  const wikidotId = meta?.wikidotId;
  const pageTitle = meta?.title;
  const periodText = formatPeriodText(l);
  const tagLabel =
    !l.tag || l.tag === 'all_pages' || l.tag === 'all_tags'
      ? ''
      : `“${l.tag}”`;

  const replacements = {
    period: l.period,
    periodText,
    tag: l.tag,      // 原始 tag 值
    tagLabel,        // 适合直接展示的标签文本（自动带引号 / 为空）
    tagName: l.tag ?? '',
    value: l.value,
    pageId: l.pageId ?? ''
  };

  const isOriginalCategoryMetric =
    l.metric === 'author_original_category_rating_year' ||
    l.metric === 'author_original_category_rating_month';
  if (isOriginalCategoryMetric) {
    const tagKey = l.tag ?? '';
    const label = tagLabel && ORIGINAL_CATEGORY_TAG_SET.has(tagKey) ? `${tagLabel}作品` : '作品';
    const footnote = tpl?.footnote ? fillTemplate(tpl.footnote, replacements) : undefined;
    let text = `在${periodText}，你发布的${label}总评分全站第一`;
    if (pageTitle) text = applyPageTitle(text, pageTitle);
    return {
      text,
      footnote,
      metric: l.metric,
      tag: l.tag,
      period: l.period,
      periodText,
      value: l.value,
      pageId: l.pageId,
      userId: l.userId,
      displayName: l.displayName,
      pageMeta: l.pageId ? { pageId: l.pageId, wikidotId, title: pageTitle } : undefined
    };
  }

  const isTranslationOverall =
    (l.metric === 'author_translation_count' || l.metric === 'author_translation_words') &&
    (!l.tag || l.tag === 'all_translations');
  if (isTranslationOverall) {
    const baseText =
      l.metric === 'author_translation_count'
        ? '你翻译的页面数量全站第一'
        : '你翻译的页面总字数全站第一';
    const footnote = tpl?.footnote ? fillTemplate(tpl.footnote, replacements) : undefined;
    let text = `在${periodText}，${baseText}`;
    if (pageTitle) text = applyPageTitle(text, pageTitle);
    return {
      text,
      footnote,
      metric: l.metric,
      tag: l.tag,
      period: l.period,
      periodText,
      value: l.value,
      pageId: l.pageId,
      userId: l.userId,
      displayName: l.displayName,
      pageMeta: l.pageId ? { pageId: l.pageId, wikidotId, title: pageTitle } : undefined
    };
  }

  const isTranslationLangMetric = l.metric.startsWith('translator_lang_');
  if (isTranslationLangMetric) {
    const langLabel = l.tag ? `${l.tag}分部` : '对应分部';
    const footnote = tpl?.footnote ? fillTemplate(tpl.footnote, replacements) : undefined;
    let text = `在${periodText}，你翻译的${langLabel}页面${l.metric.includes('count') ? '数量' : '总字数'}全站第一`;
    if (pageTitle) text = applyPageTitle(text, pageTitle);
    return {
      text,
      footnote,
      metric: l.metric,
      tag: l.tag,
      period: l.period,
      periodText,
      value: l.value,
      pageId: l.pageId,
      userId: l.userId,
      displayName: l.displayName,
      pageMeta: l.pageId ? { pageId: l.pageId, wikidotId, title: pageTitle } : undefined
    };
  }

  const isComboMetric = l.metric.startsWith('combo_');
  if (isComboMetric) {
    const noun = buildComboNoun(l.tag);
    const baseText =
      l.metric.includes('pages_count') ? '数量全站第一' :
      l.metric.includes('words_sum') ? '总字数全站第一' :
      l.metric.includes('shortest') ? '最短' :
      '评分最高';
    const footnote = tpl?.footnote ? fillTemplate(tpl.footnote, replacements) : undefined;
    let text = `在${periodText}，你发布的${noun}${baseText}`;
    if (pageTitle) text = applyPageTitle(text, pageTitle);
    return {
      text,
      footnote,
      metric: l.metric,
      tag: l.tag,
      period: l.period,
      periodText,
      value: l.value,
      pageId: l.pageId,
      userId: l.userId,
      displayName: l.displayName,
      pageMeta: l.pageId ? { pageId: l.pageId, wikidotId, title: pageTitle } : undefined
    };
  }

  if (!tpl) {
    const fallbackText = `${l.period} ${l.metric}：${l.value} 第一`;
    const text = pageTitle ? applyPageTitle(fallbackText, pageTitle) : fallbackText;
    return {
      text,
      metric: l.metric,
      tag: l.tag,
      period: l.period,
      periodText: l.period,
      value: l.value,
      pageId: l.pageId,
      userId: l.userId,
      displayName: l.displayName,
      pageMeta: l.pageId ? { pageId: l.pageId, wikidotId, title: pageTitle } : undefined
    };
  }

  let text = fillTemplate(tpl.template, replacements);
  if (l.metric === 'author_creation_words' && l.tag === '原创') {
    text = `在${periodText}，你发布的原创总字数全站第一`;
  }
  const footnote = tpl.footnote ? fillTemplate(tpl.footnote, replacements) : undefined;
  if (pageTitle) {
    text = applyPageTitle(text, pageTitle);
  }
  return {
    text,
    footnote,
    metric: l.metric,
    tag: l.tag,
    period: l.period,
    periodText,
    value: l.value,
    pageId: l.pageId,
    userId: l.userId,
    displayName: l.displayName,
    pageMeta: l.pageId ? { pageId: l.pageId, wikidotId } : undefined
  };
}

async function getActiveUsersForYear(year: number): Promise<Set<number>> {
  const { startDate: start, endDate: end, startTzIso, endTzIso } = yearRange(year);

  const rows = await prisma.$queryRaw<Array<{ id: number }>>`
    WITH daily AS (
      SELECT DISTINCT "userId" AS id
      FROM "UserDailyStats"
      WHERE date >= ${start}::date AND date < ${end}::date
    ),
    voters AS (
      SELECT DISTINCT "userId" AS id
      FROM "Vote"
      WHERE "userId" IS NOT NULL
        AND timestamp >= ${start}::timestamptz
        AND timestamp < ${end}::timestamptz
    ),
    authors AS (
      SELECT DISTINCT a."userId" AS id
      FROM "Attribution" a
      JOIN "PageVersion" pv ON pv.id = a."pageVerId"
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE a."userId" IS NOT NULL
        
        AND pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    )
    SELECT id FROM daily
    UNION
    SELECT id FROM voters
    UNION
    SELECT id FROM authors
  `;

  return new Set(rows.map((r) => Number(r.id)));
}

async function getTagPopularity(): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<Array<{ tag: string; count: number }>>`
    SELECT tag, COUNT(*) AS count
    FROM (
      SELECT unnest(tags) AS tag
      FROM "PageVersion"
      WHERE "validTo" IS NULL AND NOT "isDeleted"
    ) t
    GROUP BY tag
  `;
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.tag, Number(r.count));
  return m;
}

async function getTagLeadersByYear(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    tag: string;
    pageId: number;
    userId: number;
    displayName: string | null;
    rating: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id, 
        pv."pageId", 
        pv.tags, 
        pv.rating,
        ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.rating IS NOT NULL
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    tagged AS (
      SELECT
        pv.id AS page_ver_id,
        pv."pageId" AS page_id,
        unnest(pv.tags) AS tag,
        pv.rating
      FROM pv
      WHERE pv.tags IS NOT NULL AND array_length(pv.tags, 1) > 0
    ),
    -- 先对 Attribution 去重，避免同一作者对同一页面有多条记录导致重复
    dedup_attr AS (
      SELECT DISTINCT t.tag, t.page_id, t.page_ver_id, t.rating, a."userId"
      FROM tagged t
      JOIN "Attribution" a ON a."pageVerId" = t.page_ver_id AND a."userId" IS NOT NULL
      WHERE NOT (t.tag = ANY(${BASE_TAGS_WITHOUT_ORIGINAL}))
    ),
    ranked AS (
      SELECT
        da.tag,
        da.page_id,
        da.rating,
        da."userId",
        u."displayName",
        RANK() OVER (PARTITION BY da.tag ORDER BY da.rating DESC) AS rnk
      FROM dedup_attr da
      LEFT JOIN "User" u ON u.id = da."userId"
    )
    SELECT tag, page_id AS "pageId", rating, "userId", "displayName"
    FROM ranked
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: r.tag,
    period: `${year}`,
    pageId: Number(r.pageId),
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.rating),
    metric: 'author_top_rating'
  }));
}

async function getTagLeadersByMonth(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    tag: string;
    month: Date;
    pageId: number;
    userId: number;
    displayName: string | null;
    rating: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id, 
        pv."pageId", 
        pv.tags, 
        pv.rating, 
        ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.rating IS NOT NULL
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    tagged AS (
      SELECT
        pv.id AS page_ver_id,
        pv."pageId" AS page_id,
        date_trunc('month', pv.published_at) AS month,
        unnest(pv.tags) AS tag,
        pv.rating
      FROM pv
      WHERE pv.tags IS NOT NULL AND array_length(pv.tags, 1) > 0
    ),
    -- 先对 Attribution 去重，避免同一作者对同一页面有多条记录导致重复
    dedup_attr AS (
      SELECT DISTINCT t.tag, t.month, t.page_id, t.page_ver_id, t.rating, a."userId"
      FROM tagged t
      JOIN "Attribution" a ON a."pageVerId" = t.page_ver_id AND a."userId" IS NOT NULL
      WHERE NOT (t.tag = ANY(${BASE_TAGS_WITHOUT_ORIGINAL}))
    ),
    ranked AS (
      SELECT
        da.tag,
        da.month,
        da.page_id,
        da.rating,
        da."userId",
        u."displayName",
        RANK() OVER (PARTITION BY da.tag, da.month ORDER BY da.rating DESC) AS rnk
      FROM dedup_attr da
      LEFT JOIN "User" u ON u.id = da."userId"
    )
    SELECT tag, month, page_id AS "pageId", rating, "userId", "displayName"
    FROM ranked
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: r.tag,
    period: new Date(r.month).toISOString().slice(0, 7), // YYYY-MM
    pageId: Number(r.pageId),
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.rating),
    metric: 'author_top_rating'
  }));
}

async function getTagLeadersByWeek(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    tag: string;
    week: Date;
    pageId: number;
    userId: number;
    displayName: string | null;
    rating: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id, 
        pv."pageId", 
        pv.tags, 
        pv.rating, 
        ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.rating IS NOT NULL
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    tagged AS (
      SELECT
        pv.id AS page_ver_id,
        pv."pageId" AS page_id,
        date_trunc('week', pv.published_at) AS week,
        unnest(pv.tags) AS tag,
        pv.rating
      FROM pv
      WHERE pv.tags IS NOT NULL AND array_length(pv.tags, 1) > 0
    ),
    -- 先对 Attribution 去重，避免同一作者对同一页面有多条记录导致重复
    dedup_attr AS (
      SELECT DISTINCT t.tag, t.week, t.page_id, t.page_ver_id, t.rating, a."userId"
      FROM tagged t
      JOIN "Attribution" a ON a."pageVerId" = t.page_ver_id AND a."userId" IS NOT NULL
      WHERE NOT (t.tag = ANY(${BASE_TAGS_WITHOUT_ORIGINAL}))
    ),
    ranked AS (
      SELECT
        da.tag,
        da.week,
        da.page_id,
        da.rating,
        da."userId",
        u."displayName",
        RANK() OVER (PARTITION BY da.tag, da.week ORDER BY da.rating DESC) AS rnk
      FROM dedup_attr da
      LEFT JOIN "User" u ON u.id = da."userId"
    )
    SELECT tag, week, page_id AS "pageId", rating, "userId", "displayName"
    FROM ranked
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: r.tag,
    period: new Date(r.week).toISOString().slice(0, 10),
    pageId: Number(r.pageId),
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.rating),
    metric: 'author_top_rating_week'
  }));
}

async function getTagVoterLeadersByMonth(year: number): Promise<TagLeader[]> {
  const { startTzIso: voteStartIso, endTzIso: voteEndIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    tag: string;
    month: Date;
    userId: number;
    displayName: string | null;
    votes: number;
  }>>`
    WITH tag_votes AS (
      SELECT
        month,
        unnest(tags) AS tag,
        "userId" AS user_id
      FROM (
        SELECT
          v."userId",
          pv.tags,
          date_trunc('month', v.timestamp) AS month
        FROM "Vote" v
        JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
        WHERE v."userId" IS NOT NULL
          AND v.direction != 0
          AND v.timestamp >= ${voteStartIso}::timestamptz
          AND v.timestamp < ${voteEndIso}::timestamptz
          AND pv."validTo" IS NULL
          AND NOT pv."isDeleted"
          AND pv.tags IS NOT NULL
          AND array_length(pv.tags, 1) > 0
      ) raw_votes
    ),
    aggregated AS (
      SELECT
        tag,
        month,
        user_id,
        COUNT(*) AS votes
      FROM tag_votes
      WHERE NOT (tag = ANY(${BASE_TAGS_WITHOUT_ORIGINAL}))
      GROUP BY tag, month, user_id
      HAVING COUNT(*) >= 1
    ),
    ranked AS (
      SELECT
        tag,
        month,
        user_id,
        votes,
        RANK() OVER (PARTITION BY tag, month ORDER BY votes DESC) AS rnk
      FROM aggregated
    )
    SELECT 
      tag,
      month,
      user_id AS "userId",
      votes,
      u."displayName"
    FROM ranked ag
    LEFT JOIN "User" u ON u.id = ag.user_id
    WHERE ag.rnk = 1
  `;

  return rows.map((r) => ({
    tag: r.tag,
    period: new Date(r.month).toISOString().slice(0, 7),
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.votes),
    metric: 'voter_most_votes',
    pageId: null
  }));
}

async function getTagVoterLeadersByDay(year: number): Promise<TagLeader[]> {
  const { startTzIso: voteStartIso, endTzIso: voteEndIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    tag: string;
    day: Date;
    userId: number;
    displayName: string | null;
    votes: number;
    metric: string;
  }>>`
    WITH tag_votes AS (
      SELECT
        day,
        unnest(tags) AS tag,
        "userId" AS user_id,
        direction
      FROM (
        SELECT
          v."userId",
          v.direction,
          pv.tags,
          date_trunc('day', v.timestamp) AS day
        FROM "Vote" v
        JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
        WHERE v."userId" IS NOT NULL
          AND v.direction != 0
          AND v.timestamp >= ${voteStartIso}::timestamptz
          AND v.timestamp < ${voteEndIso}::timestamptz
          AND pv."validTo" IS NULL
          AND NOT pv."isDeleted"
          AND pv.tags IS NOT NULL
          AND array_length(pv.tags, 1) > 0
      ) raw_votes
    ),
    aggregated AS (
      SELECT
        tag,
        day,
        user_id,
        COUNT(*) FILTER (WHERE direction != 0) AS total_votes,
        COUNT(*) FILTER (WHERE direction = 1) AS up_votes,
        COUNT(*) FILTER (WHERE direction = -1) AS down_votes
      FROM tag_votes
      WHERE NOT (tag = ANY(${BASE_TAGS_WITHOUT_ORIGINAL}))
      GROUP BY tag, day, user_id
      HAVING COUNT(*) FILTER (WHERE direction != 0) >= 1
        OR COUNT(*) FILTER (WHERE direction = 1) >= 1
        OR COUNT(*) FILTER (WHERE direction = -1) >= 1
    ),
    ranked AS (
      SELECT
        tag,
        day,
        user_id,
        total_votes,
        up_votes,
        down_votes,
        RANK() OVER (PARTITION BY tag, day ORDER BY total_votes DESC) AS rnk_total,
        RANK() OVER (PARTITION BY tag, day ORDER BY up_votes DESC) AS rnk_up,
        RANK() OVER (PARTITION BY tag, day ORDER BY down_votes DESC) AS rnk_down
      FROM aggregated
    )
    SELECT
      tag,
      day,
      user_id AS "userId",
      total_votes AS votes,
      'voter_tag_day_total' AS metric
    FROM ranked WHERE rnk_total = 1
    UNION ALL
    SELECT
      tag,
      day,
      user_id AS "userId",
      up_votes AS votes,
      'voter_tag_day_up' AS metric
    FROM ranked WHERE rnk_up = 1
    UNION ALL
    SELECT
      tag,
      day,
      user_id AS "userId",
      down_votes AS votes,
      'voter_tag_day_down' AS metric
    FROM ranked WHERE rnk_down = 1
  `;

  const mapped = rows.map((r) => ({
    tag: r.tag,
    period: new Date(r.day).toISOString().slice(0, 10),
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.votes),
    metric: r.metric,
    pageId: null
  }));

  return mapped;
}

async function getTagVoterLeadersByYear(year: number): Promise<TagLeader[]> {
  const { startTzIso: voteStartIso, endTzIso: voteEndIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    tag: string;
    userId: number;
    displayName: string | null;
    votes: number;
  }>>`
    WITH tag_votes AS (
      SELECT
        unnest(tags) AS tag,
        "userId" AS user_id
      FROM (
        SELECT
          v."userId",
          pv.tags
        FROM "Vote" v
        JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
        WHERE v."userId" IS NOT NULL
          AND v.direction != 0
          AND v.timestamp >= ${voteStartIso}::timestamptz
          AND v.timestamp < ${voteEndIso}::timestamptz
          AND pv."validTo" IS NULL
          AND NOT pv."isDeleted"
          AND pv.tags IS NOT NULL
          AND array_length(pv.tags, 1) > 0
      ) raw_votes
    ),
    aggregated AS (
      SELECT
        tag,
        user_id,
        COUNT(*) AS votes,
        RANK() OVER (PARTITION BY tag ORDER BY COUNT(*) DESC) AS rnk
      FROM tag_votes
      WHERE NOT (tag = ANY(${BASE_TAGS_WITHOUT_ORIGINAL}))
      GROUP BY tag, user_id
      HAVING COUNT(*) >= 1
    )
    SELECT 
      tag,
      user_id AS "userId",
      votes,
      u."displayName"
    FROM aggregated ag
    LEFT JOIN "User" u ON u.id = ag.user_id
    WHERE ag.rnk = 1
  `;

  return rows.map((r) => ({
    tag: r.tag,
    period: `${year}`,
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.votes),
    metric: 'voter_most_votes',
    pageId: null
  }));
}

function coverage(users: Set<number>, leaders: TagLeader[]): number {
  const got = new Set<number>();
  for (const l of leaders) {
    if (users.has(l.userId)) {
      got.add(l.userId);
    }
  }
  return got.size;
}

function sampleByUser(leaders: (TagLeader | ScoredLeader)[], limit = 10) {
  const byUser = new Map<number, TagLeader[]>();
  for (const l of leaders) {
    const list = byUser.get(l.userId) || [];
    list.push(l);
    byUser.set(l.userId, list);
  }

  const samples: Array<{ userId: number; displayName: string | null; wins: TagLeader[] }> = [];
  for (const [userId, wins] of byUser) {
    wins.sort((a, b) => (Number((b as any).score ?? b.value) - Number((a as any).score ?? a.value)));
    samples.push({ userId, displayName: wins[0]?.displayName ?? null, wins: wins.slice(0, 3) });
    if (samples.length >= limit) break;
  }
  return samples;
}

export type ScoredLeader = TagLeader & { score: number };

function levelFromPeriod(metric: string, period: string): 'year' | 'month' | 'week' | 'day' {
  if (metric.includes('week')) return 'week';
  if (period.length === 4) return 'year';
  if (period.length === 7) return 'month';
  return 'day';
}

function baseMetric(metric: string): string {
  return metric.replace(/_(day|week|month|year)$/, '');
}

function formatPeriodText(l: TagLeader): string {
  const raw = l.period;
  const level = levelFromPeriod(l.metric, raw);
  const [y, m, d] = raw.split('-').map((v) => String(Number(v)));
  if (level === 'year') return `${y}年`;
  if (level === 'month') return `${y}年${m}月`;
  if (level === 'week') return `${y}年${m}月${d}日这一周`;
  if (level === 'day') return `${y}年${m}月${d}日这一天`;
  return raw;
}

function computeScore(item: TagLeader, tagPopularity: Map<string, number>): number {
  const level = levelFromPeriod(item.metric, item.period);
  const levelWeight = LEVEL_WEIGHT[level] ?? 1;
  const tagWeight = item.tag && item.tag !== 'all_tags' && item.tag !== 'all_pages'
    ? Math.log1p(tagPopularity.get(item.tag) || 1)
    : 1;
  return levelWeight * 1e6 + tagWeight * 1e3 + item.value;
}

function scoreLeaders(leaders: TagLeader[], tagPopularity: Map<string, number>): ScoredLeader[] {
  return leaders.map((l) => ({ ...l, score: computeScore(l, tagPopularity) }));
}

function topPerMetricForUser(leaders: ScoredLeader[], userId: number, topN = 3): Record<string, ScoredLeader[]> {
  const byMetric = new Map<string, ScoredLeader[]>();
  for (const l of leaders) {
    if (l.userId !== userId) continue;
    const arr = byMetric.get(l.metric) || [];
    arr.push(l);
    byMetric.set(l.metric, arr);
  }
  const result: Record<string, ScoredLeader[]> = {};
  for (const [metric, arr] of byMetric) {
    arr.sort((a, b) => b.score - a.score);
    result[metric] = arr.slice(0, topN);
  }
  return result;
}

function dedupeByHierarchy(leaders: ScoredLeader[]): ScoredLeader[] {
  const best = new Map<string, ScoredLeader>();
  for (const l of leaders) {
    const fam = baseMetric(l.metric);
    const key = `${fam}|${l.tag}|${l.pageId ?? 'nopage'}`;
    const level = levelFromPeriod(l.metric, l.period);
    const existing = best.get(key);
    if (!existing) {
      best.set(key, l);
      continue;
    }
    const existingLevel = levelFromPeriod(existing.metric, existing.period);
    if ((LEVEL_WEIGHT[level] ?? 0) > (LEVEL_WEIGHT[existingLevel] ?? 0)) {
      best.set(key, l);
    } else if ((LEVEL_WEIGHT[level] ?? 0) === (LEVEL_WEIGHT[existingLevel] ?? 0) && l.score > existing.score) {
      best.set(key, l);
    }
  }
  return Array.from(best.values());
}

async function fetchPageMetaMap(
  leaders: TagLeader[]
): Promise<Map<number, { wikidotId?: number; title?: string }>> {
  const ids = Array.from(
    new Set(leaders.map((l) => l.pageId).filter((id): id is number => typeof id === 'number'))
  );
  if (!ids.length) return new Map();
  const rows = await prisma.$queryRaw<Array<{ pageId: number; wikidotId: number | null; title: string | null }>>`
    SELECT p.id AS "pageId",
           p."wikidotId" AS "wikidotId",
           COALESCE(pv.title, p.url, CONCAT('Page #', p.id)) AS title
    FROM "Page" p
    LEFT JOIN LATERAL (
      SELECT pv.title
      FROM "PageVersion" pv
      WHERE pv."pageId" = p.id
        AND pv."validTo" IS NULL
        AND NOT pv."isDeleted"
      ORDER BY pv.id DESC
      LIMIT 1
    ) pv ON TRUE
    WHERE p.id = ANY(${ids})
  `;
  const map = new Map<number, { wikidotId?: number; title?: string }>();
  for (const r of rows) {
    map.set(Number(r.pageId), {
      wikidotId: r.wikidotId ?? undefined,
      title: r.title ?? undefined
    });
  }
  return map;
}

type VoteAggregate = {
  period: string;
  userId: number;
  displayName: string | null;
  totalVotes: number;
  upVotes: number;
  downVotes: number;
  netVotes: number;
  rnkTotal: bigint;
  rnkUp: bigint;
  rnkDown: bigint;
  rnkNet: bigint;
};

async function getAuthorReceivedVotesByPeriod(
  year: number,
  period: 'year' | 'month' | 'week'
): Promise<TagLeader[]> {
  const { startTzIso: voteStartIso, endTzIso: voteEndIso } = yearRange(year);
  const bucket = period === 'year' ? 'year' : period === 'month' ? 'month' : 'week';
  const rows = await prisma.$queryRaw<VoteAggregate[]>`
    WITH dedup_votes AS (
      SELECT *
      FROM (
        SELECT
          v.id,
          v.direction,
          v.timestamp,
          pv."pageId",
          pv.id AS pv_id,
          date_trunc(${bucket}, v.timestamp) AS bucket,
          ROW_NUMBER() OVER (
            PARTITION BY v."userId", pv."pageId", date_trunc(${bucket}, v.timestamp)
            ORDER BY v.timestamp DESC, v.id DESC
          ) AS rn
        FROM "Vote" v
        JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
        WHERE v.direction != 0
          AND v.timestamp >= ${voteStartIso}::timestamptz
          AND v.timestamp < ${voteEndIso}::timestamptz
          AND pv."validTo" IS NULL
          AND NOT pv."isDeleted"
      ) t WHERE rn = 1
    ),
    -- 先对 Attribution 去重，避免同一作者对同一页面有多条记录时重复计数
    vote_author AS (
      SELECT DISTINCT
        dv.id AS vote_id,
        dv.direction,
        dv.bucket,
        a."userId" AS author_id,
        u."displayName"
      FROM dedup_votes dv
      JOIN "Attribution" a ON a."pageVerId" = dv.pv_id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
    ),
    aggregated AS (
      SELECT
        bucket,
        author_id,
        "displayName",
        COUNT(*) FILTER (WHERE direction != 0) AS total_votes,
        COUNT(*) FILTER (WHERE direction = 1) AS up_votes,
        COUNT(*) FILTER (WHERE direction = -1) AS down_votes,
        COALESCE(SUM(direction), 0) AS net_votes
      FROM vote_author
      GROUP BY bucket, author_id, "displayName"
      HAVING COUNT(*) FILTER (WHERE direction != 0) >= 1
         OR COUNT(*) FILTER (WHERE direction = 1) >= 1
         OR COUNT(*) FILTER (WHERE direction = -1) >= 1
         OR abs(COALESCE(SUM(direction), 0)) >= 1
    ),
    ranked AS (
      SELECT
        bucket,
        author_id,
        "displayName",
        total_votes,
        up_votes,
        down_votes,
        net_votes,
        RANK() OVER (PARTITION BY bucket ORDER BY total_votes DESC) AS rnk_total,
        RANK() OVER (PARTITION BY bucket ORDER BY up_votes DESC) AS rnk_up,
        RANK() OVER (PARTITION BY bucket ORDER BY down_votes DESC) AS rnk_down,
        RANK() OVER (PARTITION BY bucket ORDER BY net_votes DESC) AS rnk_net
      FROM aggregated
    ),
    -- 只选择在至少一个指标上排名第一的用户，并去重
    winners AS (
      SELECT DISTINCT
        bucket,
        author_id,
        "displayName",
        total_votes,
        up_votes,
        down_votes,
        net_votes,
        rnk_total,
        rnk_up,
        rnk_down,
        rnk_net
      FROM ranked
      WHERE rnk_total = 1 OR rnk_up = 1 OR rnk_down = 1 OR rnk_net = 1
    )
    SELECT
      bucket AS period,
      author_id AS "userId",
      "displayName" AS "displayName",
      total_votes AS "totalVotes",
      up_votes AS "upVotes",
      down_votes AS "downVotes",
      net_votes AS "netVotes",
      rnk_total AS "rnkTotal",
      rnk_up AS "rnkUp",
      rnk_down AS "rnkDown",
      rnk_net AS "rnkNet"
    FROM winners
  `;

  return rows
    .map((r) => {
      const dateVal = new Date(r.period as any);
      const periodStr =
        period === 'year'
          ? String(year)
          : period === 'month'
          ? dateVal.toISOString().slice(0, 7)
          : dateVal.toISOString().slice(0, 10);
      const suffix = period === 'year' ? '_year' : period === 'month' ? '_month' : '_week';

      // 只为用户排名第一的指标创建条目
      const metrics: Array<{ metric: string; value: number }> = [];
      if (Number(r.rnkTotal) === 1) metrics.push({ metric: `author_received_total${suffix}`, value: Number(r.totalVotes) });
      if (Number(r.rnkUp) === 1) metrics.push({ metric: `author_received_up${suffix}`, value: Number(r.upVotes) });
      if (Number(r.rnkDown) === 1) metrics.push({ metric: `author_received_down${suffix}`, value: Number(r.downVotes) });
      if (Number(r.rnkNet) === 1) metrics.push({ metric: `author_received_net${suffix}`, value: Number(r.netVotes) });

      return metrics.map((entry) => ({
        tag: 'all_pages',
        period: periodStr,
        pageId: null,
        userId: Number(r.userId),
        displayName: r.displayName,
        value: entry.value,
        metric: entry.metric
      }));
    })
    .flat()
    .filter((l) => {
      if (l.metric.includes('_net')) return Math.abs(l.value) >= MIN_RECEIVED_VOTES;
      if (l.metric.includes('_down')) return l.value >= MIN_RECEIVED_VOTES;
      return l.value >= MIN_RECEIVED_VOTES;
    });
}

async function queryUserFirsts(userQuery: string, leaders: ScoredLeader[]) {
  const byId = Number.isFinite(Number(userQuery)) ? Number(userQuery) : null;
  const user =
    byId !== null
      ? await prisma.user.findUnique({ where: { id: byId } })
      : await prisma.user.findFirst({
          where: { displayName: { contains: userQuery, mode: 'insensitive' } }
        });
  if (!user) {
    console.log(`User "${userQuery}" not found.`);
    return;
  }
  const userWins = leaders.filter((l) => l.userId === user.id);
  const deduped = dedupeByHierarchy(userWins).sort((a, b) => b.score - a.score);
  const top3ByMetric = topPerMetricForUser(deduped, user.id, 3);
  const pageMetaMap = await fetchPageMetaMap(deduped);

  console.log(`\n=== All firsts for user ${user.displayName ?? user.username ?? user.id} (#${user.id}) ===`);
  console.log(`Total firsts: ${deduped.length}`);
  console.log(deduped.slice(0, 50).map((w) => ({
    metric: w.metric,
    tag: w.tag,
    period: w.period,
    value: w.value,
    pageId: w.pageId
  })));

  console.log('\n=== Top-3 per metric (after scoring) ===');
  for (const [metric, arr] of Object.entries(top3ByMetric)) {
    console.log(metric, arr.map((w) => ({
      tag: w.tag,
      period: w.period,
      value: w.value,
      pageId: w.pageId
    })));
  }

  console.log('\n=== 文本描述（前50条） ===');
  const rendered = deduped.slice(0, 50).map((w) => renderLeaderView(w, pageMetaMap));
  console.log(rendered);
}

async function getDailyAuthorScoreLeaders(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    day: Date;
    pageId: number;
    userId: number;
    displayName: string | null;
    rating: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id, 
        pv."pageId", 
        pv.rating, 
        ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.rating IS NOT NULL
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    ranked AS (
      SELECT
        date_trunc('day', pv.published_at) AS day,
        pv."pageId" AS page_id,
        pv.rating,
        a."userId",
        u."displayName",
        RANK() OVER (PARTITION BY date_trunc('day', pv.published_at) ORDER BY pv.rating DESC) AS rnk
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
    )
    SELECT 
      day,
      page_id AS "pageId",
      rating,
      "userId",
      "displayName"
    FROM ranked
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: 'all_pages',
    period: new Date(r.day).toISOString().slice(0, 10), // YYYY-MM-DD
    pageId: Number(r.pageId),
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.rating),
    metric: 'author_top_rating_day'
  }));
}

async function getDailyVoterCountLeaders(year: number): Promise<TagLeader[]> {
  const { startTzIso: voteStartIso, endTzIso: voteEndIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    day: Date;
    userId: number;
    displayName: string | null;
    totalVotes: number;
    upVotes: number;
    downVotes: number;
  }>>`
    WITH filtered_votes AS (
      SELECT 
        v."userId",
        v.direction,
        date_trunc('day', v.timestamp) AS day
      FROM "Vote" v
      JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
      WHERE v."userId" IS NOT NULL
        AND v.direction != 0
        AND v.timestamp >= ${voteStartIso}::timestamptz
        AND v.timestamp < ${voteEndIso}::timestamptz
        AND pv."validTo" IS NULL
        AND NOT pv."isDeleted"
    )
    SELECT
      day,
      "userId" AS "userId",
      u."displayName",
      COUNT(*) AS "totalVotes",
      COUNT(*) FILTER (WHERE direction = 1) AS "upVotes",
      COUNT(*) FILTER (WHERE direction = -1) AS "downVotes"
    FROM filtered_votes dv
    LEFT JOIN "User" u ON u.id = dv."userId"
    GROUP BY day, "userId", u."displayName"
  `;

  const bestByDay = new Map<string, Record<string, TagLeader>>();
  const maybeUpdate = (dayKey: string, metric: string, candidate: TagLeader) => {
    const existing = bestByDay.get(dayKey) || {};
    const current = existing[metric];
    if (!current || candidate.value > current.value) {
      existing[metric] = candidate;
      bestByDay.set(dayKey, existing);
    }
  };

  for (const r of rows) {
    const dayKey = new Date(r.day).toISOString().slice(0, 10);
    maybeUpdate(dayKey, 'voter_daily_total', {
      tag: 'all_tags',
      period: dayKey,
      userId: Number(r.userId),
      displayName: r.displayName,
      value: Number(r.totalVotes),
      metric: 'voter_daily_total',
      pageId: null
    });
    maybeUpdate(dayKey, 'voter_daily_up', {
      tag: 'all_tags',
      period: dayKey,
      userId: Number(r.userId),
      displayName: r.displayName,
      value: Number(r.upVotes),
      metric: 'voter_daily_up',
      pageId: null
    });
    maybeUpdate(dayKey, 'voter_daily_down', {
      tag: 'all_tags',
      period: dayKey,
      userId: Number(r.userId),
      displayName: r.displayName,
      value: Number(r.downVotes),
      metric: 'voter_daily_down',
      pageId: null
    });
  }

  const results: TagLeader[] = [];
  for (const perDay of bestByDay.values()) {
    results.push(...Object.values(perDay));
  }
  return results;
}

async function getWeeklyAuthorScoreLeaders(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    week: Date;
    pageId: number;
    userId: number;
    displayName: string | null;
    rating: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id, 
        pv."pageId", 
        pv.rating, 
        ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.rating IS NOT NULL
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    ranked AS (
      SELECT
        date_trunc('week', pv.published_at) AS week,
        pv."pageId" AS page_id,
        pv.rating,
        a."userId",
        u."displayName",
        RANK() OVER (PARTITION BY date_trunc('week', pv.published_at) ORDER BY pv.rating DESC) AS rnk
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
    )
    SELECT 
      week,
      page_id AS "pageId",
      rating,
      "userId",
      "displayName"
    FROM ranked
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: 'all_pages',
    period: new Date(r.week).toISOString().slice(0, 10), // week start
    pageId: Number(r.pageId),
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.rating),
    metric: 'author_top_rating_week'
  }));
}

async function getWeeklyVoterCountLeaders(year: number): Promise<TagLeader[]> {
  const { startTzIso: voteStartIso, endTzIso: voteEndIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    week: Date;
    userId: number;
    displayName: string | null;
    totalVotes: number;
    upVotes: number;
    downVotes: number;
  }>>`
    WITH filtered_votes AS (
      SELECT 
        v."userId",
        v.direction,
        date_trunc('week', v.timestamp) AS week
      FROM "Vote" v
      JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
      WHERE v."userId" IS NOT NULL
        AND v.direction != 0
        AND v.timestamp >= ${voteStartIso}::timestamptz
        AND v.timestamp < ${voteEndIso}::timestamptz
        AND pv."validTo" IS NULL
        AND NOT pv."isDeleted"
    )
    SELECT
      week,
      "userId" AS "userId",
      u."displayName",
      COUNT(*) AS "totalVotes",
      COUNT(*) FILTER (WHERE direction = 1) AS "upVotes",
      COUNT(*) FILTER (WHERE direction = -1) AS "downVotes"
    FROM filtered_votes dv
    LEFT JOIN "User" u ON u.id = dv."userId"
    GROUP BY week, "userId", u."displayName"
  `;

  const bestByWeek = new Map<string, Record<string, TagLeader>>();
  const maybeUpdate = (weekKey: string, metric: string, candidate: TagLeader) => {
    const existing = bestByWeek.get(weekKey) || {};
    const current = existing[metric];
    if (!current || candidate.value > current.value) {
      existing[metric] = candidate;
      bestByWeek.set(weekKey, existing);
    }
  };

  for (const r of rows) {
    const weekKey = new Date(r.week).toISOString().slice(0, 10);
    maybeUpdate(weekKey, 'voter_weekly_total', {
      tag: 'all_tags',
      period: weekKey,
      userId: Number(r.userId),
      displayName: r.displayName,
      value: Number(r.totalVotes),
      metric: 'voter_weekly_total',
      pageId: null
    });
    maybeUpdate(weekKey, 'voter_weekly_up', {
      tag: 'all_tags',
      period: weekKey,
      userId: Number(r.userId),
      displayName: r.displayName,
      value: Number(r.upVotes),
      metric: 'voter_weekly_up',
      pageId: null
    });
    maybeUpdate(weekKey, 'voter_weekly_down', {
      tag: 'all_tags',
      period: weekKey,
      userId: Number(r.userId),
      displayName: r.displayName,
      value: Number(r.downVotes),
      metric: 'voter_weekly_down',
      pageId: null
    });
  }

  const results: TagLeader[] = [];
  for (const perWeek of bestByWeek.values()) {
    results.push(...Object.values(perWeek));
  }
  return results;
}

async function getAuthorPageCountLeaders(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    period: string;
    userId: number;
    displayName: string | null;
    pages: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id,
        pv."pageId",
        ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    aggregated AS (
      SELECT 
        date_trunc('year', pv.published_at)::date AS period,
        a."userId" AS user_id,
        COUNT(DISTINCT pv."pageId") AS pages
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id
      WHERE a."userId" IS NOT NULL
      GROUP BY period, a."userId"
    ),
    ranked AS (
      SELECT 
        period,
        user_id,
        pages,
        RANK() OVER (PARTITION BY period ORDER BY pages DESC) AS rnk
      FROM aggregated
    )
    SELECT 
      period::text,
      user_id AS "userId",
      pages,
      u."displayName"
    FROM ranked r
    LEFT JOIN "User" u ON u.id = r.user_id
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: 'all_pages',
    period: r.period.slice(0, 4),
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.pages),
    metric: 'author_pages_count',
    pageId: null
  }));
}

async function getAuthorPageCountLeadersByMonth(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    period: string;
    userId: number;
    displayName: string | null;
    pages: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id,
        pv."pageId",
        ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    aggregated AS (
      SELECT 
        date_trunc('month', pv.published_at)::date AS period,
        a."userId" AS user_id,
        COUNT(DISTINCT pv."pageId") AS pages
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id
      WHERE a."userId" IS NOT NULL
      GROUP BY period, a."userId"
      HAVING COUNT(DISTINCT pv."pageId") >= ${MIN_PAGES_FOR_AUTHOR_COUNT_MONTH}
    ),
    ranked AS (
      SELECT 
        period,
        user_id,
        pages,
        RANK() OVER (PARTITION BY period ORDER BY pages DESC) AS rnk
      FROM aggregated
    )
    SELECT 
      period::text,
      user_id AS "userId",
      pages,
      u."displayName"
    FROM ranked r
    LEFT JOIN "User" u ON u.id = r.user_id
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: 'all_pages',
    period: r.period.slice(0, 7),
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.pages),
    metric: 'author_pages_count',
    pageId: null
  }));
}

async function getLongestPageLeaders(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    period: string;
    pageId: number;
    userId: number;
    displayName: string | null;
    length: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id,
        pv."pageId",
        ${PUBLISHED_AT_SQL} AS published_at,
        LENGTH(pv.source) AS len
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.source IS NOT NULL
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    ranked AS (
      SELECT 
        date_trunc('year', pv.published_at)::date AS period,
        pv."pageId" AS page_id,
        pv.len,
        a."userId",
        u."displayName",
        RANK() OVER (PARTITION BY date_trunc('year', pv.published_at) ORDER BY pv.len DESC) AS rnk
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
    )
    SELECT 
      period::text,
      page_id AS "pageId",
      "userId",
      "displayName",
      len AS length
    FROM ranked
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: 'all_pages',
    period: r.period.slice(0, 4),
    pageId: Number(r.pageId),
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.length),
    metric: 'author_page_length'
  }));
}

async function getLongestPageLeadersByMonth(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    period: string;
    pageId: number;
    userId: number;
    displayName: string | null;
    length: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id,
        pv."pageId",
        ${PUBLISHED_AT_SQL} AS published_at,
        LENGTH(pv.source) AS len
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.source IS NOT NULL
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    ranked AS (
      SELECT 
        date_trunc('month', pv.published_at)::date AS period,
        pv."pageId" AS page_id,
        pv.len,
        a."userId",
        u."displayName",
        RANK() OVER (PARTITION BY date_trunc('month', pv.published_at) ORDER BY pv.len DESC) AS rnk
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
    )
    SELECT 
      period::text,
      page_id AS "pageId",
      "userId",
      "displayName",
      len AS length
    FROM ranked
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: 'all_pages',
    period: r.period.slice(0, 7),
    pageId: Number(r.pageId),
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.length),
    metric: 'author_page_length'
  }));
}

async function getShortestPageLeaders(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    period: string;
    pageId: number;
    userId: number;
    displayName: string | null;
    length: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id,
        pv."pageId",
        ${PUBLISHED_AT_SQL} AS published_at,
        LENGTH(pv.source) AS len
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.source IS NOT NULL
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    ranked AS (
      SELECT 
        date_trunc('year', pv.published_at)::date AS period,
        pv."pageId" AS page_id,
        pv.len,
        a."userId",
        u."displayName",
        RANK() OVER (PARTITION BY date_trunc('year', pv.published_at) ORDER BY pv.len ASC) AS rnk
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      WHERE pv.len IS NOT NULL
    )
    SELECT 
      period::text,
      page_id AS "pageId",
      "userId",
      "displayName",
      len AS length
    FROM ranked
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: 'all_pages',
    period: r.period.slice(0, 4),
    pageId: Number(r.pageId),
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.length),
    metric: 'author_page_shortest'
  }));
}

async function getShortestPageLeadersByMonth(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    period: string;
    pageId: number;
    userId: number;
    displayName: string | null;
    length: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id,
        pv."pageId",
        ${PUBLISHED_AT_SQL} AS published_at,
        LENGTH(pv.source) AS len
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.source IS NOT NULL
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    ranked AS (
      SELECT 
        date_trunc('month', pv.published_at)::date AS period,
        pv."pageId" AS page_id,
        pv.len,
        a."userId",
        u."displayName",
        RANK() OVER (PARTITION BY date_trunc('month', pv.published_at) ORDER BY pv.len ASC) AS rnk
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      WHERE pv.len IS NOT NULL
    )
    SELECT 
      period::text,
      page_id AS "pageId",
      "userId",
      "displayName",
      len AS length
    FROM ranked
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: 'all_pages',
    period: r.period.slice(0, 7),
    pageId: Number(r.pageId),
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.length),
    metric: 'author_page_shortest'
  }));
}

async function getAuthorImageCountLeaders(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    userId: number;
    displayName: string | null;
    images: number;
  }>>`
    WITH imgs AS (
      SELECT 
        a."userId" AS user_id,
        COUNT(*) AS images,
        RANK() OVER (ORDER BY COUNT(*) DESC) AS rnk
      FROM "PageVersionImage" i
      JOIN "PageVersion" pv ON pv.id = i."pageVersionId"
      JOIN "Attribution" a ON a."pageVerId" = pv.id
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE a."userId" IS NOT NULL
        
        AND pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
      GROUP BY a."userId"
    )
    SELECT user_id AS "userId", images, u."displayName"
    FROM imgs
    LEFT JOIN "User" u ON u.id = imgs.user_id
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: 'all_pages',
    period: `${year}`,
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.images),
    metric: 'author_images_count',
    pageId: null
  }));
}

async function getMostCommentedNewPage(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    pageId: number;
    userId: number;
    displayName: string | null;
    comments: number;
  }>>`
    SELECT 
      pv."pageId" AS "pageId",
      a."userId" AS "userId",
      u."displayName",
      pv."commentCount" AS comments
    FROM "PageVersion" pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
    LEFT JOIN "User" u ON u.id = a."userId"
    JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
    WHERE pv."validTo" IS NULL
      AND NOT pv."isDeleted"
      AND pv."commentCount" IS NOT NULL
      AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
      AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ORDER BY pv."commentCount" DESC NULLS LAST
    LIMIT 1
  `;

  return rows.map((r) => ({
    tag: 'all_pages',
    period: `${year}`,
    pageId: Number(r.pageId),
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.comments),
    metric: 'author_page_comments_max'
  }));
}

async function getCoauthorPageCountLeaders(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    userId: number;
    displayName: string | null;
    pages: number;
  }>>`
    WITH page_authors AS (
      SELECT 
        pv."pageId" AS page_id,
        COUNT(DISTINCT a."userId") AS author_count,
        array_agg(DISTINCT a."userId") AS authors
      FROM "Attribution" a
      JOIN "PageVersion" pv ON pv.id = a."pageVerId"
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE a."userId" IS NOT NULL
        
        AND pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
      GROUP BY pv."pageId"
      HAVING COUNT(DISTINCT a."userId") >= 2
    ),
    expanded AS (
      SELECT unnest(authors) AS user_id, page_id
      FROM page_authors
    ),
    aggregated AS (
      SELECT 
        user_id,
        COUNT(DISTINCT page_id) AS pages
      FROM expanded
      GROUP BY user_id
    ),
    ranked AS (
      SELECT 
        user_id,
        pages,
        RANK() OVER (ORDER BY pages DESC) AS rnk
      FROM aggregated
    )
    SELECT user_id AS "userId", pages, u."displayName"
    FROM ranked r
    LEFT JOIN "User" u ON u.id = r.user_id
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: 'all_pages',
    period: `${year}`,
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.pages),
    metric: 'coauthor_pages',
    pageId: null
  }));
}

async function getCoauthorPartnerCountLeaders(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    userId: number;
    displayName: string | null;
    partners: number;
  }>>`
    WITH page_authors AS (
      SELECT 
        pv."pageId" AS page_id,
        array_agg(DISTINCT a."userId") AS authors
      FROM "Attribution" a
      JOIN "PageVersion" pv ON pv.id = a."pageVerId"
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE a."userId" IS NOT NULL
        
        AND pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
      GROUP BY pv."pageId"
      HAVING COUNT(DISTINCT a."userId") >= 2
    ),
    expanded AS (
      SELECT 
        unnest(authors) AS user_id,
        authors
      FROM page_authors
    ),
    pairs AS (
      SELECT 
        e.user_id,
        unnest(e.authors) AS partner_id
      FROM expanded e
    ),
    aggregated AS (
      SELECT 
        user_id,
        COUNT(DISTINCT partner_id) FILTER (WHERE partner_id != user_id) AS partners
      FROM pairs
      GROUP BY user_id
    ),
    ranked AS (
      SELECT 
        user_id,
        partners,
        RANK() OVER (ORDER BY partners DESC) AS rnk
      FROM aggregated
    )
    SELECT user_id AS "userId", partners, u."displayName"
    FROM ranked r
    LEFT JOIN "User" u ON u.id = r.user_id
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: 'all_pages',
    period: `${year}`,
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.partners),
    metric: 'coauthor_partners',
    pageId: null
  }));
}

async function getTagCreationCountLeadersByYear(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    tag: string;
    userId: number;
    displayName: string | null;
    pages: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id,
        pv."pageId",
        pv.tags,
        pv.category,
        ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    tagged AS (
      SELECT 
        pv.id AS page_ver_id,
        pv."pageId" AS page_id,
        pv.tags AS all_tags,
        unnest(pv.tags) AS tag
      FROM pv
      WHERE pv.tags IS NOT NULL AND array_length(pv.tags, 1) > 0
    ),
    aggregated AS (
      SELECT 
        t.tag,
        a."userId" AS user_id,
        COUNT(DISTINCT t.page_id) AS pages,
        RANK() OVER (PARTITION BY t.tag ORDER BY COUNT(DISTINCT t.page_id) DESC) AS rnk
      FROM tagged t
      JOIN "Attribution" a ON a."pageVerId" = t.page_ver_id AND a."userId" IS NOT NULL
      WHERE NOT (t.tag = ANY(${BASE_TAGS_WITHOUT_ORIGINAL}))
        AND (t.all_tags @> ARRAY['原创'])
      GROUP BY t.tag, a."userId"
      HAVING COUNT(DISTINCT t.page_id) > 0
    )
    SELECT tag, user_id AS "userId", pages, u."displayName"
    FROM aggregated ag
    LEFT JOIN "User" u ON u.id = ag.user_id
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: r.tag,
    period: `${year}`,
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.pages),
    metric: 'author_creation_count',
    pageId: null
  }));
}

async function getTagCreationCountLeadersByMonth(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    tag: string;
    month: Date;
    userId: number;
    displayName: string | null;
    pages: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id,
        pv."pageId",
        pv.tags,
        pv.category,
        ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    tagged AS (
      SELECT 
        pv.id AS page_ver_id,
        pv."pageId" AS page_id,
        pv.tags AS all_tags,
        date_trunc('month', pv.published_at) AS month,
        unnest(pv.tags) AS tag
      FROM pv
      WHERE pv.tags IS NOT NULL AND array_length(pv.tags, 1) > 0
    ),
    aggregated AS (
      SELECT 
        t.tag,
        t.month,
        a."userId" AS user_id,
        COUNT(DISTINCT t.page_id) AS pages,
        RANK() OVER (PARTITION BY t.tag, t.month ORDER BY COUNT(DISTINCT t.page_id) DESC) AS rnk
      FROM tagged t
      JOIN "Attribution" a ON a."pageVerId" = t.page_ver_id AND a."userId" IS NOT NULL
      WHERE NOT (t.tag = ANY(${BASE_TAGS_WITHOUT_ORIGINAL}))
        AND (t.all_tags @> ARRAY['原创'])
      GROUP BY t.tag, t.month, a."userId"
      HAVING COUNT(DISTINCT t.page_id) >= ${MIN_PAGES_FOR_AUTHOR_COUNT_MONTH}
    )
    SELECT tag, month, user_id AS "userId", pages, u."displayName"
    FROM aggregated ag
    LEFT JOIN "User" u ON u.id = ag.user_id
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: r.tag,
    period: new Date(r.month).toISOString().slice(0, 7),
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.pages),
    metric: 'author_creation_count',
    pageId: null
  }));
}

async function getTagTranslationCountLeadersByYear(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    userId: number;
    displayName: string | null;
    pages: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id,
        pv."pageId",
        pv.tags,
        pv.category,
        ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    aggregated AS (
      SELECT 
        date_trunc('year', pv.published_at) AS period,
        a."userId" AS user_id,
        u."displayName",
        COUNT(DISTINCT pv."pageId") AS pages,
        RANK() OVER (PARTITION BY date_trunc('year', pv.published_at) ORDER BY COUNT(DISTINCT pv."pageId") DESC) AS rnk
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      WHERE pv.tags IS NOT NULL
        AND array_length(pv.tags, 1) > 0
        AND NOT (pv.tags @> ARRAY['原创'])
        AND NOT (pv.tags @> ARRAY['作者'])
        AND NOT (pv.tags @> ARRAY['掩盖页'])
        AND NOT (pv.tags @> ARRAY['段落'])
        AND NOT (pv.tags @> ARRAY['补充材料'])
        AND NOT (pv.category IN ('log-of-anomalous-items-cn','short-stories'))
      GROUP BY period, a."userId", u."displayName"
      HAVING COUNT(DISTINCT pv."pageId") > 0
    )
    SELECT period::text, user_id AS "userId", pages, "displayName"
    FROM aggregated
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: 'all_translations',
    period: `${year}`,
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.pages),
    metric: 'author_translation_count',
    pageId: null
  }));
}

async function getTagTranslationCountLeadersByMonth(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    month: Date;
    userId: number;
    displayName: string | null;
    pages: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id,
        pv."pageId",
        pv.tags,
        pv.category,
        ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    aggregated AS (
      SELECT 
        date_trunc('month', pv.published_at) AS month,
        a."userId" AS user_id,
        u."displayName",
        COUNT(DISTINCT pv."pageId") AS pages,
        RANK() OVER (PARTITION BY date_trunc('month', pv.published_at) ORDER BY COUNT(DISTINCT pv."pageId") DESC) AS rnk
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      WHERE pv.tags IS NOT NULL
        AND array_length(pv.tags, 1) > 0
        AND NOT (pv.tags @> ARRAY['原创'])
        AND NOT (pv.tags @> ARRAY['作者'])
        AND NOT (pv.tags @> ARRAY['掩盖页'])
        AND NOT (pv.tags @> ARRAY['段落'])
        AND NOT (pv.tags @> ARRAY['补充材料'])
        AND NOT (pv.category IN ('log-of-anomalous-items-cn','short-stories'))
      GROUP BY month, a."userId", u."displayName"
      HAVING COUNT(DISTINCT pv."pageId") >= ${MIN_PAGES_FOR_AUTHOR_COUNT_MONTH}
    )
    SELECT month, user_id AS "userId", pages, "displayName"
    FROM aggregated
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: 'all_translations',
    period: new Date(r.month).toISOString().slice(0, 7),
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.pages),
    metric: 'author_translation_count',
    pageId: null
  }));
}

async function getTagCreationWordsLeadersByYear(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    tag: string;
    userId: number;
    displayName: string | null;
    words: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id,
        pv."pageId",
        pv.tags,
        pv.category,
        ${PUBLISHED_AT_SQL} AS published_at,
        LENGTH(COALESCE(pv.source, '')) AS len
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    tagged AS (
      SELECT 
        pv.id AS page_ver_id,
        pv."pageId" AS page_id,
        pv.tags AS all_tags,
        unnest(pv.tags) AS tag,
        pv.len
      FROM pv
      WHERE pv.tags IS NOT NULL AND array_length(pv.tags, 1) > 0
    ),
    aggregated AS (
      SELECT 
        t.tag,
        a."userId" AS user_id,
        SUM(t.len) AS words,
        RANK() OVER (PARTITION BY t.tag ORDER BY SUM(t.len) DESC) AS rnk
      FROM tagged t
      JOIN "Attribution" a ON a."pageVerId" = t.page_ver_id AND a."userId" IS NOT NULL
      WHERE NOT (t.tag = ANY(${BASE_TAGS_WITHOUT_ORIGINAL}))
        AND (t.all_tags @> ARRAY['原创'])
      GROUP BY t.tag, a."userId"
      HAVING SUM(t.len) > 0
    )
    SELECT tag, user_id AS "userId", words, u."displayName"
    FROM aggregated ag
    LEFT JOIN "User" u ON u.id = ag.user_id
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: r.tag,
    period: `${year}`,
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.words),
    metric: 'author_creation_words',
    pageId: null
  }));
}

async function getTagCreationWordsLeadersByMonth(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    tag: string;
    month: Date;
    userId: number;
    displayName: string | null;
    words: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id,
        pv."pageId",
        pv.tags,
        pv.category,
        ${PUBLISHED_AT_SQL} AS published_at,
        LENGTH(COALESCE(pv.source, '')) AS len
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    tagged AS (
      SELECT 
        pv.id AS page_ver_id,
        pv."pageId" AS page_id,
        pv.tags AS all_tags,
        date_trunc('month', pv.published_at) AS month,
        unnest(pv.tags) AS tag,
        pv.len
      FROM pv
      WHERE pv.tags IS NOT NULL AND array_length(pv.tags, 1) > 0
    ),
    aggregated AS (
      SELECT 
        t.tag,
        t.month,
        a."userId" AS user_id,
        SUM(t.len) AS words,
        RANK() OVER (PARTITION BY t.tag, t.month ORDER BY SUM(t.len) DESC) AS rnk
      FROM tagged t
      JOIN "Attribution" a ON a."pageVerId" = t.page_ver_id AND a."userId" IS NOT NULL
      WHERE NOT (t.tag = ANY(${BASE_TAGS_WITHOUT_ORIGINAL}))
        AND (t.all_tags @> ARRAY['原创'])
      GROUP BY t.tag, t.month, a."userId"
      HAVING SUM(t.len) > 0
    )
    SELECT tag, month, user_id AS "userId", words, u."displayName"
    FROM aggregated ag
    LEFT JOIN "User" u ON u.id = ag.user_id
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: r.tag,
    period: new Date(r.month).toISOString().slice(0, 7),
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.words),
    metric: 'author_creation_words',
    pageId: null
  }));
}

async function getOriginalCategoryRatingLeadersByYear(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    tag: string;
    userId: number;
    displayName: string | null;
    ratingSum: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id,
        pv."pageId",
        pv.tags,
        pv.rating,
        ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.rating IS NOT NULL
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
        AND pv.tags IS NOT NULL
        AND array_length(pv.tags, 1) > 0
        AND pv.tags @> ARRAY['原创']
    ),
    tagged AS (
      SELECT
        date_trunc('year', pv.published_at) AS period,
        tag.tag AS category,
        pv.rating,
        a."userId",
        u."displayName"
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      JOIN LATERAL unnest(pv.tags) AS tag(tag) ON TRUE
      LEFT JOIN "User" u ON u.id = a."userId"
      WHERE tag.tag = ANY(${ORIGINAL_CATEGORY_TAGS})
    ),
    aggregated AS (
      SELECT
        period,
        category,
        "userId",
        "displayName",
        SUM(rating) AS rating_sum
      FROM tagged
      GROUP BY period, category, "userId", "displayName"
    ),
    ranked AS (
      SELECT
        period,
        category,
        "userId",
        "displayName",
        rating_sum,
        RANK() OVER (PARTITION BY category, period ORDER BY rating_sum DESC) AS rnk
      FROM aggregated
    )
    SELECT 
      category AS tag,
      period,
      "userId",
      "displayName",
      rating_sum AS "ratingSum"
    FROM ranked
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: r.tag,
    period: `${year}`,
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.ratingSum),
    metric: 'author_original_category_rating_year',
    pageId: null
  }));
}

async function getOriginalCategoryRatingLeadersByMonth(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    tag: string;
    month: Date;
    userId: number;
    displayName: string | null;
    ratingSum: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id,
        pv."pageId",
        pv.tags,
        pv.rating,
        ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.rating IS NOT NULL
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
        AND pv.tags IS NOT NULL
        AND array_length(pv.tags, 1) > 0
        AND pv.tags @> ARRAY['原创']
    ),
    tagged AS (
      SELECT
        date_trunc('month', pv.published_at) AS month,
        tag.tag AS category,
        pv.rating,
        a."userId",
        u."displayName"
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      JOIN LATERAL unnest(pv.tags) AS tag(tag) ON TRUE
      LEFT JOIN "User" u ON u.id = a."userId"
      WHERE tag.tag = ANY(${ORIGINAL_CATEGORY_TAGS})
    ),
    aggregated AS (
      SELECT
        month,
        category,
        "userId",
        "displayName",
        SUM(rating) AS rating_sum
      FROM tagged
      GROUP BY month, category, "userId", "displayName"
    ),
    ranked AS (
      SELECT
        month,
        category,
        "userId",
        "displayName",
        rating_sum,
        RANK() OVER (PARTITION BY category, month ORDER BY rating_sum DESC) AS rnk
      FROM aggregated
    )
    SELECT 
      category AS tag,
      month,
      "userId",
      "displayName",
      rating_sum AS "ratingSum"
    FROM ranked
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: r.tag,
    period: new Date(r.month).toISOString().slice(0, 7),
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.ratingSum),
    metric: 'author_original_category_rating_month',
    pageId: null
  }));
}

async function getTagTranslationWordsLeadersByYear(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    userId: number;
    displayName: string | null;
    words: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id,
        pv."pageId",
        pv.tags,
        pv.category,
        ${PUBLISHED_AT_SQL} AS published_at,
        LENGTH(COALESCE(pv.source, '')) AS len
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    aggregated AS (
      SELECT 
        date_trunc('year', pv.published_at) AS period,
        a."userId" AS user_id,
        u."displayName",
        SUM(pv.len) AS words,
        RANK() OVER (PARTITION BY date_trunc('year', pv.published_at) ORDER BY SUM(pv.len) DESC) AS rnk
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      WHERE pv.tags IS NOT NULL
        AND array_length(pv.tags, 1) > 0
        AND NOT (pv.tags @> ARRAY['原创'])
        AND NOT (pv.tags @> ARRAY['作者'])
        AND NOT (pv.tags @> ARRAY['掩盖页'])
        AND NOT (pv.tags @> ARRAY['段落'])
        AND NOT (pv.tags @> ARRAY['补充材料'])
        AND NOT (pv.category IN ('log-of-anomalous-items-cn','short-stories'))
      GROUP BY period, a."userId", u."displayName"
      HAVING SUM(pv.len) > 0
    )
    SELECT period::text, user_id AS "userId", words, "displayName"
    FROM aggregated
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: 'all_translations',
    period: `${year}`,
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.words),
    metric: 'author_translation_words',
    pageId: null
  }));
}

async function getTagTranslationWordsLeadersByMonth(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    month: Date;
    userId: number;
    displayName: string | null;
    words: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id,
        pv."pageId",
        pv.tags,
        pv.category,
        ${PUBLISHED_AT_SQL} AS published_at,
        LENGTH(COALESCE(pv.source, '')) AS len
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    aggregated AS (
      SELECT 
        date_trunc('month', pv.published_at) AS month,
        a."userId" AS user_id,
        u."displayName",
        SUM(pv.len) AS words,
        RANK() OVER (PARTITION BY date_trunc('month', pv.published_at) ORDER BY SUM(pv.len) DESC) AS rnk
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      WHERE pv.tags IS NOT NULL
        AND array_length(pv.tags, 1) > 0
        AND NOT (pv.tags @> ARRAY['原创'])
        AND NOT (pv.tags @> ARRAY['作者'])
        AND NOT (pv.tags @> ARRAY['掩盖页'])
        AND NOT (pv.tags @> ARRAY['段落'])
        AND NOT (pv.tags @> ARRAY['补充材料'])
        AND NOT (pv.category IN ('log-of-anomalous-items-cn','short-stories'))
      GROUP BY month, a."userId", u."displayName"
      HAVING SUM(pv.len) > 0
    )
    SELECT month, user_id AS "userId", words, "displayName"
    FROM aggregated
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: 'all_translations',
    period: new Date(r.month).toISOString().slice(0, 7),
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.words),
    metric: 'author_translation_words',
    pageId: null
  }));
}

async function getTranslationLangCountLeadersByYear(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    tag: string;
    userId: number;
    displayName: string | null;
    pages: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id,
        pv."pageId",
        pv.tags,
        pv.category,
        ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
        AND pv.tags IS NOT NULL
        AND array_length(pv.tags, 1) > 0
        AND NOT (pv.tags @> ARRAY['原创'])
        AND NOT (pv.tags @> ARRAY['作者'])
        AND NOT (pv.tags @> ARRAY['掩盖页'])
        AND NOT (pv.tags @> ARRAY['段落'])
        AND NOT (pv.tags @> ARRAY['补充材料'])
        AND NOT (pv.category IN ('log-of-anomalous-items-cn','short-stories'))
    ),
    tagged AS (
      SELECT 
        date_trunc('year', pv.published_at) AS period,
        lang.tag,
        pv."pageId" AS page_id,
        a."userId",
        u."displayName"
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      JOIN LATERAL (
        SELECT unnest(
          CASE 
            WHEN EXISTS (SELECT 1 FROM unnest(pv.tags) t WHERE t = ANY(${TRANSLATION_LANG_TAGS}))
              THEN (SELECT array_agg(t) FROM unnest(pv.tags) t WHERE t = ANY(${TRANSLATION_LANG_TAGS}))
            ELSE ARRAY['en']
          END
        ) AS tag
      ) lang ON TRUE
    ),
    filtered AS (
      SELECT * FROM tagged WHERE tag = ANY(${TRANSLATION_LANG_TAGS})
    ),
    aggregated AS (
      SELECT 
        period,
        tag,
        "userId",
        "displayName",
        COUNT(DISTINCT page_id) AS pages
      FROM filtered
      GROUP BY period, tag, "userId", "displayName"
    ),
    ranked AS (
      SELECT 
        period,
        tag,
        "userId",
        "displayName",
        pages,
        RANK() OVER (PARTITION BY tag, period ORDER BY pages DESC) AS rnk
      FROM aggregated
    )
    SELECT 
      tag,
      period,
      "userId",
      "displayName",
      pages
    FROM ranked
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: r.tag,
    period: `${year}`,
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.pages),
    metric: 'translator_lang_count_year',
    pageId: null
  }));
}

async function getTranslationLangCountLeadersByMonth(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    tag: string;
    month: Date;
    userId: number;
    displayName: string | null;
    pages: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id,
        pv."pageId",
        pv.tags,
        pv.category,
        ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
        AND pv.tags IS NOT NULL
        AND array_length(pv.tags, 1) > 0
        AND NOT (pv.tags @> ARRAY['原创'])
        AND NOT (pv.tags @> ARRAY['作者'])
        AND NOT (pv.tags @> ARRAY['掩盖页'])
        AND NOT (pv.tags @> ARRAY['段落'])
        AND NOT (pv.tags @> ARRAY['补充材料'])
        AND NOT (pv.category IN ('log-of-anomalous-items-cn','short-stories'))
    ),
    tagged AS (
      SELECT 
        date_trunc('month', pv.published_at) AS month,
        lang.tag,
        pv."pageId" AS page_id,
        a."userId",
        u."displayName"
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      JOIN LATERAL (
        SELECT unnest(
          CASE 
            WHEN EXISTS (SELECT 1 FROM unnest(pv.tags) t WHERE t = ANY(${TRANSLATION_LANG_TAGS}))
              THEN (SELECT array_agg(t) FROM unnest(pv.tags) t WHERE t = ANY(${TRANSLATION_LANG_TAGS}))
            ELSE ARRAY['en']
          END
        ) AS tag
      ) lang ON TRUE
    ),
    filtered AS (
      SELECT * FROM tagged WHERE tag = ANY(${TRANSLATION_LANG_TAGS})
    ),
    aggregated AS (
      SELECT 
        month,
        tag,
        "userId",
        "displayName",
        COUNT(DISTINCT page_id) AS pages
      FROM filtered
      GROUP BY month, tag, "userId", "displayName"
    ),
    ranked AS (
      SELECT 
        month,
        tag,
        "userId",
        "displayName",
        pages,
        RANK() OVER (PARTITION BY tag, month ORDER BY pages DESC) AS rnk
      FROM aggregated
    )
    SELECT 
      tag,
      month,
      "userId",
      "displayName",
      pages
    FROM ranked
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: r.tag,
    period: new Date(r.month).toISOString().slice(0, 7),
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.pages),
    metric: 'translator_lang_count_month',
    pageId: null
  }));
}

async function getTranslationLangWordsLeadersByYear(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    tag: string;
    userId: number;
    displayName: string | null;
    words: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id,
        pv."pageId",
        pv.tags,
        pv.category,
        LENGTH(COALESCE(pv.source, '')) AS len,
        ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
        AND pv.tags IS NOT NULL
        AND array_length(pv.tags, 1) > 0
        AND NOT (pv.tags @> ARRAY['原创'])
        AND NOT (pv.tags @> ARRAY['作者'])
        AND NOT (pv.tags @> ARRAY['掩盖页'])
        AND NOT (pv.tags @> ARRAY['段落'])
        AND NOT (pv.tags @> ARRAY['补充材料'])
        AND NOT (pv.category IN ('log-of-anomalous-items-cn','short-stories'))
    ),
    tagged AS (
      SELECT 
        date_trunc('year', pv.published_at) AS period,
        lang.tag,
        pv.len,
        a."userId",
        u."displayName"
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      JOIN LATERAL (
        SELECT unnest(
          CASE 
            WHEN EXISTS (SELECT 1 FROM unnest(pv.tags) t WHERE t = ANY(${TRANSLATION_LANG_TAGS}))
              THEN (SELECT array_agg(t) FROM unnest(pv.tags) t WHERE t = ANY(${TRANSLATION_LANG_TAGS}))
            ELSE ARRAY['en']
          END
        ) AS tag
      ) lang ON TRUE
    ),
    filtered AS (
      SELECT * FROM tagged WHERE tag = ANY(${TRANSLATION_LANG_TAGS})
    ),
    aggregated AS (
      SELECT 
        period,
        tag,
        "userId",
        "displayName",
        SUM(len) AS words
      FROM filtered
      GROUP BY period, tag, "userId", "displayName"
    ),
    ranked AS (
      SELECT 
        period,
        tag,
        "userId",
        "displayName",
        words,
        RANK() OVER (PARTITION BY tag, period ORDER BY words DESC) AS rnk
      FROM aggregated
    )
    SELECT 
      tag,
      period,
      "userId",
      "displayName",
      words
    FROM ranked
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: r.tag,
    period: `${year}`,
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.words),
    metric: 'translator_lang_words_year',
    pageId: null
  }));
}

async function getTranslationLangWordsLeadersByMonth(year: number): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    tag: string;
    month: Date;
    userId: number;
    displayName: string | null;
    words: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id,
        pv."pageId",
        pv.tags,
        pv.category,
        LENGTH(COALESCE(pv.source, '')) AS len,
        ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
        AND pv.tags IS NOT NULL
        AND array_length(pv.tags, 1) > 0
        AND NOT (pv.tags @> ARRAY['原创'])
        AND NOT (pv.tags @> ARRAY['作者'])
        AND NOT (pv.tags @> ARRAY['掩盖页'])
        AND NOT (pv.tags @> ARRAY['段落'])
        AND NOT (pv.tags @> ARRAY['补充材料'])
        AND NOT (pv.category IN ('log-of-anomalous-items-cn','short-stories'))
    ),
    tagged AS (
      SELECT 
        date_trunc('month', pv.published_at) AS month,
        lang.tag,
        pv.len,
        a."userId",
        u."displayName"
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      JOIN LATERAL (
        SELECT unnest(
          CASE 
            WHEN EXISTS (SELECT 1 FROM unnest(pv.tags) t WHERE t = ANY(${TRANSLATION_LANG_TAGS}))
              THEN (SELECT array_agg(t) FROM unnest(pv.tags) t WHERE t = ANY(${TRANSLATION_LANG_TAGS}))
            ELSE ARRAY['en']
          END
        ) AS tag
      ) lang ON TRUE
    ),
    filtered AS (
      SELECT * FROM tagged WHERE tag = ANY(${TRANSLATION_LANG_TAGS})
    ),
    aggregated AS (
      SELECT 
        month,
        tag,
        "userId",
        "displayName",
        SUM(len) AS words
      FROM filtered
      GROUP BY month, tag, "userId", "displayName"
    ),
    ranked AS (
      SELECT 
        month,
        tag,
        "userId",
        "displayName",
        words,
        RANK() OVER (PARTITION BY tag, month ORDER BY words DESC) AS rnk
      FROM aggregated
    )
    SELECT 
      tag,
      month,
      "userId",
      "displayName",
      words
    FROM ranked
    WHERE rnk = 1
  `;

  return rows.map((r) => ({
    tag: r.tag,
    period: new Date(r.month).toISOString().slice(0, 7),
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.words),
    metric: 'translator_lang_words_month',
    pageId: null
  }));
}

function eventTagConditionSql() {
  return `(
    t ~ '(竞赛|征文|大赛)$'
    OR t LIKE '看图说话-%'
    OR (t ~ '\\\\d{3,}' AND t NOT ILIKE '%site%')
  )`;
}

async function getComboRatingLeaders(year: number, period: 'year' | 'month'): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const bucket = period === 'year' ? 'year' : 'month';
  const rows = await prisma.$queryRaw<Array<{
    combo: string;
    period: Date;
    pageId: number;
    userId: number;
    displayName: string | null;
    rating: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id,
        pv."pageId",
        pv.tags,
        pv.rating,
        LENGTH(COALESCE(pv.source, '')) AS len,
        ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.rating IS NOT NULL
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    info AS (
      SELECT 
        date_trunc(${bucket}, published_at) AS period,
        CASE WHEN pv.tags @> ARRAY['原创'] THEN '原创' ELSE '翻译' END AS origin,
        CASE WHEN pv.tags @> ARRAY['原创'] THEN NULL ELSE COALESCE(
          (SELECT t FROM unnest(pv.tags) t WHERE t = ANY(${TRANSLATION_LANG_TAGS}) LIMIT 1),
          'en'
        ) END AS lang_tag,
        (SELECT t FROM unnest(pv.tags) t WHERE t = ANY(${CONTENT_TYPE_TAGS}) LIMIT 1) AS content_tag,
        (SELECT t FROM unnest(pv.tags) t WHERE ${Prisma.raw(eventTagConditionSql())} LIMIT 1) AS event_tag,
        (SELECT t FROM unnest(pv.tags) t WHERE t = ANY(${OBJECT_CLASS_TAGS}) LIMIT 1) AS class_tag,
        pv.rating,
        pv.len,
        pv."pageId",
        a."userId",
        u."displayName"
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
    ),
    combos AS (
      SELECT 
        period,
        rating,
        len,
        "pageId",
        "userId",
        "displayName",
        unnest(array_remove(ARRAY[
          origin,
          CASE WHEN origin = '翻译' AND lang_tag IS NOT NULL THEN origin || '|' || lang_tag END,
          CASE WHEN content_tag IS NOT NULL THEN
            CASE WHEN origin = '翻译' AND lang_tag IS NOT NULL
              THEN origin || '|' || lang_tag || '|' || content_tag
              ELSE origin || '|' || content_tag
            END
          END,
          CASE WHEN content_tag IS NOT NULL AND event_tag IS NOT NULL THEN
            CASE WHEN origin = '翻译' AND lang_tag IS NOT NULL
              THEN origin || '|' || lang_tag || '|' || content_tag || '|' || event_tag
              ELSE origin || '|' || content_tag || '|' || event_tag
            END
          END,
          CASE WHEN content_tag IS NOT NULL AND class_tag IS NOT NULL THEN
            CASE WHEN origin = '翻译' AND lang_tag IS NOT NULL
              THEN origin || '|' || lang_tag || '|' || content_tag || '|' || class_tag
              ELSE origin || '|' || content_tag || '|' || class_tag
            END
          END,
          CASE WHEN content_tag IS NOT NULL AND event_tag IS NOT NULL AND class_tag IS NOT NULL THEN
            CASE WHEN origin = '翻译' AND lang_tag IS NOT NULL
              THEN origin || '|' || lang_tag || '|' || content_tag || '|' || event_tag || '|' || class_tag
              ELSE origin || '|' || content_tag || '|' || event_tag || '|' || class_tag
            END
          END
        ], NULL)) AS combo
      FROM info
    ),
    ranked AS (
      SELECT 
        combo,
        period,
        "pageId",
        "userId",
        "displayName",
        rating,
        RANK() OVER (PARTITION BY combo, period ORDER BY rating DESC) AS rnk
      FROM combos
      WHERE rating IS NOT NULL
    )
    SELECT combo, period, "pageId", "userId", "displayName", rating
    FROM ranked
    WHERE rnk = 1
  `;

  const metric = period === 'year' ? 'combo_rating_best_year' : 'combo_rating_best_month';
  return rows.map((r) => ({
    tag: r.combo,
    period: period === 'year' ? String(year) : new Date(r.period).toISOString().slice(0, 7),
    pageId: Number(r.pageId),
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.rating),
    metric
  }));
}

async function getComboAggregateLeaders(
  year: number,
  period: 'year' | 'month',
  agg: 'count' | 'words'
): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const bucket = period === 'year' ? 'year' : 'month';
  const rows = await prisma.$queryRaw<Array<{
    combo: string;
    period: Date;
    userId: number;
    displayName: string | null;
    val: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id,
        pv."pageId",
        pv.tags,
        LENGTH(COALESCE(pv.source, '')) AS len,
        ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    info AS (
      SELECT 
        date_trunc(${bucket}, published_at) AS period,
        CASE WHEN pv.tags @> ARRAY['原创'] THEN '原创' ELSE '翻译' END AS origin,
        CASE WHEN pv.tags @> ARRAY['原创'] THEN NULL ELSE COALESCE(
          (SELECT t FROM unnest(pv.tags) t WHERE t = ANY(${TRANSLATION_LANG_TAGS}) LIMIT 1),
          'en'
        ) END AS lang_tag,
        (SELECT t FROM unnest(pv.tags) t WHERE t = ANY(${CONTENT_TYPE_TAGS}) LIMIT 1) AS content_tag,
        (SELECT t FROM unnest(pv.tags) t WHERE ${Prisma.raw(eventTagConditionSql())} LIMIT 1) AS event_tag,
        (SELECT t FROM unnest(pv.tags) t WHERE t = ANY(${OBJECT_CLASS_TAGS}) LIMIT 1) AS class_tag,
        pv.len,
        pv."pageId",
        a."userId",
        u."displayName"
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
    ),
    combos AS (
      SELECT 
        period,
        len,
        "pageId",
        "userId",
        "displayName",
        unnest(array_remove(ARRAY[
          origin,
          CASE WHEN origin = '翻译' AND lang_tag IS NOT NULL THEN origin || '|' || lang_tag END,
          CASE WHEN content_tag IS NOT NULL THEN
            CASE WHEN origin = '翻译' AND lang_tag IS NOT NULL
              THEN origin || '|' || lang_tag || '|' || content_tag
              ELSE origin || '|' || content_tag
            END
          END,
          CASE WHEN content_tag IS NOT NULL AND event_tag IS NOT NULL THEN
            CASE WHEN origin = '翻译' AND lang_tag IS NOT NULL
              THEN origin || '|' || lang_tag || '|' || content_tag || '|' || event_tag
              ELSE origin || '|' || content_tag || '|' || event_tag
            END
          END,
          CASE WHEN content_tag IS NOT NULL AND class_tag IS NOT NULL THEN
            CASE WHEN origin = '翻译' AND lang_tag IS NOT NULL
              THEN origin || '|' || lang_tag || '|' || content_tag || '|' || class_tag
              ELSE origin || '|' || content_tag || '|' || class_tag
            END
          END,
          CASE WHEN content_tag IS NOT NULL AND event_tag IS NOT NULL AND class_tag IS NOT NULL THEN
            CASE WHEN origin = '翻译' AND lang_tag IS NOT NULL
              THEN origin || '|' || lang_tag || '|' || content_tag || '|' || event_tag || '|' || class_tag
              ELSE origin || '|' || content_tag || '|' || event_tag || '|' || class_tag
            END
          END
        ], NULL)) AS combo
      FROM info
    ),
    aggregated AS (
      SELECT 
        combo,
        period,
        "userId",
        "displayName",
        ${Prisma.raw(agg === 'count' ? 'COUNT(DISTINCT "pageId")' : 'SUM(len)')} AS val
      FROM combos
      GROUP BY combo, period, "userId", "displayName"
    ),
    ranked AS (
      SELECT 
        combo,
        period,
        "userId",
        "displayName",
        val,
        RANK() OVER (PARTITION BY combo, period ORDER BY val DESC) AS rnk
      FROM aggregated
    )
    SELECT combo, period, "userId", "displayName", val
    FROM ranked
    WHERE rnk = 1
  `;

  const metric =
    agg === 'count'
      ? period === 'year'
        ? 'combo_pages_count_year'
        : 'combo_pages_count_month'
      : period === 'year'
      ? 'combo_words_sum_year'
      : 'combo_words_sum_month';

  return rows.map((r) => ({
    tag: r.combo,
    period: period === 'year' ? String(year) : new Date(r.period).toISOString().slice(0, 7),
    pageId: null,
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.val),
    metric
  }));
}

async function getComboShortestLeaders(year: number, period: 'year' | 'month'): Promise<TagLeader[]> {
  const { startTzIso, endTzIso } = yearRange(year);
  const bucket = period === 'year' ? 'year' : 'month';
  const rows = await prisma.$queryRaw<Array<{
    combo: string;
    period: Date;
    pageId: number;
    userId: number;
    displayName: string | null;
    len: number;
  }>>`
    WITH pv AS (
      SELECT 
        pv.id,
        pv."pageId",
        pv.tags,
        LENGTH(COALESCE(pv.source, '')) AS len,
        ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.source IS NOT NULL
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz
        AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    info AS (
      SELECT 
        date_trunc(${bucket}, published_at) AS period,
        CASE WHEN pv.tags @> ARRAY['原创'] THEN '原创' ELSE '翻译' END AS origin,
        CASE WHEN pv.tags @> ARRAY['原创'] THEN NULL ELSE COALESCE(
          (SELECT t FROM unnest(pv.tags) t WHERE t = ANY(${TRANSLATION_LANG_TAGS}) LIMIT 1),
          'en'
        ) END AS lang_tag,
        (SELECT t FROM unnest(pv.tags) t WHERE t = ANY(${CONTENT_TYPE_TAGS}) LIMIT 1) AS content_tag,
        (SELECT t FROM unnest(pv.tags) t WHERE ${Prisma.raw(eventTagConditionSql())} LIMIT 1) AS event_tag,
        (SELECT t FROM unnest(pv.tags) t WHERE t = ANY(${OBJECT_CLASS_TAGS}) LIMIT 1) AS class_tag,
        pv.len,
        pv."pageId",
        a."userId",
        u."displayName"
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
    ),
    combos AS (
      SELECT 
        period,
        len,
        "pageId",
        "userId",
        "displayName",
        unnest(array_remove(ARRAY[
          origin,
          CASE WHEN origin = '翻译' AND lang_tag IS NOT NULL THEN origin || '|' || lang_tag END,
          CASE WHEN content_tag IS NOT NULL THEN
            CASE WHEN origin = '翻译' AND lang_tag IS NOT NULL
              THEN origin || '|' || lang_tag || '|' || content_tag
              ELSE origin || '|' || content_tag
            END
          END,
          CASE WHEN content_tag IS NOT NULL AND event_tag IS NOT NULL THEN
            CASE WHEN origin = '翻译' AND lang_tag IS NOT NULL
              THEN origin || '|' || lang_tag || '|' || content_tag || '|' || event_tag
              ELSE origin || '|' || content_tag || '|' || event_tag
            END
          END,
          CASE WHEN content_tag IS NOT NULL AND class_tag IS NOT NULL THEN
            CASE WHEN origin = '翻译' AND lang_tag IS NOT NULL
              THEN origin || '|' || lang_tag || '|' || content_tag || '|' || class_tag
              ELSE origin || '|' || content_tag || '|' || class_tag
            END
          END,
          CASE WHEN content_tag IS NOT NULL AND event_tag IS NOT NULL AND class_tag IS NOT NULL THEN
            CASE WHEN origin = '翻译' AND lang_tag IS NOT NULL
              THEN origin || '|' || lang_tag || '|' || content_tag || '|' || event_tag || '|' || class_tag
              ELSE origin || '|' || content_tag || '|' || event_tag || '|' || class_tag
            END
          END
        ], NULL)) AS combo
      FROM info
    ),
    ranked AS (
      SELECT 
        combo,
        period,
        "pageId",
        "userId",
        "displayName",
        len,
        RANK() OVER (PARTITION BY combo, period ORDER BY len ASC) AS rnk
      FROM combos
      WHERE len IS NOT NULL
    )
    SELECT combo, period, "pageId", "userId", "displayName", len
    FROM ranked
    WHERE rnk = 1
  `;

  const metric = period === 'year' ? 'combo_shortest_year' : 'combo_shortest_month';
  return rows.map((r) => ({
    tag: r.combo,
    period: period === 'year' ? String(year) : new Date(r.period).toISOString().slice(0, 7),
    pageId: Number(r.pageId),
    userId: Number(r.userId),
    displayName: r.displayName,
    value: Number(r.len),
    metric
  }));
}

// ============ 导出函数：生成用户成就数据 ============
export interface GenerateUserFirstsOptions {
  concurrency?: number;
  silent?: boolean;
  ultra?: boolean;
}

export async function generateUserFirstsData(
  year: number,
  options: GenerateUserFirstsOptions = {}
): Promise<ScoredLeader[]> {
  const { concurrency = QUERY_CONCURRENCY, silent = false, ultra = false } = options;

  const log = silent ? () => {} : console.log.bind(console);

  log('\n=== User Firsts Analysis (Library Mode) ===');
  log(`Year: ${year}`);
  log(`Query Concurrency: ${ultra ? '46 (all at once)' : concurrency}`);

  // 预计算：创建临时表
  log('Phase 1: Precomputing base data...');
  await Promise.all([
    createBaseTempTable(year),
    createVoteTempTable(year)
  ]);

  log('\nPhase 2: Running leader queries...');
  const activeUsersPromise = getActiveUsersForYear(year);
  const tagPopularityPromise = getTagPopularity();

  // 定义所有查询任务（46个）
  const queryTasks = [
    () => getTagLeadersByYear(year),
    () => getTagLeadersByMonth(year),
    () => getTagLeadersByWeek(year),
    () => getAuthorReceivedVotesByPeriod(year, 'year'),
    () => getAuthorReceivedVotesByPeriod(year, 'month'),
    () => getAuthorReceivedVotesByPeriod(year, 'week'),
    () => getTagVoterLeadersByYear(year),
    () => getTagVoterLeadersByMonth(year),
    () => getTagVoterLeadersByDay(year),
    () => getDailyAuthorScoreLeaders(year),
    () => getDailyVoterCountLeaders(year),
    () => getWeeklyAuthorScoreLeaders(year),
    () => getWeeklyVoterCountLeaders(year),
    () => getAuthorPageCountLeaders(year),
    () => getAuthorPageCountLeadersByMonth(year),
    () => getLongestPageLeaders(year),
    () => getLongestPageLeadersByMonth(year),
    () => getShortestPageLeaders(year),
    () => getShortestPageLeadersByMonth(year),
    () => getAuthorImageCountLeaders(year),
    () => getMostCommentedNewPage(year),
    () => getCoauthorPageCountLeaders(year),
    () => getCoauthorPartnerCountLeaders(year),
    () => getTagCreationCountLeadersByYear(year),
    () => getTagCreationCountLeadersByMonth(year),
    () => getTagTranslationCountLeadersByYear(year),
    () => getTagTranslationCountLeadersByMonth(year),
    () => getTagCreationWordsLeadersByYear(year),
    () => getTagCreationWordsLeadersByMonth(year),
    () => getOriginalCategoryRatingLeadersByYear(year),
    () => getOriginalCategoryRatingLeadersByMonth(year),
    () => getTagTranslationWordsLeadersByYear(year),
    () => getTagTranslationWordsLeadersByMonth(year),
    () => getTranslationLangCountLeadersByYear(year),
    () => getTranslationLangCountLeadersByMonth(year),
    () => getTranslationLangWordsLeadersByYear(year),
    () => getTranslationLangWordsLeadersByMonth(year),
    () => getComboRatingLeaders(year, 'year'),
    () => getComboRatingLeaders(year, 'month'),
    () => getComboAggregateLeaders(year, 'year', 'count'),
    () => getComboAggregateLeaders(year, 'month', 'count'),
    () => getComboAggregateLeaders(year, 'year', 'words'),
    () => getComboAggregateLeaders(year, 'month', 'words'),
    () => getComboShortestLeaders(year, 'year'),
    () => getComboShortestLeaders(year, 'month')
  ];

  log(`  Executing ${queryTasks.length} queries...`);

  const [
    tagYearLeaders,
    tagMonthLeaders,
    tagWeekLeaders,
    authorReceivedYear,
    authorReceivedMonth,
    authorReceivedWeek,
    tagVoterYearLeaders,
    tagVoterMonthLeaders,
    tagVoterDayLeaders,
    dailyAuthorLeaders,
    dailyVoterLeaders,
    weeklyAuthorLeaders,
    weeklyVoterLeaders,
    authorPageCountYear,
    authorPageCountMonth,
    longestPageYear,
    longestPageMonth,
    shortestPageYear,
    shortestPageMonth,
    imageCountYear,
    mostCommented,
    coauthorPages,
    coauthorPartners,
    creationCountYear,
    creationCountMonth,
    translationCountYear,
    translationCountMonth,
    creationWordsYear,
    creationWordsMonth,
    originalCategoryRatingYear,
    originalCategoryRatingMonth,
    translationWordsYear,
    translationWordsMonth,
    translationLangCountYear,
    translationLangCountMonth,
    translationLangWordsYear,
    translationLangWordsMonth,
    comboRatingYear,
    comboRatingMonth,
    comboCountYear,
    comboCountMonth,
    comboWordsYear,
    comboWordsMonth,
    comboShortestYear,
    comboShortestMonth
  ] = ultra
    ? await runAllParallel(queryTasks, 'Leaders')
    : await runInBatches(queryTasks, concurrency, 'Leaders');

  const [activeUsers, tagPopularity] = await Promise.all([activeUsersPromise, tagPopularityPromise]);

  const combinedAuthors = [
    ...tagYearLeaders,
    ...tagMonthLeaders,
    ...tagWeekLeaders,
    ...authorPageCountYear,
    ...authorPageCountMonth,
    ...longestPageYear,
    ...longestPageMonth,
    ...shortestPageYear,
    ...shortestPageMonth,
    ...imageCountYear,
    ...mostCommented,
    ...coauthorPages,
    ...coauthorPartners,
    ...creationCountYear,
    ...creationCountMonth,
    ...translationCountYear,
    ...translationCountMonth,
    ...creationWordsYear,
    ...creationWordsMonth,
    ...originalCategoryRatingYear,
    ...originalCategoryRatingMonth,
    ...translationLangCountYear,
    ...translationLangCountMonth,
    ...translationLangWordsYear,
    ...translationLangWordsMonth,
    ...comboRatingYear,
    ...comboRatingMonth,
    ...comboCountYear,
    ...comboCountMonth,
    ...comboWordsYear,
    ...comboWordsMonth,
    ...comboShortestYear,
    ...comboShortestMonth,
    ...translationWordsYear,
    ...translationWordsMonth,
    ...authorReceivedYear,
    ...authorReceivedMonth,
    ...authorReceivedWeek
  ];
  const combinedAll = [
    ...combinedAuthors,
    ...tagVoterYearLeaders,
    ...tagVoterMonthLeaders,
    ...tagVoterDayLeaders,
    ...dailyAuthorLeaders,
    ...dailyVoterLeaders,
    ...weeklyAuthorLeaders,
    ...weeklyVoterLeaders
  ];

  const scoredAll = scoreLeaders(combinedAll, tagPopularity);

  if (!silent) {
    log('=== Coverage ===');
    log({
      year,
      activeUsers: activeUsers.size,
      totalLeaders: scoredAll.length,
      uniqueUsers: new Set(scoredAll.map(l => l.userId)).size,
      coverageRate: `${((new Set(scoredAll.map(l => l.userId)).size / activeUsers.size) * 100).toFixed(1)}%`
    });
  }

  return scoredAll;
}

async function main() {
  const refresh = process.argv.includes('--refresh');
  const ultra = process.argv.includes('--ultra');  // 极限并行模式
  const userArgIndex = process.argv.indexOf('--user');
  const userQuery = userArgIndex >= 0 ? process.argv[userArgIndex + 1] : null;

  // 启动信息
  console.log('\n=== User Firsts Analysis ===');
  console.log(`Year: ${YEAR}`);
  console.log(`Mode: ${ultra ? 'ULTRA (all parallel)' : TURBO_MODE ? 'TURBO' : 'Standard'}`);
  console.log(`Query Concurrency: ${ultra ? '46 (all at once)' : QUERY_CONCURRENCY}`);
  console.log(`Options: refresh=${refresh}, user=${userQuery || 'none'}`);
  console.log('');

  if (userQuery && !refresh && fs.existsSync(OUTPUT_PATH)) {
    const cached = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
    const scoredAll = cached.leaders as ScoredLeader[];
    await queryUserFirsts(userQuery, scoredAll);
    return;
  }

  const totalStartTime = Date.now();

  // 预计算：创建临时表
  console.log('Phase 1: Precomputing base data...');
  await Promise.all([
    createBaseTempTable(YEAR),
    createVoteTempTable(YEAR)
  ]);

  console.log('\nPhase 2: Running leader queries...');
  const activeUsersPromise = getActiveUsersForYear(YEAR);
  const tagPopularityPromise = getTagPopularity();

  // 定义所有查询任务（46个）
  const queryTasks = [
    () => getTagLeadersByYear(YEAR),
    () => getTagLeadersByMonth(YEAR),
    () => getTagLeadersByWeek(YEAR),
    () => getAuthorReceivedVotesByPeriod(YEAR, 'year'),
    () => getAuthorReceivedVotesByPeriod(YEAR, 'month'),
    () => getAuthorReceivedVotesByPeriod(YEAR, 'week'),
    () => getTagVoterLeadersByYear(YEAR),
    () => getTagVoterLeadersByMonth(YEAR),
    () => getTagVoterLeadersByDay(YEAR),
    () => getDailyAuthorScoreLeaders(YEAR),
    () => getDailyVoterCountLeaders(YEAR),
    () => getWeeklyAuthorScoreLeaders(YEAR),
    () => getWeeklyVoterCountLeaders(YEAR),
    () => getAuthorPageCountLeaders(YEAR),
    () => getAuthorPageCountLeadersByMonth(YEAR),
    () => getLongestPageLeaders(YEAR),
    () => getLongestPageLeadersByMonth(YEAR),
    () => getShortestPageLeaders(YEAR),
    () => getShortestPageLeadersByMonth(YEAR),
    () => getAuthorImageCountLeaders(YEAR),
    () => getMostCommentedNewPage(YEAR),
    () => getCoauthorPageCountLeaders(YEAR),
    () => getCoauthorPartnerCountLeaders(YEAR),
    () => getTagCreationCountLeadersByYear(YEAR),
    () => getTagCreationCountLeadersByMonth(YEAR),
    () => getTagTranslationCountLeadersByYear(YEAR),
    () => getTagTranslationCountLeadersByMonth(YEAR),
    () => getTagCreationWordsLeadersByYear(YEAR),
    () => getTagCreationWordsLeadersByMonth(YEAR),
    () => getOriginalCategoryRatingLeadersByYear(YEAR),
    () => getOriginalCategoryRatingLeadersByMonth(YEAR),
    () => getTagTranslationWordsLeadersByYear(YEAR),
    () => getTagTranslationWordsLeadersByMonth(YEAR),
    () => getTranslationLangCountLeadersByYear(YEAR),
    () => getTranslationLangCountLeadersByMonth(YEAR),
    () => getTranslationLangWordsLeadersByYear(YEAR),
    () => getTranslationLangWordsLeadersByMonth(YEAR),
    () => getComboRatingLeaders(YEAR, 'year'),
    () => getComboRatingLeaders(YEAR, 'month'),
    () => getComboAggregateLeaders(YEAR, 'year', 'count'),
    () => getComboAggregateLeaders(YEAR, 'month', 'count'),
    () => getComboAggregateLeaders(YEAR, 'year', 'words'),
    () => getComboAggregateLeaders(YEAR, 'month', 'words'),
    () => getComboShortestLeaders(YEAR, 'year'),
    () => getComboShortestLeaders(YEAR, 'month')
  ];

  console.log(`  Executing ${queryTasks.length} queries...`);

  // 根据模式选择执行策略并解构结果
  const [
    tagYearLeaders,
    tagMonthLeaders,
    tagWeekLeaders,
    authorReceivedYear,
    authorReceivedMonth,
    authorReceivedWeek,
    tagVoterYearLeaders,
    tagVoterMonthLeaders,
    tagVoterDayLeaders,
    dailyAuthorLeaders,
    dailyVoterLeaders,
    weeklyAuthorLeaders,
    weeklyVoterLeaders,
    authorPageCountYear,
    authorPageCountMonth,
    longestPageYear,
    longestPageMonth,
    shortestPageYear,
    shortestPageMonth,
    imageCountYear,
    mostCommented,
    coauthorPages,
    coauthorPartners,
    creationCountYear,
    creationCountMonth,
    translationCountYear,
    translationCountMonth,
    creationWordsYear,
    creationWordsMonth,
    originalCategoryRatingYear,
    originalCategoryRatingMonth,
    translationWordsYear,
    translationWordsMonth,
    translationLangCountYear,
    translationLangCountMonth,
    translationLangWordsYear,
    translationLangWordsMonth,
    comboRatingYear,
    comboRatingMonth,
    comboCountYear,
    comboCountMonth,
    comboWordsYear,
    comboWordsMonth,
    comboShortestYear,
    comboShortestMonth
  ] = ultra
    ? await runAllParallel(queryTasks, 'Leaders')  // Ultra: 全部并行
    : await runInBatches(queryTasks, QUERY_CONCURRENCY, 'Leaders');  // 标准/Turbo: 分批并行

  const [activeUsers, tagPopularity] = await Promise.all([activeUsersPromise, tagPopularityPromise]);

  const combinedAuthors = [
    ...tagYearLeaders,
    ...tagMonthLeaders,
    ...tagWeekLeaders,
    ...authorPageCountYear,
    ...authorPageCountMonth,
    ...longestPageYear,
    ...longestPageMonth,
    ...shortestPageYear,
    ...shortestPageMonth,
    ...imageCountYear,
    ...mostCommented,
    ...coauthorPages,
    ...coauthorPartners,
    ...creationCountYear,
    ...creationCountMonth,
    ...translationCountYear,
    ...translationCountMonth,
    ...creationWordsYear,
    ...creationWordsMonth,
    ...originalCategoryRatingYear,
    ...originalCategoryRatingMonth,
    ...translationLangCountYear,
    ...translationLangCountMonth,
    ...translationLangWordsYear,
    ...translationLangWordsMonth,
    ...comboRatingYear,
    ...comboRatingMonth,
    ...comboCountYear,
    ...comboCountMonth,
    ...comboWordsYear,
    ...comboWordsMonth,
    ...comboShortestYear,
    ...comboShortestMonth,
    ...translationWordsYear,
    ...translationWordsMonth,
    ...authorReceivedYear,
    ...authorReceivedMonth,
    ...authorReceivedWeek
  ];
  const combinedAll = [
    ...combinedAuthors,
    ...tagVoterYearLeaders,
    ...tagVoterMonthLeaders,
    ...tagVoterDayLeaders,
    ...dailyAuthorLeaders,
    ...dailyVoterLeaders,
    ...weeklyAuthorLeaders,
    ...weeklyVoterLeaders
  ];

  const scoredAll = scoreLeaders(combinedAll, tagPopularity);

  console.log('=== Coverage ===');
  console.log({
    year: YEAR,
    activeUsers: activeUsers.size,
    tagYearLeaders: tagYearLeaders.length,
    tagMonthLeaders: tagMonthLeaders.length,
    tagWeekLeaders: tagWeekLeaders.length,
    tagVoterYearLeaders: tagVoterYearLeaders.length,
    tagVoterMonthLeaders: tagVoterMonthLeaders.length,
    tagVoterDayLeaders: tagVoterDayLeaders.length,
    dailyAuthorLeaders: dailyAuthorLeaders.length,
    dailyVoterLeaders: dailyVoterLeaders.length,
    weeklyAuthorLeaders: weeklyAuthorLeaders.length,
    weeklyVoterLeaders: weeklyVoterLeaders.length,
    authorPageCountYear: authorPageCountYear.length,
    authorPageCountMonth: authorPageCountMonth.length,
    longestPageYear: longestPageYear.length,
    longestPageMonth: longestPageMonth.length,
    shortestPageYear: shortestPageYear.length,
    shortestPageMonth: shortestPageMonth.length,
    imageCountYear: imageCountYear.length,
    mostCommented: mostCommented.length,
    coauthorPages: coauthorPages.length,
    coauthorPartners: coauthorPartners.length,
    creationCountYear: creationCountYear.length,
    creationCountMonth: creationCountMonth.length,
    translationCountYear: translationCountYear.length,
    translationCountMonth: translationCountMonth.length,
    creationWordsYear: creationWordsYear.length,
    creationWordsMonth: creationWordsMonth.length,
    translationWordsYear: translationWordsYear.length,
    translationWordsMonth: translationWordsMonth.length,
    authorReceivedYear: authorReceivedYear.length,
    authorReceivedMonth: authorReceivedMonth.length,
    authorReceivedWeek: authorReceivedWeek.length,
    comboRatingYear: comboRatingYear.length,
    comboRatingMonth: comboRatingMonth.length,
    comboCountYear: comboCountYear.length,
    comboCountMonth: comboCountMonth.length,
    comboWordsYear: comboWordsYear.length,
    comboWordsMonth: comboWordsMonth.length,
    comboShortestYear: comboShortestYear.length,
    comboShortestMonth: comboShortestMonth.length,
    uniqueUsersTagYear: new Set(tagYearLeaders.map((l) => l.userId)).size,
    uniqueUsersTagMonth: new Set(tagMonthLeaders.map((l) => l.userId)).size,
    uniqueUsersTagWeek: new Set(tagWeekLeaders.map((l) => l.userId)).size,
    uniqueUsersAuthorReceivedYear: new Set(authorReceivedYear.map((l) => l.userId)).size,
    uniqueUsersAuthorReceivedMonth: new Set(authorReceivedMonth.map((l) => l.userId)).size,
    uniqueUsersAuthorReceivedWeek: new Set(authorReceivedWeek.map((l) => l.userId)).size,
    uniqueUsersTagVoterYear: new Set(tagVoterYearLeaders.map((l) => l.userId)).size,
    uniqueUsersTagVoterMonth: new Set(tagVoterMonthLeaders.map((l) => l.userId)).size,
    uniqueUsersTagVoterDay: new Set(tagVoterDayLeaders.map((l) => l.userId)).size,
    uniqueUsersDailyAuthor: new Set(dailyAuthorLeaders.map((l) => l.userId)).size,
    uniqueUsersDailyVoter: new Set(dailyVoterLeaders.map((l) => l.userId)).size,
    uniqueUsersWeeklyAuthor: new Set(weeklyAuthorLeaders.map((l) => l.userId)).size,
    uniqueUsersWeeklyVoter: new Set(weeklyVoterLeaders.map((l) => l.userId)).size,
    uniqueUsersAuthorPageCountYear: new Set(authorPageCountYear.map((l) => l.userId)).size,
    uniqueUsersAuthorPageCountMonth: new Set(authorPageCountMonth.map((l) => l.userId)).size,
    uniqueUsersLongestPageYear: new Set(longestPageYear.map((l) => l.userId)).size,
    uniqueUsersLongestPageMonth: new Set(longestPageMonth.map((l) => l.userId)).size,
    uniqueUsersShortestPageYear: new Set(shortestPageYear.map((l) => l.userId)).size,
    uniqueUsersShortestPageMonth: new Set(shortestPageMonth.map((l) => l.userId)).size,
    uniqueUsersImageCountYear: new Set(imageCountYear.map((l) => l.userId)).size,
    uniqueUsersMostCommented: new Set(mostCommented.map((l) => l.userId)).size,
    uniqueUsersCoauthorPages: new Set(coauthorPages.map((l) => l.userId)).size,
    uniqueUsersCoauthorPartners: new Set(coauthorPartners.map((l) => l.userId)).size,
    uniqueUsersCreationCountYear: new Set(creationCountYear.map((l) => l.userId)).size,
    uniqueUsersCreationCountMonth: new Set(creationCountMonth.map((l) => l.userId)).size,
    uniqueUsersTranslationCountYear: new Set(translationCountYear.map((l) => l.userId)).size,
    uniqueUsersTranslationCountMonth: new Set(translationCountMonth.map((l) => l.userId)).size,
    uniqueUsersCreationWordsYear: new Set(creationWordsYear.map((l) => l.userId)).size,
    uniqueUsersCreationWordsMonth: new Set(creationWordsMonth.map((l) => l.userId)).size,
    uniqueUsersTranslationWordsYear: new Set(translationWordsYear.map((l) => l.userId)).size,
    uniqueUsersTranslationWordsMonth: new Set(translationWordsMonth.map((l) => l.userId)).size,
    uniqueUsersComboRatingYear: new Set(comboRatingYear.map((l) => l.userId)).size,
    uniqueUsersComboRatingMonth: new Set(comboRatingMonth.map((l) => l.userId)).size,
    uniqueUsersComboCountYear: new Set(comboCountYear.map((l) => l.userId)).size,
    uniqueUsersComboCountMonth: new Set(comboCountMonth.map((l) => l.userId)).size,
    uniqueUsersComboWordsYear: new Set(comboWordsYear.map((l) => l.userId)).size,
    uniqueUsersComboWordsMonth: new Set(comboWordsMonth.map((l) => l.userId)).size,
    uniqueUsersComboShortestYear: new Set(comboShortestYear.map((l) => l.userId)).size,
    uniqueUsersComboShortestMonth: new Set(comboShortestMonth.map((l) => l.userId)).size,
    coverageFromYear: coverage(activeUsers, tagYearLeaders),
    coverageFromMonth: coverage(activeUsers, tagMonthLeaders),
    coverageFromWeek: coverage(activeUsers, tagWeekLeaders),
    coverageFromVoterYear: coverage(activeUsers, tagVoterYearLeaders),
    coverageFromVoterMonth: coverage(activeUsers, tagVoterMonthLeaders),
    coverageFromVoterDay: coverage(activeUsers, tagVoterDayLeaders),
    coverageFromDailyAuthor: coverage(activeUsers, dailyAuthorLeaders),
    coverageFromDailyVoter: coverage(activeUsers, dailyVoterLeaders),
    coverageFromWeeklyAuthor: coverage(activeUsers, weeklyAuthorLeaders),
    coverageFromWeeklyVoter: coverage(activeUsers, weeklyVoterLeaders),
    coverageFromAuthorPageCountYear: coverage(activeUsers, authorPageCountYear),
    coverageFromAuthorPageCountMonth: coverage(activeUsers, authorPageCountMonth),
    coverageFromLongestPageYear: coverage(activeUsers, longestPageYear),
    coverageFromLongestPageMonth: coverage(activeUsers, longestPageMonth),
    coverageFromShortestPageYear: coverage(activeUsers, shortestPageYear),
    coverageFromShortestPageMonth: coverage(activeUsers, shortestPageMonth),
    coverageFromImageCountYear: coverage(activeUsers, imageCountYear),
    coverageFromMostCommented: coverage(activeUsers, mostCommented),
    coverageFromCoauthorPages: coverage(activeUsers, coauthorPages),
    coverageFromCoauthorPartners: coverage(activeUsers, coauthorPartners),
    coverageFromCreationCountYear: coverage(activeUsers, creationCountYear),
    coverageFromCreationCountMonth: coverage(activeUsers, creationCountMonth),
    coverageFromTranslationCountYear: coverage(activeUsers, translationCountYear),
    coverageFromTranslationCountMonth: coverage(activeUsers, translationCountMonth),
    coverageFromCreationWordsYear: coverage(activeUsers, creationWordsYear),
    coverageFromCreationWordsMonth: coverage(activeUsers, creationWordsMonth),
    coverageFromTranslationWordsYear: coverage(activeUsers, translationWordsYear),
    coverageFromTranslationWordsMonth: coverage(activeUsers, translationWordsMonth),
    coverageFromAuthorReceivedYear: coverage(activeUsers, authorReceivedYear),
    coverageFromAuthorReceivedMonth: coverage(activeUsers, authorReceivedMonth),
    coverageFromAuthorReceivedWeek: coverage(activeUsers, authorReceivedWeek),
    coverageFromComboRatingYear: coverage(activeUsers, comboRatingYear),
    coverageFromComboRatingMonth: coverage(activeUsers, comboRatingMonth),
    coverageFromComboCountYear: coverage(activeUsers, comboCountYear),
    coverageFromComboCountMonth: coverage(activeUsers, comboCountMonth),
    coverageFromComboWordsYear: coverage(activeUsers, comboWordsYear),
    coverageFromComboWordsMonth: coverage(activeUsers, comboWordsMonth),
    coverageFromComboShortestYear: coverage(activeUsers, comboShortestYear),
    coverageFromComboShortestMonth: coverage(activeUsers, comboShortestMonth),
    coverageAuthorsCombined: coverage(activeUsers, combinedAuthors),
    coverageAll: coverage(activeUsers, combinedAll)
  });

  const topYearRaw = scoredAll
    .filter((l) => levelFromPeriod(l.metric, l.period) === 'year')
    .sort((a, b) => b.score - a.score);
  const dedupYear: TagLeader[] = [];
  const seenYear = new Set<string>();
  for (const item of topYearRaw) {
    const key = `${item.metric}|${item.tag}|${item.period}|${item.userId}|${item.value}`;
    if (seenYear.has(key)) continue;
    seenYear.add(key);
    dedupYear.push(item);
    if (dedupYear.length >= 30) break;
  }
  const yearPageMeta = await fetchPageMetaMap(dedupYear);
  console.log('\n=== 年度重磅（按得分前30） ===');
  console.log(
    dedupYear.map((l) => {
      const rendered = renderLeaderView(l, yearPageMeta);
      return {
        metric: l.metric,
        tag: l.tag,
        period: l.period,
        value: l.value,
        text: rendered.text,
        userId: l.userId,
        displayName: l.displayName
      };
    })
  );

  console.log('\n=== 热门标签看板（每标签前5） ===');
  const popularTags = Array.from(tagPopularity.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag);
  const preferredTags = ['原创', '翻译', 'scp', 'goi格式', '故事', 'wanderers', '艺术作品', '文章'];
  const tagRoster = Array.from(new Set([...preferredTags, ...popularTags.slice(0, 10)]));
  for (const tag of tagRoster) {
    const rawList = scoredAll.filter((l) => l.tag === tag).sort((a, b) => b.score - a.score);
    const dedup: TagLeader[] = [];
    const seen = new Set<string>();
    for (const item of rawList) {
      const key = `${item.metric}|${item.tag}|${item.period}|${item.userId}|${item.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dedup.push(item);
      if (dedup.length >= 5) break;
    }
    const list = dedup;
    if (!list.length) continue;
    const tagPageMeta = await fetchPageMetaMap(list);
    console.log(
      `Tag: ${tag}`,
      list.map((l) => {
        const rendered = renderLeaderView(l, tagPageMeta);
        return {
          period: l.period,
          metric: l.metric,
          value: l.value,
          text: rendered.text,
          userId: l.userId,
          displayName: l.displayName
        };
      })
    );
  }

  if (userQuery) {
    await queryUserFirsts(userQuery, scoredAll);
  }

  // Export JSON
  try {
    if (!fs.existsSync(path.dirname(OUTPUT_PATH))) {
      fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    }
    if (fs.existsSync(OUTPUT_PATH) && !refresh) {
      console.log(`\nJSON exists at ${OUTPUT_PATH}. Use --refresh to overwrite.`);
    } else {
      const exportPayload = {
        year: YEAR,
        generatedAt: new Date().toISOString(),
        leaders: scoredAll,
        templates: METRIC_TEMPLATES
      };
      fs.writeFileSync(
        OUTPUT_PATH,
        JSON.stringify(exportPayload, null, 2),
        'utf-8'
      );
      console.log(`\nJSON exported to ${OUTPUT_PATH}${refresh ? ' (refreshed)' : ''}`);
    }
  } catch (err) {
    console.warn('Failed to export JSON:', err);
  }
}

// 仅在直接执行时运行 main()
const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('user-firsts-analysis.ts') ||
  process.argv[1].endsWith('user-firsts-analysis.js')
);

if (isMainModule) {
  main()
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(async () => {
      await disconnectPrisma();
    });
}
