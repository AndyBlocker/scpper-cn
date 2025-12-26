/**
 * Export Annual Summary Data for Web Page
 *
 * This script generates JSON files for the annual summary web page:
 * - site.json: site-wide statistics
 * - users/index.json: user index
 * - users/{id}.json: individual user data
 *
 * Run: npx tsx scripts/export-annual-summary.ts [--year 2025] [--output ../frontend/public/annual-summary]
 */

import { prisma, disconnectPrisma } from '../src/utils/db-connection.ts';
import { Prisma } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import {
  generateUserFirstsData as generateUserFirstsFromAnalysis,
  METRIC_TEMPLATES as IMPORTED_METRIC_TEMPLATES,
  type ScoredLeader,
  type TagLeader
} from './user-firsts-analysis.ts';

const DEFAULT_YEAR = 2025;

// 并发配置：默认模式 vs 激进模式（--turbo）
// 由于 max_connections=400，默认模式已大幅提升
// getUserSummary 内部已并行化（9个查询/用户），所以 USER_BATCH_SIZE 需要考虑总连接数
// 例如：USER_BATCH_SIZE=30 * 9 queries = 270 并发连接
let TURBO_MODE = false;

function getConcurrency() {
  if (TURBO_MODE) {
    return {
      EXPORT_CONCURRENCY: Math.max(1, Math.floor(Number(process.env.ANNUAL_EXPORT_CONCURRENCY || 20))),
      CATEGORY_CONCURRENCY: Math.max(1, Math.floor(Number(process.env.ANNUAL_CATEGORY_CONCURRENCY || 10))),
      CATEGORY_QUERY_CONCURRENCY: Math.max(1, Math.floor(Number(process.env.ANNUAL_CATEGORY_QUERY_CONCURRENCY || 15))),
      USER_BATCH_SIZE: Math.max(1, Math.floor(Number(process.env.ANNUAL_USER_BATCH_SIZE || 40))),  // 40 * 9 = 360 connections
      FIRSTS_QUERY_CONCURRENCY: Math.max(1, Math.floor(Number(process.env.ANNUAL_FIRSTS_CONCURRENCY || 50)))
    };
  }
  return {
    EXPORT_CONCURRENCY: Math.max(1, Math.floor(Number(process.env.ANNUAL_EXPORT_CONCURRENCY || 10))),
    CATEGORY_CONCURRENCY: Math.max(1, Math.floor(Number(process.env.ANNUAL_CATEGORY_CONCURRENCY || 5))),
    CATEGORY_QUERY_CONCURRENCY: Math.max(1, Math.floor(Number(process.env.ANNUAL_CATEGORY_QUERY_CONCURRENCY || 8))),
    USER_BATCH_SIZE: Math.max(1, Math.floor(Number(process.env.ANNUAL_USER_BATCH_SIZE || 30))),  // 30 * 9 = 270 connections
    FIRSTS_QUERY_CONCURRENCY: Math.max(1, Math.floor(Number(process.env.ANNUAL_FIRSTS_CONCURRENCY || 50)))
  };
}

// 向后兼容的并发常量（运行时会根据 TURBO_MODE 更新）
let EXPORT_CONCURRENCY = 4;
let CATEGORY_CONCURRENCY = 2;
let CATEGORY_QUERY_CONCURRENCY = 3;

// ============ UTC+8 时区格式化辅助函数 ============

/**
 * 将 Date 对象格式化为 UTC+8 时区的 ISO 字符串
 * @param date Date 对象（存储为 UTC）
 * @returns ISO 格式字符串，带 +08:00 后缀
 */
function formatDateTimeUTC8(date: Date): string {
  const utc8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return utc8.toISOString().replace('Z', '+08:00');
}

/**
 * 将 Date 对象格式化为 UTC+8 时区的日期字符串 (YYYY-MM-DD)
 * @param date Date 对象（存储为 UTC）
 * @returns YYYY-MM-DD 格式字符串
 */
function formatDateOnlyUTC8(date: Date): string {
  const utc8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return utc8.toISOString().slice(0, 10);
}

/**
 * 将 Date 对象格式化为 UTC+8 时区的月份字符串 (YYYY-MM)
 * @param date Date 对象（存储为 UTC）
 * @returns YYYY-MM 格式字符串
 */
function formatMonthUTC8(date: Date): string {
  const utc8 = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return utc8.toISOString().slice(0, 7);
}

type DistributionBucketSpec = { label: string; min: number; max: number | null };
type DistributionBucket = { label: string; min: number; max: number | null; count: number };
type DistributionResult = { total: number; buckets: DistributionBucket[] };
type UserPercentile = { value: number; rank: number; total: number; percentile: number; percentileLabel: string };

const TAG_COUNT_BUCKETS: DistributionBucketSpec[] = [
  { label: '0-2', min: 0, max: 2 },
  { label: '3-5', min: 3, max: 5 },
  { label: '6-8', min: 6, max: 8 },
  { label: '9-11', min: 9, max: 11 },
  { label: '12-14', min: 12, max: 14 },
  { label: '15-17', min: 15, max: 17 },
  { label: '18-20', min: 18, max: 20 },
  { label: '21+', min: 21, max: null }
];

const TITLE_LENGTH_BUCKETS: DistributionBucketSpec[] = [
  { label: '0-5', min: 0, max: 5 },
  { label: '6-10', min: 6, max: 10 },
  { label: '11-15', min: 11, max: 15 },
  { label: '16-20', min: 16, max: 20 },
  { label: '21-25', min: 21, max: 25 },
  { label: '26-30', min: 26, max: 30 },
  { label: '31-40', min: 31, max: 40 },
  { label: '41-50', min: 41, max: 50 },
  { label: '51+', min: 51, max: null }
];

const VOTES_CAST_BUCKETS: DistributionBucketSpec[] = [
  { label: '1-5', min: 1, max: 5 },
  { label: '6-20', min: 6, max: 20 },
  { label: '21-50', min: 21, max: 50 },
  { label: '51-100', min: 51, max: 100 },
  { label: '101-200', min: 101, max: 200 },
  { label: '201-500', min: 201, max: 500 },
  { label: '501-1000', min: 501, max: 1000 },
  { label: '1001-2000', min: 1001, max: 2000 },
  { label: '2001+', min: 2001, max: null }
];

const CONTENT_WORD_BUCKETS: DistributionBucketSpec[] = [
  { label: '0-5k', min: 0, max: 5000 },
  { label: '5k-1万', min: 5001, max: 10000 },
  { label: '1-2万', min: 10001, max: 20000 },
  { label: '2-4万', min: 20001, max: 40000 },
  { label: '4-8万', min: 40001, max: 80000 },
  { label: '8-12万', min: 80001, max: 120000 },
  { label: '12-20万', min: 120001, max: 200000 },
  { label: '20万+', min: 200001, max: null }
];

function buildDistribution(values: number[], buckets: DistributionBucketSpec[]): DistributionResult {
  const resultBuckets: DistributionBucket[] = buckets.map(bucket => ({
    label: bucket.label,
    min: bucket.min,
    max: bucket.max,
    count: 0
  }));
  for (const value of values) {
    const bucket = resultBuckets.find(item => value >= item.min && (item.max === null || value <= item.max));
    if (bucket) bucket.count += 1;
  }
  return {
    total: values.length,
    buckets: resultBuckets
  };
}

// ============ User-Firsts Integration ============

interface TagLeader {
  tag: string;
  period: string;
  userId: number;
  displayName: string | null;
  value: number;
  metric: string;
  pageId?: number | null;
  score: number;
}

interface UserFirstsCache {
  year: number;
  generatedAt: string;
  leaders: TagLeader[];
}

// Load user-firsts cache
let userFirstsCache: UserFirstsCache | null = null;
let userFirstsByUserId: Map<number, TagLeader[]> = new Map();

function loadUserFirstsCache(year: number): void {
  const cachePath = path.join(process.cwd(), 'cache', `user-firsts-${year}.json`);
  if (!fs.existsSync(cachePath)) {
    console.log(`  [WARN] User-firsts cache not found: ${cachePath}`);
    return;
  }

  try {
    const data = fs.readFileSync(cachePath, 'utf-8');
    userFirstsCache = JSON.parse(data);

    // Group by userId for fast lookup
    userFirstsByUserId = new Map();
    for (const leader of userFirstsCache!.leaders) {
      if (!userFirstsByUserId.has(leader.userId)) {
        userFirstsByUserId.set(leader.userId, []);
      }
      userFirstsByUserId.get(leader.userId)!.push(leader);
    }

    console.log(`  -> Loaded ${userFirstsCache!.leaders.length} user-firsts entries`);
  } catch (e) {
    console.error(`  [ERROR] Failed to load user-firsts cache:`, e);
  }
}

// Metric templates for rendering achievement text
// 格式统一：[时间范围][限定条件]成就描述
// 注意：{{tagLabelOrAll}} 会在 renderLeaderText 中处理，无标签时显示"全站"
const METRIC_TEMPLATES: Record<string, { template: string; category: string; icon: string }> = {
  // Author creation metrics - 创作相关（你发布的作品）
  author_top_rating: { template: '{{periodText}}{{tagLabelOrAll}}作品最高得分', category: 'creation', icon: 'star' },
  author_top_rating_day: { template: '{{periodText}}全站作品最高得分', category: 'creation', icon: 'trophy' },
  author_top_rating_week: { template: '{{periodText}}{{tagLabelOrAll}}作品最高得分', category: 'creation', icon: 'trophy' },
  author_pages_count: { template: '{{periodText}}发布页面数量第一', category: 'creation', icon: 'file-text' },
  author_page_length: { template: '{{periodText}}发布最长页面', category: 'creation', icon: 'scroll' },
  author_page_shortest: { template: '{{periodText}}高分（≥30）最短页面', category: 'creation', icon: 'minimize' },
  author_creation_count: { template: '{{periodText}}{{tagLabel}}原创篇数第一', category: 'creation', icon: 'pen' },
  author_creation_words: { template: '{{periodText}}{{tagLabel}}原创总字数第一', category: 'creation', icon: 'file-text' },
  author_original_category_rating_year: { template: '{{periodText}}{{tagLabel}}原创总得分第一', category: 'creation', icon: 'star' },
  author_original_category_rating_month: { template: '{{periodText}}{{tagLabel}}原创总得分第一', category: 'creation', icon: 'star' },

  // Translation metrics - 翻译相关
  author_translation_count: { template: '{{periodText}}{{tagLabel}}翻译篇数第一', category: 'translation', icon: 'languages' },
  author_translation_words: { template: '{{periodText}}{{tagLabel}}翻译总字数第一', category: 'translation', icon: 'file-text' },
  translator_lang_count_year: { template: '{{periodText}}{{tagName}}分部翻译数量第一', category: 'translation', icon: 'globe' },
  translator_lang_count_month: { template: '{{periodText}}{{tagName}}分部翻译数量第一', category: 'translation', icon: 'globe' },
  translator_lang_words_year: { template: '{{periodText}}{{tagName}}分部翻译总字数第一', category: 'translation', icon: 'globe' },
  translator_lang_words_month: { template: '{{periodText}}{{tagName}}分部翻译总字数第一', category: 'translation', icon: 'globe' },

  // Collaboration metrics - 合著相关
  coauthor_pages: { template: '{{periodText}}合著页面数量第一', category: 'collaboration', icon: 'users' },
  coauthor_partners: { template: '{{periodText}}合作作者人数第一', category: 'collaboration', icon: 'user-plus' },

  // Voting metrics (voter actions) - 投票相关（你投出的票）
  voter_most_votes: { template: '{{periodText}}对{{tagLabelOrAll}}页面投票数第一', category: 'voting', icon: 'vote' },
  voter_daily_total: { template: '{{periodText}}全站投票数第一', category: 'voting', icon: 'vote' },
  voter_daily_up: { template: '{{periodText}}全站投出UpVote数第一', category: 'voting', icon: 'thumbs-up' },
  voter_daily_down: { template: '{{periodText}}全站投出DownVote数第一', category: 'voting', icon: 'thumbs-down' },
  voter_weekly_total: { template: '{{periodText}}全站投票数第一', category: 'voting', icon: 'vote' },
  voter_weekly_up: { template: '{{periodText}}全站投出UpVote数第一', category: 'voting', icon: 'thumbs-up' },
  voter_weekly_down: { template: '{{periodText}}全站投出DownVote数第一', category: 'voting', icon: 'thumbs-down' },
  voter_tag_day_total: { template: '{{periodText}}对{{tagLabel}}页面投票数第一', category: 'voting', icon: 'vote' },
  voter_tag_day_up: { template: '{{periodText}}对{{tagLabel}}页面投UpVote数第一', category: 'voting', icon: 'thumbs-up' },
  voter_tag_day_down: { template: '{{periodText}}对{{tagLabel}}页面投DownVote数第一', category: 'voting', icon: 'thumbs-down' },

  // Reception metrics (votes received) - 获得投票相关（你收到的票）
  author_received_total_year: { template: '{{periodText}}获得总票数第一', category: 'reception', icon: 'inbox' },
  author_received_up_year: { template: '{{periodText}}获得UpVote数第一', category: 'reception', icon: 'thumbs-up' },
  author_received_net_year: { template: '{{periodText}}获得净得分第一', category: 'reception', icon: 'trending-up' },
  author_received_down_year: { template: '{{periodText}}获得DownVote数第一', category: 'reception', icon: 'thumbs-down' },
  author_received_total_month: { template: '{{periodText}}获得总票数第一', category: 'reception', icon: 'inbox' },
  author_received_up_month: { template: '{{periodText}}获得UpVote数第一', category: 'reception', icon: 'thumbs-up' },
  author_received_net_month: { template: '{{periodText}}获得净得分第一', category: 'reception', icon: 'trending-up' },
  author_received_down_month: { template: '{{periodText}}获得DownVote数第一', category: 'reception', icon: 'thumbs-down' },
  author_received_total_week: { template: '{{periodText}}获得总票数第一', category: 'reception', icon: 'inbox' },
  author_received_up_week: { template: '{{periodText}}获得UpVote数第一', category: 'reception', icon: 'thumbs-up' },
  author_received_down_week: { template: '{{periodText}}获得DownVote数第一', category: 'reception', icon: 'thumbs-down' },
  author_received_net_week: { template: '{{periodText}}获得净得分第一', category: 'reception', icon: 'trending-up' },

  // Combo metrics (tag combinations) - 标签组合相关
  combo_rating_best_year: { template: '{{periodText}}{{tagLabel}}作品最高得分', category: 'creation', icon: 'star' },
  combo_rating_best_month: { template: '{{periodText}}{{tagLabel}}作品最高得分', category: 'creation', icon: 'star' },
  combo_pages_count_year: { template: '{{periodText}}{{tagLabel}}页面数第一', category: 'creation', icon: 'layers' },
  combo_pages_count_month: { template: '{{periodText}}{{tagLabel}}页面数第一', category: 'creation', icon: 'layers' },
  combo_words_sum_year: { template: '{{periodText}}{{tagLabel}}页面总字数第一', category: 'creation', icon: 'file-text' },
  combo_words_sum_month: { template: '{{periodText}}{{tagLabel}}页面总字数第一', category: 'creation', icon: 'file-text' },
  combo_shortest_year: { template: '{{periodText}}{{tagLabel}}高分（≥30）最短页面', category: 'creation', icon: 'minimize' },
  combo_shortest_month: { template: '{{periodText}}{{tagLabel}}高分（≥30）最短页面', category: 'creation', icon: 'minimize' },
};

function formatPeriodText(period: string, metric: string): string {
  const parts = period.split('-');
  if (parts.length === 1) return `${parts[0]}年`;
  if (parts.length === 2) return `${parts[0]}年${Number(parts[1])}月`;
  if (parts.length === 3) {
    if (metric.includes('week')) return `${parts[0]}年${Number(parts[1])}月${Number(parts[2])}日这一周`;
    return `${parts[0]}年${Number(parts[1])}月${Number(parts[2])}日`;
  }
  return period;
}

function renderLeaderText(leader: TagLeader): string {
  const metric = leader.metric || '';
  const periodText = formatPeriodText(leader.period, metric);
  // Format tag for display: replace "|" with "," for combo tags, add "标签" suffix
  const displayTag = leader.tag?.replace(/\|/g, ',') || '';
  const hasTag = leader.tag && leader.tag !== 'all_pages' && leader.tag !== 'all_tags';
  const tagLabel = hasTag ? `"${displayTag}"标签` : '';
  const tagLabelOrAll = hasTag ? `"${displayTag}"标签` : '全站';
  const tagName = displayTag;

  const tpl = METRIC_TEMPLATES[metric];
  if (!tpl) {
    // Improved fallback: generate readable Chinese text
    const metricParts = metric.split('_');
    let description = '第一';
    if (metricParts.includes('words')) description = '字数第一';
    else if (metricParts.includes('count')) description = '数量第一';
    else if (metricParts.includes('rating')) description = '得分第一';
    else if (metricParts.includes('votes')) description = '投票第一';
    else if (metricParts.includes('up')) description = 'UpVote数第一';
    else if (metricParts.includes('down')) description = 'DownVote数第一';
    return `${periodText}${tagLabel ? tagLabel : '全站'}${description}`;
  }

  return tpl.template
    .replace(/\{\{periodText\}\}/g, periodText)
    .replace(/\{\{tagLabelOrAll\}\}/g, tagLabelOrAll)
    .replace(/\{\{tagLabel\}\}/g, tagLabel)
    .replace(/\{\{tagName\}\}/g, tagName);
}

function getLeaderTier(leader: TagLeader): 'gold' | 'silver' | 'bronze' | 'honorable' {
  // Year-level achievements are more valuable
  const isYear = leader.period.split('-').length === 1;
  const isMonth = leader.period.split('-').length === 2;

  // High score achievements
  if (leader.score > 4000000) return isYear ? 'gold' : 'silver';
  if (leader.score > 3000000) return isMonth ? 'silver' : 'bronze';
  return 'bronze';
}

function getUserFirstsAchievements(userId: number, year: number, maxCount: number = 5): any[] {
  const leaders = userFirstsByUserId.get(userId);
  if (!leaders || leaders.length === 0) return [];

  // Sort by score descending, take top N
  const sorted = [...leaders].sort((a, b) => b.score - a.score);
  const topLeaders = sorted.slice(0, maxCount);

  return topLeaders.map((leader, idx) => {
    const tpl = METRIC_TEMPLATES[leader.metric];
    const periodText = formatPeriodText(leader.period, leader.metric);

    return {
      id: `firsts_${year}_${userId}_${idx}`,
      category: tpl?.category || 'special',
      tier: getLeaderTier(leader),
      icon: tpl?.icon || 'award',
      title: renderLeaderText(leader),
      description: `数值: ${leader.value}`,
      value: leader.value,
      valueLabel: '',
      period: leader.period.split('-').length === 1 ? 'year' : leader.period.split('-').length === 2 ? 'month' : 'day',
      periodText,
      tag: leader.tag,
      earnedAt: formatDateTimeUTC8(new Date()),
      relatedPage: leader.pageId ? { pageId: leader.pageId } : null,
      rarity: 1 - (leader.score / 5000000), // Approximate rarity
      rarityLabel: '第一名',
      metric: leader.metric,
      score: leader.score
    };
  });
}

// ============ User-Firsts Generation (inline) ============
// 从 user-firsts-analysis.ts 移植的核心查询逻辑

const BASE_TAGS = new Set([
  '原创', '作者', '段落', '补充材料', '页面', '重定向', '管理', '_cc', '指导'
]);
const BASE_TAGS_WITHOUT_ORIGINAL = Array.from(BASE_TAGS).filter((t) => t !== '原创');
const ORIGINAL_CATEGORY_TAGS = ['scp', 'goi格式', '故事', 'wanderers', '艺术作品', '文章'] as const;
const TRANSLATION_LANG_TAGS = [
  'en', 'int', 'ru', 'ko', 'fr', 'pl', 'es', 'th', 'jp', 'de', 'it', 'ua', 'pt', 'cs', 'vn', 'cy', 'el', 'eo', 'et', 'he', 'hu', 'id', 'la',
  'nd-da', 'nd-fo', 'nd-no', 'nd-sv', 'nl', 'ro', 'sl', 'tr'
] as const;
const CONTENT_TYPE_TAGS = ['scp', 'goi格式', 'wanderers', '故事', '文章'] as const;
const OBJECT_CLASS_TAGS = [
  'safe', 'euclid', 'keter', 'thaumiel', 'apollyon', 'archon', 'ticonderoga', '无效化', '被废除', '等待分级'
] as const;

const LEVEL_WEIGHT: Record<'year' | 'month' | 'week' | 'day', number> = {
  year: 4,
  month: 3,
  week: 2,
  day: 1
};

type TagLeaderRaw = Omit<TagLeader, 'score'>;

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

function firstsYearRange(year: number) {
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

function levelFromPeriod(metric: string, period: string): 'year' | 'month' | 'week' | 'day' {
  if (metric.includes('week')) return 'week';
  if (period.length === 4) return 'year';
  if (period.length === 7) return 'month';
  return 'day';
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

function computeFirstsScore(item: TagLeaderRaw, tagPopularity: Map<string, number>): number {
  const level = levelFromPeriod(item.metric, item.period);
  const levelWeight = LEVEL_WEIGHT[level] ?? 1;
  const tagWeight = item.tag && item.tag !== 'all_tags' && item.tag !== 'all_pages'
    ? Math.log1p(tagPopularity.get(item.tag) || 1)
    : 1;
  return levelWeight * 1e6 + tagWeight * 1e3 + item.value;
}

function scoreFirstsLeaders(leaders: TagLeaderRaw[], tagPopularity: Map<string, number>): TagLeader[] {
  return leaders.map((l) => ({ ...l, score: computeFirstsScore(l, tagPopularity) }));
}

// 核心查询函数
async function getTagLeadersByYearFirsts(year: number): Promise<TagLeaderRaw[]> {
  const { startTzIso, endTzIso } = firstsYearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    tag: string; pageId: number; userId: number; displayName: string | null; rating: number;
  }>>`
    WITH pv AS (
      SELECT pv.id, pv."pageId", pv.tags, pv.rating, ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL AND NOT pv."isDeleted" AND pv.rating IS NOT NULL
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    tagged AS (
      SELECT pv.id AS page_ver_id, pv."pageId" AS page_id, unnest(pv.tags) AS tag, pv.rating
      FROM pv WHERE pv.tags IS NOT NULL AND array_length(pv.tags, 1) > 0
    ),
    ranked AS (
      SELECT t.tag, t.page_id, t.rating, a."userId", u."displayName",
        RANK() OVER (PARTITION BY t.tag ORDER BY t.rating DESC) AS rnk
      FROM tagged t
      JOIN "Attribution" a ON a."pageVerId" = t.page_ver_id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      WHERE NOT (t.tag = ANY(${BASE_TAGS_WITHOUT_ORIGINAL}))
    )
    SELECT tag, page_id AS "pageId", rating, "userId", "displayName" FROM ranked WHERE rnk = 1
  `;
  return rows.map((r) => ({
    tag: r.tag, period: `${year}`, pageId: Number(r.pageId), userId: Number(r.userId),
    displayName: r.displayName, value: Number(r.rating), metric: 'author_top_rating'
  }));
}

async function getTagLeadersByMonthFirsts(year: number): Promise<TagLeaderRaw[]> {
  const { startTzIso, endTzIso } = firstsYearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    tag: string; month: Date; pageId: number; userId: number; displayName: string | null; rating: number;
  }>>`
    WITH pv AS (
      SELECT pv.id, pv."pageId", pv.tags, pv.rating, ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL AND NOT pv."isDeleted" AND pv.rating IS NOT NULL
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    tagged AS (
      SELECT pv.id AS page_ver_id, pv."pageId" AS page_id, date_trunc('month', pv.published_at) AS month,
        unnest(pv.tags) AS tag, pv.rating
      FROM pv WHERE pv.tags IS NOT NULL AND array_length(pv.tags, 1) > 0
    ),
    ranked AS (
      SELECT t.tag, t.month, t.page_id, t.rating, a."userId", u."displayName",
        RANK() OVER (PARTITION BY t.tag, t.month ORDER BY t.rating DESC) AS rnk
      FROM tagged t
      JOIN "Attribution" a ON a."pageVerId" = t.page_ver_id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      WHERE NOT (t.tag = ANY(${BASE_TAGS_WITHOUT_ORIGINAL}))
    )
    SELECT tag, month, page_id AS "pageId", rating, "userId", "displayName" FROM ranked WHERE rnk = 1
  `;
  return rows.map((r) => ({
    tag: r.tag, period: new Date(r.month).toISOString().slice(0, 7), pageId: Number(r.pageId),
    userId: Number(r.userId), displayName: r.displayName, value: Number(r.rating), metric: 'author_top_rating'
  }));
}

async function getDailyAuthorScoreLeadersFirsts(year: number): Promise<TagLeaderRaw[]> {
  const { startTzIso, endTzIso } = firstsYearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    day: Date; pageId: number; userId: number; displayName: string | null; rating: number;
  }>>`
    WITH pv AS (
      SELECT pv.id, pv."pageId", pv.rating, ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL AND NOT pv."isDeleted" AND pv.rating IS NOT NULL
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    ranked AS (
      SELECT date_trunc('day', pv.published_at) AS day, pv."pageId" AS page_id, pv.rating,
        a."userId", u."displayName",
        RANK() OVER (PARTITION BY date_trunc('day', pv.published_at) ORDER BY pv.rating DESC) AS rnk
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
    )
    SELECT day, page_id AS "pageId", rating, "userId", "displayName" FROM ranked WHERE rnk = 1
  `;
  return rows.map((r) => ({
    tag: 'all_pages', period: new Date(r.day).toISOString().slice(0, 10), pageId: Number(r.pageId),
    userId: Number(r.userId), displayName: r.displayName, value: Number(r.rating), metric: 'author_top_rating_day'
  }));
}

async function getDailyVoterCountLeadersFirsts(year: number): Promise<TagLeaderRaw[]> {
  const { startTzIso: voteStartIso, endTzIso: voteEndIso } = firstsYearRange(year);
  // 去重：每个用户对每个页面在每天只计最后一票
  const rows = await prisma.$queryRaw<Array<{
    day: Date; userId: number; displayName: string | null; totalVotes: number; upVotes: number; downVotes: number;
  }>>`
    WITH dedup_votes AS (
      SELECT * FROM (
        SELECT
          v."userId",
          v.direction,
          pv."pageId",
          date_trunc('day', v.timestamp) AS day,
          ROW_NUMBER() OVER (
            PARTITION BY v."userId", pv."pageId", date_trunc('day', v.timestamp)
            ORDER BY v.timestamp DESC, v.id DESC
          ) AS rn
        FROM "Vote" v
        JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
        WHERE v."userId" IS NOT NULL AND v.direction != 0
          AND v.timestamp >= ${voteStartIso}::timestamptz AND v.timestamp < ${voteEndIso}::timestamptz
          AND pv."validTo" IS NULL AND NOT pv."isDeleted"
      ) t WHERE rn = 1
    )
    SELECT day, "userId", u."displayName",
      COUNT(*) AS "totalVotes",
      COUNT(*) FILTER (WHERE direction = 1) AS "upVotes",
      COUNT(*) FILTER (WHERE direction = -1) AS "downVotes"
    FROM dedup_votes dv
    LEFT JOIN "User" u ON u.id = dv."userId"
    GROUP BY day, "userId", u."displayName"
  `;

  const bestByDay = new Map<string, Record<string, TagLeaderRaw>>();
  const maybeUpdate = (dayKey: string, metric: string, candidate: TagLeaderRaw) => {
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
      tag: 'all_tags', period: dayKey, userId: Number(r.userId), displayName: r.displayName,
      value: Number(r.totalVotes), metric: 'voter_daily_total', pageId: null
    });
    maybeUpdate(dayKey, 'voter_daily_up', {
      tag: 'all_tags', period: dayKey, userId: Number(r.userId), displayName: r.displayName,
      value: Number(r.upVotes), metric: 'voter_daily_up', pageId: null
    });
    maybeUpdate(dayKey, 'voter_daily_down', {
      tag: 'all_tags', period: dayKey, userId: Number(r.userId), displayName: r.displayName,
      value: Number(r.downVotes), metric: 'voter_daily_down', pageId: null
    });
  }

  const results: TagLeaderRaw[] = [];
  bestByDay.forEach((perDay) => {
    Object.values(perDay).forEach((leader) => results.push(leader as TagLeaderRaw));
  });
  return results;
}

async function getAuthorPageCountLeadersFirsts(year: number): Promise<TagLeaderRaw[]> {
  const { startTzIso, endTzIso } = firstsYearRange(year);
  const rows = await prisma.$queryRaw<Array<{
    period: string; userId: number; displayName: string | null; pages: number;
  }>>`
    WITH pv AS (
      SELECT pv.id, pv."pageId", ${PUBLISHED_AT_SQL} AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      ${REVISION_PUBLISHED_JOIN_SQL}
      WHERE pv."validTo" IS NULL AND NOT pv."isDeleted"
        AND ${PUBLISHED_AT_SQL} >= ${startTzIso}::timestamptz AND ${PUBLISHED_AT_SQL} < ${endTzIso}::timestamptz
    ),
    aggregated AS (
      SELECT date_trunc('year', pv.published_at)::date AS period, a."userId" AS user_id,
        COUNT(DISTINCT pv."pageId") AS pages
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id WHERE a."userId" IS NOT NULL
      GROUP BY period, a."userId"
    ),
    ranked AS (
      SELECT period, user_id, pages, RANK() OVER (PARTITION BY period ORDER BY pages DESC) AS rnk
      FROM aggregated
    )
    SELECT period::text, user_id AS "userId", pages, u."displayName"
    FROM ranked r LEFT JOIN "User" u ON u.id = r.user_id WHERE rnk = 1
  `;
  return rows.map((r) => ({
    tag: 'all_pages', period: r.period.slice(0, 4), userId: Number(r.userId),
    displayName: r.displayName, value: Number(r.pages), metric: 'author_pages_count', pageId: null
  }));
}

async function getTagVoterLeadersByYearFirsts(year: number): Promise<TagLeaderRaw[]> {
  const { startTzIso: voteStartIso, endTzIso: voteEndIso } = firstsYearRange(year);
  // 去重：每个用户对每个页面只计最后一票，然后再展开标签
  const rows = await prisma.$queryRaw<Array<{
    tag: string; userId: number; displayName: string | null; votes: number;
  }>>`
    WITH dedup_votes AS (
      SELECT * FROM (
        SELECT
          v."userId",
          pv."pageId",
          pv.tags,
          ROW_NUMBER() OVER (
            PARTITION BY v."userId", pv."pageId"
            ORDER BY v.timestamp DESC, v.id DESC
          ) AS rn
        FROM "Vote" v
        JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
        WHERE v."userId" IS NOT NULL AND v.direction != 0
          AND v.timestamp >= ${voteStartIso}::timestamptz AND v.timestamp < ${voteEndIso}::timestamptz
          AND pv."validTo" IS NULL AND NOT pv."isDeleted"
          AND pv.tags IS NOT NULL AND array_length(pv.tags, 1) > 0
      ) t WHERE rn = 1
    ),
    tag_votes AS (
      SELECT unnest(tags) AS tag, "userId" AS user_id
      FROM dedup_votes
    ),
    aggregated AS (
      SELECT tag, user_id, COUNT(*) AS votes,
        RANK() OVER (PARTITION BY tag ORDER BY COUNT(*) DESC) AS rnk
      FROM tag_votes WHERE NOT (tag = ANY(${BASE_TAGS_WITHOUT_ORIGINAL}))
      GROUP BY tag, user_id HAVING COUNT(*) >= 1
    )
    SELECT tag, user_id AS "userId", votes, u."displayName"
    FROM aggregated ag LEFT JOIN "User" u ON u.id = ag.user_id WHERE ag.rnk = 1
  `;
  return rows.map((r) => ({
    tag: r.tag, period: `${year}`, userId: Number(r.userId), displayName: r.displayName,
    value: Number(r.votes), metric: 'voter_most_votes', pageId: null
  }));
}

async function getAuthorReceivedVotesByPeriodFirsts(
  year: number, period: 'year' | 'month' | 'week'
): Promise<TagLeaderRaw[]> {
  const { startTzIso: voteStartIso, endTzIso: voteEndIso } = firstsYearRange(year);
  const bucket = period;
  // 双重去重：1) 按投票者+页面+时间段去重投票 2) 按投票ID+作者去重 Attribution
  const rows = await prisma.$queryRaw<Array<{
    period: Date; userId: number; displayName: string | null;
    totalVotes: number; upVotes: number; downVotes: number; netVotes: number;
  }>>`
    WITH dedup_votes AS (
      SELECT * FROM (
        SELECT v.id, v.direction, v.timestamp, pv."pageId", pv.id AS pv_id,
          date_trunc(${bucket}, v.timestamp) AS bucket,
          ROW_NUMBER() OVER (
            PARTITION BY v."userId", pv."pageId", date_trunc(${bucket}, v.timestamp)
            ORDER BY v.timestamp DESC, v.id DESC
          ) AS rn
        FROM "Vote" v
        JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
        WHERE v.direction != 0
          AND v.timestamp >= ${voteStartIso}::timestamptz AND v.timestamp < ${voteEndIso}::timestamptz
          AND pv."validTo" IS NULL AND NOT pv."isDeleted"
      ) t WHERE rn = 1
    ),
    -- 对每个投票和作者组合去重，避免同一作者对同一页面有多个 Attribution 记录导致重复计数
    vote_author AS (
      SELECT DISTINCT dv.id AS vote_id, dv.direction, dv.bucket, a."userId" AS author_id, u."displayName"
      FROM dedup_votes dv
      JOIN "Attribution" a ON a."pageVerId" = dv.pv_id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
    ),
    aggregated AS (
      SELECT bucket, author_id, "displayName",
        COUNT(*) FILTER (WHERE direction != 0) AS total_votes,
        COUNT(*) FILTER (WHERE direction = 1) AS up_votes,
        COUNT(*) FILTER (WHERE direction = -1) AS down_votes,
        COALESCE(SUM(direction), 0) AS net_votes
      FROM vote_author GROUP BY bucket, author_id, "displayName"
    ),
    ranked AS (
      SELECT bucket, author_id, "displayName", total_votes, up_votes, down_votes, net_votes,
        RANK() OVER (PARTITION BY bucket ORDER BY total_votes DESC) AS rnk_total,
        RANK() OVER (PARTITION BY bucket ORDER BY up_votes DESC) AS rnk_up,
        RANK() OVER (PARTITION BY bucket ORDER BY down_votes DESC) AS rnk_down,
        RANK() OVER (PARTITION BY bucket ORDER BY net_votes DESC) AS rnk_net
      FROM aggregated
    )
    SELECT bucket AS period, author_id AS "userId", "displayName",
      total_votes AS "totalVotes", up_votes AS "upVotes", down_votes AS "downVotes", net_votes AS "netVotes"
    FROM ranked WHERE rnk_total = 1 OR rnk_up = 1 OR rnk_down = 1 OR rnk_net = 1
  `;

  const suffix = period === 'year' ? '_year' : period === 'month' ? '_month' : '_week';
  return rows.flatMap((r) => {
    const dateVal = new Date(r.period);
    const periodStr = period === 'year' ? String(year) : period === 'month'
      ? dateVal.toISOString().slice(0, 7) : dateVal.toISOString().slice(0, 10);
    return [
      { tag: 'all_pages', period: periodStr, pageId: null, userId: Number(r.userId), displayName: r.displayName, value: Number(r.totalVotes), metric: `author_received_total${suffix}` },
      { tag: 'all_pages', period: periodStr, pageId: null, userId: Number(r.userId), displayName: r.displayName, value: Number(r.upVotes), metric: `author_received_up${suffix}` },
      { tag: 'all_pages', period: periodStr, pageId: null, userId: Number(r.userId), displayName: r.displayName, value: Number(r.downVotes), metric: `author_received_down${suffix}` },
      { tag: 'all_pages', period: periodStr, pageId: null, userId: Number(r.userId), displayName: r.displayName, value: Number(r.netVotes), metric: `author_received_net${suffix}` }
    ];
  });
}

// ============ Deleted Pages User-Firsts ============

/**
 * 获取今年创建并删除页面最多的用户（按年/月/周）
 * 只统计今年创建的页面，排除历史数据迁移后被删除的情况
 */
async function getDeletedPagesLeadersByPeriodFirsts(
  year: number, period: 'year' | 'month' | 'week'
): Promise<TagLeaderRaw[]> {
  const { startTzIso, endTzIso } = firstsYearRange(year);
  const bucket = period;

  // 去重：避免同一用户对同一页面有多个 Attribution 记录导致重复计数
  const rows = await prisma.$queryRaw<Array<{
    period: Date;
    userId: number;
    displayName: string | null;
    deletedCount: bigint;
  }>>`
    WITH deleted_pages AS (
      SELECT
        pv.id AS deleted_ver_id,
        pv."createdAt" AS deleted_at,
        date_trunc(${bucket}, pv."createdAt") AS bucket
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL
        AND pv."isDeleted" = true
        AND pv."createdAt" >= ${startTzIso}::timestamptz
        AND pv."createdAt" < ${endTzIso}::timestamptz
        AND p."firstPublishedAt" >= ${startTzIso}::timestamptz
        AND p."firstPublishedAt" < ${endTzIso}::timestamptz
    ),
    dedup_attr AS (
      SELECT DISTINCT dp.bucket, dp.deleted_ver_id, a."userId"
      FROM deleted_pages dp
      JOIN "Attribution" a ON a."pageVerId" = dp.deleted_ver_id AND a."userId" IS NOT NULL
    ),
    aggregated AS (
      SELECT
        da.bucket,
        da."userId",
        u."displayName",
        COUNT(*) AS deleted_count
      FROM dedup_attr da
      LEFT JOIN "User" u ON u.id = da."userId"
      GROUP BY da.bucket, da."userId", u."displayName"
    ),
    ranked AS (
      SELECT
        bucket,
        "userId",
        "displayName",
        deleted_count,
        RANK() OVER (PARTITION BY bucket ORDER BY deleted_count DESC) AS rnk
      FROM aggregated
    )
    SELECT bucket AS period, "userId", "displayName", deleted_count AS "deletedCount"
    FROM ranked WHERE rnk = 1 AND deleted_count > 0
  `;

  const suffix = period === 'year' ? '_year' : period === 'month' ? '_month' : '_week';
  return rows.map((r) => {
    const dateVal = new Date(r.period);
    const periodStr = period === 'year' ? String(year) : period === 'month'
      ? dateVal.toISOString().slice(0, 7) : dateVal.toISOString().slice(0, 10);
    return {
      tag: 'all_pages',
      period: periodStr,
      pageId: null,
      userId: Number(r.userId),
      displayName: r.displayName,
      value: Number(r.deletedCount),
      metric: `author_deleted_pages${suffix}`
    };
  });
}

/**
 * 获取今年在六大类下创建并删除页面最多的用户（按年/月/周）
 */
async function getDeletedPagesByCategoryLeadersByPeriodFirsts(
  year: number, period: 'year' | 'month' | 'week'
): Promise<TagLeaderRaw[]> {
  const { startTzIso, endTzIso } = firstsYearRange(year);
  const bucket = period;

  // 查询已删除页面及其历史标签
  const rows = await prisma.$queryRaw<Array<{
    period: Date;
    tag: string;
    userId: number;
    displayName: string | null;
    deletedCount: bigint;
  }>>`
    WITH deleted_pages AS (
      SELECT
        pv.id AS deleted_ver_id,
        pv."pageId",
        pv."createdAt" AS deleted_at,
        date_trunc(${bucket}, pv."createdAt") AS bucket
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL
        AND pv."isDeleted" = true
        AND pv."createdAt" >= ${startTzIso}::timestamptz
        AND pv."createdAt" < ${endTzIso}::timestamptz
        AND p."firstPublishedAt" >= ${startTzIso}::timestamptz
        AND p."firstPublishedAt" < ${endTzIso}::timestamptz
    ),
    -- 获取每个已删除页面的最后有意义标签
    page_tags AS (
      SELECT DISTINCT ON (dp."pageId")
        dp.deleted_ver_id,
        dp.bucket,
        array_remove(pv.tags, '待删除') AS clean_tags
      FROM deleted_pages dp
      JOIN "PageVersion" pv ON pv."pageId" = dp."pageId"
      WHERE array_length(pv.tags, 1) > 0
      ORDER BY dp."pageId", pv."createdAt" DESC
    ),
    -- 展开标签并只保留六大类
    category_tags AS (
      SELECT
        pt.deleted_ver_id,
        pt.bucket,
        unnest(pt.clean_tags) AS tag
      FROM page_tags pt
    ),
    filtered_tags AS (
      SELECT * FROM category_tags
      WHERE tag = ANY(ARRAY['scp', 'goi格式', '故事', 'wanderers', '艺术作品', '文章'])
    ),
    -- 先对 Attribution 去重，避免同一用户对同一页面有多条记录时重复计数
    dedup_attr AS (
      SELECT DISTINCT ft.bucket, ft.tag, ft.deleted_ver_id, a."userId"
      FROM filtered_tags ft
      JOIN "Attribution" a ON a."pageVerId" = ft.deleted_ver_id AND a."userId" IS NOT NULL
    ),
    aggregated AS (
      SELECT
        da.bucket,
        da.tag,
        da."userId",
        u."displayName",
        COUNT(*) AS deleted_count
      FROM dedup_attr da
      LEFT JOIN "User" u ON u.id = da."userId"
      GROUP BY da.bucket, da.tag, da."userId", u."displayName"
    ),
    ranked AS (
      SELECT
        bucket,
        tag,
        "userId",
        "displayName",
        deleted_count,
        RANK() OVER (PARTITION BY bucket, tag ORDER BY deleted_count DESC) AS rnk
      FROM aggregated
    )
    SELECT bucket AS period, tag, "userId", "displayName", deleted_count AS "deletedCount"
    FROM ranked WHERE rnk = 1 AND deleted_count > 0
  `;

  const suffix = period === 'year' ? '_year' : period === 'month' ? '_month' : '_week';
  return rows.map((r) => {
    const dateVal = new Date(r.period);
    const periodStr = period === 'year' ? String(year) : period === 'month'
      ? dateVal.toISOString().slice(0, 7) : dateVal.toISOString().slice(0, 10);
    return {
      tag: r.tag,
      period: periodStr,
      pageId: null,
      userId: Number(r.userId),
      displayName: r.displayName,
      value: Number(r.deletedCount),
      metric: `author_deleted_pages_category${suffix}`
    };
  });
}

// 主生成函数 - 使用 user-firsts-analysis.ts 的完整实现
async function generateUserFirstsData(year: number): Promise<TagLeader[]> {
  const concurrency = getConcurrency();
  console.log(`  -> Generating user-firsts data using full analysis with concurrency ${concurrency.FIRSTS_QUERY_CONCURRENCY}...`);

  // 调用完整的 user-firsts-analysis 函数
  const scoredLeaders = await generateUserFirstsFromAnalysis(year, {
    concurrency: concurrency.FIRSTS_QUERY_CONCURRENCY,
    silent: false
  });

  console.log(`  -> Generated ${scoredLeaders.length} user-firsts entries`);
  return scoredLeaders;
}

async function loadOrGenerateUserFirsts(year: number, forceGenerate: boolean, refreshCache: boolean): Promise<void> {
  const cachePath = path.join(process.cwd(), 'cache', `user-firsts-${year}.json`);
  const cacheExists = fs.existsSync(cachePath);

  if (!forceGenerate && cacheExists) {
    console.log(`\nLoading user-firsts cache...`);
    loadUserFirstsCache(year);
    return;
  }

  console.log(`\nGenerating user-firsts data${refreshCache ? ' (refreshing cache)' : ''}...`);
  const leaders = await generateUserFirstsData(year);

  // 更新内存缓存
  userFirstsCache = {
    year,
    generatedAt: new Date().toISOString(),
    leaders
  };

  userFirstsByUserId = new Map();
  for (const leader of leaders) {
    if (!userFirstsByUserId.has(leader.userId)) {
      userFirstsByUserId.set(leader.userId, []);
    }
    userFirstsByUserId.get(leader.userId)!.push(leader);
  }

  // 写入缓存文件
  if (refreshCache || !cacheExists) {
    const cacheDir = path.dirname(cachePath);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    fs.writeFileSync(cachePath, JSON.stringify(userFirstsCache, null, 2), 'utf-8');
    console.log(`  -> Cache written to ${cachePath}`);
  }
}

const DEFAULT_OUTPUT = path.join(process.cwd(), '..', 'frontend', 'public', 'annual-summary');

interface CommandArgs {
  year: number;
  outputDir: string;
  siteOnly: boolean;
  turbo: boolean;
  generateFirsts: boolean;
  refreshFirsts: boolean;
}

function parseArgs(): CommandArgs {
  const args = process.argv.slice(2);
  let year = DEFAULT_YEAR;
  let outputDir = DEFAULT_OUTPUT;
  let siteOnly = false;
  let turbo = false;
  let generateFirsts = false;
  let refreshFirsts = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--year' && args[i + 1]) {
      year = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      outputDir = args[i + 1];
      i++;
    } else if (args[i] === '--site-only') {
      siteOnly = true;
    } else if (args[i] === '--turbo' || args[i] === '--fast') {
      turbo = true;
    } else if (args[i] === '--generate-firsts') {
      generateFirsts = true;
    } else if (args[i] === '--refresh-firsts') {
      generateFirsts = true;
      refreshFirsts = true;
    }
  }

  return { year, outputDir, siteOnly, turbo, generateFirsts, refreshFirsts };
}

function yearRange(year: number) {
  const startTz = `${year}-01-01T00:00:00+08:00`;
  const endTz = `${year}-12-25T23:59:59+08:00`;
  return {
    startTzIso: new Date(startTz).toISOString(),
    endTzIso: new Date(endTz).toISOString()
  };
}

async function runInBatches<T>(tasks: Array<() => Promise<T>>, batchSize: number): Promise<T[]> {
  const results: T[] = [];
  const size = Math.max(1, Math.floor(batchSize));
  for (let i = 0; i < tasks.length; i += size) {
    const batch = tasks.slice(i, i + size).map(task => task());
    const batchResults = await Promise.all(batch);
    results.push(...batchResults);
  }
  return results;
}

// ============ Site Statistics ============

async function getSiteOverview(year: number) {
  const { startTzIso, endTzIso } = yearRange(year);
  const { startTzIso: prevStartIso, endTzIso: prevEndIso } = yearRange(year - 1);

  const [
    pageStats,
    prevPageStats,
    userStats,
    voteStats,
    wordStats,
    categoryStats
  ] = await runInBatches([
    () => prisma.$queryRaw<[{
      total: bigint;
      originals: bigint;
      translations: bigint;
    }]>`
      WITH pv AS (
        SELECT
          pv.id,
          pv."pageId",
          pv.tags,
          COALESCE(
            (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
            pv."createdAt"
          ) AS published_at
        FROM "PageVersion" pv
        WHERE pv."validTo" IS NULL
          AND NOT pv."isDeleted"
      )
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE tags @> ARRAY['原创']) AS originals,
        COUNT(*) FILTER (WHERE NOT (tags @> ARRAY['原创'])) AS translations
      FROM pv
      WHERE published_at >= ${startTzIso}::timestamptz
        AND published_at < ${endTzIso}::timestamptz
    `,
    () => prisma.$queryRaw<[{
      total: bigint;
    }]>`
      WITH pv AS (
        SELECT
          pv.tags,
          COALESCE(
            (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
            pv."createdAt"
          ) AS published_at
        FROM "PageVersion" pv
        WHERE pv."validTo" IS NULL
          AND NOT pv."isDeleted"
      )
      SELECT
        COUNT(*) AS total
      FROM pv
      WHERE published_at >= ${prevStartIso}::timestamptz
        AND published_at < ${prevEndIso}::timestamptz
    `,
    () => prisma.$queryRaw<[{
      total: bigint;
      newThisYear: bigint;
      activeThisYear: bigint;
      authors: bigint;
      translators: bigint;
      voters: bigint;
    }]>`
      WITH pv AS (
        SELECT
          a."userId",
          pv.tags,
          COALESCE(
            (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
            pv."createdAt"
          ) AS published_at
        FROM "PageVersion" pv
        JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
        WHERE pv."validTo" IS NULL
          AND NOT pv."isDeleted"
      )
      SELECT
        (SELECT COUNT(*) FROM "User") AS total,
        (SELECT COUNT(*) FROM "User" WHERE "firstActivityAt" >= ${startTzIso}::timestamptz AND "firstActivityAt" < ${endTzIso}::timestamptz) AS "newThisYear",
        (SELECT COUNT(DISTINCT "userId") FROM "UserDailyStats" WHERE date >= ${startTzIso}::date AND date < ${endTzIso}::date) AS "activeThisYear",
        (SELECT COUNT(DISTINCT "userId") FROM pv WHERE published_at >= ${startTzIso}::timestamptz AND published_at < ${endTzIso}::timestamptz AND tags @> ARRAY['原创']) AS authors,
        (SELECT COUNT(DISTINCT "userId") FROM pv WHERE published_at >= ${startTzIso}::timestamptz AND published_at < ${endTzIso}::timestamptz AND NOT (tags @> ARRAY['原创'])) AS translators,
        (SELECT COUNT(DISTINCT "userId") FROM "Vote" WHERE timestamp >= ${startTzIso}::timestamptz AND timestamp < ${endTzIso}::timestamptz AND "userId" IS NOT NULL) AS voters
    `,
    () => prisma.$queryRaw<[{
      total: bigint;
      up: bigint;
      down: bigint;
    }]>`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE direction = 1) AS up,
        COUNT(*) FILTER (WHERE direction = -1) AS down
      FROM "Vote" v
      JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
      WHERE v.timestamp >= ${startTzIso}::timestamptz
        AND v.timestamp < ${endTzIso}::timestamptz
        AND pv."validTo" IS NULL
        AND NOT pv."isDeleted"
    `,
    () => prisma.$queryRaw<[{
      totalOriginal: bigint;
      totalTranslation: bigint;
    }]>`
      WITH pv AS (
        SELECT
          pv.tags,
          LENGTH(COALESCE(pv.source, '')) AS len,
          COALESCE(
            (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
            pv."createdAt"
          ) AS published_at
        FROM "PageVersion" pv
        WHERE pv."validTo" IS NULL
          AND NOT pv."isDeleted"
      )
      SELECT
        COALESCE(SUM(len) FILTER (WHERE tags @> ARRAY['原创']), 0) AS "totalOriginal",
        COALESCE(SUM(len) FILTER (WHERE NOT (tags @> ARRAY['原创'])), 0) AS "totalTranslation"
      FROM pv
      WHERE published_at >= ${startTzIso}::timestamptz
        AND published_at < ${endTzIso}::timestamptz
    `,
    () => prisma.$queryRaw<{
      tag: string;
      count: bigint;
    }[]>`
      WITH pv AS (
        SELECT
          pv.tags,
          COALESCE(
            (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
            pv."createdAt"
          ) AS published_at
        FROM "PageVersion" pv
        WHERE pv."validTo" IS NULL
          AND NOT pv."isDeleted"
      ),
      tagged AS (
        SELECT unnest(tags) AS tag FROM pv
        WHERE published_at >= ${startTzIso}::timestamptz
          AND published_at < ${endTzIso}::timestamptz
      )
      SELECT tag, COUNT(*) AS count
      FROM tagged
      WHERE tag IN ('scp', '故事', 'tale', 'goi格式', 'goi-format', 'wanderers', '艺术作品', 'art', '文章', 'article')
      GROUP BY tag
      ORDER BY count DESC
    `
  ], Math.min(EXPORT_CONCURRENCY, 3)) as [
    { total: bigint; originals: bigint; translations: bigint }[],
    { total: bigint }[],
    { total: bigint; newThisYear: bigint; activeThisYear: bigint; authors: bigint; translators: bigint; voters: bigint }[],
    { total: bigint; up: bigint; down: bigint }[],
    { totalOriginal: bigint; totalTranslation: bigint }[],
    { tag: string; count: bigint }[]
  ];

  const byCategory: Record<string, number> = {};
  const categoryKeyMap: Record<string, string> = {
    scp: 'scp',
    故事: 'tale',
    tale: 'tale',
    'goi格式': 'goi-format',
    'goi-format': 'goi-format',
    wanderers: 'wanderers',
    '艺术作品': 'art',
    art: 'art',
    '文章': 'article',
    article: 'article'
  };
  for (const row of categoryStats) {
    const key = categoryKeyMap[row.tag] || 'other';
    byCategory[key] = (byCategory[key] || 0) + Number(row.count);
  }

  const recognizedTotal = Object.values(byCategory).reduce((acc, val) => acc + val, 0);
  const totalPages = Number(pageStats[0].total);
  const previousTotal = Number(prevPageStats?.[0]?.total ?? 0);
  const growthRate = previousTotal > 0 ? ((totalPages - previousTotal) / previousTotal) * 100 : null;
  const growthLabel = growthRate === null ? '—' : `${growthRate >= 0 ? '+' : ''}${growthRate.toFixed(1)}%`;
  if (totalPages > recognizedTotal) {
    byCategory.other = totalPages - recognizedTotal;
  }

  return {
    pages: {
      total: totalPages,
      growth: growthLabel,
      originals: Number(pageStats[0].originals),
      translations: Number(pageStats[0].translations),
      deleted: 0,
      byCategory
    },
    users: {
      total: Number(userStats[0].total),
      newThisYear: Number(userStats[0].newThisYear),
      activeThisYear: Number(userStats[0].activeThisYear),
      authors: Number(userStats[0].authors),
      translators: Number(userStats[0].translators),
      voters: Number(userStats[0].voters)
    },
    votes: {
      total: Number(voteStats[0].total),
      up: Number(voteStats[0].up),
      down: Number(voteStats[0].down),
      netScore: Number(voteStats[0].up) - Number(voteStats[0].down),
      avgPerPage: Number(pageStats[0].total) > 0 ? Math.round(Number(voteStats[0].total) / Number(pageStats[0].total) * 10) / 10 : 0,
      avgPerActiveUser: Number(userStats[0].activeThisYear) > 0 ? Math.round(Number(voteStats[0].total) / Number(userStats[0].activeThisYear) * 10) / 10 : 0
    },
    words: {
      totalOriginal: Number(wordStats[0].totalOriginal),
      totalTranslation: Number(wordStats[0].totalTranslation),
      avgPerOriginal: Number(pageStats[0].originals) > 0 ? Math.round(Number(wordStats[0].totalOriginal) / Number(pageStats[0].originals)) : 0,
      avgPerTranslation: Number(pageStats[0].translations) > 0 ? Math.round(Number(wordStats[0].totalTranslation) / Number(pageStats[0].translations)) : 0
    }
  };
}

async function getTopRatedPages(year: number, limit: number = 10) {
  const { startTzIso, endTzIso } = yearRange(year);

  const originals = await prisma.$queryRaw<{
    wikidotId: number;
    title: string;
    currentUrl: string;
    rating: number;
    createdAt: Date;
    authorDisplayName: string;
    tags: string[];
    wordCount: number;
  }[]>`
    WITH pv AS (
      SELECT
        pv.id,
        p."wikidotId",
        pv.title,
        p."currentUrl",
        pv.rating,
        pv.tags,
        LENGTH(COALESCE(pv.source, '')) AS word_count,
        COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.rating IS NOT NULL
        AND pv.tags @> ARRAY['原创']
    ),
    pv_with_authors AS (
      SELECT
        pv."wikidotId",
        pv.title,
        pv."currentUrl",
        pv.rating,
        pv.published_at,
        pv.tags,
        pv.word_count,
        STRING_AGG(DISTINCT u."displayName", '、' ORDER BY u."displayName") AS author_names
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      WHERE pv.published_at >= ${startTzIso}::timestamptz
        AND pv.published_at < ${endTzIso}::timestamptz
      GROUP BY pv."wikidotId", pv.title, pv."currentUrl", pv.rating, pv.published_at, pv.tags, pv.word_count
    )
    SELECT
      "wikidotId" AS "wikidotId",
      title,
      "currentUrl",
      rating,
      published_at AS "createdAt",
      author_names AS "authorDisplayName",
      tags,
      word_count AS "wordCount"
    FROM pv_with_authors
    ORDER BY rating DESC
    LIMIT ${limit}
  `;

  const translations = await prisma.$queryRaw<{
    wikidotId: number;
    title: string;
    currentUrl: string;
    rating: number;
    createdAt: Date;
    authorDisplayName: string;
    tags: string[];
    wordCount: number;
  }[]>`
    WITH pv AS (
      SELECT
        pv.id,
        p."wikidotId",
        pv.title,
        p."currentUrl",
        pv.rating,
        pv.tags,
        LENGTH(COALESCE(pv.source, '')) AS word_count,
        COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.rating IS NOT NULL
        AND NOT (pv.tags @> ARRAY['原创'])
    ),
    pv_with_authors AS (
      SELECT
        pv."wikidotId",
        pv.title,
        pv."currentUrl",
        pv.rating,
        pv.published_at,
        pv.tags,
        pv.word_count,
        STRING_AGG(DISTINCT u."displayName", '、' ORDER BY u."displayName") AS author_names
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      WHERE pv.published_at >= ${startTzIso}::timestamptz
        AND pv.published_at < ${endTzIso}::timestamptz
      GROUP BY pv."wikidotId", pv.title, pv."currentUrl", pv.rating, pv.published_at, pv.tags, pv.word_count
    )
    SELECT
      "wikidotId" AS "wikidotId",
      title,
      "currentUrl",
      rating,
      published_at AS "createdAt",
      author_names AS "authorDisplayName",
      tags,
      word_count AS "wordCount"
    FROM pv_with_authors
    ORDER BY rating DESC
    LIMIT ${limit}
  `;

  // Longest pages (by word count)
  const longestPages = await prisma.$queryRaw<{
    wikidotId: number;
    title: string;
    currentUrl: string;
    rating: number;
    createdAt: Date;
    authorDisplayName: string;
    tags: string[];
    wordCount: number;
  }[]>`
    WITH pv AS (
      SELECT
        pv.id,
        p."wikidotId",
        pv.title,
        p."currentUrl",
        pv.rating,
        pv.tags,
        LENGTH(COALESCE(pv.source, '')) AS word_count,
        COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.rating IS NOT NULL
    ),
    pv_with_authors AS (
      SELECT
        pv."wikidotId",
        pv.title,
        pv."currentUrl",
        pv.rating,
        pv.published_at,
        pv.tags,
        pv.word_count,
        STRING_AGG(DISTINCT u."displayName", '、' ORDER BY u."displayName") AS author_names
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      WHERE pv.published_at >= ${startTzIso}::timestamptz
        AND pv.published_at < ${endTzIso}::timestamptz
      GROUP BY pv."wikidotId", pv.title, pv."currentUrl", pv.rating, pv.published_at, pv.tags, pv.word_count
    )
    SELECT
      "wikidotId" AS "wikidotId",
      title,
      "currentUrl",
      rating,
      published_at AS "createdAt",
      author_names AS "authorDisplayName",
      tags,
      word_count AS "wordCount"
    FROM pv_with_authors
    ORDER BY word_count DESC
    LIMIT ${limit}
  `;

  // Shortest high-rated pages (rating >= 50, sorted by word count ascending)
  const shortestHighRated = await prisma.$queryRaw<{
    wikidotId: number;
    title: string;
    currentUrl: string;
    rating: number;
    createdAt: Date;
    authorDisplayName: string;
    tags: string[];
    wordCount: number;
  }[]>`
    WITH pv AS (
      SELECT
        pv.id,
        p."wikidotId",
        pv.title,
        p."currentUrl",
        pv.rating,
        pv.tags,
        LENGTH(COALESCE(pv.source, '')) AS word_count,
        COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.rating IS NOT NULL
        AND pv.rating >= 50
    ),
    pv_with_authors AS (
      SELECT
        pv."wikidotId",
        pv.title,
        pv."currentUrl",
        pv.rating,
        pv.published_at,
        pv.tags,
        pv.word_count,
        STRING_AGG(DISTINCT u."displayName", '、' ORDER BY u."displayName") AS author_names
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      WHERE pv.published_at >= ${startTzIso}::timestamptz
        AND pv.published_at < ${endTzIso}::timestamptz
        AND pv.word_count > 0
      GROUP BY pv."wikidotId", pv.title, pv."currentUrl", pv.rating, pv.published_at, pv.tags, pv.word_count
    )
    SELECT
      "wikidotId" AS "wikidotId",
      title,
      "currentUrl",
      rating,
      published_at AS "createdAt",
      author_names AS "authorDisplayName",
      tags,
      word_count AS "wordCount"
    FROM pv_with_authors
    ORDER BY word_count ASC
    LIMIT ${limit}
  `;

  // Extract slug from full URL (e.g., "http://scp-wiki-cn.wikidot.com/scp-001" -> "scp-001")
  const extractSlug = (url: string) => {
    const parts = url.split('/');
    return parts[parts.length - 1] || url;
  };

  const mapPage = (p: typeof originals[0], i: number) => ({
    rank: i + 1,
    wikidotId: Number(p.wikidotId),
    title: p.title,
    slug: extractSlug(p.currentUrl),
    rating: Number(p.rating),
    createdAt: formatDateTimeUTC8(p.createdAt),
    authorDisplayName: p.authorDisplayName,
    tags: p.tags,
    wordCount: Number(p.wordCount)
  });

  return {
    topRatedOriginals: originals.map(mapPage),
    topRatedTranslations: translations.map(mapPage),
    longestPages: longestPages.map(mapPage),
    shortestHighRated: shortestHighRated.map(mapPage)
  };
}

// Get top rated page for each category tag
async function getTopByCategory(year: number) {
  const { startTzIso, endTzIso } = yearRange(year);

  const categories = ['scp', '故事', 'goi格式', 'wanderers', '艺术作品', '文章'] as const;
  const results: Record<string, {
    original: {
      title: string;
      slug: string;
      rating: number;
      authorDisplayName: string;
      wikidotId: number;
    } | null;
    translation: {
      title: string;
      slug: string;
      rating: number;
      authorDisplayName: string;
      wikidotId: number;
    } | null;
  }> = {};

  for (const category of categories) {
    const topOriginal = await prisma.$queryRaw<{
      wikidotId: number;
      title: string;
      currentUrl: string;
      rating: number;
      authorDisplayName: string;
    }[]>`
      WITH pv AS (
        SELECT
          pv.id,
          p."wikidotId",
          pv.title,
          p."currentUrl",
          pv.rating,
          COALESCE(
            (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
            pv."createdAt"
          ) AS published_at
        FROM "PageVersion" pv
        JOIN "Page" p ON p.id = pv."pageId"
        WHERE pv."validTo" IS NULL
          AND NOT pv."isDeleted"
          AND pv.rating IS NOT NULL
          AND pv.tags @> ARRAY['原创']
          AND pv.tags @> ARRAY[${category}]
      ),
      pv_with_authors AS (
        SELECT
          pv."wikidotId",
          pv.title,
          pv."currentUrl",
          pv.rating,
          STRING_AGG(DISTINCT u."displayName", '、' ORDER BY u."displayName") AS author_names
        FROM pv
        JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
        LEFT JOIN "User" u ON u.id = a."userId"
        WHERE pv.published_at >= ${startTzIso}::timestamptz
          AND pv.published_at < ${endTzIso}::timestamptz
        GROUP BY pv."wikidotId", pv.title, pv."currentUrl", pv.rating
      )
      SELECT
        "wikidotId" AS "wikidotId",
        title,
        "currentUrl",
        rating,
        author_names AS "authorDisplayName"
      FROM pv_with_authors
      ORDER BY rating DESC
      LIMIT 1
    `;

    const topTranslation = await prisma.$queryRaw<{
      wikidotId: number;
      title: string;
      currentUrl: string;
      rating: number;
      authorDisplayName: string;
    }[]>`
      WITH pv AS (
        SELECT
          pv.id,
          p."wikidotId",
          pv.title,
          p."currentUrl",
          pv.rating,
          COALESCE(
            (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
            pv."createdAt"
          ) AS published_at
        FROM "PageVersion" pv
        JOIN "Page" p ON p.id = pv."pageId"
        WHERE pv."validTo" IS NULL
          AND NOT pv."isDeleted"
          AND pv.rating IS NOT NULL
          AND NOT (pv.tags @> ARRAY['原创'])
          AND pv.tags @> ARRAY[${category}]
      ),
      pv_with_authors AS (
        SELECT
          pv."wikidotId",
          pv.title,
          pv."currentUrl",
          pv.rating,
          STRING_AGG(DISTINCT u."displayName", '、' ORDER BY u."displayName") AS author_names
        FROM pv
        JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
        LEFT JOIN "User" u ON u.id = a."userId"
        WHERE pv.published_at >= ${startTzIso}::timestamptz
          AND pv.published_at < ${endTzIso}::timestamptz
        GROUP BY pv."wikidotId", pv.title, pv."currentUrl", pv.rating
      )
      SELECT
        "wikidotId" AS "wikidotId",
        title,
        "currentUrl",
        rating,
        author_names AS "authorDisplayName"
      FROM pv_with_authors
      ORDER BY rating DESC
      LIMIT 1
    `;

    const mapEntry = (rows: typeof topOriginal) => {
      if (rows.length === 0) return null;
      const p = rows[0];
      return {
        title: p.title,
        slug: p.currentUrl.split('/').pop() || '',
        rating: Number(p.rating),
        authorDisplayName: p.authorDisplayName,
        wikidotId: Number(p.wikidotId)
      };
    };

    results[category] = {
      original: mapEntry(topOriginal),
      translation: mapEntry(topTranslation)
    };
  }

  return results;
}

// Get additional extreme statistics
async function getExtremeStats(year: number) {
  const { startTzIso, endTzIso } = yearRange(year);

  // Page that received the most total votes this year
  const mostVotesTotal = await prisma.$queryRaw<{
    wikidotId: number;
    title: string;
    currentUrl: string;
    authorDisplayName: string;
    totalVotes: bigint;
  }[]>`
    WITH pv AS (
      SELECT
        pv.id,
        p."wikidotId",
        pv.title,
        p."currentUrl"
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.tags IS NOT NULL
        AND ARRAY_LENGTH(pv.tags, 1) > 0
    ),
    vote_counts AS (
      SELECT
        pv."wikidotId",
        pv.title,
        pv."currentUrl",
        pv.id AS pv_id,
        COUNT(*) AS total_votes
      FROM pv
      JOIN "Vote" v ON v."pageVersionId" = pv.id
      WHERE v.timestamp >= ${startTzIso}::timestamptz
        AND v.timestamp < ${endTzIso}::timestamptz
      GROUP BY pv."wikidotId", pv.title, pv."currentUrl", pv.id
    ),
    vote_counts_with_authors AS (
      SELECT
        vc."wikidotId",
        vc.title,
        vc."currentUrl",
        vc.total_votes,
        STRING_AGG(DISTINCT u."displayName", '、' ORDER BY u."displayName") AS author_names
      FROM vote_counts vc
      JOIN "Attribution" a ON a."pageVerId" = vc.pv_id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      GROUP BY vc."wikidotId", vc.title, vc."currentUrl", vc.total_votes
    )
    SELECT
      "wikidotId" AS "wikidotId",
      title,
      "currentUrl",
      author_names AS "authorDisplayName",
      total_votes AS "totalVotes"
    FROM vote_counts_with_authors
    ORDER BY total_votes DESC
    LIMIT 1
  `;

  // Highest rating gain in a single day (most votes received)
  const mostVotesOneDay = await prisma.$queryRaw<{
    wikidotId: number;
    title: string;
    currentUrl: string;
    authorDisplayName: string;
    dayVotes: bigint;
    voteDate: Date;
  }[]>`
    WITH pv AS (
      SELECT
        pv.id,
        p."wikidotId",
        pv.title,
        p."currentUrl"
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.tags IS NOT NULL
        AND ARRAY_LENGTH(pv.tags, 1) > 0
    ),
    daily_votes AS (
      SELECT
        pv."wikidotId",
        pv.title,
        pv."currentUrl",
        pv.id AS pv_id,
        (v.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::date AS vote_date,
        COUNT(*) AS day_votes
      FROM pv
      JOIN "Vote" v ON v."pageVersionId" = pv.id
      WHERE v.timestamp >= ${startTzIso}::timestamptz
        AND v.timestamp < ${endTzIso}::timestamptz
      GROUP BY pv."wikidotId", pv.title, pv."currentUrl", pv.id, (v.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::date
    ),
    daily_votes_with_authors AS (
      SELECT
        dv."wikidotId",
        dv.title,
        dv."currentUrl",
        dv.vote_date,
        dv.day_votes,
        STRING_AGG(DISTINCT u."displayName", '、' ORDER BY u."displayName") AS author_names
      FROM daily_votes dv
      JOIN "Attribution" a ON a."pageVerId" = dv.pv_id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      GROUP BY dv."wikidotId", dv.title, dv."currentUrl", dv.vote_date, dv.day_votes
    )
    SELECT
      "wikidotId" AS "wikidotId",
      title,
      "currentUrl",
      author_names AS "authorDisplayName",
      day_votes AS "dayVotes",
      vote_date AS "voteDate"
    FROM daily_votes_with_authors
    ORDER BY day_votes DESC
    LIMIT 1
  `;

  // Most upvotes received in a single day
  const mostUpvotesOneDay = await prisma.$queryRaw<{
    wikidotId: number;
    title: string;
    currentUrl: string;
    authorDisplayName: string;
    dayUpvotes: bigint;
    voteDate: Date;
  }[]>`
    WITH pv AS (
      SELECT
        pv.id,
        p."wikidotId",
        pv.title,
        p."currentUrl"
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
    ),
    daily_upvotes AS (
      SELECT
        pv."wikidotId",
        pv.title,
        pv."currentUrl",
        pv.id AS pv_id,
        (v.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::date AS vote_date,
        COUNT(*) AS day_upvotes
      FROM pv
      JOIN "Vote" v ON v."pageVersionId" = pv.id
      WHERE v.timestamp >= ${startTzIso}::timestamptz
        AND v.timestamp < ${endTzIso}::timestamptz
        AND v.direction = 1
      GROUP BY pv."wikidotId", pv.title, pv."currentUrl", pv.id, (v.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::date
    ),
    daily_upvotes_with_authors AS (
      SELECT
        du."wikidotId",
        du.title,
        du."currentUrl",
        du.vote_date,
        du.day_upvotes,
        STRING_AGG(DISTINCT u."displayName", '、' ORDER BY u."displayName") AS author_names
      FROM daily_upvotes du
      JOIN "Attribution" a ON a."pageVerId" = du.pv_id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      GROUP BY du."wikidotId", du.title, du."currentUrl", du.vote_date, du.day_upvotes
    )
    SELECT
      "wikidotId" AS "wikidotId",
      title,
      "currentUrl",
      author_names AS "authorDisplayName",
      day_upvotes AS "dayUpvotes",
      vote_date AS "voteDate"
    FROM daily_upvotes_with_authors
    ORDER BY day_upvotes DESC
    LIMIT 1
  `;

  // Most prolific day (most pages created in a single day)
  const mostProlificDay = await prisma.$queryRaw<{
    publishDate: Date;
    pageCount: bigint;
  }[]>`
    WITH pv AS (
      SELECT
        COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AS published_at
      FROM "PageVersion" pv
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
    )
    SELECT
      (published_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::date AS "publishDate",
      COUNT(*) AS "pageCount"
    FROM pv
    WHERE published_at >= ${startTzIso}::timestamptz
      AND published_at < ${endTzIso}::timestamptz
    GROUP BY (published_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::date
    ORDER BY "pageCount" DESC
    LIMIT 1
  `;

  return {
    mostVotesTotal: mostVotesTotal.length > 0 ? {
      wikidotId: Number(mostVotesTotal[0].wikidotId),
      title: mostVotesTotal[0].title,
      author: mostVotesTotal[0].authorDisplayName,
      count: Number(mostVotesTotal[0].totalVotes),
      label: '年度获票最多'
    } : null,
    mostVotesOneDay: mostVotesOneDay.length > 0 ? {
      wikidotId: Number(mostVotesOneDay[0].wikidotId),
      title: mostVotesOneDay[0].title,
      author: mostVotesOneDay[0].authorDisplayName,
      count: Number(mostVotesOneDay[0].dayVotes),
      date: formatDateOnlyUTC8(mostVotesOneDay[0].voteDate),
      label: '单日最多投票'
    } : null,
    mostUpvotesOneDay: mostUpvotesOneDay.length > 0 ? {
      wikidotId: Number(mostUpvotesOneDay[0].wikidotId),
      title: mostUpvotesOneDay[0].title,
      author: mostUpvotesOneDay[0].authorDisplayName,
      count: Number(mostUpvotesOneDay[0].dayUpvotes),
      date: formatDateOnlyUTC8(mostUpvotesOneDay[0].voteDate),
      label: '单日 UpVotes 最多'
    } : null,
    mostProlificDay: mostProlificDay.length > 0 ? {
      date: formatDateOnlyUTC8(mostProlificDay[0].publishDate),
      count: Number(mostProlificDay[0].pageCount),
      label: '最繁忙发布日'
    } : null
  };
}

async function getTopAuthors(year: number, limit: number = 10) {
  const { startTzIso, endTzIso } = yearRange(year);

  // byRating: 去重以避免同一用户对同一页面有多个 Attribution 记录导致重复计数
  const byRating = await prisma.$queryRaw<{
    userId: number;
    wikidotId: number | null;
    userName: string;
    displayName: string;
    totalRating: bigint;
    pageCount: bigint;
  }[]>`
    WITH pv AS (
      SELECT
        pv.id,
        pv.rating,
        COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AS published_at
      FROM "PageVersion" pv
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.rating IS NOT NULL
    ),
    dedup_attr AS (
      SELECT DISTINCT a."userId", pv.id AS page_ver_id, pv.rating
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      WHERE pv.published_at >= ${startTzIso}::timestamptz
        AND pv.published_at < ${endTzIso}::timestamptz
    )
    SELECT
      da."userId" AS "userId",
      u."wikidotId" AS "wikidotId",
      u.username AS "userName",
      u."displayName" AS "displayName",
      SUM(da.rating) AS "totalRating",
      COUNT(*) AS "pageCount"
    FROM dedup_attr da
    LEFT JOIN "User" u ON u.id = da."userId"
    GROUP BY da."userId", u."wikidotId", u.username, u."displayName"
    ORDER BY "totalRating" DESC
    LIMIT ${limit}
  `;

  // byOriginalCount: 去重以避免同一用户对同一页面有多个 Attribution 记录导致重复计数
  const byOriginalCount = await prisma.$queryRaw<{
    userId: number;
    wikidotId: number | null;
    userName: string;
    displayName: string;
    originalCount: bigint;
    totalRating: bigint;
  }[]>`
    WITH pv AS (
      SELECT
        pv.id,
        pv.rating,
        COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AS published_at
      FROM "PageVersion" pv
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.tags @> ARRAY['原创']
    ),
    dedup_attr AS (
      SELECT DISTINCT a."userId", pv.id AS page_ver_id, pv.rating
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      WHERE pv.published_at >= ${startTzIso}::timestamptz
        AND pv.published_at < ${endTzIso}::timestamptz
    )
    SELECT
      da."userId" AS "userId",
      u."wikidotId" AS "wikidotId",
      u.username AS "userName",
      u."displayName" AS "displayName",
      COUNT(*) AS "originalCount",
      COALESCE(SUM(da.rating), 0) AS "totalRating"
    FROM dedup_attr da
    LEFT JOIN "User" u ON u.id = da."userId"
    GROUP BY da."userId", u."wikidotId", u.username, u."displayName"
    ORDER BY "originalCount" DESC
    LIMIT ${limit}
  `;

  // byTranslationCount: 去重以避免同一用户对同一页面有多个 Attribution 记录导致重复计数
  const byTranslationCount = await prisma.$queryRaw<{
    userId: number;
    wikidotId: number | null;
    userName: string;
    displayName: string;
    translationCount: bigint;
    totalRating: bigint;
  }[]>`
    WITH pv AS (
      SELECT
        pv.id,
        pv.rating,
        COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AS published_at
      FROM "PageVersion" pv
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND NOT (pv.tags @> ARRAY['原创'])
    ),
    dedup_attr AS (
      SELECT DISTINCT a."userId", pv.id AS page_ver_id, pv.rating
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      WHERE pv.published_at >= ${startTzIso}::timestamptz
        AND pv.published_at < ${endTzIso}::timestamptz
    )
    SELECT
      da."userId" AS "userId",
      u."wikidotId" AS "wikidotId",
      u.username AS "userName",
      u."displayName" AS "displayName",
      COUNT(*) AS "translationCount",
      COALESCE(SUM(da.rating), 0) AS "totalRating"
    FROM dedup_attr da
    LEFT JOIN "User" u ON u.id = da."userId"
    GROUP BY da."userId", u."wikidotId", u.username, u."displayName"
    ORDER BY "translationCount" DESC
    LIMIT ${limit}
  `;

  // byWordCount: 去重以避免同一用户对同一页面有多个 Attribution 记录导致重复计数
  const byWordCount = await prisma.$queryRaw<{
    userId: number;
    wikidotId: number | null;
    userName: string;
    displayName: string;
    totalWords: bigint;
    pageCount: bigint;
  }[]>`
    WITH pv AS (
      SELECT
        pv.id,
        LENGTH(COALESCE(pv.source, '')) AS word_count,
        COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AS published_at
      FROM "PageVersion" pv
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
    ),
    dedup_attr AS (
      SELECT DISTINCT a."userId", pv.id AS page_ver_id, pv.word_count
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      WHERE pv.published_at >= ${startTzIso}::timestamptz
        AND pv.published_at < ${endTzIso}::timestamptz
    )
    SELECT
      da."userId" AS "userId",
      u."wikidotId" AS "wikidotId",
      u.username AS "userName",
      u."displayName" AS "displayName",
      SUM(da.word_count) AS "totalWords",
      COUNT(*) AS "pageCount"
    FROM dedup_attr da
    LEFT JOIN "User" u ON u.id = da."userId"
    GROUP BY da."userId", u."wikidotId", u.username, u."displayName"
    ORDER BY "totalWords" DESC
    LIMIT ${limit}
  `;

  return {
    topByTotalRating: byRating.map((a, i) => ({
      rank: i + 1,
      userId: Number(a.userId),
      wikidotId: a.wikidotId ? Number(a.wikidotId) : null,
      userName: a.userName,
      displayName: a.displayName,
      totalRating: Number(a.totalRating),
      pageCount: Number(a.pageCount),
      avgRating: Number(a.pageCount) > 0 ? Math.round(Number(a.totalRating) / Number(a.pageCount) * 10) / 10 : 0
    })),
    topByOriginalCount: byOriginalCount.map((a, i) => ({
      rank: i + 1,
      userId: Number(a.userId),
      wikidotId: a.wikidotId ? Number(a.wikidotId) : null,
      userName: a.userName,
      displayName: a.displayName,
      originalCount: Number(a.originalCount),
      totalRating: Number(a.totalRating),
      avgRating: Number(a.originalCount) > 0 ? Math.round(Number(a.totalRating) / Number(a.originalCount) * 10) / 10 : 0
    })),
    topByTranslationCount: byTranslationCount.map((a, i) => ({
      rank: i + 1,
      userId: Number(a.userId),
      wikidotId: a.wikidotId ? Number(a.wikidotId) : null,
      userName: a.userName,
      displayName: a.displayName,
      translationCount: Number(a.translationCount),
      totalRating: Number(a.totalRating)
    })),
    topByWordCount: byWordCount.map((a, i) => ({
      rank: i + 1,
      userId: Number(a.userId),
      wikidotId: a.wikidotId ? Number(a.wikidotId) : null,
      userName: a.userName,
      displayName: a.displayName,
      totalWords: Number(a.totalWords),
      pageCount: Number(a.pageCount)
    }))
  };
}

async function getTopVoters(year: number, limit: number = 10) {
  const { startTzIso, endTzIso } = yearRange(year);

  // 去重：每个用户对每个页面只计最后一票
  const topVoters = await prisma.$queryRaw<{
    userId: number;
    wikidotId: number | null;
    userName: string;
    displayName: string;
    totalVotes: bigint;
    upVotes: bigint;
    downVotes: bigint;
    activeDays: bigint;
  }[]>`
    WITH dedup_votes AS (
      SELECT * FROM (
        SELECT
          v."userId",
          v.direction,
          v.timestamp,
          pv."pageId",
          ROW_NUMBER() OVER (
            PARTITION BY v."userId", pv."pageId"
            ORDER BY v.timestamp DESC, v.id DESC
          ) AS rn
        FROM "Vote" v
        JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
        WHERE v.timestamp >= ${startTzIso}::timestamptz
          AND v.timestamp < ${endTzIso}::timestamptz
          AND v."userId" IS NOT NULL
          AND v.direction != 0
          AND pv."validTo" IS NULL
          AND NOT pv."isDeleted"
      ) t WHERE rn = 1
    )
    SELECT
      dv."userId" AS "userId",
      u."wikidotId" AS "wikidotId",
      u.username AS "userName",
      u."displayName" AS "displayName",
      COUNT(*) AS "totalVotes",
      COUNT(*) FILTER (WHERE dv.direction = 1) AS "upVotes",
      COUNT(*) FILTER (WHERE dv.direction = -1) AS "downVotes",
      COUNT(DISTINCT (dv.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::date) AS "activeDays"
    FROM dedup_votes dv
    LEFT JOIN "User" u ON u.id = dv."userId"
    GROUP BY dv."userId", u."wikidotId", u.username, u."displayName"
    ORDER BY "totalVotes" DESC
    LIMIT ${limit}
  `;

  return {
    topByTotalVotes: topVoters.map((v, i) => ({
      rank: i + 1,
      userId: Number(v.userId),
      wikidotId: v.wikidotId ? Number(v.wikidotId) : null,
      userName: v.userName,
      displayName: v.displayName,
      totalVotes: Number(v.totalVotes),
      upVotes: Number(v.upVotes),
      downVotes: Number(v.downVotes),
      upRate: Number(v.totalVotes) > 0 ? Math.round(Number(v.upVotes) / Number(v.totalVotes) * 1000) / 1000 : 0,
      activeDays: Number(v.activeDays),
      avgVotesPerDay: Number(v.activeDays) > 0 ? Math.round(Number(v.totalVotes) / Number(v.activeDays) * 10) / 10 : 0
    }))
  };
}

// ============ Monthly Vote Statistics ============

async function getMonthlyVoteStats(year: number) {
  const { startTzIso, endTzIso } = yearRange(year);

  const monthlyVotes = await prisma.$queryRaw<{
    month: Date;
    total: bigint;
    up: bigint;
    down: bigint;
  }[]>`
    SELECT
      date_trunc('month', v.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai') AS month,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE v.direction = 1) AS up,
      COUNT(*) FILTER (WHERE v.direction = -1) AS down
    FROM "Vote" v
    JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
    WHERE v.timestamp >= ${startTzIso}::timestamptz
      AND v.timestamp < ${endTzIso}::timestamptz
      AND pv."validTo" IS NULL
      AND NOT pv."isDeleted"
    GROUP BY 1
    ORDER BY 1
  `;

  return {
    monthlyVotes: monthlyVotes.map(v => ({
      month: formatMonthUTC8(v.month),
      total: Number(v.total),
      up: Number(v.up),
      down: Number(v.down),
      upRate: Number(v.total) > 0 ? Math.round(Number(v.up) / Number(v.total) * 1000) / 10 : 0
    }))
  };
}

// ============ Vote Distribution by Category ============

async function getVotesByCategory(year: number) {
  const { startTzIso, endTzIso } = yearRange(year);

  const categories = ['scp', '故事', 'goi格式', 'wanderers', '艺术作品', '文章'] as const;
  const results: Record<string, { total: number; up: number; down: number; upRate: number }> = {};

  for (const category of categories) {
    const stats = await prisma.$queryRaw<[{
      total: bigint;
      up: bigint;
      down: bigint;
    }]>`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE v.direction = 1) AS up,
        COUNT(*) FILTER (WHERE v.direction = -1) AS down
      FROM "Vote" v
      JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
      WHERE v.timestamp >= ${startTzIso}::timestamptz
        AND v.timestamp < ${endTzIso}::timestamptz
        AND pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.tags @> ARRAY[${category}]
    `;

    const total = Number(stats[0].total);
    const up = Number(stats[0].up);
    const down = Number(stats[0].down);

    results[category] = {
      total,
      up,
      down,
      upRate: total > 0 ? Math.round(up / total * 1000) / 10 : 0
    };
  }

  return { votesByCategory: results };
}

// ============ Revision Time Distribution ============

async function getRevisionTimeDistribution(year: number) {
  const { startTzIso, endTzIso } = yearRange(year);

  // Monthly revision counts
  const monthlyRevisions = await prisma.$queryRaw<{
    month: Date;
    count: bigint;
  }[]>`
    SELECT
      date_trunc('month', r.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai') AS month,
      COUNT(*) AS count
    FROM "Revision" r
    JOIN "PageVersion" pv ON pv.id = r."pageVersionId"
    WHERE r.timestamp >= ${startTzIso}::timestamptz
      AND r.timestamp < ${endTzIso}::timestamptz
      AND pv."validTo" IS NULL
      AND NOT pv."isDeleted"
    GROUP BY 1
    ORDER BY 1
  `;

  // Hourly distribution (0-23)
  const hourlyRevisions = await prisma.$queryRaw<{
    hour: number;
    count: bigint;
  }[]>`
    SELECT
      EXTRACT(HOUR FROM r.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::int AS hour,
      COUNT(*) AS count
    FROM "Revision" r
    JOIN "PageVersion" pv ON pv.id = r."pageVersionId"
    WHERE r.timestamp >= ${startTzIso}::timestamptz
      AND r.timestamp < ${endTzIso}::timestamptz
      AND pv."validTo" IS NULL
      AND NOT pv."isDeleted"
    GROUP BY 1
    ORDER BY 1
  `;

  // Time of day distribution (凌晨/早晨/上午/下午/晚上/深夜)
  const timeOfDayRevisions = await prisma.$queryRaw<{
    period: string;
    count: bigint;
  }[]>`
    WITH rev_hours AS (
      SELECT
        EXTRACT(HOUR FROM r.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::int AS hour
      FROM "Revision" r
      JOIN "PageVersion" pv ON pv.id = r."pageVersionId"
      WHERE r.timestamp >= ${startTzIso}::timestamptz
        AND r.timestamp < ${endTzIso}::timestamptz
        AND pv."validTo" IS NULL
        AND NOT pv."isDeleted"
    )
    SELECT
      CASE
        WHEN hour >= 0 AND hour < 6 THEN '凌晨'
        WHEN hour >= 6 AND hour < 9 THEN '早晨'
        WHEN hour >= 9 AND hour < 12 THEN '上午'
        WHEN hour >= 12 AND hour < 14 THEN '中午'
        WHEN hour >= 14 AND hour < 18 THEN '下午'
        WHEN hour >= 18 AND hour < 22 THEN '晚上'
        ELSE '深夜'
      END AS period,
      COUNT(*) AS count
    FROM rev_hours
    GROUP BY 1
  `;

  // Weekday distribution (周一-周日)
  const weekdayRevisions = await prisma.$queryRaw<{
    weekday: number;
    count: bigint;
  }[]>`
    SELECT
      EXTRACT(DOW FROM r.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::int AS weekday,
      COUNT(*) AS count
    FROM "Revision" r
    JOIN "PageVersion" pv ON pv.id = r."pageVersionId"
    WHERE r.timestamp >= ${startTzIso}::timestamptz
      AND r.timestamp < ${endTzIso}::timestamptz
      AND pv."validTo" IS NULL
      AND NOT pv."isDeleted"
    GROUP BY 1
    ORDER BY 1
  `;

  // Map time periods to ensure correct order
  const periodOrder = ['凌晨', '早晨', '上午', '中午', '下午', '晚上', '深夜'];
  const periodMap = new Map(timeOfDayRevisions.map(p => [p.period, Number(p.count)]));
  const byTimeOfDay = periodOrder.map(period => ({
    period,
    count: periodMap.get(period) || 0
  }));

  const weekdayOrder = [
    { label: '周一', value: 1 },
    { label: '周二', value: 2 },
    { label: '周三', value: 3 },
    { label: '周四', value: 4 },
    { label: '周五', value: 5 },
    { label: '周六', value: 6 },
    { label: '周日', value: 0 }
  ];
  const weekdayMap = new Map(weekdayRevisions.map(r => [r.weekday, Number(r.count)]));
  const byWeekday = weekdayOrder.map(day => ({
    weekday: day.label,
    count: weekdayMap.get(day.value) || 0
  }));

  return {
    monthlyRevisions: monthlyRevisions.map(r => ({
      month: formatMonthUTC8(r.month),
      count: Number(r.count)
    })),
    hourlyRevisions: hourlyRevisions.map(r => ({
      hour: r.hour,
      count: Number(r.count)
    })),
    byTimeOfDay,
    byWeekday
  };
}

// ============ Interesting Statistics ============

async function getInterestingStats(year: number) {
  const { startTzIso, endTzIso } = yearRange(year);

  // Most active voting day
  const mostActiveVotingDay = await prisma.$queryRaw<{
    date: Date;
    voteCount: bigint;
  }[]>`
    SELECT
      (v.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::date AS date,
      COUNT(*) AS "voteCount"
    FROM "Vote" v
    JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
    WHERE v.timestamp >= ${startTzIso}::timestamptz
      AND v.timestamp < ${endTzIso}::timestamptz
      AND pv."validTo" IS NULL
      AND NOT pv."isDeleted"
    GROUP BY 1
    ORDER BY "voteCount" DESC
    LIMIT 1
  `;

  // Longest page created this year
  const longestPage = await prisma.$queryRaw<{
    title: string;
    authorDisplayName: string;
    wordCount: number;
    wikidotId: number;
  }[]>`
    WITH pv AS (
      SELECT
        pv.id,
        p."wikidotId",
        pv.title,
        LENGTH(COALESCE(pv.source, '')) AS word_count,
        COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
    ),
    pv_with_authors AS (
      SELECT
        pv."wikidotId",
        pv.title,
        pv.word_count,
        STRING_AGG(DISTINCT u."displayName", '、' ORDER BY u."displayName") AS author_names
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      WHERE pv.published_at >= ${startTzIso}::timestamptz
        AND pv.published_at < ${endTzIso}::timestamptz
      GROUP BY pv."wikidotId", pv.title, pv.word_count
    )
    SELECT
      "wikidotId" AS "wikidotId",
      title,
      author_names AS "authorDisplayName",
      word_count AS "wordCount"
    FROM pv_with_authors
    ORDER BY word_count DESC
    LIMIT 1
  `;

  // Most collaborative page (most co-authors)
  const mostCollaborativePage = await prisma.$queryRaw<{
    title: string;
    authorCount: bigint;
    authors: string;
    wikidotId: number;
  }[]>`
    WITH pv AS (
      SELECT
        pv.id,
        p."wikidotId",
        pv.title,
        COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
    ),
    pv_authors AS (
      SELECT
        pv."wikidotId",
        pv.title,
        COUNT(DISTINCT a."userId") AS author_count,
        STRING_AGG(DISTINCT u."displayName", '、' ORDER BY u."displayName") AS authors
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      WHERE pv.published_at >= ${startTzIso}::timestamptz
        AND pv.published_at < ${endTzIso}::timestamptz
      GROUP BY pv."wikidotId", pv.title
    )
    SELECT
      "wikidotId" AS "wikidotId",
      title,
      author_count AS "authorCount",
      authors
    FROM pv_authors
    ORDER BY author_count DESC
    LIMIT 1
  `;

  // Most controversial page (highest down vote ratio among pages with >= 20 votes)
  const mostControversialPage = await prisma.$queryRaw<{
    title: string;
    authorDisplayName: string;
    totalVotes: bigint;
    downVotes: bigint;
    downRate: number;
    wikidotId: number;
  }[]>`
    WITH pv AS (
      SELECT
        pv.id,
        p."wikidotId",
        pv.title,
        COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
    ),
    vote_stats AS (
      SELECT
        pv."wikidotId",
        pv.title,
        pv.id AS pv_id,
        COUNT(*) AS total_votes,
        COUNT(*) FILTER (WHERE v.direction = -1) AS down_votes
      FROM pv
      JOIN "Vote" v ON v."pageVersionId" = pv.id
      WHERE pv.published_at >= ${startTzIso}::timestamptz
        AND pv.published_at < ${endTzIso}::timestamptz
        AND v.timestamp >= ${startTzIso}::timestamptz
        AND v.timestamp < ${endTzIso}::timestamptz
      GROUP BY pv."wikidotId", pv.title, pv.id
      HAVING COUNT(*) >= 20
    ),
    with_authors AS (
      SELECT
        vs."wikidotId",
        vs.title,
        vs.total_votes,
        vs.down_votes,
        (vs.down_votes::float / vs.total_votes * 100)::float AS down_rate,
        STRING_AGG(DISTINCT u."displayName", '、' ORDER BY u."displayName") AS author_names
      FROM vote_stats vs
      JOIN "Attribution" a ON a."pageVerId" = vs.pv_id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      GROUP BY vs."wikidotId", vs.title, vs.total_votes, vs.down_votes
    )
    SELECT
      "wikidotId" AS "wikidotId",
      title,
      author_names AS "authorDisplayName",
      total_votes AS "totalVotes",
      down_votes AS "downVotes",
      down_rate AS "downRate"
    FROM with_authors
    ORDER BY down_rate DESC
    LIMIT 1
  `;

  // Fastest rising page (most votes in first 24 hours)
  const fastestRisingPage = await prisma.$queryRaw<{
    title: string;
    authorDisplayName: string;
    first24hVotes: bigint;
    wikidotId: number;
  }[]>`
    WITH pv AS (
      SELECT
        pv.id,
        p."wikidotId",
        pv.title,
        COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
    ),
    first_day_votes AS (
      SELECT
        pv."wikidotId",
        pv.title,
        pv.id AS pv_id,
        COUNT(*) AS vote_count
      FROM pv
      JOIN "Vote" v ON v."pageVersionId" = pv.id
      WHERE pv.published_at >= ${startTzIso}::timestamptz
        AND pv.published_at < ${endTzIso}::timestamptz
        AND v.timestamp >= pv.published_at
        AND v.timestamp < pv.published_at + interval '24 hours'
      GROUP BY pv."wikidotId", pv.title, pv.id
    ),
    with_authors AS (
      SELECT
        fdv."wikidotId",
        fdv.title,
        fdv.vote_count,
        STRING_AGG(DISTINCT u."displayName", '、' ORDER BY u."displayName") AS author_names
      FROM first_day_votes fdv
      JOIN "Attribution" a ON a."pageVerId" = fdv.pv_id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      GROUP BY fdv."wikidotId", fdv.title, fdv.vote_count
    )
    SELECT
      "wikidotId" AS "wikidotId",
      title,
      author_names AS "authorDisplayName",
      vote_count AS "first24hVotes"
    FROM with_authors
    ORDER BY vote_count DESC
    LIMIT 1
  `;

  // Weekday vs Weekend activity
  const weekdayVsWeekend = await prisma.$queryRaw<{
    isWeekend: boolean;
    voteCount: bigint;
    pageCount: bigint;
  }[]>`
    WITH votes_by_day AS (
      SELECT
        EXTRACT(DOW FROM v.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai') IN (0, 6) AS is_weekend,
        COUNT(*) AS vote_count
      FROM "Vote" v
      JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
      WHERE v.timestamp >= ${startTzIso}::timestamptz
        AND v.timestamp < ${endTzIso}::timestamptz
        AND pv."validTo" IS NULL
        AND NOT pv."isDeleted"
      GROUP BY 1
    ),
    pages_by_day AS (
      SELECT
        EXTRACT(DOW FROM COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai') IN (0, 6) AS is_weekend,
        COUNT(*) AS page_count
      FROM "PageVersion" pv
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) >= ${startTzIso}::timestamptz
        AND COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) < ${endTzIso}::timestamptz
      GROUP BY 1
    )
    SELECT
      COALESCE(v.is_weekend, p.is_weekend) AS "isWeekend",
      COALESCE(v.vote_count, 0) AS "voteCount",
      COALESCE(p.page_count, 0) AS "pageCount"
    FROM votes_by_day v
    FULL OUTER JOIN pages_by_day p ON v.is_weekend = p.is_weekend
  `;

  // Peak voting hour
  const peakVotingHour = await prisma.$queryRaw<{
    hour: number;
    voteCount: bigint;
  }[]>`
    SELECT
      EXTRACT(HOUR FROM v.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::int AS hour,
      COUNT(*) AS "voteCount"
    FROM "Vote" v
    JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
    WHERE v.timestamp >= ${startTzIso}::timestamptz
      AND v.timestamp < ${endTzIso}::timestamptz
      AND pv."validTo" IS NULL
      AND NOT pv."isDeleted"
    GROUP BY 1
    ORDER BY "voteCount" DESC
    LIMIT 1
  `;

  // Longest title page
  const longestTitlePage = await prisma.$queryRaw<{
    title: string;
    titleLength: number;
    authorDisplayName: string;
    wikidotId: number;
    rating: number;
  }[]>`
    WITH pv AS (
      SELECT
        pv.id,
        p."wikidotId",
        pv.title,
        LENGTH(pv.title) AS title_length,
        pv.rating,
        COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
    ),
    pv_with_authors AS (
      SELECT
        pv."wikidotId",
        pv.title,
        pv.title_length,
        pv.rating,
        STRING_AGG(DISTINCT u."displayName", '、' ORDER BY u."displayName") AS author_names
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      WHERE pv.published_at >= ${startTzIso}::timestamptz
        AND pv.published_at < ${endTzIso}::timestamptz
      GROUP BY pv."wikidotId", pv.title, pv.title_length, pv.rating
    )
    SELECT
      "wikidotId" AS "wikidotId",
      title,
      title_length AS "titleLength",
      author_names AS "authorDisplayName",
      rating
    FROM pv_with_authors
    ORDER BY title_length DESC
    LIMIT 1
  `;

  // Most tags page
  const mostTagsPage = await prisma.$queryRaw<{
    title: string;
    tagCount: number;
    tags: string[];
    authorDisplayName: string;
    wikidotId: number;
    rating: number;
  }[]>`
    WITH pv AS (
      SELECT
        pv.id,
        p."wikidotId",
        pv.title,
        pv.tags,
        COALESCE(ARRAY_LENGTH(pv.tags, 1), 0) AS tag_count,
        pv.rating,
        COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AS published_at
      FROM "PageVersion" pv
      JOIN "Page" p ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.tags IS NOT NULL
        AND ARRAY_LENGTH(pv.tags, 1) > 0
    ),
    pv_with_authors AS (
      SELECT
        pv."wikidotId",
        pv.title,
        pv.tags,
        pv.tag_count,
        pv.rating,
        STRING_AGG(DISTINCT u."displayName", '、' ORDER BY u."displayName") AS author_names
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      LEFT JOIN "User" u ON u.id = a."userId"
      WHERE pv.published_at >= ${startTzIso}::timestamptz
        AND pv.published_at < ${endTzIso}::timestamptz
      GROUP BY pv."wikidotId", pv.title, pv.tags, pv.tag_count, pv.rating
    )
    SELECT
      "wikidotId" AS "wikidotId",
      title,
      tag_count AS "tagCount",
      tags,
      author_names AS "authorDisplayName",
      rating
    FROM pv_with_authors
    ORDER BY tag_count DESC NULLS LAST
    LIMIT 1
  `;

  // First revision of the year
  const firstRevision = await prisma.$queryRaw<{
    timestamp: Date;
    type: string;
    title: string;
    authorDisplayName: string | null;
    wikidotId: number;
  }[]>`
    SELECT
      r.timestamp,
      r.type,
      pv.title,
      u."displayName" AS "authorDisplayName",
      p."wikidotId"
    FROM "Revision" r
    JOIN "PageVersion" pv ON pv.id = r."pageVersionId"
    JOIN "Page" p ON p.id = pv."pageId"
    LEFT JOIN "User" u ON u.id = r."userId"
    WHERE r.timestamp >= ${startTzIso}::timestamptz
      AND r.timestamp < ${endTzIso}::timestamptz
    ORDER BY r.timestamp ASC
    LIMIT 1
  `;

  // Format weekday vs weekend
  const weekdayData = weekdayVsWeekend.find(w => !w.isWeekend);
  const weekendData = weekdayVsWeekend.find(w => w.isWeekend);

  return {
    mostActiveVotingDay: mostActiveVotingDay.length > 0 ? {
      date: formatDateOnlyUTC8(mostActiveVotingDay[0].date),
      voteCount: Number(mostActiveVotingDay[0].voteCount),
      label: '最活跃投票日'
    } : null,
    longestPage: longestPage.length > 0 ? {
      title: longestPage[0].title,
      author: longestPage[0].authorDisplayName,
      wordCount: Number(longestPage[0].wordCount),
      wikidotId: Number(longestPage[0].wikidotId),
      label: '年度最长作品'
    } : null,
    mostCollaborativePage: mostCollaborativePage.length > 0 ? {
      title: mostCollaborativePage[0].title,
      authors: mostCollaborativePage[0].authors,
      authorCount: Number(mostCollaborativePage[0].authorCount),
      wikidotId: Number(mostCollaborativePage[0].wikidotId),
      label: '合著人数最多'
    } : null,
    mostControversialPage: mostControversialPage.length > 0 ? {
      title: mostControversialPage[0].title,
      author: mostControversialPage[0].authorDisplayName,
      totalVotes: Number(mostControversialPage[0].totalVotes),
      downVotes: Number(mostControversialPage[0].downVotes),
      downRate: Math.round(mostControversialPage[0].downRate * 10) / 10,
      wikidotId: Number(mostControversialPage[0].wikidotId),
      label: '最具争议作品'
    } : null,
    fastestRisingPage: fastestRisingPage.length > 0 ? {
      title: fastestRisingPage[0].title,
      author: fastestRisingPage[0].authorDisplayName,
      first24hVotes: Number(fastestRisingPage[0].first24hVotes),
      wikidotId: Number(fastestRisingPage[0].wikidotId),
      label: '24小时内获票最多'
    } : null,
    weekdayVsWeekend: {
      weekday: {
        votes: weekdayData ? Number(weekdayData.voteCount) : 0,
        pages: weekdayData ? Number(weekdayData.pageCount) : 0
      },
      weekend: {
        votes: weekendData ? Number(weekendData.voteCount) : 0,
        pages: weekendData ? Number(weekendData.pageCount) : 0
      }
    },
    peakVotingHour: peakVotingHour.length > 0 ? {
      hour: peakVotingHour[0].hour,
      voteCount: Number(peakVotingHour[0].voteCount),
      label: `${peakVotingHour[0].hour}:00-${peakVotingHour[0].hour + 1}:00`
    } : null,
    longestTitlePage: longestTitlePage.length > 0 ? {
      title: longestTitlePage[0].title,
      titleLength: Number(longestTitlePage[0].titleLength),
      author: longestTitlePage[0].authorDisplayName,
      wikidotId: Number(longestTitlePage[0].wikidotId),
      rating: Number(longestTitlePage[0].rating),
      label: '标题最长'
    } : null,
    mostTagsPage: mostTagsPage.length > 0 ? {
      title: mostTagsPage[0].title,
      tagCount: Number(mostTagsPage[0].tagCount),
      tags: mostTagsPage[0].tags,
      author: mostTagsPage[0].authorDisplayName,
      wikidotId: Number(mostTagsPage[0].wikidotId),
      rating: Number(mostTagsPage[0].rating),
      label: 'Tag最多'
    } : null,
    firstRevision: firstRevision.length > 0 ? {
      timestamp: formatDateTimeUTC8(firstRevision[0].timestamp),
      type: firstRevision[0].type,
      title: firstRevision[0].title,
      author: firstRevision[0].authorDisplayName || '未知',
      wikidotId: Number(firstRevision[0].wikidotId),
      label: '年度第一个编辑'
    } : null
  };
}

async function getMonthlyTrends(year: number) {
  const { startTzIso, endTzIso } = yearRange(year);

  const trends = await prisma.$queryRaw<{
    month: Date;
    originals: bigint;
    translations: bigint;
  }[]>`
    WITH pv AS (
      SELECT
        pv.tags,
        COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AS published_at
      FROM "PageVersion" pv
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
    )
    SELECT
      date_trunc('month', published_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai') AS month,
      COUNT(*) FILTER (WHERE tags @> ARRAY['原创']) AS originals,
      COUNT(*) FILTER (WHERE NOT (tags @> ARRAY['原创'])) AS translations
    FROM pv
    WHERE published_at >= ${startTzIso}::timestamptz
      AND published_at < ${endTzIso}::timestamptz
    GROUP BY 1
    ORDER BY 1
  `;

  return {
    monthlyPages: trends.map(t => ({
      month: formatMonthUTC8(t.month),
      originals: Number(t.originals),
      translations: Number(t.translations),
      total: Number(t.originals) + Number(t.translations)
    }))
  };
}

async function getPageDistributions(year: number) {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<{
    tagCount: number;
    titleLength: number;
  }[]>`
    WITH pv AS (
      SELECT
        COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AS published_at,
        COALESCE(cardinality(pv.tags), 0) AS tag_count,
        LENGTH(COALESCE(pv.title, '')) AS title_length
      FROM "PageVersion" pv
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
    )
    SELECT
      tag_count AS "tagCount",
      title_length AS "titleLength"
    FROM pv
    WHERE published_at >= ${startTzIso}::timestamptz
      AND published_at < ${endTzIso}::timestamptz
  `;

  const tagCounts = rows.map(row => Number(row.tagCount));
  const titleLengths = rows.map(row => Number(row.titleLength));

  return {
    tagCount: buildDistribution(tagCounts, TAG_COUNT_BUCKETS),
    titleLength: buildDistribution(titleLengths, TITLE_LENGTH_BUCKETS)
  };
}

async function getUserDistributions(year: number) {
  const { startTzIso, endTzIso } = yearRange(year);
  const voteRows = await prisma.$queryRaw<{
    userId: number;
    votesCast: bigint;
  }[]>`
    SELECT
      v."userId" AS "userId",
      COUNT(*) AS "votesCast"
    FROM "Vote" v
    JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
    WHERE v.timestamp >= ${startTzIso}::timestamptz
      AND v.timestamp < ${endTzIso}::timestamptz
      AND v."userId" IS NOT NULL
      AND pv."validTo" IS NULL
      AND NOT pv."isDeleted"
    GROUP BY v."userId"
    HAVING COUNT(*) > 0
  `;

  // 去重以避免同一用户对同一页面有多个 Attribution 记录导致重复计数
  const wordRows = await prisma.$queryRaw<{
    userId: number;
    totalWords: bigint;
  }[]>`
    WITH pv AS (
      SELECT
        pv.id,
        LENGTH(COALESCE(pv.source, '')) AS word_count,
        COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AS published_at
      FROM "PageVersion" pv
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
    ),
    dedup_attr AS (
      SELECT DISTINCT a."userId", pv.id AS page_ver_id, pv.word_count
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      WHERE pv.published_at >= ${startTzIso}::timestamptz
        AND pv.published_at < ${endTzIso}::timestamptz
    )
    SELECT
      "userId" AS "userId",
      SUM(word_count) AS "totalWords"
    FROM dedup_attr
    GROUP BY "userId"
    HAVING SUM(word_count) > 0
  `;

  const voteValues = voteRows.map(row => Number(row.votesCast)).filter(value => value > 0);
  const wordValues = wordRows.map(row => Number(row.totalWords)).filter(value => value > 0);

  return {
    votesCast: buildDistribution(voteValues, VOTES_CAST_BUCKETS),
    contentWords: buildDistribution(wordValues, CONTENT_WORD_BUCKETS)
  };
}

async function getDistributions(year: number) {
  const [pageDistributions, userDistributions] = await Promise.all([
    getPageDistributions(year),
    getUserDistributions(year)
  ]);

  return {
    ...pageDistributions,
    ...userDistributions
  };
}

// ============ Deleted Page Statistics ============

/**
 * 获取今年创建并被删除的页面统计
 * 注意：只统计今年创建的页面，排除历史数据迁移后被删除的情况
 */
async function getDeletedPageStats(year: number) {
  const { startTzIso, endTzIso } = yearRange(year);

  // 今年创建并在今年被删除的页面
  const deletedPages = await prisma.$queryRaw<{
    pageId: number;
    deletedVerId: number;
    title: string;
    deletedAt: Date;
    createdAt: Date;
  }[]>`
    SELECT
      pv.id AS "deletedVerId",
      pv."pageId" AS "pageId",
      pv.title,
      pv."createdAt" AS "deletedAt",
      p."firstPublishedAt" AS "createdAt"
    FROM "PageVersion" pv
    JOIN "Page" p ON p.id = pv."pageId"
    WHERE pv."validTo" IS NULL
      AND pv."isDeleted" = true
      AND pv."createdAt" >= ${startTzIso}::timestamptz
      AND pv."createdAt" < ${endTzIso}::timestamptz
      AND p."firstPublishedAt" >= ${startTzIso}::timestamptz
      AND p."firstPublishedAt" < ${endTzIso}::timestamptz
  `;

  if (deletedPages.length === 0) {
    return {
      total: 0,
      byCategory: {
        scp: 0,
        tale: 0,
        goi: 0,
        wanderers: 0,
        art: 0,
        article: 0
      },
      originalCount: 0,
      translationCount: 0,
      topAuthors: [],
      monthlyTrend: []
    };
  }

  const deletedVerIds = deletedPages.map(p => p.deletedVerId);
  const pageIds = deletedPages.map(p => p.pageId);

  // 获取每个已删除页面的有意义标签（从历史版本中找）
  const meaningfulTags = await prisma.$queryRaw<{
    pageId: number;
    cleanTags: string[];
  }[]>`
    WITH ranked_versions AS (
      SELECT
        pv."pageId",
        array_remove(pv.tags, '待删除') AS clean_tags,
        ROW_NUMBER() OVER (PARTITION BY pv."pageId" ORDER BY pv."createdAt" DESC) AS rn
      FROM "PageVersion" pv
      WHERE pv."pageId" = ANY(${pageIds})
        AND array_length(pv.tags, 1) > 0
    )
    SELECT
      "pageId" AS "pageId",
      clean_tags AS "cleanTags"
    FROM ranked_versions
    WHERE rn = 1
  `;

  const tagsByPageId = new Map(meaningfulTags.map(t => [t.pageId, t.cleanTags]));

  // 统计分类
  let scpCount = 0, taleCount = 0, goiCount = 0, wanderersCount = 0, artCount = 0, articleCount = 0;
  let originalCount = 0, translationCount = 0;

  for (const page of deletedPages) {
    const tags = tagsByPageId.get(page.pageId) || [];
    if (tags.includes('scp')) scpCount++;
    if (tags.includes('故事')) taleCount++;
    if (tags.includes('goi格式')) goiCount++;
    if (tags.includes('wanderers')) wanderersCount++;
    if (tags.includes('艺术作品')) artCount++;
    if (tags.includes('文章')) articleCount++;
    if (tags.includes('原创')) {
      originalCount++;
    } else {
      translationCount++;
    }
  }

  // 今年创建并删除页面最多的作者
  const topAuthors = await prisma.$queryRaw<{
    userId: number;
    wikidotId: number | null;
    displayName: string;
    deletedCount: bigint;
  }[]>`
    SELECT
      a."userId" AS "userId",
      u."wikidotId" AS "wikidotId",
      u."displayName" AS "displayName",
      COUNT(*) AS "deletedCount"
    FROM "Attribution" a
    JOIN "User" u ON u.id = a."userId"
    WHERE a."pageVerId" = ANY(${deletedVerIds})
      AND a."userId" IS NOT NULL
    GROUP BY a."userId", u."wikidotId", u."displayName"
    ORDER BY "deletedCount" DESC
    LIMIT 10
  `;

  // 按月统计删除趋势
  const monthlyTrend = await prisma.$queryRaw<{
    month: Date;
    count: bigint;
  }[]>`
    SELECT
      date_trunc('month', pv."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai') AS month,
      COUNT(*) AS count
    FROM "PageVersion" pv
    JOIN "Page" p ON p.id = pv."pageId"
    WHERE pv."validTo" IS NULL
      AND pv."isDeleted" = true
      AND pv."createdAt" >= ${startTzIso}::timestamptz
      AND pv."createdAt" < ${endTzIso}::timestamptz
      AND p."firstPublishedAt" >= ${startTzIso}::timestamptz
      AND p."firstPublishedAt" < ${endTzIso}::timestamptz
    GROUP BY 1
    ORDER BY 1
  `;

  return {
    total: deletedPages.length,
    byCategory: {
      scp: scpCount,
      tale: taleCount,
      goi: goiCount,
      wanderers: wanderersCount,
      art: artCount,
      article: articleCount
    },
    originalCount,
    translationCount,
    topAuthors: topAuthors.map((a, i) => ({
      rank: i + 1,
      userId: Number(a.userId),
      wikidotId: a.wikidotId ? Number(a.wikidotId) : null,
      displayName: a.displayName,
      deletedCount: Number(a.deletedCount)
    })),
    monthlyTrend: monthlyTrend.map(m => ({
      month: formatMonthUTC8(m.month),
      count: Number(m.count)
    }))
  };
}

// 非描述性标签列表（用于热门标签过滤）
const NON_DESCRIPTIVE_TAGS = [
  // 基础分类标签
  'scp', '故事', 'tale', 'goi格式', 'goi-format', 'goi', 'goif',
  'wanderers', 'wanders', '艺术作品', 'art', '文章', 'article',
  // 创作类型
  '原创', '翻译', '合著', 'collaboration', 'coauthor',
  // 管理/系统标签
  '作者', '段落', '补充材料', '页面', '重定向', '管理', '_cc', '指导',
  // 分级标签
  'safe', 'euclid', 'keter', 'thaumiel', 'apollyon', 'archon',
  'ticonderoga', 'neutralized', '无效化', 'decommissioned', '被废除',
  'esoteric-class', '机密分级', 'pending', '等待分级',
  // 精品标签
  '精品', '主题精品',
  // 竞赛/征文标签
  '竞赛', '征文', '整千竞赛', 'contest', 'competition',
  '夏日征文', '冬日征文', '春日征文', '秋日征文',
  '2020征文', '2021征文', '2022征文', '2023征文', '2024征文', '2025征文',
  // 分部标签
  'cn', 'en', 'ru', 'ko', 'jp', 'fr', 'pl', 'es', 'th', 'de', 'it', 'int', 'ua', 'pt', 'cs', 'zh', 'vn'
];

async function getPopularTags(year: number, limit: number = 20) {
  const { startTzIso, endTzIso } = yearRange(year);

  const tags = await prisma.$queryRaw<{
    tag: string;
    count: bigint;
    avgRating: number;
  }[]>`
    WITH pv AS (
      SELECT
        pv.tags,
        pv.rating,
        COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AS published_at
      FROM "PageVersion" pv
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.rating IS NOT NULL
    ),
    tagged AS (
      SELECT unnest(tags) AS tag, rating FROM pv
      WHERE published_at >= ${startTzIso}::timestamptz
        AND published_at < ${endTzIso}::timestamptz
    )
    SELECT
      tag,
      COUNT(*) AS count,
      AVG(rating)::float AS "avgRating"
    FROM tagged
    WHERE tag NOT IN (${Prisma.join(NON_DESCRIPTIVE_TAGS)})
      AND tag NOT LIKE '\\_%' ESCAPE '\\'
      AND tag NOT LIKE 'crom%'
    GROUP BY tag
    HAVING COUNT(*) >= 5
    ORDER BY count DESC
    LIMIT ${limit}
  `;

  return {
    popularTags: tags.map(t => ({
      tag: t.tag,
      count: Number(t.count),
      avgRating: Math.round(t.avgRating * 10) / 10
    }))
  };
}

async function getTagStats(year: number) {
  const { startTzIso, endTzIso } = yearRange(year);

  // Branch stats for translations
  // Non-EN branches have explicit tags; EN translations have no branch tag
  const otherBranchTags = ['int', 'ru', 'ko', 'fr', 'pl', 'es', 'th', 'jp', 'de', 'it', 'ua', 'pt', 'cs', 'zh', 'vn'];
  const boutiqueExcludedTags = [
    '精品',
    'scp',
    '故事',
    'tale',
    'goi格式',
    'goi-format',
    'goi',
    'goif',
    'wanderers',
    'wanders',
    '艺术作品',
    'art',
    '文章',
    'article',
    '原创',
    '合著',
    'collaboration',
    'coauthor',
    'safe',
    'euclid',
    'keter',
    'thaumiel',
    'apollyon',
    'archon',
    'ticonderoga',
    'neutralized',
    '无效化',
    'decommissioned',
    '被废除',
    'esoteric-class',
    '机密分级',
    'pending',
    '等待分级'
  ];
  const newTagExcluded = ['原创', '作者', '段落', '补充材料', '页面', '重定向', '管理', '_cc', '指导'];

  const [
    objectClassStats,
    branchStats,
    boutiquePageCount,
    boutiqueTagStats,
    newTagsThisYear
  ] = await Promise.all([
    prisma.$queryRaw<{
      tag: string;
      count: bigint;
      originals: bigint;
      translations: bigint;
      avgRating: number;
    }[]>`
      WITH pv AS (
        SELECT
          pv.tags,
          pv.rating,
          pv.tags @> ARRAY['原创'] AS is_original,
          COALESCE(
            (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
            pv."createdAt"
          ) AS published_at
        FROM "PageVersion" pv
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.tags @> ARRAY['scp']
      ),
      tagged AS (
        SELECT unnest(tags) AS tag, rating, is_original FROM pv
        WHERE published_at >= ${startTzIso}::timestamptz
          AND published_at < ${endTzIso}::timestamptz
      )
      SELECT
        tag,
        COUNT(*) AS count,
        COUNT(*) FILTER (WHERE is_original) AS originals,
        COUNT(*) FILTER (WHERE NOT is_original) AS translations,
        AVG(rating)::float AS "avgRating"
      FROM tagged
    WHERE tag IN (
      'safe',
      'euclid',
      'keter',
      'thaumiel',
      'apollyon',
      'archon',
      'ticonderoga',
      'esoteric-class',
      'pending',
      '无效化',
      '被废除',
      '机密分级',
      '等待分级'
    )
      GROUP BY tag
      ORDER BY count DESC
    `,
    prisma.$queryRaw<{
      tag: string;
      count: bigint;
      avgRating: number;
    }[]>`
      WITH translations AS (
        SELECT
          pv.id,
          pv.tags,
          pv.rating,
          COALESCE(
            (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
            pv."createdAt"
          ) AS published_at
        FROM "PageVersion" pv
        WHERE pv."validTo" IS NULL
          AND NOT pv."isDeleted"
          AND pv.rating IS NOT NULL
          AND NOT (pv.tags @> ARRAY['原创'])
      ),
      year_translations AS (
        SELECT * FROM translations
        WHERE published_at >= ${startTzIso}::timestamptz
          AND published_at < ${endTzIso}::timestamptz
      ),
      tagged AS (
        SELECT unnest(tags) AS tag, rating FROM year_translations
      ),
      branch_counts AS (
        SELECT
          tag,
          COUNT(*) AS count,
          AVG(rating)::float AS "avgRating"
        FROM tagged
        WHERE tag IN (${Prisma.join(otherBranchTags)})
        GROUP BY tag
      ),
      en_count AS (
        SELECT
          'en' AS tag,
          COUNT(*) AS count,
          AVG(rating)::float AS "avgRating"
        FROM year_translations yt
        WHERE NOT EXISTS (
          SELECT 1 FROM unnest(yt.tags) AS t
          WHERE t IN (${Prisma.join(otherBranchTags)})
        )
      )
      SELECT * FROM branch_counts
      UNION ALL
      SELECT * FROM en_count WHERE count > 0
      ORDER BY count DESC
    `,
    prisma.$queryRaw<{
      count: bigint;
    }[]>`
      WITH pv AS (
        SELECT
          pv.tags,
          COALESCE(
            (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
            pv."createdAt"
          ) AS published_at
        FROM "PageVersion" pv
        WHERE pv."validTo" IS NULL
          AND NOT pv."isDeleted"
          AND pv.tags @> ARRAY['精品']
      )
      SELECT COUNT(*) AS count
      FROM pv
      WHERE published_at >= ${startTzIso}::timestamptz
        AND published_at < ${endTzIso}::timestamptz
    `,
    prisma.$queryRaw<{
      tag: string;
      count: bigint;
    }[]>`
      WITH pv AS (
        SELECT
          pv.tags,
          COALESCE(
            (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
            pv."createdAt"
          ) AS published_at
        FROM "PageVersion" pv
        WHERE pv."validTo" IS NULL
          AND NOT pv."isDeleted"
          AND pv.tags @> ARRAY['精品']
      ),
      tagged AS (
        SELECT unnest(tags) AS tag
        FROM pv
        WHERE published_at >= ${startTzIso}::timestamptz
          AND published_at < ${endTzIso}::timestamptz
      )
      SELECT tag, COUNT(*) AS count
      FROM tagged
      WHERE tag NOT IN (${Prisma.join(boutiqueExcludedTags)})
      GROUP BY tag
      ORDER BY count DESC
      LIMIT 50
    `,
    prisma.$queryRaw<{
      tag: string;
      firstSeen: Date;
      count: bigint;
    }[]>`
      WITH pv AS (
        SELECT
          pv.tags,
          COALESCE(
            (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
            pv."createdAt"
          ) AS published_at
        FROM "PageVersion" pv
        WHERE pv."validTo" IS NULL
          AND NOT pv."isDeleted"
          AND pv.tags IS NOT NULL
      ),
      tagged AS (
        SELECT unnest(tags) AS tag, published_at
        FROM pv
      ),
      first_seen AS (
        SELECT tag, MIN(published_at) AS first_seen
        FROM tagged
        GROUP BY tag
      ),
      year_counts AS (
        SELECT tag, COUNT(*) AS count
        FROM tagged
        WHERE published_at >= ${startTzIso}::timestamptz
          AND published_at < ${endTzIso}::timestamptz
        GROUP BY tag
      )
      SELECT
        f.tag,
        f.first_seen AS "firstSeen",
        COALESCE(y.count, 0) AS count
      FROM first_seen f
      LEFT JOIN year_counts y ON y.tag = f.tag
      WHERE f.first_seen >= ${startTzIso}::timestamptz
        AND f.first_seen < ${endTzIso}::timestamptz
        AND f.tag NOT IN (${Prisma.join(newTagExcluded)})
      ORDER BY count DESC, f.tag ASC
    `
  ]);

  const byObjectClass: Record<string, { count: number; originals: number; translations: number; avgRating: number }> = {};
  for (const row of objectClassStats) {
    byObjectClass[row.tag] = {
      count: Number(row.count),
      originals: Number(row.originals),
      translations: Number(row.translations),
      avgRating: Math.round(row.avgRating * 10) / 10
    };
  }

  const byBranch: Record<string, { count: number; avgRating: number }> = {};
  for (const row of branchStats) {
    byBranch[row.tag] = {
      count: Number(row.count),
      avgRating: Math.round(row.avgRating * 10) / 10
    };
  }

  const boutiqueTags = {
    totalPages: boutiquePageCount.length ? Number(boutiquePageCount[0].count) : 0,
    tags: boutiqueTagStats.map(row => ({
      tag: row.tag,
      count: Number(row.count)
    }))
  };

  const newTags = newTagsThisYear.map(row => ({
    tag: row.tag,
    count: Number(row.count),
    firstSeen: formatDateOnlyUTC8(new Date(row.firstSeen))
  }));

  return {
    byObjectClass,
    byBranch,
    boutiqueTags,
    newTagsThisYear: newTags
  };
}

// Get detailed statistics for each category (SCP, 故事, GOI格式, etc.)
async function getCategoryDetails(year: number) {
  const { startTzIso, endTzIso } = yearRange(year);

  const categories = ['scp', '故事', 'goi格式', 'wanderers', '艺术作品', '文章'] as const;
  const results: Record<string, any> = {};

  const buildCategory = async (category: string) => {
    const [
      monthlyTrends,
      overallStats,
      topPages,
      topPagesOriginal,
      topPagesTranslation,
      topAuthors,
      topAuthorsOriginal,
      topAuthorsTranslation,
      popularSubTags
    ] = await runInBatches([
      () => prisma.$queryRaw<{
        month: Date;
        originals: bigint;
        translations: bigint;
        totalRating: bigint;
      }[]>`
        WITH pv AS (
          SELECT
            pv.tags,
            pv.rating,
            COALESCE(
              (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
              pv."createdAt"
            ) AS published_at
          FROM "PageVersion" pv
          WHERE pv."validTo" IS NULL
            AND NOT pv."isDeleted"
            AND pv.tags @> ARRAY[${category}]
        )
        SELECT
          date_trunc('month', published_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai') AS month,
          COUNT(*) FILTER (WHERE tags @> ARRAY['原创']) AS originals,
          COUNT(*) FILTER (WHERE NOT (tags @> ARRAY['原创'])) AS translations,
          COALESCE(SUM(rating), 0) AS "totalRating"
        FROM pv
        WHERE published_at >= ${startTzIso}::timestamptz
          AND published_at < ${endTzIso}::timestamptz
        GROUP BY 1
        ORDER BY 1
      `,
      () => prisma.$queryRaw<[{
        totalPages: bigint;
        originals: bigint;
        translations: bigint;
        totalWords: bigint;
        avgRating: number;
        avgWordCount: number;
      }]>`
        WITH pv AS (
          SELECT
            pv.tags,
            pv.rating,
            LENGTH(COALESCE(pv.source, '')) AS word_count,
            COALESCE(
              (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
              pv."createdAt"
            ) AS published_at
          FROM "PageVersion" pv
          WHERE pv."validTo" IS NULL
            AND NOT pv."isDeleted"
            AND pv.tags @> ARRAY[${category}]
        )
        SELECT
          COUNT(*) AS "totalPages",
          COUNT(*) FILTER (WHERE tags @> ARRAY['原创']) AS originals,
          COUNT(*) FILTER (WHERE NOT (tags @> ARRAY['原创'])) AS translations,
          COALESCE(SUM(word_count), 0) AS "totalWords",
          AVG(rating)::float AS "avgRating",
          AVG(word_count)::float AS "avgWordCount"
        FROM pv
        WHERE published_at >= ${startTzIso}::timestamptz
          AND published_at < ${endTzIso}::timestamptz
      `,
      () => prisma.$queryRaw<{
        wikidotId: number;
        title: string;
        currentUrl: string;
        rating: number;
        authorDisplayName: string;
        wordCount: number;
        isOriginal: boolean;
      }[]>`
        WITH pv AS (
          SELECT
            pv.id,
            p."wikidotId",
            pv.title,
            p."currentUrl",
            pv.rating,
            pv.tags,
            LENGTH(COALESCE(pv.source, '')) AS word_count,
            COALESCE(
              (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
              pv."createdAt"
            ) AS published_at
          FROM "PageVersion" pv
          JOIN "Page" p ON p.id = pv."pageId"
          WHERE pv."validTo" IS NULL
            AND NOT pv."isDeleted"
            AND pv.rating IS NOT NULL
            AND pv.tags @> ARRAY[${category}]
        ),
        pv_with_authors AS (
          SELECT
            pv."wikidotId",
            pv.title,
            pv."currentUrl",
            pv.rating,
            pv.word_count,
            pv.tags @> ARRAY['原创'] AS is_original,
            STRING_AGG(DISTINCT u."displayName", '、' ORDER BY u."displayName") AS author_names
          FROM pv
          JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
          LEFT JOIN "User" u ON u.id = a."userId"
          WHERE pv.published_at >= ${startTzIso}::timestamptz
            AND pv.published_at < ${endTzIso}::timestamptz
          GROUP BY pv."wikidotId", pv.title, pv."currentUrl", pv.rating, pv.word_count, pv.tags
        )
        SELECT
          "wikidotId" AS "wikidotId",
          title,
          "currentUrl",
          rating,
          author_names AS "authorDisplayName",
          word_count AS "wordCount",
          is_original AS "isOriginal"
        FROM pv_with_authors
        ORDER BY rating DESC
        LIMIT 5
      `,
      () => prisma.$queryRaw<{
        wikidotId: number;
        title: string;
        currentUrl: string;
        rating: number;
        authorDisplayName: string;
        wordCount: number;
        isOriginal: boolean;
      }[]>`
        WITH pv AS (
          SELECT
            pv.id,
            p."wikidotId",
            pv.title,
            p."currentUrl",
            pv.rating,
            pv.tags,
            LENGTH(COALESCE(pv.source, '')) AS word_count,
            COALESCE(
              (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
              pv."createdAt"
            ) AS published_at
          FROM "PageVersion" pv
          JOIN "Page" p ON p.id = pv."pageId"
          WHERE pv."validTo" IS NULL
            AND NOT pv."isDeleted"
            AND pv.rating IS NOT NULL
            AND pv.tags @> ARRAY['原创']
            AND pv.tags @> ARRAY[${category}]
        ),
        pv_with_authors AS (
          SELECT
            pv."wikidotId",
            pv.title,
            pv."currentUrl",
            pv.rating,
            pv.word_count,
            pv.tags @> ARRAY['原创'] AS is_original,
            STRING_AGG(DISTINCT u."displayName", '、' ORDER BY u."displayName") AS author_names
          FROM pv
          JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
          LEFT JOIN "User" u ON u.id = a."userId"
          WHERE pv.published_at >= ${startTzIso}::timestamptz
            AND pv.published_at < ${endTzIso}::timestamptz
          GROUP BY pv."wikidotId", pv.title, pv."currentUrl", pv.rating, pv.word_count, pv.tags
        )
        SELECT
          "wikidotId" AS "wikidotId",
          title,
          "currentUrl",
          rating,
          author_names AS "authorDisplayName",
          word_count AS "wordCount",
          is_original AS "isOriginal"
        FROM pv_with_authors
        ORDER BY rating DESC
        LIMIT 5
      `,
      () => prisma.$queryRaw<{
        wikidotId: number;
        title: string;
        currentUrl: string;
        rating: number;
        authorDisplayName: string;
        wordCount: number;
        isOriginal: boolean;
      }[]>`
        WITH pv AS (
          SELECT
            pv.id,
            p."wikidotId",
            pv.title,
            p."currentUrl",
            pv.rating,
            pv.tags,
            LENGTH(COALESCE(pv.source, '')) AS word_count,
            COALESCE(
              (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
              pv."createdAt"
            ) AS published_at
          FROM "PageVersion" pv
          JOIN "Page" p ON p.id = pv."pageId"
          WHERE pv."validTo" IS NULL
            AND NOT pv."isDeleted"
            AND pv.rating IS NOT NULL
            AND NOT (pv.tags @> ARRAY['原创'])
            AND pv.tags @> ARRAY[${category}]
        ),
        pv_with_authors AS (
          SELECT
            pv."wikidotId",
            pv.title,
            pv."currentUrl",
            pv.rating,
            pv.word_count,
            pv.tags @> ARRAY['原创'] AS is_original,
            STRING_AGG(DISTINCT u."displayName", '、' ORDER BY u."displayName") AS author_names
          FROM pv
          JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
          LEFT JOIN "User" u ON u.id = a."userId"
          WHERE pv.published_at >= ${startTzIso}::timestamptz
            AND pv.published_at < ${endTzIso}::timestamptz
          GROUP BY pv."wikidotId", pv.title, pv."currentUrl", pv.rating, pv.word_count, pv.tags
        )
        SELECT
          "wikidotId" AS "wikidotId",
          title,
          "currentUrl",
          rating,
          author_names AS "authorDisplayName",
          word_count AS "wordCount",
          is_original AS "isOriginal"
        FROM pv_with_authors
        ORDER BY rating DESC
        LIMIT 5
      `,
      // topAuthors: 去重以避免同一用户对同一页面有多个 Attribution 记录导致重复计数
      () => prisma.$queryRaw<{
        userId: number;
        wikidotId: number | null;
        displayName: string;
        pageCount: bigint;
        totalRating: bigint;
      }[]>`
        WITH pv AS (
          SELECT
            pv.id,
            pv.rating,
            COALESCE(
              (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
              pv."createdAt"
            ) AS published_at
          FROM "PageVersion" pv
          WHERE pv."validTo" IS NULL
            AND NOT pv."isDeleted"
            AND pv.tags @> ARRAY[${category}]
        ),
        dedup_attr AS (
          SELECT DISTINCT a."userId", pv.id AS page_ver_id, pv.rating
          FROM pv
          JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
          WHERE pv.published_at >= ${startTzIso}::timestamptz
            AND pv.published_at < ${endTzIso}::timestamptz
        )
        SELECT
          da."userId" AS "userId",
          u."wikidotId" AS "wikidotId",
          u."displayName" AS "displayName",
          COUNT(*) AS "pageCount",
          COALESCE(SUM(da.rating), 0) AS "totalRating"
        FROM dedup_attr da
        LEFT JOIN "User" u ON u.id = da."userId"
        GROUP BY da."userId", u."wikidotId", u."displayName"
        ORDER BY "totalRating" DESC
        LIMIT 5
      `,
      // topAuthorsOriginal: 去重以避免同一用户对同一页面有多个 Attribution 记录导致重复计数
      () => prisma.$queryRaw<{
        userId: number;
        wikidotId: number | null;
        displayName: string;
        pageCount: bigint;
        totalRating: bigint;
      }[]>`
        WITH pv AS (
          SELECT
            pv.id,
            pv.rating,
            COALESCE(
              (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
              pv."createdAt"
            ) AS published_at
          FROM "PageVersion" pv
          WHERE pv."validTo" IS NULL
            AND NOT pv."isDeleted"
            AND pv.tags @> ARRAY[${category}]
            AND pv.tags @> ARRAY['原创']
        ),
        dedup_attr AS (
          SELECT DISTINCT a."userId", pv.id AS page_ver_id, pv.rating
          FROM pv
          JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
          WHERE pv.published_at >= ${startTzIso}::timestamptz
            AND pv.published_at < ${endTzIso}::timestamptz
        )
        SELECT
          da."userId" AS "userId",
          u."wikidotId" AS "wikidotId",
          u."displayName" AS "displayName",
          COUNT(*) AS "pageCount",
          COALESCE(SUM(da.rating), 0) AS "totalRating"
        FROM dedup_attr da
        LEFT JOIN "User" u ON u.id = da."userId"
        GROUP BY da."userId", u."wikidotId", u."displayName"
        ORDER BY "totalRating" DESC
        LIMIT 5
      `,
      // topAuthorsTranslation: 去重以避免同一用户对同一页面有多个 Attribution 记录导致重复计数
      () => prisma.$queryRaw<{
        userId: number;
        wikidotId: number | null;
        displayName: string;
        pageCount: bigint;
        totalRating: bigint;
      }[]>`
        WITH pv AS (
          SELECT
            pv.id,
            pv.rating,
            COALESCE(
              (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
              pv."createdAt"
            ) AS published_at
          FROM "PageVersion" pv
          WHERE pv."validTo" IS NULL
            AND NOT pv."isDeleted"
            AND pv.tags @> ARRAY[${category}]
            AND NOT (pv.tags @> ARRAY['原创'])
        ),
        dedup_attr AS (
          SELECT DISTINCT a."userId", pv.id AS page_ver_id, pv.rating
          FROM pv
          JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
          WHERE pv.published_at >= ${startTzIso}::timestamptz
            AND pv.published_at < ${endTzIso}::timestamptz
        )
        SELECT
          da."userId" AS "userId",
          u."wikidotId" AS "wikidotId",
          u."displayName" AS "displayName",
          COUNT(*) AS "pageCount",
          COALESCE(SUM(da.rating), 0) AS "totalRating"
        FROM dedup_attr da
        LEFT JOIN "User" u ON u.id = da."userId"
        GROUP BY da."userId", u."wikidotId", u."displayName"
        ORDER BY "totalRating" DESC
        LIMIT 5
      `,
      () => prisma.$queryRaw<{
        tag: string;
        count: bigint;
        avgRating: number;
      }[]>`
        WITH pv AS (
          SELECT
            pv.tags,
            pv.rating,
            COALESCE(
              (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
              pv."createdAt"
            ) AS published_at
          FROM "PageVersion" pv
          WHERE pv."validTo" IS NULL
            AND NOT pv."isDeleted"
            AND pv.tags @> ARRAY[${category}]
        ),
        tagged AS (
          SELECT unnest(tags) AS tag, rating FROM pv
          WHERE published_at >= ${startTzIso}::timestamptz
            AND published_at < ${endTzIso}::timestamptz
        )
        SELECT
          tag,
          COUNT(*) AS count,
          AVG(rating)::float AS "avgRating"
        FROM tagged
        WHERE tag NOT IN (${Prisma.join([...NON_DESCRIPTIVE_TAGS, category])})
          AND tag NOT LIKE '\\_%' ESCAPE '\\'
          AND tag NOT LIKE 'crom%'
        GROUP BY tag
        HAVING COUNT(*) >= 3
        ORDER BY count DESC
        LIMIT 10
      `
    ], CATEGORY_QUERY_CONCURRENCY) as [
      { month: Date; originals: bigint; translations: bigint; totalRating: bigint }[],
      { totalPages: bigint; originals: bigint; translations: bigint; totalWords: bigint; avgRating: number; avgWordCount: number }[],
      { wikidotId: number; title: string; currentUrl: string; rating: number; authorDisplayName: string; wordCount: number; isOriginal: boolean }[],
      { wikidotId: number; title: string; currentUrl: string; rating: number; authorDisplayName: string; wordCount: number; isOriginal: boolean }[],
      { wikidotId: number; title: string; currentUrl: string; rating: number; authorDisplayName: string; wordCount: number; isOriginal: boolean }[],
      { userId: number; wikidotId: number | null; displayName: string; pageCount: bigint; totalRating: bigint }[],
      { userId: number; wikidotId: number | null; displayName: string; pageCount: bigint; totalRating: bigint }[],
      { userId: number; wikidotId: number | null; displayName: string; pageCount: bigint; totalRating: bigint }[],
      { tag: string; count: bigint; avgRating: number }[]
    ];

    const stats = overallStats[0];
    const totalPages = Number(stats.totalPages);
    const originals = Number(stats.originals);
    const translations = Number(stats.translations);

    return {
      overview: {
        totalPages,
        originals,
        translations,
        originalRatio: totalPages > 0 ? Math.round((originals / totalPages) * 1000) / 10 : 0,
        totalWords: Number(stats.totalWords),
        avgRating: stats.avgRating ? Math.round(stats.avgRating * 10) / 10 : 0,
        avgWordCount: stats.avgWordCount ? Math.round(stats.avgWordCount) : 0
      },
      monthlyTrends: monthlyTrends.map(t => ({
        month: formatMonthUTC8(t.month),
        originals: Number(t.originals),
        translations: Number(t.translations),
        total: Number(t.originals) + Number(t.translations),
        totalRating: Number(t.totalRating)
      })),
      topPages: topPages.map((p, i) => ({
        rank: i + 1,
        wikidotId: Number(p.wikidotId),
        title: p.title,
        slug: p.currentUrl.split('/').pop() || '',
        rating: Number(p.rating),
        authorDisplayName: p.authorDisplayName,
        wordCount: Number(p.wordCount),
        isOriginal: p.isOriginal
      })),
      topPagesOriginal: topPagesOriginal.map((p, i) => ({
        rank: i + 1,
        wikidotId: Number(p.wikidotId),
        title: p.title,
        slug: p.currentUrl.split('/').pop() || '',
        rating: Number(p.rating),
        authorDisplayName: p.authorDisplayName,
        wordCount: Number(p.wordCount),
        isOriginal: p.isOriginal
      })),
      topPagesTranslation: topPagesTranslation.map((p, i) => ({
        rank: i + 1,
        wikidotId: Number(p.wikidotId),
        title: p.title,
        slug: p.currentUrl.split('/').pop() || '',
        rating: Number(p.rating),
        authorDisplayName: p.authorDisplayName,
        wordCount: Number(p.wordCount),
        isOriginal: p.isOriginal
      })),
      topAuthors: topAuthors.map((a, i) => ({
        rank: i + 1,
        userId: Number(a.userId),
        wikidotId: a.wikidotId ? Number(a.wikidotId) : null,
        displayName: a.displayName,
        pageCount: Number(a.pageCount),
        totalRating: Number(a.totalRating),
        avgRating: Number(a.pageCount) > 0 ? Math.round(Number(a.totalRating) / Number(a.pageCount) * 10) / 10 : 0
      })),
      topAuthorsOriginal: topAuthorsOriginal.map((a, i) => ({
        rank: i + 1,
        userId: Number(a.userId),
        wikidotId: a.wikidotId ? Number(a.wikidotId) : null,
        displayName: a.displayName,
        pageCount: Number(a.pageCount),
        totalRating: Number(a.totalRating),
        avgRating: Number(a.pageCount) > 0 ? Math.round(Number(a.totalRating) / Number(a.pageCount) * 10) / 10 : 0
      })),
      topAuthorsTranslation: topAuthorsTranslation.map((a, i) => ({
        rank: i + 1,
        userId: Number(a.userId),
        wikidotId: a.wikidotId ? Number(a.wikidotId) : null,
        displayName: a.displayName,
        pageCount: Number(a.pageCount),
        totalRating: Number(a.totalRating),
        avgRating: Number(a.pageCount) > 0 ? Math.round(Number(a.totalRating) / Number(a.pageCount) * 10) / 10 : 0
      })),
      popularTags: popularSubTags.map(t => ({
        tag: t.tag,
        count: Number(t.count),
        avgRating: t.avgRating ? Math.round(t.avgRating * 10) / 10 : 0
      }))
    };
  };

  const entries = await runInBatches(
    categories.map(category => async () => ({
      category,
      data: await buildCategory(category)
    })),
    CATEGORY_CONCURRENCY
  );

  for (const entry of entries) {
    results[entry.category] = entry.data;
  }

  return results;
}

function getPercentileLabel(percentile: number) {
  if (!Number.isFinite(percentile)) return '活跃参与者';
  if (percentile <= 0.05) return '前5%';
  if (percentile <= 0.1) return '前10%';
  if (percentile <= 0.25) return '前25%';
  if (percentile <= 0.5) return '前50%';
  return '活跃参与者';
}

// ============ 预计算缓存 ============
// 用于存储所有用户的排名数据，避免每个用户重复计算全局排名

interface RankingCache {
  rank: number;
  total: number;
  percentile: number;
  percentileLabel: string;
  score?: number;
}

interface VotePercentileCache extends RankingCache {
  value: number;
}

// ============ 用户数据预计算缓存 ============
interface PageStatsCache {
  originalCount: number;
  translationCount: number;
  totalWords: number;
  originalWords: number;
  translationWords: number;
  totalRating: number;
  avgRating: number;
}

interface VoteReceivedCache {
  total: number;
  up: number;
  down: number;
}

interface VoteCastCache {
  total: number;
  up: number;
  down: number;
  activeDays: number;
}

interface ActivityStatsCache {
  activeDays: number;
  firstActivity: string | null;
  lastActivity: string | null;
}

let cachedEngagementRankings: Map<number, RankingCache> | null = null;
let cachedPrevYearRankings: Map<number, RankingCache> | null = null;
let cachedVotePercentiles: Map<number, VotePercentileCache> | null = null;
let cachedContentPercentiles: Map<number, VotePercentileCache> | null = null;

// 新增：用户统计数据缓存
let cachedPageStats: Map<number, PageStatsCache> | null = null;
let cachedVotesReceived: Map<number, VoteReceivedCache> | null = null;
let cachedVotesCast: Map<number, VoteCastCache> | null = null;
let cachedActivityStats: Map<number, ActivityStatsCache> | null = null;

async function precomputeAllEngagementRankings(year: number): Promise<Map<number, RankingCache>> {
  const { startTzIso, endTzIso } = yearRange(year);
  console.log(`  -> Precomputing engagement rankings for ${year}...`);

  const rows = await prisma.$queryRaw<Array<{
    userId: number;
    rank: bigint;
    total: bigint;
    score: number;
  }>>`
    WITH activity_scores AS (
      SELECT
        uds."userId",
        SUM(uds."pages_created") AS pages_created,
        SUM(uds."votes_cast") AS votes_cast,
        SUM(CASE WHEN uds."pages_created" > 0 OR uds."votes_cast" > 0 THEN 1 ELSE 0 END) AS active_days
      FROM "UserDailyStats" uds
      WHERE uds.date >= ${startTzIso}::date
        AND uds.date < ${endTzIso}::date
      GROUP BY uds."userId"
    ),
    reception_scores AS (
      WITH user_pages AS (
        SELECT
          a."userId",
          pv.id AS page_id,
          pv.rating,
          pv.tags @> ARRAY['原创'] AS is_original,
          pv.tags @> ARRAY['翻译'] AS is_translation
        FROM "Attribution" a
        JOIN "PageVersion" pv ON pv.id = a."pageVerId"
        WHERE a."userId" IS NOT NULL
          AND pv."validTo" IS NULL
          AND NOT pv."isDeleted"
          AND COALESCE(
            (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
            pv."createdAt"
          ) >= ${startTzIso}::timestamptz
          AND COALESCE(
            (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
            pv."createdAt"
          ) < ${endTzIso}::timestamptz
      ),
      votes_per_page AS (
        SELECT
          up.page_id,
          COUNT(v.id) AS votes_received
        FROM user_pages up
        LEFT JOIN "Vote" v ON v."pageVersionId" = up.page_id
          AND v.timestamp >= ${startTzIso}::timestamptz
          AND v.timestamp < ${endTzIso}::timestamptz
        GROUP BY up.page_id
      )
      SELECT
        up."userId",
        COUNT(*) AS page_count,
        SUM(CASE WHEN up.is_original THEN 1 ELSE 0 END) AS original_count,
        SUM(CASE WHEN up.is_translation THEN 1 ELSE 0 END) AS translation_count,
        COALESCE(SUM(vp.votes_received), 0) AS votes_received,
        COALESCE(SUM(up.rating), 0) AS total_rating,
        AVG(up.rating)::float AS avg_rating
      FROM user_pages up
      LEFT JOIN votes_per_page vp ON vp.page_id = up.page_id
      GROUP BY up."userId"
    ),
    user_scores AS (
      SELECT
        COALESCE(a."userId", r."userId") AS "userId",
        (
          0.0
          + COALESCE(r.page_count, 0) * 30
          + COALESCE(r.original_count, 0) * 20
          + COALESCE(r.translation_count, 0) * 10
          + COALESCE(r.total_rating, 0) * 2.5
          + COALESCE(r.avg_rating, 0) * 40
          + COALESCE(r.votes_received, 0) * 1.5
          + COALESCE(a.votes_cast, 0) * 1
          + COALESCE(a.active_days, 0) * 12
        ) AS score
      FROM activity_scores a
      FULL OUTER JOIN reception_scores r ON a."userId" = r."userId"
      WHERE COALESCE(a.pages_created, 0) > 0 OR COALESCE(a.votes_cast, 0) > 0 OR COALESCE(r.page_count, 0) > 0
    ),
    ranked AS (
      SELECT
        "userId",
        score::float AS score,
        ROW_NUMBER() OVER (ORDER BY score DESC) AS rank,
        COUNT(*) OVER () AS total
      FROM user_scores
    )
    SELECT "userId" AS "userId", rank, total, score
    FROM ranked
  `;

  const cache = new Map<number, RankingCache>();
  for (const row of rows) {
    const rankNum = Number(row.rank);
    const totalNum = Number(row.total);
    const percentile = totalNum > 0 ? rankNum / totalNum : 1;
    cache.set(Number(row.userId), {
      rank: rankNum,
      total: totalNum,
      percentile,
      percentileLabel: getPercentileLabel(percentile),
      score: row.score
    });
  }
  console.log(`  -> Cached ${cache.size} engagement rankings for ${year}`);
  return cache;
}

async function precomputeAllVotePercentiles(year: number): Promise<Map<number, VotePercentileCache>> {
  const { startTzIso, endTzIso } = yearRange(year);
  console.log(`  -> Precomputing vote percentiles for ${year}...`);

  const rows = await prisma.$queryRaw<Array<{
    userId: number;
    votesCast: bigint;
    rank: bigint;
    total: bigint;
  }>>`
    WITH user_votes AS (
      SELECT
        v."userId" AS "userId",
        COUNT(*) AS "votesCast"
      FROM "Vote" v
      JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
      WHERE v.timestamp >= ${startTzIso}::timestamptz
        AND v.timestamp < ${endTzIso}::timestamptz
        AND v."userId" IS NOT NULL
        AND pv."validTo" IS NULL
        AND NOT pv."isDeleted"
      GROUP BY v."userId"
      HAVING COUNT(*) > 0
    ),
    ranked AS (
      SELECT
        "userId",
        "votesCast",
        ROW_NUMBER() OVER (ORDER BY "votesCast" DESC) AS rank,
        COUNT(*) OVER () AS total
      FROM user_votes
    )
    SELECT "userId" AS "userId", "votesCast" AS "votesCast", rank, total
    FROM ranked
  `;

  const cache = new Map<number, VotePercentileCache>();
  for (const row of rows) {
    const rankNum = Number(row.rank);
    const totalNum = Number(row.total);
    const percentile = totalNum > 0 ? rankNum / totalNum : 1;
    cache.set(Number(row.userId), {
      value: Number(row.votesCast),
      rank: rankNum,
      total: totalNum,
      percentile,
      percentileLabel: getPercentileLabel(percentile)
    });
  }
  console.log(`  -> Cached ${cache.size} vote percentiles`);
  return cache;
}

// 去重以避免同一用户对同一页面有多个 Attribution 记录导致重复计数
async function precomputeAllContentPercentiles(year: number): Promise<Map<number, VotePercentileCache>> {
  const { startTzIso, endTzIso } = yearRange(year);
  console.log(`  -> Precomputing content percentiles for ${year}...`);

  const rows = await prisma.$queryRaw<Array<{
    userId: number;
    totalWords: bigint;
    rank: bigint;
    total: bigint;
  }>>`
    WITH pv AS (
      SELECT
        pv.id,
        LENGTH(COALESCE(pv.source, '')) AS word_count,
        COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AS published_at
      FROM "PageVersion" pv
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
    ),
    dedup_attr AS (
      SELECT DISTINCT a."userId", pv.id AS page_ver_id, pv.word_count
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      WHERE pv.published_at >= ${startTzIso}::timestamptz
        AND pv.published_at < ${endTzIso}::timestamptz
    ),
    user_words AS (
      SELECT
        "userId" AS "userId",
        SUM(word_count) AS "totalWords"
      FROM dedup_attr
      GROUP BY "userId"
      HAVING SUM(word_count) > 0
    ),
    ranked AS (
      SELECT
        "userId",
        "totalWords",
        ROW_NUMBER() OVER (ORDER BY "totalWords" DESC) AS rank,
        COUNT(*) OVER () AS total
      FROM user_words
    )
    SELECT "userId" AS "userId", "totalWords" AS "totalWords", rank, total
    FROM ranked
  `;

  const cache = new Map<number, VotePercentileCache>();
  for (const row of rows) {
    const rankNum = Number(row.rank);
    const totalNum = Number(row.total);
    const percentile = totalNum > 0 ? rankNum / totalNum : 1;
    cache.set(Number(row.userId), {
      value: Number(row.totalWords),
      rank: rankNum,
      total: totalNum,
      percentile,
      percentileLabel: getPercentileLabel(percentile)
    });
  }
  console.log(`  -> Cached ${cache.size} content percentiles`);
  return cache;
}

async function precomputeAllRankings(year: number): Promise<void> {
  console.log(`\nPrecomputing all user rankings (this saves ~50x time)...`);
  const startTime = Date.now();

  // 并行预计算所有排名数据
  const [engagementRankings, prevYearRankings, votePercentiles, contentPercentiles] = await Promise.all([
    precomputeAllEngagementRankings(year),
    precomputeAllEngagementRankings(year - 1),
    precomputeAllVotePercentiles(year),
    precomputeAllContentPercentiles(year)
  ]);

  cachedEngagementRankings = engagementRankings;
  cachedPrevYearRankings = prevYearRankings;
  cachedVotePercentiles = votePercentiles;
  cachedContentPercentiles = contentPercentiles;

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  -> All rankings precomputed in ${elapsed}s\n`);
}

// ============ 用户统计数据批量预计算 ============
// 去重以避免同一用户对同一页面有多个 Attribution 记录导致重复计数
async function precomputeAllPageStats(year: number): Promise<Map<number, PageStatsCache>> {
  const { startTzIso, endTzIso } = yearRange(year);
  console.log(`  -> Precomputing page stats for all users...`);

  const rows = await prisma.$queryRaw<Array<{
    userId: number;
    originalCount: bigint;
    translationCount: bigint;
    totalWords: bigint;
    originalWords: bigint;
    translationWords: bigint;
    totalRating: bigint;
    avgRating: number | null;
  }>>`
    WITH pv_base AS (
      SELECT
        pv.id,
        pv.tags,
        pv.rating,
        LENGTH(COALESCE(pv.source, '')) AS word_count,
        COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AS published_at
      FROM "PageVersion" pv
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
    ),
    dedup_attr AS (
      SELECT DISTINCT a."userId", pv.id AS page_ver_id, pv.tags, pv.rating, pv.word_count, pv.published_at
      FROM pv_base pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
    )
    SELECT
      "userId",
      COUNT(*) FILTER (WHERE tags @> ARRAY['原创'] AND published_at >= ${startTzIso}::timestamptz AND published_at < ${endTzIso}::timestamptz) AS "originalCount",
      COUNT(*) FILTER (WHERE NOT (tags @> ARRAY['原创']) AND published_at >= ${startTzIso}::timestamptz AND published_at < ${endTzIso}::timestamptz) AS "translationCount",
      COALESCE(SUM(word_count) FILTER (WHERE published_at >= ${startTzIso}::timestamptz AND published_at < ${endTzIso}::timestamptz), 0) AS "totalWords",
      COALESCE(SUM(word_count) FILTER (WHERE tags @> ARRAY['原创'] AND published_at >= ${startTzIso}::timestamptz AND published_at < ${endTzIso}::timestamptz), 0) AS "originalWords",
      COALESCE(SUM(word_count) FILTER (WHERE NOT (tags @> ARRAY['原创']) AND published_at >= ${startTzIso}::timestamptz AND published_at < ${endTzIso}::timestamptz), 0) AS "translationWords",
      COALESCE(SUM(rating) FILTER (WHERE published_at >= ${startTzIso}::timestamptz AND published_at < ${endTzIso}::timestamptz), 0) AS "totalRating",
      AVG(rating) FILTER (WHERE published_at >= ${startTzIso}::timestamptz AND published_at < ${endTzIso}::timestamptz)::float AS "avgRating"
    FROM dedup_attr
    GROUP BY "userId"
  `;

  const cache = new Map<number, PageStatsCache>();
  for (const row of rows) {
    cache.set(row.userId, {
      originalCount: Number(row.originalCount),
      translationCount: Number(row.translationCount),
      totalWords: Number(row.totalWords),
      originalWords: Number(row.originalWords),
      translationWords: Number(row.translationWords),
      totalRating: Number(row.totalRating),
      avgRating: row.avgRating ? Math.round(row.avgRating * 10) / 10 : 0
    });
  }
  console.log(`  -> Cached ${cache.size} page stats`);
  return cache;
}

async function precomputeAllVotesReceived(year: number): Promise<Map<number, VoteReceivedCache>> {
  const { startTzIso, endTzIso } = yearRange(year);
  console.log(`  -> Precomputing votes received for all users...`);

  // 去重：每个投票者对每个页面只计最后一票
  const rows = await prisma.$queryRaw<Array<{
    userId: number;
    total: bigint;
    up: bigint;
    down: bigint;
  }>>`
    WITH dedup_votes AS (
      SELECT * FROM (
        SELECT
          v."userId" AS voter_id,
          v.direction,
          pv."pageId",
          a."userId" AS author_id,
          ROW_NUMBER() OVER (
            PARTITION BY v."userId", pv."pageId"
            ORDER BY v.timestamp DESC, v.id DESC
          ) AS rn
        FROM "Vote" v
        JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
        JOIN "Attribution" a ON a."pageVerId" = pv.id
        WHERE v.timestamp >= ${startTzIso}::timestamptz
          AND v.timestamp < ${endTzIso}::timestamptz
          AND v.direction != 0
          AND a."userId" IS NOT NULL
          AND pv."validTo" IS NULL
          AND NOT pv."isDeleted"
      ) t WHERE rn = 1
    )
    SELECT
      author_id AS "userId",
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE direction = 1) AS up,
      COUNT(*) FILTER (WHERE direction = -1) AS down
    FROM dedup_votes
    GROUP BY author_id
  `;

  const cache = new Map<number, VoteReceivedCache>();
  for (const row of rows) {
    cache.set(row.userId, {
      total: Number(row.total),
      up: Number(row.up),
      down: Number(row.down)
    });
  }
  console.log(`  -> Cached ${cache.size} votes received`);
  return cache;
}

async function precomputeAllVotesCast(year: number): Promise<Map<number, VoteCastCache>> {
  const { startTzIso, endTzIso } = yearRange(year);
  console.log(`  -> Precomputing votes cast for all users...`);

  // 去重：每个用户对每个页面只计最后一票
  const rows = await prisma.$queryRaw<Array<{
    userId: number;
    total: bigint;
    up: bigint;
    down: bigint;
    activeDays: bigint;
  }>>`
    WITH dedup_votes AS (
      SELECT * FROM (
        SELECT
          v."userId",
          v.direction,
          v.timestamp,
          pv."pageId",
          ROW_NUMBER() OVER (
            PARTITION BY v."userId", pv."pageId"
            ORDER BY v.timestamp DESC, v.id DESC
          ) AS rn
        FROM "Vote" v
        JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
        WHERE v.timestamp >= ${startTzIso}::timestamptz
          AND v.timestamp < ${endTzIso}::timestamptz
          AND v."userId" IS NOT NULL
          AND v.direction != 0
          AND pv."validTo" IS NULL
          AND NOT pv."isDeleted"
      ) t WHERE rn = 1
    )
    SELECT
      "userId",
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE direction = 1) AS up,
      COUNT(*) FILTER (WHERE direction = -1) AS down,
      COUNT(DISTINCT (timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::date) AS "activeDays"
    FROM dedup_votes
    GROUP BY "userId"
  `;

  const cache = new Map<number, VoteCastCache>();
  for (const row of rows) {
    cache.set(row.userId, {
      total: Number(row.total),
      up: Number(row.up),
      down: Number(row.down),
      activeDays: Number(row.activeDays)
    });
  }
  console.log(`  -> Cached ${cache.size} votes cast`);
  return cache;
}

async function precomputeAllActivityStats(year: number): Promise<Map<number, ActivityStatsCache>> {
  const { startTzIso, endTzIso } = yearRange(year);
  console.log(`  -> Precomputing activity stats for all users...`);

  const rows = await prisma.$queryRaw<Array<{
    userId: number;
    activeDays: bigint;
    firstActivity: Date | null;
    lastActivity: Date | null;
  }>>`
    SELECT
      "userId",
      COUNT(DISTINCT date) AS "activeDays",
      MIN(date) AS "firstActivity",
      MAX(date) AS "lastActivity"
    FROM "UserDailyStats"
    WHERE date >= ${startTzIso}::date
      AND date < ${endTzIso}::date
    GROUP BY "userId"
  `;

  const cache = new Map<number, ActivityStatsCache>();
  for (const row of rows) {
    cache.set(row.userId, {
      activeDays: Number(row.activeDays),
      firstActivity: row.firstActivity ? formatDateOnlyUTC8(row.firstActivity) : null,
      lastActivity: row.lastActivity ? formatDateOnlyUTC8(row.lastActivity) : null
    });
  }
  console.log(`  -> Cached ${cache.size} activity stats`);
  return cache;
}

async function precomputeAllUserStats(year: number): Promise<void> {
  console.log(`\nPrecomputing all user stats (this saves ~9x queries per user)...`);
  const startTime = Date.now();

  const [pageStats, votesReceived, votesCast, activityStats] = await Promise.all([
    precomputeAllPageStats(year),
    precomputeAllVotesReceived(year),
    precomputeAllVotesCast(year),
    precomputeAllActivityStats(year)
  ]);

  cachedPageStats = pageStats;
  cachedVotesReceived = votesReceived;
  cachedVotesCast = votesCast;
  cachedActivityStats = activityStats;

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  -> All user stats precomputed in ${elapsed}s\n`);
}

function clearRankingCaches(): void {
  cachedEngagementRankings = null;
  cachedPrevYearRankings = null;
  cachedVotePercentiles = null;
  cachedContentPercentiles = null;
  // 清理用户统计缓存
  cachedPageStats = null;
  cachedVotesReceived = null;
  cachedVotesCast = null;
  cachedActivityStats = null;
}

// 使用缓存的快速查找函数
function getCachedEngagementRanking(userId: number, year: number, currentYear: number): RankingCache | null {
  const cache = year === currentYear ? cachedEngagementRankings : cachedPrevYearRankings;
  return cache?.get(userId) || null;
}

function getCachedVotePercentile(userId: number): VotePercentileCache | null {
  return cachedVotePercentiles?.get(userId) || null;
}

function getCachedContentPercentile(userId: number): VotePercentileCache | null {
  return cachedContentPercentiles?.get(userId) || null;
}

// 新增：获取缓存的用户统计数据
function getCachedPageStats(userId: number): PageStatsCache | null {
  return cachedPageStats?.get(userId) || null;
}

function getCachedVotesReceived(userId: number): VoteReceivedCache | null {
  return cachedVotesReceived?.get(userId) || null;
}

function getCachedVotesCast(userId: number): VoteCastCache | null {
  return cachedVotesCast?.get(userId) || null;
}

function getCachedActivityStats(userId: number): ActivityStatsCache | null {
  return cachedActivityStats?.get(userId) || null;
}

async function getUserVotesCastPercentile(userId: number, year: number): Promise<UserPercentile | null> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<[{
    userId: number;
    votesCast: bigint;
    rank: bigint;
    total: bigint;
  }]>`
    WITH user_votes AS (
      SELECT
        v."userId" AS "userId",
        COUNT(*) AS "votesCast"
      FROM "Vote" v
      JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
      WHERE v.timestamp >= ${startTzIso}::timestamptz
        AND v.timestamp < ${endTzIso}::timestamptz
        AND v."userId" IS NOT NULL
        AND pv."validTo" IS NULL
        AND NOT pv."isDeleted"
      GROUP BY v."userId"
      HAVING COUNT(*) > 0
    ),
    ranked AS (
      SELECT
        "userId",
        "votesCast",
        ROW_NUMBER() OVER (ORDER BY "votesCast" DESC) AS rank,
        COUNT(*) OVER () AS total
      FROM user_votes
    )
    SELECT
      "userId" AS "userId",
      "votesCast" AS "votesCast",
      rank,
      total
    FROM ranked
    WHERE "userId" = ${userId}
  `;

  if (!rows[0]) return null;

  const row = rows[0];
  const rankNum = Number(row.rank);
  const totalNum = Number(row.total);
  const percentile = totalNum > 0 ? rankNum / totalNum : 1;

  return {
    value: Number(row.votesCast),
    rank: rankNum,
    total: totalNum,
    percentile,
    percentileLabel: getPercentileLabel(percentile)
  };
}

async function getUserContentWordsPercentile(userId: number, year: number): Promise<UserPercentile | null> {
  const { startTzIso, endTzIso } = yearRange(year);
  const rows = await prisma.$queryRaw<[{
    userId: number;
    totalWords: bigint;
    rank: bigint;
    total: bigint;
  }]>`
    WITH pv AS (
      SELECT
        pv.id,
        LENGTH(COALESCE(pv.source, '')) AS word_count,
        COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AS published_at
      FROM "PageVersion" pv
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
    ),
    user_words AS (
      SELECT
        a."userId" AS "userId",
        SUM(pv.word_count) AS "totalWords"
      FROM pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id AND a."userId" IS NOT NULL
      WHERE pv.published_at >= ${startTzIso}::timestamptz
        AND pv.published_at < ${endTzIso}::timestamptz
      GROUP BY a."userId"
      HAVING SUM(pv.word_count) > 0
    ),
    ranked AS (
      SELECT
        "userId",
        "totalWords",
        ROW_NUMBER() OVER (ORDER BY "totalWords" DESC) AS rank,
        COUNT(*) OVER () AS total
      FROM user_words
    )
    SELECT
      "userId" AS "userId",
      "totalWords" AS "totalWords",
      rank,
      total
    FROM ranked
    WHERE "userId" = ${userId}
  `;

  if (!rows[0]) return null;

  const row = rows[0];
  const rankNum = Number(row.rank);
  const totalNum = Number(row.total);
  const percentile = totalNum > 0 ? rankNum / totalNum : 1;

  return {
    value: Number(row.totalWords),
    rank: rankNum,
    total: totalNum,
    percentile,
    percentileLabel: getPercentileLabel(percentile)
  };
}

async function getUserEngagementRanking(userId: number, year: number) {
  const { startTzIso, endTzIso } = yearRange(year);

  // Enhanced ranking formula (balanced volume, quality, engagement, consistency):
  // - Creation volume: page_count * 30 + originals * 20 + translations * 10
  // - Quality/reception: total_rating * 2.5 + avg_rating * 40 + votes_received * 1.5
  // - Community engagement: votes_cast * 1
  // - Consistency: active_days * 12
  const ranking = await prisma.$queryRaw<[{
    rank: bigint;
    total: bigint;
    score: number;
  }]>`
    WITH activity_scores AS (
      SELECT
        uds."userId",
        SUM(uds."pages_created") AS pages_created,
        SUM(uds."votes_cast") AS votes_cast,
        SUM(CASE WHEN uds."pages_created" > 0 OR uds."votes_cast" > 0 THEN 1 ELSE 0 END) AS active_days
      FROM "UserDailyStats" uds
      WHERE uds.date >= ${startTzIso}::date
        AND uds.date < ${endTzIso}::date
      GROUP BY uds."userId"
    ),
    -- Get votes received and ratings for each user's pages created this year
    reception_scores AS (
      WITH user_pages AS (
        SELECT
          a."userId",
          pv.id AS page_id,
          pv.rating,
          pv.tags @> ARRAY['原创'] AS is_original,
          pv.tags @> ARRAY['翻译'] AS is_translation
        FROM "Attribution" a
        JOIN "PageVersion" pv ON pv.id = a."pageVerId"
        WHERE a."userId" IS NOT NULL
          AND pv."validTo" IS NULL
          AND NOT pv."isDeleted"
          AND COALESCE(
            (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
            pv."createdAt"
          ) >= ${startTzIso}::timestamptz
          AND COALESCE(
            (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
            pv."createdAt"
          ) < ${endTzIso}::timestamptz
      ),
      votes_per_page AS (
        SELECT
          up.page_id,
          COUNT(v.id) AS votes_received
        FROM user_pages up
        LEFT JOIN "Vote" v ON v."pageVersionId" = up.page_id
          AND v.timestamp >= ${startTzIso}::timestamptz
          AND v.timestamp < ${endTzIso}::timestamptz
        GROUP BY up.page_id
      )
      SELECT
        up."userId",
        COUNT(*) AS page_count,
        SUM(CASE WHEN up.is_original THEN 1 ELSE 0 END) AS original_count,
        SUM(CASE WHEN up.is_translation THEN 1 ELSE 0 END) AS translation_count,
        COALESCE(SUM(vp.votes_received), 0) AS votes_received,
        COALESCE(SUM(up.rating), 0) AS total_rating,
        AVG(up.rating)::float AS avg_rating
      FROM user_pages up
      LEFT JOIN votes_per_page vp ON vp.page_id = up.page_id
      GROUP BY up."userId"
    ),
    user_scores AS (
      SELECT
        COALESCE(a."userId", r."userId") AS "userId",
        COALESCE(a.pages_created, 0) AS pages_created,
        COALESCE(a.votes_cast, 0) AS votes_cast,
        COALESCE(a.active_days, 0) AS active_days,
        COALESCE(r.page_count, 0) AS page_count,
        COALESCE(r.original_count, 0) AS original_count,
        COALESCE(r.translation_count, 0) AS translation_count,
        COALESCE(r.votes_received, 0) AS votes_received,
        COALESCE(r.total_rating, 0) AS total_rating,
        COALESCE(r.avg_rating, 0) AS avg_rating,
        -- Weighted score formula (numeric to keep decimal weights)
        (
          0.0
          + COALESCE(r.page_count, 0) * 30
          + COALESCE(r.original_count, 0) * 20
          + COALESCE(r.translation_count, 0) * 10
          + COALESCE(r.total_rating, 0) * 2.5
          + COALESCE(r.avg_rating, 0) * 40
          + COALESCE(r.votes_received, 0) * 1.5
          + COALESCE(a.votes_cast, 0) * 1
          + COALESCE(a.active_days, 0) * 12
        ) AS score
      FROM activity_scores a
      FULL OUTER JOIN reception_scores r ON a."userId" = r."userId"
      WHERE COALESCE(a.pages_created, 0) > 0 OR COALESCE(a.votes_cast, 0) > 0 OR COALESCE(r.page_count, 0) > 0
    ),
    ranked AS (
      SELECT
        "userId",
        score::float AS score,
        ROW_NUMBER() OVER (ORDER BY score DESC) AS rank,
        COUNT(*) OVER () AS total
      FROM user_scores
    )
    SELECT rank, total, score
    FROM ranked
    WHERE "userId" = ${userId}
  `;

  if (!ranking[0]) return null;

  const row = ranking[0];
  const rankNum = Number(row.rank);
  const totalNum = Number(row.total);
  const percentile = totalNum > 0 ? rankNum / totalNum : 1;

  return {
    rank: rankNum,
    total: totalNum,
    percentile,
    percentileLabel: getPercentileLabel(percentile)
  };
}

async function getUserTimeline(userId: number, year: number) {
  const { startTzIso, endTzIso } = yearRange(year);

  const voteRows = await prisma.$queryRaw<{
    month: Date;
    votesCast: bigint;
  }[]>`
    SELECT
      date_trunc('month', v."timestamp" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai') AS month,
      COUNT(*) AS "votesCast"
    FROM "Vote" v
    JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
    WHERE v."userId" = ${userId}
      AND v."timestamp" >= ${startTzIso}::timestamptz
      AND v."timestamp" < ${endTzIso}::timestamptz
      AND pv."validTo" IS NULL
      AND NOT pv."isDeleted"
    GROUP BY 1
    ORDER BY 1
  `;

  // Get pages created by this user with titles (for highlight)
  const userPages = await prisma.$queryRaw<{
    month: string;
    title: string;
    rating: number | null;
    isOriginal: boolean;
  }[]>`
    WITH pv AS (
      SELECT
        pv.id,
        pv.title,
        pv.rating,
        pv.tags @> ARRAY['原创'] AS "isOriginal",
        COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) AS published_at
      FROM "PageVersion" pv
      JOIN "Attribution" a ON a."pageVerId" = pv.id
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND a."userId" = ${userId}
    )
    SELECT
      TO_CHAR(published_at, 'YYYY-MM') AS month,
      title,
      rating,
      "isOriginal"
    FROM pv
    WHERE published_at >= ${startTzIso}::timestamptz
      AND published_at < ${endTzIso}::timestamptz
    ORDER BY published_at
  `;

  // Group pages by month
  const pagesByMonth = new Map<string, { title: string; rating: number | null; isOriginal: boolean }[]>();
  for (const page of userPages) {
    if (!pagesByMonth.has(page.month)) {
      pagesByMonth.set(page.month, []);
    }
    pagesByMonth.get(page.month)!.push({
      title: page.title,
      rating: page.rating,
      isOriginal: page.isOriginal
    });
  }

  const voteByMonth = new Map(voteRows.map(row => [formatMonthUTC8(row.month), Number(row.votesCast)]));
  const monthSet = new Set<string>([...voteByMonth.keys(), ...pagesByMonth.keys()]);
  const monthList = Array.from(monthSet).sort();

  return monthList.map((month) => {
    const monthPages = pagesByMonth.get(month) || [];
    const pages = monthPages.length;
    const votes = voteByMonth.get(month) || 0;

    // Build highlight text with page titles
    let highlightText = '';
    if (monthPages.length > 0) {
      const originals = monthPages.filter(p => p.isOriginal);
      const translations = monthPages.filter(p => !p.isOriginal);
      const parts: string[] = [];

      if (originals.length > 0) {
        const topOriginal = originals.sort((a, b) => (b.rating || 0) - (a.rating || 0))[0];
        parts.push(`发布原创《${topOriginal.title}》${originals.length > 1 ? `等${originals.length}篇` : ''}`);
      }
      if (translations.length > 0) {
        const topTrans = translations.sort((a, b) => (b.rating || 0) - (a.rating || 0))[0];
        parts.push(`翻译《${topTrans.title}》${translations.length > 1 ? `等${translations.length}篇` : ''}`);
      }
      if (votes > 0) {
        parts.push(`投票${votes}次`);
      }
      highlightText = parts.join('，');
    } else if (pages > 0 && votes > 0) {
      highlightText = `创作 ${pages} 篇，投票 ${votes} 次`;
    } else if (pages > 0) {
      highlightText = `创作 ${pages} 篇作品`;
    } else if (votes > 0) {
      highlightText = `参与 ${votes} 次投票`;
    }

    return {
      month,
      pages,
      votesCast: votes,
      pagesDetail: monthPages.slice(0, 3), // Include up to 3 page details
      highlight: highlightText ? { type: 'activity', text: highlightText } : null
    };
  });
}

// ============ User-specific Statistics ============

async function getUsersWithActivity(year: number) {
  const { startTzIso, endTzIso } = yearRange(year);

  const users = await prisma.$queryRaw<{
    userId: number;
    userName: string;
    displayName: string;
    hasOriginals: boolean;
    hasTranslations: boolean;
    hasVotes: boolean;
  }[]>`
    WITH user_activity AS (
      SELECT DISTINCT "userId" AS user_id FROM "UserDailyStats"
      WHERE date >= ${startTzIso}::date AND date < ${endTzIso}::date
    ),
    -- Users who created original pages in this year
    user_originals AS (
      SELECT DISTINCT a."userId" AS user_id
      FROM "Attribution" a
      JOIN "PageVersion" pv ON pv.id = a."pageVerId"
      JOIN "Page" p ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND pv.tags @> ARRAY['原创']
        AND a."userId" IS NOT NULL
        AND COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) >= ${startTzIso}::timestamptz
        AND COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) < ${endTzIso}::timestamptz
    ),
    -- Users who created translation pages in this year
    user_translations AS (
      SELECT DISTINCT a."userId" AS user_id
      FROM "Attribution" a
      JOIN "PageVersion" pv ON pv.id = a."pageVerId"
      JOIN "Page" p ON p.id = pv."pageId"
      WHERE pv."validTo" IS NULL
        AND NOT pv."isDeleted"
        AND NOT (pv.tags @> ARRAY['原创'])
        AND a."userId" IS NOT NULL
        AND COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) >= ${startTzIso}::timestamptz
        AND COALESCE(
          (SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'),
          pv."createdAt"
        ) < ${endTzIso}::timestamptz
    ),
    -- Users who voted in this year
    user_votes AS (
      SELECT DISTINCT "userId" AS user_id
      FROM "Vote"
      WHERE timestamp >= ${startTzIso}::timestamptz AND timestamp < ${endTzIso}::timestamptz
        AND "userId" IS NOT NULL
    )
    SELECT
      u.id AS "userId",
      u.username AS "userName",
      u."displayName",
      EXISTS (SELECT 1 FROM user_originals uo WHERE uo.user_id = u.id) AS "hasOriginals",
      EXISTS (SELECT 1 FROM user_translations ut WHERE ut.user_id = u.id) AS "hasTranslations",
      EXISTS (SELECT 1 FROM user_votes uv WHERE uv.user_id = u.id) AS "hasVotes"
    FROM "User" u
    WHERE EXISTS (SELECT 1 FROM user_activity ua WHERE ua.user_id = u.id)
    ORDER BY u.id
  `;

  return users;
}

async function getUserSummary(userId: number, year: number) {
  const { startTzIso, endTzIso } = yearRange(year);

  // Basic user info - 必须先检查用户是否存在
  const userInfo = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      wikidotId: true,
      username: true,
      displayName: true
    }
  });

  if (!userInfo) return null;

  // ============ 使用预计算缓存（有缓存用缓存，无则用默认值）============
  // 默认值（用于缓存未命中或无数据的用户）
  const defaultPageStats: PageStatsCache = { originalCount: 0, translationCount: 0, totalWords: 0, originalWords: 0, translationWords: 0, totalRating: 0, avgRating: 0 };
  const defaultVotesReceived: VoteReceivedCache = { total: 0, up: 0, down: 0 };
  const defaultVotesCast: VoteCastCache = { total: 0, up: 0, down: 0, activeDays: 0 };
  const defaultActivityStats: ActivityStatsCache = { activeDays: 0, firstActivity: null, lastActivity: null };

  // 直接从缓存获取或使用默认值（不再需要分支逻辑）
  const pageStats: PageStatsCache = getCachedPageStats(userId) ?? defaultPageStats;
  const votesReceived: VoteReceivedCache = getCachedVotesReceived(userId) ?? defaultVotesReceived;
  const votesCast: VoteCastCache = getCachedVotesCast(userId) ?? defaultVotesCast;
  const activityStats: ActivityStatsCache = getCachedActivityStats(userId) ?? defaultActivityStats;

  // 只需查询5个字段（favoriteTags, creationTags, revisionHourly, revisionTimeOfDay, timeline）
  const [favoriteTags, creationTags, userRevisionHourly, userRevisionTimeOfDay, timeline] = await Promise.all([
    // Favorite tags (by votes cast)
    prisma.$queryRaw<{ tag: string; voteCount: bigint; upCount: bigint }[]>`
      WITH user_votes AS (
        SELECT v.direction, pv.tags
        FROM "Vote" v
        JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
        WHERE v."userId" = ${userId}
          AND v.timestamp >= ${startTzIso}::timestamptz
          AND v.timestamp < ${endTzIso}::timestamptz
          AND pv."validTo" IS NULL AND NOT pv."isDeleted"
      ),
      tagged AS (SELECT unnest(tags) AS tag, direction FROM user_votes)
      SELECT tag, COUNT(*) AS "voteCount", COUNT(*) FILTER (WHERE direction = 1) AS "upCount"
      FROM tagged
      WHERE tag NOT IN (${Prisma.join(NON_DESCRIPTIVE_TAGS)})
        AND tag NOT LIKE '\\_%' ESCAPE '\\' AND tag NOT LIKE 'crom%'
      GROUP BY tag ORDER BY "voteCount" DESC LIMIT 10
    `,
    // Tags from user's created pages
    prisma.$queryRaw<{ tag: string; pageCount: bigint; avgRating: number }[]>`
      WITH user_pages AS (
        SELECT pv.tags, pv.rating
        FROM "PageVersion" pv
        JOIN "Attribution" a ON a."pageVerId" = pv.id
        WHERE a."userId" = ${userId} AND pv."validTo" IS NULL AND NOT pv."isDeleted"
          AND COALESCE((SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'), pv."createdAt") >= ${startTzIso}::timestamptz
          AND COALESCE((SELECT MIN(timestamp) FROM "Revision" r WHERE r."pageVersionId" = pv.id AND r.type = 'PAGE_CREATED'), pv."createdAt") < ${endTzIso}::timestamptz
      ),
      tagged AS (SELECT unnest(tags) AS tag, rating FROM user_pages)
      SELECT tag, COUNT(*) AS "pageCount", AVG(rating)::float AS "avgRating"
      FROM tagged
      WHERE tag NOT IN (${Prisma.join(NON_DESCRIPTIVE_TAGS)})
        AND tag NOT LIKE '\\_%' ESCAPE '\\' AND tag NOT LIKE 'crom%'
      GROUP BY tag ORDER BY "pageCount" DESC, "avgRating" DESC LIMIT 10
    `,
    // User's revision hourly distribution
    prisma.$queryRaw<{ hour: number; count: bigint }[]>`
      SELECT EXTRACT(HOUR FROM r.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::int AS hour, COUNT(*) AS count
      FROM "Revision" r
      JOIN "PageVersion" pv ON pv.id = r."pageVersionId"
      JOIN "Attribution" a ON a."pageVerId" = pv.id
      WHERE r.timestamp >= ${startTzIso}::timestamptz AND r.timestamp < ${endTzIso}::timestamptz
        AND a."userId" = ${userId} AND pv."validTo" IS NULL AND NOT pv."isDeleted"
      GROUP BY 1 ORDER BY 1
    `,
    // User's revision time of day
    prisma.$queryRaw<{ period: string; count: bigint }[]>`
      WITH rev_hours AS (
        SELECT EXTRACT(HOUR FROM r.timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai')::int AS hour
        FROM "Revision" r
        JOIN "PageVersion" pv ON pv.id = r."pageVersionId"
        JOIN "Attribution" a ON a."pageVerId" = pv.id
        WHERE r.timestamp >= ${startTzIso}::timestamptz AND r.timestamp < ${endTzIso}::timestamptz
          AND a."userId" = ${userId} AND pv."validTo" IS NULL AND NOT pv."isDeleted"
      )
      SELECT CASE
        WHEN hour >= 0 AND hour < 6 THEN '凌晨' WHEN hour >= 6 AND hour < 9 THEN '早晨'
        WHEN hour >= 9 AND hour < 12 THEN '上午' WHEN hour >= 12 AND hour < 14 THEN '中午'
        WHEN hour >= 14 AND hour < 18 THEN '下午' WHEN hour >= 18 AND hour < 22 THEN '晚上'
        ELSE '深夜' END AS period, COUNT(*) AS count
      FROM rev_hours GROUP BY 1
    `,
    getUserTimeline(userId, year)
  ]);

  // Map time periods to ensure correct order
  const periodOrder = ['凌晨', '早晨', '上午', '中午', '下午', '晚上', '深夜'];
  const userPeriodMap = new Map(userRevisionTimeOfDay.map(p => [p.period, Number(p.count)]));
  const userRevisionByTimeOfDay = periodOrder.map(period => ({
    period,
    count: userPeriodMap.get(period) || 0
  }));

  const totalVotesReceived = votesReceived.total;
  const upVotesReceived = votesReceived.up;
  const totalVotesCast = votesCast.total;
  const upVotesCast = votesCast.up;

  // 使用预计算缓存（如果可用），否则回退到逐个查询
  const cachedRanking = getCachedEngagementRanking(userId, year, year);
  const cachedPrevRanking = getCachedEngagementRanking(userId, year - 1, year);
  const cachedVotePerc = getCachedVotePercentile(userId);
  const cachedContentPerc = getCachedContentPercentile(userId);

  const ranking = cachedRanking || await getUserEngagementRanking(userId, year);
  const votePercentile = cachedVotePerc ? {
    value: cachedVotePerc.value,
    rank: cachedVotePerc.rank,
    total: cachedVotePerc.total,
    percentile: cachedVotePerc.percentile,
    percentileLabel: cachedVotePerc.percentileLabel
  } : await getUserVotesCastPercentile(userId, year);
  const contentPercentile = cachedContentPerc ? {
    value: cachedContentPerc.value,
    rank: cachedContentPerc.rank,
    total: cachedContentPerc.total,
    percentile: cachedContentPerc.percentile,
    percentileLabel: cachedContentPerc.percentileLabel
  } : await getUserContentWordsPercentile(userId, year);
  const previousRanking = cachedPrevRanking || await getUserEngagementRanking(userId, year - 1);

  const endRank = ranking?.rank ?? 0;
  const startRank = previousRanking?.rank ?? endRank;
  const rankChangeValue = startRank && endRank ? startRank - endRank : 0;
  const rankDirection = rankChangeValue > 0 ? 'up' : rankChangeValue < 0 ? 'down' : 'same';

  const mostActiveMonth = timeline
    .map(t => ({ month: t.month, score: (t.pages || 0) * 20 + (t.votesCast || 0) }))
    .sort((a, b) => b.score - a.score)[0]?.month || null;

  const achievements = [];
  const earnedAt = formatDateTimeUTC8(new Date(endTzIso));

  // Only add user-firsts achievements (e.g., "XX标签第一名") - 全量存储
  const firstsAchievements = getUserFirstsAchievements(userId, year, Infinity);
  achievements.push(...firstsAchievements);

  if (achievements.length === 0) {
    achievements.push({
      id: `participation_${year}_${userId}`,
      category: 'special',
      tier: 'honorable',
      icon: 'star',
      title: '活跃参与者',
      description: '今年参与了站点互动，欢迎继续创作与投票',
      value: activityStats.activeDays,
      valueLabel: '天',
      period: 'year',
      periodText: `${year}年`,
      tag: null,
      earnedAt,
      relatedPage: null,
      rarity: 1,
      rarityLabel: '保持活跃'
    });
  }

  return {
    userId: userInfo.id,
    wikidotId: userInfo.wikidotId,
    userName: userInfo.username,
    displayName: userInfo.displayName,
    avatarUrl: null,
    overview: {
      rankChange: {
        startRank,
        endRank,
        change: rankChangeValue,
        direction: rankDirection
      },
      creation: {
        originalCount: pageStats.originalCount,
        translationCount: pageStats.translationCount,
        totalCount: pageStats.originalCount + pageStats.translationCount,
        totalWords: pageStats.totalWords,
        originalWords: pageStats.originalWords,
        translationWords: pageStats.translationWords
      },
      ratings: {
        totalRatingGained: pageStats.totalRating,
        avgRating: pageStats.avgRating ? Math.round(pageStats.avgRating * 10) / 10 : 0
      },
      votesReceived: {
        total: totalVotesReceived,
        up: upVotesReceived,
        down: votesReceived.down,
        netScore: upVotesReceived - votesReceived.down,
        upRate: totalVotesReceived > 0 ? Math.round(upVotesReceived / totalVotesReceived * 1000) / 1000 : 0
      },
      votesCast: {
        total: totalVotesCast,
        up: upVotesCast,
        down: votesCast.down,
        upRate: totalVotesCast > 0 ? Math.round(upVotesCast / totalVotesCast * 1000) / 1000 : 0,
        activeDays: votesCast.activeDays
      },
      activity: {
        activeDays: activityStats.activeDays,
        firstActivityDate: activityStats.firstActivity,
        lastActivityDate: activityStats.lastActivity,
        mostActiveMonth,
        longestStreak: 0
      }
    },
    preferences: {
      favoriteTagsByVotes: favoriteTags.map(t => ({
        tag: t.tag,
        voteCount: Number(t.voteCount),
        upCount: Number(t.upCount),
        upRate: Number(t.voteCount) > 0 ? Math.round(Number(t.upCount) / Number(t.voteCount) * 1000) / 1000 : 0
      })),
      creationTagsByPages: creationTags.map(t => ({
        tag: t.tag,
        pageCount: Number(t.pageCount),
        avgRating: t.avgRating ? Math.round(t.avgRating * 10) / 10 : 0
      }))
    },
    achievements,
    percentiles: {
      votesCast: votePercentile,
      contentWords: contentPercentile
    },
    rankings: ranking ? {
      overall: {
        rank: ranking.rank,
        total: ranking.total,
        percentile: ranking.percentile,
        percentileLabel: ranking.percentileLabel
      }
    } : {
      overall: {
        rank: 0,
        total: 0,
        percentile: 1,
        percentileLabel: '活跃参与者'
      }
    },
    timeline,
    revisionTimeDistribution: (() => {
      const hourlyData = userRevisionHourly.map(h => ({
        hour: h.hour,
        count: Number(h.count)
      }));
      const peakHourData = hourlyData.length > 0
        ? hourlyData.reduce((max, h) => h.count > max.count ? h : max, hourlyData[0])
        : null;
      return {
        hourly: hourlyData,
        byTimeOfDay: userRevisionByTimeOfDay,
        peakHour: peakHourData ? {
          hour: peakHourData.hour,
          count: peakHourData.count,
          label: `${peakHourData.hour}:00-${peakHourData.hour + 1}:00`
        } : null,
        totalRevisions: hourlyData.reduce((sum, h) => sum + h.count, 0)
      };
    })()
  };
}

// ============ Main Export Functions ============

async function exportSiteData(year: number, outputDir: string) {
  console.log(`Generating site data for ${year}...`);

  const [
    overview,
    pageRankings,
    authorRankings,
    voterRankings,
    trends,
    funFacts,
    tagStats,
    categoryBest,
    extremeStats,
    categoryDetails,
    monthlyVoteStats,
    votesByCategory,
    revisionTimeDistribution,
    interestingStats,
    distributions,
    deletedPageStats
  ] = await runInBatches<any>([
    () => getSiteOverview(year),
    () => getTopRatedPages(year),
    () => getTopAuthors(year),
    () => getTopVoters(year),
    () => getMonthlyTrends(year),
    () => getPopularTags(year),
    () => getTagStats(year),
    () => getTopByCategory(year),
    () => getExtremeStats(year),
    () => getCategoryDetails(year),
    () => getMonthlyVoteStats(year),
    () => getVotesByCategory(year),
    () => getRevisionTimeDistribution(year),
    () => getInterestingStats(year),
    () => getDistributions(year),
    () => getDeletedPageStats(year)
  ], EXPORT_CONCURRENCY);

  const siteData = {
    overview,
    pageRankings,
    authorRankings,
    voterRankings,
    trends,
    milestones: [],
    funFacts,
    tagStats,
    categoryBest,
    extremeStats,
    categoryDetails,
    // New statistics
    monthlyVoteStats,
    votesByCategory,
    revisionTimeDistribution,
    interestingStats,
    distributions,
    deletedPageStats
  };

  const yearDir = path.join(outputDir, String(year));
  if (!fs.existsSync(yearDir)) {
    fs.mkdirSync(yearDir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(yearDir, 'site.json'),
    JSON.stringify(siteData, null, 2),
    'utf-8'
  );

  console.log(`  -> site.json written`);
  return siteData;
}

async function exportUserIndex(year: number, outputDir: string) {
  console.log(`Generating user index for ${year}...`);

  const users = await getUsersWithActivity(year);

  const usersIndex: Record<string, any> = {};
  for (const user of users) {
    usersIndex[String(user.userId)] = {
      userName: user.userName,
      displayName: user.displayName,
      avatarUrl: null,
      hasOriginals: user.hasOriginals,
      hasTranslations: user.hasTranslations,
      hasVotes: user.hasVotes,
      achievementCount: 0,
      highlightAchievement: null
    };
  }

  const indexData = {
    users: usersIndex,
    totalCount: users.length
  };

  const yearDir = path.join(outputDir, String(year));
  const usersDir = path.join(yearDir, 'users');
  if (!fs.existsSync(usersDir)) {
    fs.mkdirSync(usersDir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(usersDir, 'index.json'),
    JSON.stringify(indexData, null, 2),
    'utf-8'
  );

  console.log(`  -> users/index.json written (${users.length} users)`);
  return users;
}

async function exportUserData(userId: number, year: number, outputDir: string) {
  const userData = await getUserSummary(userId, year);
  if (!userData) return null;

  const yearDir = path.join(outputDir, String(year));
  const usersDir = path.join(yearDir, 'users');

  fs.writeFileSync(
    path.join(usersDir, `${userId}.json`),
    JSON.stringify(userData, null, 2),
    'utf-8'
  );

  return userData;
}

async function exportMetadata(year: number, outputDir: string, userCount: number) {
  const meta = {
    version: '1.0.0',
    year,
    generatedAt: formatDateTimeUTC8(new Date()),
    dataRange: {
      start: `${year}-01-01T00:00:00+08:00`,
      end: `${year}-12-25T23:59:59+08:00`
    },
    totalUsers: userCount,
    usersWithSummary: userCount
  };

  const yearDir = path.join(outputDir, String(year));
  fs.writeFileSync(
    path.join(yearDir, 'meta.json'),
    JSON.stringify(meta, null, 2),
    'utf-8'
  );

  console.log(`  -> meta.json written`);
}

async function main() {
  const { year, outputDir, siteOnly, turbo, generateFirsts, refreshFirsts } = parseArgs();

  // 设置全局 turbo 模式并更新并发配置
  TURBO_MODE = turbo;
  const concurrency = getConcurrency();
  EXPORT_CONCURRENCY = concurrency.EXPORT_CONCURRENCY;
  CATEGORY_CONCURRENCY = concurrency.CATEGORY_CONCURRENCY;
  CATEGORY_QUERY_CONCURRENCY = concurrency.CATEGORY_QUERY_CONCURRENCY;

  console.log(`\n=== Annual Summary Export ===`);
  console.log(`Year: ${year}`);
  console.log(`Output: ${outputDir}`);
  console.log(`Mode: ${siteOnly ? 'site-only (skip user data)' : 'full'}`);
  if (turbo) {
    console.log(`Turbo Mode: ENABLED (aggressive parallelization)`);
    console.log(`  - Export Concurrency: ${concurrency.EXPORT_CONCURRENCY}`);
    console.log(`  - Category Concurrency: ${concurrency.CATEGORY_CONCURRENCY}`);
    console.log(`  - Query Concurrency: ${concurrency.CATEGORY_QUERY_CONCURRENCY}`);
    console.log(`  - User Batch Size: ${concurrency.USER_BATCH_SIZE}`);
    console.log(`  - Firsts Query Concurrency: ${concurrency.FIRSTS_QUERY_CONCURRENCY}`);
  }
  if (generateFirsts) {
    console.log(`Generate Firsts: ${refreshFirsts ? 'REFRESH (force regenerate cache)' : 'YES (if cache missing)'}`);
  }
  console.log('');

  // Export site data
  await exportSiteData(year, outputDir);

  if (siteOnly) {
    console.log(`\n=== Export Complete (site-only mode) ===\n`);
    return;
  }

  // Load or generate user-firsts for achievements
  const cachePath = path.join(process.cwd(), 'cache', `user-firsts-${year}.json`);
  const cacheExists = fs.existsSync(cachePath);
  const needsGeneration = generateFirsts || refreshFirsts || !cacheExists;

  if (needsGeneration) {
    await loadOrGenerateUserFirsts(year, generateFirsts || !cacheExists, refreshFirsts);
  } else {
    console.log(`\nLoading user-firsts cache...`);
    loadUserFirstsCache(year);
  }

  // Export user index
  const users = await exportUserIndex(year, outputDir);

  // 预计算所有用户排名和统计数据（大幅提升性能）
  await precomputeAllRankings(year);
  await precomputeAllUserStats(year);

  // Export individual user data
  console.log(`\nGenerating individual user data...`);
  let exported = 0;
  const batchSize = concurrency.USER_BATCH_SIZE;

  for (let i = 0; i < users.length; i += batchSize) {
    const batch = users.slice(i, i + batchSize);
    await Promise.all(batch.map(u => exportUserData(u.userId, year, outputDir)));
    exported += batch.length;
    process.stdout.write(`  -> ${exported}/${users.length} users processed\r`);
  }
  console.log(`  -> ${exported} user files written`);

  // Export metadata
  await exportMetadata(year, outputDir, users.length);

  console.log(`\n=== Export Complete ===\n`);
}

main()
  .catch((err) => {
    console.error('Export failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    clearRankingCaches();
    await disconnectPrisma();
  });
