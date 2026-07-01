import { Prisma, PrismaClient } from '@prisma/client';
import pg from 'pg';
import { getPrismaClient } from '../utils/db-connection.js';

type MarketCategory = 'OVERALL' | 'TRANSLATION' | 'SCP' | 'TALE' | 'GOI' | 'WANDERERS';

type CategoryMarginSnapshot = {
  category: string;
  longMargin: number;
  shortMargin: number;
};

type CategoryWindowStats = {
  revisions: number;
  votesUp: number;
  votesDown: number;
  totalVotes: number;
  newPages: number;
  deletedPages: number;
};

type RawSignal = {
  category: MarketCategory;
  dRev: number;
  dVotesTotal: number;
  dSentiment: number;
  dNet: number;
  dDelRate: number;
  voteCount: number;
};

type TickRunSummary = {
  generated: number;
  fromAsOfTs: string | null;
  toAsOfTs: string | null;
  sourceWatermarkTs: string | null;
};

type CategoryOffsetHistory = Map<number, number[]>;

type HourlyBaseline = Map<number, number>;  // key = dow*24+hour, value = median count

type MicroBaselineContext = {
  revision: Map<MarketCategory, HourlyBaseline>;
  forum: HourlyBaseline;
  revisionDataDays: number;
  forumDataDays: number;
};

type RawStatsQueryResult = {
  currentNonVote: CategoryWindowStats;
  currentVote: CategoryWindowStats;
  pageCountStart: number;
  baselineRev: number;
  baselineVotesTotal: number;
  baselineApproval: number;
  baselineNet: number;
  baselineDelRate: number;
};

const CATEGORY_LIST: MarketCategory[] = [
  'OVERALL',
  'TRANSLATION',
  'SCP',
  'TALE',
  'GOI',
  'WANDERERS'
];

const TASK_NAME = 'category_index_tick';
const SOURCE_WATERMARK_TASKS = ['daily_aggregates', 'page_stats'];
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const INDEX_BASE = 100;
const INDEX_K = 0.1;
const SCORE_CLAMP = 3.2;
// 子类信号减去 1.0×OVERALL：子类指数只表达"品类相对全站"的份额变化，
// 全站潮汐（含活动量长期趋势）仅由 OVERALL 承载（v3 前为 0.5，半剔除）
const INFLATION_ALPHA = 1.0;
const LEGACY_INFLATION_ALPHA = 0.5;
// tick 口径版本：v2 = score 公式 v3（INFLATION_ALPHA=1.0、drift 引用 raw、
// 收盘剔除 drag/micro、软锚点）。投票 T+1 截止规则本身未变。
// drift 历史加载时依据该标记把旧口径子类 raw 换算到新口径。
const LEGACY_TICK_RULE_VERSION = 'utc8-t+1-v1';
const TICK_RULE_VERSION = 'utc8-t+1-v2';

const DRIFT_WINDOW_WEEKS = 26;
const DRIFT_MIN_HISTORY_WEEKS = 8;
const DRIFT_BETA_OVERALL = 0.95;
const DRIFT_BETA_TRANSLATION = 0.7;
const DRIFT_BETA_OTHERS = 0.65;
// drift ref 的小时桶样本不足 DRIFT_MIN_HISTORY_WEEKS 时，回退到该类目全部桶
// 池化中位数（池化样本需达到该阈值），消除上线初期/新桶的修正空窗
const DRIFT_FALLBACK_MIN_SAMPLES = 192;

// ─── 周锚点与跨周携带（v3）───
// 每周以 ANCHOR_PHI_WEEKLY 的比例把指数的对数偏差拉回 INDEX_BASE：
// anchorTerm = (周内小时/167) × φ × ln(INDEX_BASE/周开盘)，随周内时间线性放大，
// 周日 23:00 满额、周一 00:00 为 0，因此"下周开盘 = 本周收盘"约束天然保持，无周一跳价。
// φ=0.06 ⇒ 对数偏差半衰期约 11.5 周；锚力表现为周内连续微漂移（深跌时每小时约 +0.04%）。
const ANCHOR_PHI_WEEKLY = 0.06;
// 跨周携带 clamp：周收盘 tick 的 score 决定整周复利因子，单独收紧上限
// （周内 tick 仍用 SCORE_CLAMP=±3.2），±2.0 ⇒ 单周跨周携带最多 ±22%
const CARRY_CLAMP = 2.0;
// 周日 23:00 (UTC+8) 的 weekly offset bucket
const WEEK_CLOSE_OFFSET = 7 * 24 - 1;

const VOTE_K = 360;
const SENTIMENT_ALPHA = 2;
const SENTIMENT_BETA = 2;
const SENTIMENT_K = 140;
const DEL_RATE_PENALTY = 0.05;
const Z_CLAMP = 6;

const BASE_GROWTH_WEIGHT_REV = 0.22;
const BASE_GROWTH_WEIGHT_VOTES = 0.25;
const BASE_GROWTH_WEIGHT_NET = 0.2;
const SENTIMENT_WEIGHT = 0.15;
const GROWTH_WEIGHT_SUM = BASE_GROWTH_WEIGHT_REV + BASE_GROWTH_WEIGHT_VOTES + BASE_GROWTH_WEIGHT_NET;
const GROWTH_WEIGHT_MULTIPLIER = (1 - SENTIMENT_WEIGHT) / GROWTH_WEIGHT_SUM;
const WEIGHT_REV = BASE_GROWTH_WEIGHT_REV * GROWTH_WEIGHT_MULTIPLIER;
const WEIGHT_VOTES = BASE_GROWTH_WEIGHT_VOTES * GROWTH_WEIGHT_MULTIPLIER;
const WEIGHT_NET = BASE_GROWTH_WEIGHT_NET * GROWTH_WEIGHT_MULTIPLIER;

const REV_SCALE = 0.4;
const VOTES_SCALE = 0.4;
const NET_SCALE = 0.4;
const SENTIMENT_SCALE = 0.95;
const DEL_RATE_SCALE = 0.2;

const CROWD_DRAG_K = 0.3;
const CROWD_LIQUIDITY_BASE = 5000;
const NOISE_AMPLITUDE = 0.003;

const BASELINE_MEDIAN_WEEKS = 12;

// ─── Micro-Signal Layer ───
const MICRO_REV_WINDOW_HOURS = 4;
const MICRO_FORUM_WINDOW_HOURS = 4;
const REV_MICRO_SCALE = 1.2;
const FORUM_MICRO_SCALE = 1.5;
const REV_MICRO_WEIGHT = 0.10;
const FORUM_MICRO_WEIGHT = 0.05;
const VOTE_AMP_K = 0.4;
const MICRO_BASELINE_WEEKS = 12;
const MICRO_MIN_BASELINE_DAYS = 14;

const FALLBACK_BACKFILL_HOURS = 24;
const MAX_BACKFILL_HOURS = 24 * 14;
const SCORE_HISTORY_WINDOW_PER_OFFSET = DRIFT_WINDOW_WEEKS;

// ════════ v4 增量驱动重设计（灰度开关；默认关 = 完全保持 v3 行为）════════
// 设计与回测：docs/gacha-market-oracle-v4-{proposals,backtest}-2026-06-30.md
// 价格改「基本面增量驱动」：Δln(price)=K·scoreCorrected + 随机增量 + 弱锚增量（链式连续，
// 天然满足"下周开盘=本周收盘"）。随机层用 OU 卷积纯函数（均值回复+方差有界+无运行状态），
// 是 (category, 绝对小时) 的纯函数 → 可逐位复现，满足"绝不改历史 tick"的前提。
function v4ParseBool(v: string | undefined): boolean {
  if (v == null) return false;
  const n = v.trim().toLowerCase();
  return n === '1' || n === 'true' || n === 'yes' || n === 'on';
}
// 注意：用 Number.isFinite 而非 `Number(v) || def`，否则 env 显式设 0 会被当 falsy 吞掉、
// 无法把某一层参数关成 0（Claude review #6）。
function v4NumEnv(v: string | undefined, def: number): number {
  if (v == null || v.trim() === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
const V4_ENABLED = v4ParseBool(process.env.V4_ORACLE_INCREMENT);
const V4_TICK_RULE_VERSION = 'utc8-t+1-v3';
const V4_SEED_SALT = (process.env.ORACLE_SEED_SALT || 'scpper-oracle-v4-default').trim();
const V4_K_FUND = v4NumEnv(process.env.V4_K_FUND, 0.0013);             // 基本面增量驱动系数
const V4_SIGMA_TARGET = v4NumEnv(process.env.V4_SIGMA_TARGET, 0.0055); // OU 增量目标小时 std（中等波动档）
const V4_OU_KAPPA = 0.06;            // 随机位移均值回复速率
const V4_OU_WINDOW = 200;            // 卷积窗（(1-κ)^200≈3e-6，足够截断）
const V4_VOL_WEEK_AMP = 0.6;         // 周级冷热 regime 幅度
const V4_JUMP_LAMBDA = 0.006;        // 泊松跳跃概率/小时（~1/周）
const V4_JUMP_MIN = 0.03;
const V4_JUMP_MAG = 0.05;            // 跳幅 ±3~8%
const V4_INCR_CLAMP = 0.15;          // 单 tick 增量硬顶（防极端针 → 防清算级联）
const V4_ANCHOR_LAMBDA = v4NumEnv(process.env.V4_ANCHOR_LAMBDA, 0.25);   // 弱公允值锚（防长期漂移）
const V4_FAIR_GAMMA = 0.18;          // 公允值随基本面浮动：F=ln(100)+γ·levelRef
const V4_BETA_SEAS_OVERALL = 0.9;    // drift 季节项系数
const V4_BETA_SEAS_OTHER = 0.8;
const V4_BETA_LEVEL = 0.05;          // drift 趋势项系数（≈0，几乎保留品类自身趋势）
const V4_SCORE_CLAMP = 3.6;
const V4_EARLY_WEEK_HOURS = 72;      // 周初 blend，消周一信号空窗

function v4Hash32(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function v4Mul32(a: number): number {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function v4Uniform(category: string, week: number, tag: string, t: number): number {
  return v4Mul32(v4Hash32(`${V4_SEED_SALT}|${category}|${week}|${tag}|${t}`));
}
function v4Normal(category: string, week: number, tag: string, t: number): number {
  let s = 0;
  for (let k = 0; k < 12; k++) s += v4Mul32(v4Hash32(`${V4_SEED_SALT}|${category}|${week}|${tag}|${t}|${k}`));
  return s - 6; // Irwin-Hall ≈ N(0,1)，纯整数+加法、跨平台逐位一致
}
const v4IncrCache = new Map<string, number>();
// 绝对小时 h 的随机 log 增量（纯函数）：周级 vol regime × Irwin-Hall 正态 + 低频泊松跳跃
function v4IncrAt(category: string, h: number): number {
  const key = category + '|' + h;
  const cached = v4IncrCache.get(key);
  if (cached !== undefined) return cached;
  const week = startOfUtc8Week(new Date(h * HOUR_MS)).getTime();
  const volWeek = 1 + V4_VOL_WEEK_AMP * (v4Uniform(category, week, 'vol', 0) - 0.5) * 2;
  let incr = V4_SIGMA_TARGET * volWeek * v4Normal(category, week, 'ou', h);
  if (v4Uniform(category, week, 'jump', h) < V4_JUMP_LAMBDA) {
    const sgn = v4Uniform(category, week, 'js', h) < 0.5 ? -1 : 1;
    incr += sgn * (V4_JUMP_MIN + V4_JUMP_MAG * v4Uniform(category, week, 'jm', h));
  }
  incr = clamp(incr, -V4_INCR_CLAMP, V4_INCR_CLAMP);
  v4IncrCache.set(key, incr);
  return incr;
}
const v4OuCache = new Map<string, number>();
// OU 闭式解 S[h]=Σ (1-κ)^j·incr[h-j]：均值回复、方差有界、纯函数（无运行状态、可逐位复现）
function v4OuLevel(category: string, h: number): number {
  const key = category + '|' + h;
  const cached = v4OuCache.get(key);
  if (cached !== undefined) return cached;
  let s = 0, w = 1; const decay = 1 - V4_OU_KAPPA;
  for (let j = 0; j < V4_OU_WINDOW; j++) { s += w * v4IncrAt(category, h - j); w *= decay; if (w < 1e-6) break; }
  v4OuCache.set(key, s);
  return s;
}

function addUtc8Offset(date: Date) {
  return new Date(date.getTime() + UTC8_OFFSET_MS);
}

function removeUtc8Offset(date: Date) {
  return new Date(date.getTime() - UTC8_OFFSET_MS);
}

function floorToUtc8Hour(input: Date) {
  const shifted = addUtc8Offset(input);
  shifted.setUTCMinutes(0, 0, 0);
  return removeUtc8Offset(shifted);
}

function startOfUtc8Day(input: Date) {
  const shifted = addUtc8Offset(input);
  shifted.setUTCHours(0, 0, 0, 0);
  return removeUtc8Offset(shifted);
}

function utcDateOnlyFromUtc8Day(input: Date) {
  const shifted = addUtc8Offset(input);
  return new Date(Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate()
  ));
}

function startOfUtc8Week(input: Date) {
  const shifted = addUtc8Offset(input);
  const day = shifted.getUTCDay();
  const mondayOffset = (day + 6) % 7;
  shifted.setUTCDate(shifted.getUTCDate() - mondayOffset);
  shifted.setUTCHours(0, 0, 0, 0);
  return removeUtc8Offset(shifted);
}

function weeklyOffsetBucket(input: Date) {
  const weekStart = startOfUtc8Week(input);
  const offset = Math.floor((input.getTime() - weekStart.getTime()) / HOUR_MS);
  return Math.max(0, Math.min(offset, (7 * 24) - 1));
}

function addUtc8Hours(input: Date, hours: number) {
  return new Date(input.getTime() + hours * HOUR_MS);
}

function addUtc8Days(input: Date, days: number) {
  const shifted = addUtc8Offset(input);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return removeUtc8Offset(shifted);
}

function minDate(a: Date, b: Date) {
  return new Date(Math.min(a.getTime(), b.getTime()));
}

function pad2(value: number) {
  return String(value).padStart(2, '0');
}

function pad3(value: number) {
  return String(value).padStart(3, '0');
}

function toUtcNaiveTimestamp(date: Date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`
    + ` ${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}.${pad3(date.getUTCMilliseconds())}`;
}

/**
 * The DB columns here are mostly `timestamp without time zone`.
 * Bind as UTC-naive text to avoid implicit timezone conversion by PostgreSQL session tz.
 */
function utcNaiveTimestampSql(date: Date) {
  return Prisma.sql`${toUtcNaiveTimestamp(date)}::timestamp`;
}

function clamp(value: number, minValue: number, maxValue: number) {
  return Math.max(minValue, Math.min(maxValue, value));
}

function logit(probability: number) {
  const p = clamp(probability, 0.01, 0.99);
  return Math.log(p / (1 - p));
}

function safeLog1p(value: number) {
  return Math.log1p(Math.max(0, value));
}

function signedLog1p(value: number) {
  if (value === 0) return 0;
  return Math.sign(value) * Math.log1p(Math.abs(value));
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  const left = sorted[middle - 1] ?? 0;
  const right = sorted[middle] ?? 0;
  return (left + right) / 2;
}

function categoryPredicateSql(category: MarketCategory) {
  switch (category) {
    case 'OVERALL':
      return Prisma.sql`TRUE`;
    case 'TRANSLATION':
      return Prisma.sql`NOT ('原创' = ANY(pv.tags) OR 'original' = ANY(pv.tags))`;
    case 'SCP':
      return Prisma.sql`
        ('原创' = ANY(pv.tags) OR 'original' = ANY(pv.tags))
        AND ('scp' = ANY(pv.tags) OR 'SCP' = ANY(pv.tags))
      `;
    case 'TALE':
      return Prisma.sql`
        ('原创' = ANY(pv.tags) OR 'original' = ANY(pv.tags))
        AND ('故事' = ANY(pv.tags) OR 'tale' = ANY(pv.tags))
      `;
    case 'GOI':
      return Prisma.sql`
        ('原创' = ANY(pv.tags) OR 'original' = ANY(pv.tags))
        AND ('goi格式' = ANY(pv.tags) OR 'goi-format' = ANY(pv.tags) OR 'goi' = ANY(pv.tags))
      `;
    case 'WANDERERS':
      return Prisma.sql`
        ('原创' = ANY(pv.tags) OR 'original' = ANY(pv.tags))
        AND ('wanderers' = ANY(pv.tags) OR '流浪者' = ANY(pv.tags))
      `;
    default:
      return Prisma.sql`FALSE`;
  }
}

export class CategoryIndexTickJob {
  private prisma: PrismaClient;
  private userDbUrl: string | null;

  constructor(prisma?: PrismaClient, userDbUrl?: string) {
    this.prisma = prisma || getPrismaClient();
    this.userDbUrl = userDbUrl ?? process.env.USER_DATABASE_URL ?? process.env.USER_BACKEND_DATABASE_URL ?? null;
  }

  async run(options: { forceFullBackfill?: boolean } = {}): Promise<TickRunSummary> {
    // V4 私盐 fail-fast：随机增量是 (盐, category, 时刻) 的纯函数；若用公开默认盐，
    // 任何人都能据 category/时刻 复现未来随机增量并 front-run（Codex review P2）。
    if (V4_ENABLED && !(process.env.ORACLE_SEED_SALT || '').trim()) {
      throw new Error(
        '[CategoryIndexTickJob] V4_ORACLE_INCREMENT 已启用但未设置 ORACLE_SEED_SALT：'
        + '随机层将使用公开默认盐，未来随机增量可被逆向 front-run。'
        + '请先在生产环境设置一个保密的 ORACLE_SEED_SALT 再启用 V4。'
      );
    }
    const sourceWatermark = await this.resolveSourceWatermark();
    const nowAsOf = floorToUtc8Hour(new Date());
    const latestTick = await this.prisma.categoryIndexTick.findFirst({
      orderBy: { asOfTs: 'desc' },
      select: { asOfTs: true }
    });

    const maxBackfillHours = options.forceFullBackfill ? MAX_BACKFILL_HOURS : FALLBACK_BACKFILL_HOURS;
    const oldestAllowed = addUtc8Hours(nowAsOf, -(maxBackfillHours - 1));
    const defaultStart = oldestAllowed;
    const startAsOfRaw = latestTick?.asOfTs
      ? addUtc8Hours(floorToUtc8Hour(new Date(latestTick.asOfTs)), 1)
      : defaultStart;
    const startAsOf = startAsOfRaw.getTime() < oldestAllowed.getTime() ? oldestAllowed : startAsOfRaw;
    if (startAsOf.getTime() > nowAsOf.getTime()) {
      await this.touchTaskWatermark(latestTick?.asOfTs ?? null);
      return {
        generated: 0,
        fromAsOfTs: null,
        toAsOfTs: null,
        sourceWatermarkTs: sourceWatermark?.toISOString() ?? null
      };
    }

    const scoreHistory = await this.loadScoreHistoryByOffset();
    const marginSnapshot = await this.loadCrowdMarginSnapshot();
    const microBaselines = await this.loadMicroBaselines();
    const weekOpenCache = new Map<string, number>();
    // v4 链式增量状态（仅 V4_ENABLED 用）：上一 tick 价格 + 其时刻 + 上周收盘 genuine raw
    const lastIndexByCategory = new Map<string, number>();
    const lastIndexTsByCategory = new Map<string, number>();
    const lastCloseRawByCategory = new Map<string, number>();
    let generated = 0;
    let firstGenerated: Date | null = null;
    let lastGenerated: Date | null = null;

    for (let cursorTs = startAsOf.getTime(); cursorTs <= nowAsOf.getTime(); cursorTs += HOUR_MS) {
      const asOfTs = new Date(cursorTs);
      const watermarkTs = sourceWatermark ? new Date(Math.min(sourceWatermark.getTime(), asOfTs.getTime())) : asOfTs;

      const asOfDay = startOfUtc8Day(asOfTs);
      const watermarkDay = startOfUtc8Day(watermarkTs);
      const voteCutoff = addUtc8Days(asOfDay, -1);
      const nonVoteEnd = minDate(voteCutoff, watermarkDay);
      const voteEnd = minDate(voteCutoff, watermarkDay);
      const weekStart = startOfUtc8Week(asOfTs);
      const dayStart = startOfUtc8Day(asOfTs);

      // ─── Pre-query micro-signal data for this tick ───
      const revWindow = new Map<MarketCategory, number>();
      const cumRevToday = new Map<MarketCategory, number>();
      const revWindowStart = new Date(asOfTs.getTime() - MICRO_REV_WINDOW_HOURS * HOUR_MS);
      for (const category of CATEGORY_LIST) {
        const [windowCount, cumCount] = await Promise.all([
          this.queryRecentRevisionCount(revWindowStart, asOfTs, category),
          this.queryRecentRevisionCount(dayStart, asOfTs, category),
        ]);
        revWindow.set(category, windowCount);
        cumRevToday.set(category, cumCount);
      }
      const forumWindowStart = new Date(asOfTs.getTime() - MICRO_FORUM_WINDOW_HOURS * HOUR_MS);
      const recentForumCount = await this.queryRecentForumPostCount(forumWindowStart, asOfTs);

      // ─── Compute raw signals with interpolation for all categories ───
      const rawSignals = new Map<MarketCategory, RawSignal>();
      for (const category of CATEGORY_LIST) {
        const rawStats = await this.queryRawStats(category, weekStart, voteEnd, nonVoteEnd);

        // Query transition day stats for interpolation
        const [transitionDayNonVote, transitionDayVote] = await Promise.all([
          this.queryWindowStats(category, voteEnd, voteEnd, { includeContentMetrics: true }),
          this.queryWindowStats(category, voteEnd, voteEnd, { includeContentMetrics: false }),
        ]);

        // Compute alpha (revision-adaptive interpolation rate)
        const expectedDailyRevs = this.getDailyRevisionBaseline(asOfTs, microBaselines.revision.get(category));
        const alpha = Math.min(1, (cumRevToday.get(category) ?? 0) / Math.max(1, expectedDailyRevs));

        // Interpolate current stats — gradually include the transition day
        const interpolatedNonVote: CategoryWindowStats = {
          revisions: Math.max(0, rawStats.currentNonVote.revisions - (1 - alpha) * transitionDayNonVote.revisions),
          votesUp: rawStats.currentNonVote.votesUp,
          votesDown: rawStats.currentNonVote.votesDown,
          totalVotes: rawStats.currentNonVote.totalVotes,
          newPages: Math.max(0, rawStats.currentNonVote.newPages - (1 - alpha) * transitionDayNonVote.newPages),
          deletedPages: Math.max(0, rawStats.currentNonVote.deletedPages - (1 - alpha) * transitionDayNonVote.deletedPages),
        };
        const interpolatedVote: CategoryWindowStats = {
          revisions: rawStats.currentVote.revisions,
          votesUp: Math.max(0, rawStats.currentVote.votesUp - (1 - alpha) * transitionDayVote.votesUp),
          votesDown: Math.max(0, rawStats.currentVote.votesDown - (1 - alpha) * transitionDayVote.votesDown),
          totalVotes: Math.max(0, rawStats.currentVote.totalVotes - (1 - alpha) * transitionDayVote.totalVotes),
          newPages: 0,
          deletedPages: 0,
        };

        const rawSignal = this.computeSignalsFromStats(
          category,
          interpolatedNonVote,
          interpolatedVote,
          rawStats.pageCountStart,
          rawStats.baselineRev,
          rawStats.baselineVotesTotal,
          rawStats.baselineApproval,
          rawStats.baselineNet,
          rawStats.baselineDelRate,
        );
        rawSignals.set(category, rawSignal);
      }

      const overallSignal = rawSignals.get('OVERALL');
      if (!overallSignal) continue;
      const offsetBucket = weeklyOffsetBucket(asOfTs);

      for (const category of CATEGORY_LIST) {
        const rawSignal = rawSignals.get(category);
        if (!rawSignal) continue;

        const xRev = category === 'OVERALL'
          ? rawSignal.dRev
          : rawSignal.dRev - INFLATION_ALPHA * overallSignal.dRev;
        const xVotes = category === 'OVERALL'
          ? rawSignal.dVotesTotal
          : rawSignal.dVotesTotal - INFLATION_ALPHA * overallSignal.dVotesTotal;
        const xNet = category === 'OVERALL'
          ? rawSignal.dNet
          : rawSignal.dNet - INFLATION_ALPHA * overallSignal.dNet;
        const xSent = category === 'OVERALL'
          ? rawSignal.dSentiment
          : rawSignal.dSentiment - INFLATION_ALPHA * overallSignal.dSentiment;
        const xDelRate = category === 'OVERALL'
          ? rawSignal.dDelRate
          : rawSignal.dDelRate - INFLATION_ALPHA * overallSignal.dDelRate;

        const zRev = clamp(xRev / REV_SCALE, -Z_CLAMP, Z_CLAMP);
        const zVotes = clamp(xVotes / VOTES_SCALE, -Z_CLAMP, Z_CLAMP);
        const zNet = clamp(xNet / NET_SCALE, -Z_CLAMP, Z_CLAMP);
        const zSent = clamp(xSent / SENTIMENT_SCALE, -Z_CLAMP, Z_CLAMP);
        const zDelRate = clamp(xDelRate / DEL_RATE_SCALE, -Z_CLAMP, Z_CLAMP);

        const shrinkVote = Math.sqrt(rawSignal.voteCount / (rawSignal.voteCount + VOTE_K));
        const shrinkSent = Math.sqrt(rawSignal.voteCount / (rawSignal.voteCount + SENTIMENT_K));
        const zVotesEff = zVotes * shrinkVote;
        const zSentEff = zSent * shrinkSent;

        const scoreSignalRaw =
          (WEIGHT_REV * zRev)
          + (WEIGHT_VOTES * zVotesEff)
          + (WEIGHT_NET * zNet)
          + (SENTIMENT_WEIGHT * zSentEff)
          - (DEL_RATE_PENALTY * zDelRate);

        const categoryHistory = scoreHistory.get(category) ?? new Map<number, number[]>();
        const offsetHistory = categoryHistory.get(offsetBucket) ?? [];
        let scoreRef = 0;
        if (offsetHistory.length >= DRIFT_MIN_HISTORY_WEEKS) {
          scoreRef = median(offsetHistory);
        } else {
          // 该小时桶样本不足时，回退到该类目全部桶的池化中位数，
          // 避免上线初期出现长达数周的"零修正"空窗
          const pooled: number[] = [];
          for (const values of categoryHistory.values()) {
            pooled.push(...values);
          }
          if (pooled.length >= DRIFT_FALLBACK_MIN_SAMPLES) {
            scoreRef = median(pooled);
          }
        }
        const driftBeta = category === 'OVERALL'
          ? DRIFT_BETA_OVERALL
          : category === 'TRANSLATION'
            ? DRIFT_BETA_TRANSLATION
            : DRIFT_BETA_OTHERS;

        // 这些列在两套口径下都要写：scoreRef=实际扣减量；scoreProvisional=进价格的 score；
        // crowdDrag=观测/0；noise=随机增量/确定性噪声；indexMark=最终价格。
        let storeScoreRef: number;
        let storeScoreProvisional: number;
        let storeIndexMark: number;
        let storeCrowdDrag: number;
        let storeNoise: number;

        if (V4_ENABLED) {
          // ─── v4 增量驱动（链式连续） ───
          // drift 季节/趋势分解：只去周内季节形态，几乎保留品类自身水平/趋势
          let levelRef = 0;
          {
            const pooled: number[] = [];
            for (const values of categoryHistory.values()) pooled.push(...values);
            if (pooled.length >= DRIFT_FALLBACK_MIN_SAMPLES) levelRef = median(pooled);
          }
          const seasonalRef = offsetHistory.length >= DRIFT_MIN_HISTORY_WEEKS
            ? median(offsetHistory) - levelRef
            : 0;
          const betaSeas = category === 'OVERALL' ? V4_BETA_SEAS_OVERALL : V4_BETA_SEAS_OTHER;
          // early-week blend：周初用上周收盘 raw ramp-in，消周一信号空窗。
          // prevCloseRaw 懒加载：正常 hourly run 通常只生成当前小时、不会生成上周收盘 tick，
          // 故内存 Map 多为空，须从 DB 读 (< 本周一的最近 tick 的 genuine score_signal_raw)，
          // 否则每周前 72h 被错误地拉向 0（Codex review P2）。
          let prevCloseRaw = lastCloseRawByCategory.get(category);
          if (prevCloseRaw == null) {
            const prevWeekClose = await this.prisma.categoryIndexTick.findFirst({
              where: { category, asOfTs: { lt: weekStart } },
              orderBy: { asOfTs: 'desc' },
              select: { scoreSignalRaw: true }
            });
            prevCloseRaw = prevWeekClose?.scoreSignalRaw != null ? Number(prevWeekClose.scoreSignalRaw) : 0;
            lastCloseRawByCategory.set(category, prevCloseRaw);
          }
          const weekProgress = clamp(offsetBucket / V4_EARLY_WEEK_HOURS, 0, 1);
          const rawEff = weekProgress * scoreSignalRaw + (1 - weekProgress) * prevCloseRaw;
          const scoreCorrected = clamp(
            rawEff - betaSeas * seasonalRef - V4_BETA_LEVEL * levelRef,
            -V4_SCORE_CLAMP, V4_SCORE_CLAMP
          );
          // 链式：上一 tick 价格（首值懒加载自 DB 中 < asOfTs 的最近 tick；只读，不重写历史）
          let lastIndex = lastIndexByCategory.get(category);
          let lastIndexTs = lastIndexTsByCategory.get(category);
          if (lastIndex == null) {
            const prev = await this.prisma.categoryIndexTick.findFirst({
              where: { category, asOfTs: { lt: asOfTs } },
              orderBy: { asOfTs: 'desc' },
              select: { indexMark: true, asOfTs: true }
            });
            lastIndex = prev?.indexMark ? Number(prev.indexMark) : INDEX_BASE;
            lastIndexTs = prev?.asOfTs ? new Date(prev.asOfTs).getTime() : undefined;
          }
          if (!(lastIndex > 0)) lastIndex = INDEX_BASE;
          // gap 检测：上一价格须恰为 asOfTs-1h；否则（job 中断/回填窗截断导致链断）本 tick 视为
          // 重启锚点（dlog=0、价格保持上一收盘），并告警；缺口不回填——gap 期间无数据可生成，
          // 强行用单小时增量链接会把数天跨度压成一步、产生 stale 价格（Codex review P2）。
          const isRestart = !(lastIndexTs != null && lastIndexTs === asOfTs.getTime() - HOUR_MS);
          if (isRestart) {
            console.warn(
              `[CategoryIndexTickJob] ⚠️ v4 chain restart for ${category}: prev tick ts=`
              + `${lastIndexTs != null ? new Date(lastIndexTs).toISOString() : 'none'} ≠ `
              + `${new Date(asOfTs.getTime() - HOUR_MS).toISOString()}；价格保持上一收盘，缺口未回填。`
            );
          }
          // 随机层：OU 卷积纯函数的逐时增量（连续、无周一跳、可复现）
          const absHour = Math.floor(asOfTs.getTime() / HOUR_MS);
          const stochIncr = v4OuLevel(category, absHour) - v4OuLevel(category, absHour - 1);
          // 弱公允值锚增量：F 随基本面浮动，仅在价格远离公允值时温和回拉
          const fairValue = Math.log(INDEX_BASE) + V4_FAIR_GAMMA * levelRef;
          const anchorIncr = (V4_ANCHOR_LAMBDA / (7 * 24)) * (fairValue - Math.log(lastIndex));
          // 价格（增量驱动）：基本面 drift + 随机增量 + 弱锚增量。
          // 周一 00:00（周开盘）或链重启（gap）时强制 dlog=0 → 价格保持上一收盘，严格保持
          // "下周开盘=本周收盘"不变量；score/noise 同置 0 使审计列与 ForecastJob 口径一致
          // （Codex review P2：价格未动则 score/noise 也应为 0；周开盘丢弃该小时增量，影响 1/168 无感）。
          const isWeekOpen = offsetBucket === 0;
          const zeroMove = isWeekOpen || isRestart;
          const dlog = zeroMove
            ? 0
            : V4_K_FUND * scoreCorrected + stochIncr + anchorIncr;
          storeIndexMark = Number((lastIndex * Math.exp(dlog)).toFixed(6));
          storeScoreRef = betaSeas * seasonalRef + V4_BETA_LEVEL * levelRef;
          storeScoreProvisional = zeroMove ? 0 : scoreCorrected;
          storeCrowdDrag = 0; // v4 P0：crowd_drag 不计入价格
          storeNoise = zeroMove ? 0 : stochIncr;
        } else {
          // ─── v3 原逻辑（开关关时行为完全不变） ───
          const rawScoreProvisional = clamp(scoreSignalRaw - driftBeta * scoreRef, -SCORE_CLAMP, SCORE_CLAMP);

          // Crowd drag: reduce price push when one side is over-concentrated
          const crowdDrag = this.computeCrowdDrag(category, marginSnapshot);
          const rawScoreWithDrag = clamp(rawScoreProvisional - crowdDrag, -SCORE_CLAMP, SCORE_CLAMP);

          // Micro signal: intra-day price movement from real-time activity
          const microScore = this.computeMicroSignal(
            asOfTs, category,
            revWindow.get(category) ?? 0,
            recentForumCount,
            microBaselines,
            rawSignal.dVotesTotal
          );

          const scoreWithMicro = rawScoreWithDrag + microScore;
          // 周日 23:00 的收盘 tick 决定整周跨周复利因子：
          // 只保留周度信号（raw − β×ref），剔除 crowdDrag 与 micro 这两个
          // 日内/持仓信号（v3 前它们被永久积分进价格，形成可被集体押注
          // 方向套利的价格税），并用更紧的 CARRY_CLAMP 限制单周携带幅度。
          // crowd_drag 列仍照实记录观测值，仅不参与收盘 score。
          const isWeekClose = offsetBucket === WEEK_CLOSE_OFFSET;
          const scoreProvisional = asOfTs.getTime() === weekStart.getTime()
            ? 0
            : isWeekClose
              ? clamp(scoreSignalRaw - driftBeta * scoreRef, -CARRY_CLAMP, CARRY_CLAMP)
              : clamp(scoreWithMicro, -SCORE_CLAMP, SCORE_CLAMP);
          const weekKey = `${category}:${weekStart.toISOString()}`;

          let indexOpen = weekOpenCache.get(weekKey);
          if (indexOpen == null) {
            const latestAtWeekStart = await this.prisma.categoryIndexTick.findFirst({
              where: {
                category,
                asOfTs: { lte: weekStart }
              },
              orderBy: { asOfTs: 'desc' },
              select: { asOfTs: true, indexMark: true }
            });
            if (latestAtWeekStart
              && new Date(latestAtWeekStart.asOfTs).getTime() < weekStart.getTime() - HOUR_MS) {
              // 回填窗口截断等原因导致上周收盘 tick 缺失，跨周复利链在此断裂，
              // 退化为以最近可用 tick 作开盘。保持生成（市场不停摆）但需告警人工核查。
              console.warn(
                `[CategoryIndexTickJob] ⚠️ week open chain broken for ${category}: `
                + `weekStart=${weekStart.toISOString()}, nearest tick=${new Date(latestAtWeekStart.asOfTs).toISOString()}`
              );
            }
            indexOpen = latestAtWeekStart?.indexMark ? Number(latestAtWeekStart.indexMark) : INDEX_BASE;
            weekOpenCache.set(weekKey, indexOpen);
          }

          // 软锚点：以周内线性 ramp 的形式把对数偏差按 φ/周 拉回 INDEX_BASE。
          // offsetBucket=0（周一 00:00）时为 0，保证 indexOpen(next)=indexClose(prev)
          // 强约束不被破坏；收盘 tick 携带满额锚力进入下周开盘。
          const anchorTerm = indexOpen > 0
            ? (offsetBucket / WEEK_CLOSE_OFFSET) * ANCHOR_PHI_WEEKLY * Math.log(INDEX_BASE / indexOpen)
            : 0;
          const baseIndexMark = indexOpen * Math.exp(INDEX_K * scoreProvisional + anchorTerm);
          // 周一 00:00 禁用 noise：score=0 且 anchorTerm=0，indexMark 必须严格等于
          // 上周收盘，否则"下周开盘=本周收盘"约束被噪声破坏（后续小时的进程会以
          // 带噪的周一 tick 作为本周开盘）。
          const noise = asOfTs.getTime() === weekStart.getTime()
            ? 0
            : this.deterministicNoise(category, asOfTs, NOISE_AMPLITUDE);
          storeIndexMark = Number((baseIndexMark * (1 + noise)).toFixed(6));
          storeScoreRef = scoreRef;
          storeScoreProvisional = scoreProvisional;
          storeCrowdDrag = crowdDrag;
          storeNoise = noise;
        }

        const voteCutoffDate = utcDateOnlyFromUtc8Day(startOfUtc8Day(addUtc8Days(asOfTs, -1)));

        try {
          await this.prisma.categoryIndexTick.create({
            data: {
              category,
              asOfTs,
              watermarkTs,
              voteCutoffDate,
              voteRuleVersion: V4_ENABLED ? V4_TICK_RULE_VERSION : TICK_RULE_VERSION,
              scoreSignalRaw: new Prisma.Decimal(scoreSignalRaw.toFixed(8)),
              scoreRef: new Prisma.Decimal(storeScoreRef.toFixed(8)),
              scoreProvisional: new Prisma.Decimal(storeScoreProvisional.toFixed(8)),
              indexMark: new Prisma.Decimal(storeIndexMark.toFixed(6)),
              crowdDrag: new Prisma.Decimal(storeCrowdDrag.toFixed(8)),
              noise: new Prisma.Decimal(storeNoise.toFixed(8))
            }
          });
          generated += 1;
          if (!firstGenerated || asOfTs.getTime() < firstGenerated.getTime()) {
            firstGenerated = asOfTs;
          }
          if (!lastGenerated || asOfTs.getTime() > lastGenerated.getTime()) {
            lastGenerated = asOfTs;
          }

          // v4：链式状态推进（成功落库后才更新，与 P2002 跳过语义一致）
          if (V4_ENABLED) {
            lastIndexByCategory.set(category, storeIndexMark);
            lastIndexTsByCategory.set(category, asOfTs.getTime());
            if (offsetBucket === WEEK_CLOSE_OFFSET) lastCloseRawByCategory.set(category, scoreSignalRaw);
          }

          // drift 历史窗口与 loadScoreHistoryByOffset 同口径：存修正前的 raw 信号。
          // 仅在 create 成功后推进——P2002（该小时已有 tick）时 DB 行已在加载时
          // 计入历史，再 push 会造成同一小时重复样本。
          offsetHistory.push(scoreSignalRaw);
          if (offsetHistory.length > SCORE_HISTORY_WINDOW_PER_OFFSET) {
            offsetHistory.splice(0, offsetHistory.length - SCORE_HISTORY_WINDOW_PER_OFFSET);
          }
          categoryHistory.set(offsetBucket, offsetHistory);
          scoreHistory.set(category, categoryHistory);
        } catch (error) {
          if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
            throw error;
          }
          // v4：该 tick 已存在（backfill 重叠），清除链式缓存 → 下一小时从 DB 重新读取真实上一价格，
          // 避免把"跳过的小时"误当作链式前值。绝不覆盖已存在 tick。
          if (V4_ENABLED) {
            lastIndexByCategory.delete(category);
            lastIndexTsByCategory.delete(category);
            // 该 tick 已存在：上周收盘 raw 缓存也清除，避免下周前 72h blend 用到过期值（Claude review）
            if (offsetBucket === WEEK_CLOSE_OFFSET) lastCloseRawByCategory.delete(category);
          }
        }
      }
    }

    await this.touchTaskWatermark(lastGenerated ?? latestTick?.asOfTs ?? null);

    return {
      generated,
      fromAsOfTs: firstGenerated?.toISOString() ?? null,
      toAsOfTs: lastGenerated?.toISOString() ?? null,
      sourceWatermarkTs: sourceWatermark?.toISOString() ?? null
    };
  }

  private async loadCrowdMarginSnapshot(): Promise<Map<string, CategoryMarginSnapshot>> {
    const output = new Map<string, CategoryMarginSnapshot>();
    if (!this.userDbUrl) return output;

    const pool = new pg.Pool({ connectionString: this.userDbUrl, max: 1 });
    try {
      const { rows } = await pool.query<{ category: string; longMargin: string; shortMargin: string }>(`
        WITH opens AS (
          SELECT
            metadata->>'positionId' AS pos_id,
            metadata->>'contractId' AS contract,
            metadata->>'side' AS side,
            (metadata->>'margin')::int AS margin
          FROM "GachaLedgerEntry"
          WHERE reason = 'MARKET_POSITION_OPEN'
            AND "createdAt" >= NOW() - INTERVAL '45 days'
        ),
        settles AS (
          SELECT DISTINCT metadata->>'positionId' AS pos_id
          FROM "GachaLedgerEntry"
          WHERE reason = 'MARKET_POSITION_SETTLE'
            AND "createdAt" >= NOW() - INTERVAL '45 days'
        )
        SELECT
          o.contract AS category,
          SUM(CASE WHEN o.side = 'LONG' THEN o.margin ELSE 0 END)::int AS "longMargin",
          SUM(CASE WHEN o.side = 'SHORT' THEN o.margin ELSE 0 END)::int AS "shortMargin"
        FROM opens o
        LEFT JOIN settles s ON o.pos_id = s.pos_id
        WHERE s.pos_id IS NULL
        GROUP BY o.contract
      `);
      for (const row of rows) {
        output.set(row.category, {
          category: row.category,
          longMargin: Number(row.longMargin) || 0,
          shortMargin: Number(row.shortMargin) || 0
        });
      }
    } catch (err) {
      console.warn('[CategoryIndexTickJob] loadCrowdMarginSnapshot failed, proceeding with zero drag:', err);
    } finally {
      await pool.end();
    }
    return output;
  }

  private computeCrowdDrag(
    category: MarketCategory,
    marginSnapshot: Map<string, CategoryMarginSnapshot>
  ): number {
    const snap = marginSnapshot.get(category);
    if (!snap) return 0;
    const netImbalance = snap.longMargin - snap.shortMargin;
    const totalExposure = snap.longMargin + snap.shortMargin;
    if (totalExposure <= 0) return 0;
    return CROWD_DRAG_K * netImbalance / (totalExposure + CROWD_LIQUIDITY_BASE);
  }

  private deterministicNoise(category: string, asOfTs: Date, amplitude: number): number {
    const seed = `${category}:${asOfTs.getTime()}`;
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
    }
    const normalized = ((hash & 0x7fffffff) % 10000) / 10000 * 2 - 1;
    return amplitude * normalized;
  }

  private async resolveSourceWatermark() {
    const rows = await this.prisma.analysisWatermark.findMany({
      where: {
        task: { in: SOURCE_WATERMARK_TASKS }
      },
      select: { cursorTs: true }
    });
    const timestamps = rows
      .map((item) => item.cursorTs?.getTime() ?? null)
      .filter((value): value is number => value != null && Number.isFinite(value));
    if (timestamps.length === 0) {
      return null;
    }
    return new Date(Math.min(...timestamps));
  }

  /**
   * Drift ref 历史必须取 scoreSignalRaw（修正前的原始信号）。
   * v3 前取的是 scoreProvisional（修正后值），自引用导致稳态残余偏差为
   * b/(1+β) 而非 (1-β)·b —— OVERALL β=0.95 实际只消掉约一半偏差，是
   * 2026-02~06 全线长跌的主因之一。
   *
   * 口径换算：旧版（LEGACY_TICK_RULE_VERSION）子类行的 raw 按旧
   * INFLATION_ALPHA=0.5 写入，换算到新口径为
   *   raw_v3 = raw_old − (1.0−0.5) × overall_raw(同时刻)
   * （OVERALL 自身无 alpha 项，新旧口径一致，可直接作参照）。
   * 缺少同时刻 OVERALL 参照的旧行无法换算，丢弃该样本。
   */
  private async loadScoreHistoryByOffset() {
    const output = new Map<MarketCategory, CategoryOffsetHistory>();
    const totalTake = DRIFT_WINDOW_WEEKS * 7 * 24;
    const pushSample = (byOffset: Map<number, number[]>, ts: Date, value: number) => {
      const bucket = weeklyOffsetBucket(ts);
      const values = byOffset.get(bucket) ?? [];
      values.push(value);
      if (values.length > SCORE_HISTORY_WINDOW_PER_OFFSET) {
        values.splice(0, values.length - SCORE_HISTORY_WINDOW_PER_OFFSET);
      }
      byOffset.set(bucket, values);
    };

    const overallRows = await this.prisma.categoryIndexTick.findMany({
      where: { category: 'OVERALL' },
      select: { asOfTs: true, scoreSignalRaw: true },
      orderBy: { asOfTs: 'desc' },
      take: totalTake
    });
    const overallRawByTs = new Map<number, number>();
    {
      const byOffset = new Map<number, number[]>();
      for (const row of overallRows.reverse()) {
        const value = Number(row.scoreSignalRaw);
        if (!Number.isFinite(value)) continue;
        const ts = new Date(row.asOfTs);
        overallRawByTs.set(ts.getTime(), value);
        pushSample(byOffset, ts, value);
      }
      output.set('OVERALL', byOffset);
    }

    for (const category of CATEGORY_LIST) {
      if (category === 'OVERALL') continue;
      const rows = await this.prisma.categoryIndexTick.findMany({
        where: { category },
        select: { asOfTs: true, scoreSignalRaw: true, voteRuleVersion: true },
        orderBy: { asOfTs: 'desc' },
        take: totalTake
      });

      const byOffset = new Map<number, number[]>();
      for (const row of rows.reverse()) {
        let value = Number(row.scoreSignalRaw);
        if (!Number.isFinite(value)) continue;
        const ts = new Date(row.asOfTs);
        if (row.voteRuleVersion === LEGACY_TICK_RULE_VERSION) {
          const overallRaw = overallRawByTs.get(ts.getTime());
          if (overallRaw == null) continue;
          value -= (INFLATION_ALPHA - LEGACY_INFLATION_ALPHA) * overallRaw;
        }
        pushSample(byOffset, ts, value);
      }
      output.set(category, byOffset);
    }

    return output;
  }

  private async queryRawStats(
    category: MarketCategory,
    weekStart: Date,
    voteEnd: Date,
    nonVoteEnd: Date
  ): Promise<RawStatsQueryResult> {
    // Current week stats
    const [currentNonVoteStats, currentVoteStats, currentPageCountStart] = await Promise.all([
      this.queryWindowStats(category, weekStart, nonVoteEnd, { includeContentMetrics: true }),
      this.queryWindowStats(category, weekStart, voteEnd, { includeContentMetrics: false }),
      this.queryLivePageCountAt(category, weekStart)
    ]);

    // Baseline: median of the past BASELINE_MEDIAN_WEEKS weeks at the same relative offset
    const histNonVotePromises: Promise<CategoryWindowStats>[] = [];
    const histVotePromises: Promise<CategoryWindowStats>[] = [];
    const histPageCountPromises: Promise<number>[] = [];
    for (let w = 1; w <= BASELINE_MEDIAN_WEEKS; w++) {
      const hWeekStart = addUtc8Days(weekStart, -7 * w);
      const hNonVoteEnd = addUtc8Days(nonVoteEnd, -7 * w);
      const hVoteEnd = addUtc8Days(voteEnd, -7 * w);
      histNonVotePromises.push(this.queryWindowStats(category, hWeekStart, hNonVoteEnd, { includeContentMetrics: true }));
      histVotePromises.push(this.queryWindowStats(category, hWeekStart, hVoteEnd, { includeContentMetrics: false }));
      histPageCountPromises.push(this.queryLivePageCountAt(category, hWeekStart));
    }
    const [histNonVote, histVote, histPageCount] = await Promise.all([
      Promise.all(histNonVotePromises),
      Promise.all(histVotePromises),
      Promise.all(histPageCountPromises)
    ]);

    const baselineRev = median(histNonVote.map(s => safeLog1p(s.revisions)));
    const baselineVotesTotal = median(histVote.map(s => safeLog1p(s.totalVotes)));
    const baselineApproval = median(histVote.map(s => {
      const up = s.votesUp;
      const down = s.votesDown;
      return logit((up + SENTIMENT_ALPHA) / (Math.max(0, up + down) + SENTIMENT_ALPHA + SENTIMENT_BETA));
    }));
    const baselineNet = median(histNonVote.map(s => signedLog1p(s.newPages - s.deletedPages)));
    const baselineDelRate = median(histNonVote.map((s, i) => {
      return safeLog1p(s.deletedPages / Math.max(1, histPageCount[i]));
    }));

    return {
      currentNonVote: currentNonVoteStats,
      currentVote: currentVoteStats,
      pageCountStart: currentPageCountStart,
      baselineRev,
      baselineVotesTotal,
      baselineApproval,
      baselineNet,
      baselineDelRate,
    };
  }

  private computeSignalsFromStats(
    category: MarketCategory,
    currentNonVote: CategoryWindowStats,
    currentVote: CategoryWindowStats,
    pageCountStart: number,
    baselineRev: number,
    baselineVotesTotal: number,
    baselineApproval: number,
    baselineNet: number,
    baselineDelRate: number
  ): RawSignal {
    const dRev = safeLog1p(currentNonVote.revisions) - baselineRev;
    const dVotesTotal = safeLog1p(currentVote.totalVotes) - baselineVotesTotal;
    const approvalNow = (
      currentVote.votesUp + SENTIMENT_ALPHA
    ) / (
      Math.max(0, currentVote.votesUp + currentVote.votesDown) + SENTIMENT_ALPHA + SENTIMENT_BETA
    );
    const dSentiment = logit(approvalNow) - baselineApproval;

    const netNow = currentNonVote.newPages - currentNonVote.deletedPages;
    const dNet = signedLog1p(netNow) - baselineNet;

    const delRateNow = currentNonVote.deletedPages / Math.max(1, pageCountStart);
    const dDelRate = safeLog1p(delRateNow) - baselineDelRate;

    return {
      category,
      dRev,
      dVotesTotal,
      dSentiment,
      dNet,
      dDelRate,
      voteCount: Math.max(0, currentVote.totalVotes),
    };
  }

  // ─── Micro-Signal Layer Methods ───

  private async loadMicroBaselines(): Promise<MicroBaselineContext> {
    const now = new Date();
    const baselineEnd = startOfUtc8Day(now);
    const baselineStart = addUtc8Days(baselineEnd, -(MICRO_BASELINE_WEEKS * 7));
    const baselineStartTs = utcNaiveTimestampSql(baselineStart);
    const baselineEndTs = utcNaiveTimestampSql(baselineEnd);

    const revisionBaselines = new Map<MarketCategory, HourlyBaseline>();
    let revisionDataDays = 0;

    for (const category of CATEGORY_LIST) {
      const predicate = categoryPredicateSql(category);
      const rows = await this.prisma.$queryRaw<Array<{
        dow: number;
        hour: number;
        median_count: number;
      }>>(Prisma.sql`
        WITH hourly AS (
          SELECT
            EXTRACT(DOW FROM r.timestamp + INTERVAL '8 hours')::int AS dow,
            EXTRACT(HOUR FROM r.timestamp + INTERVAL '8 hours')::int AS hour,
            DATE(r.timestamp + INTERVAL '8 hours') AS day,
            COUNT(*) AS cnt
          FROM "Revision" r
          JOIN "PageVersion" pv ON r."pageVersionId" = pv.id
          WHERE r.timestamp >= ${baselineStartTs}
            AND r.timestamp < ${baselineEndTs}
            AND ${predicate}
          GROUP BY 1, 2, 3
        )
        SELECT dow, hour,
          PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cnt)::double precision AS median_count
        FROM hourly
        GROUP BY dow, hour
      `);

      const baseline = new Map<number, number>();
      for (const row of rows) {
        baseline.set(Number(row.dow) * 24 + Number(row.hour), Number(row.median_count) || 0);
      }
      revisionBaselines.set(category, baseline);

      // Use OVERALL's data days as the global indicator
      if (category === 'OVERALL') {
        const dayCountRows = await this.prisma.$queryRaw<Array<{ data_days: number }>>(Prisma.sql`
          SELECT COUNT(DISTINCT DATE(r.timestamp + INTERVAL '8 hours'))::int AS data_days
          FROM "Revision" r
          WHERE r.timestamp >= ${baselineStartTs}
            AND r.timestamp < ${baselineEndTs}
        `);
        revisionDataDays = Number(dayCountRows[0]?.data_days ?? 0);
      }
    }

    // Forum baselines (global, not per-category)
    const forumRows = await this.prisma.$queryRaw<Array<{
      dow: number;
      hour: number;
      median_count: number;
    }>>(Prisma.sql`
      WITH hourly AS (
        SELECT
          EXTRACT(DOW FROM "createdAt" + INTERVAL '8 hours')::int AS dow,
          EXTRACT(HOUR FROM "createdAt" + INTERVAL '8 hours')::int AS hour,
          DATE("createdAt" + INTERVAL '8 hours') AS day,
          COUNT(*) AS cnt
        FROM "ForumPost"
        WHERE "createdAt" >= ${baselineStartTs}
          AND "createdAt" < ${baselineEndTs}
          AND "createdAt" IS NOT NULL
        GROUP BY 1, 2, 3
      )
      SELECT dow, hour,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY cnt)::double precision AS median_count
      FROM hourly
      GROUP BY dow, hour
    `);

    const forumBaseline = new Map<number, number>();
    for (const row of forumRows) {
      forumBaseline.set(Number(row.dow) * 24 + Number(row.hour), Number(row.median_count) || 0);
    }

    const forumDayCountRows = await this.prisma.$queryRaw<Array<{ data_days: number }>>(Prisma.sql`
      SELECT COUNT(DISTINCT DATE("createdAt" + INTERVAL '8 hours'))::int AS data_days
      FROM "ForumPost"
      WHERE "createdAt" >= ${baselineStartTs}
        AND "createdAt" < ${baselineEndTs}
        AND "createdAt" IS NOT NULL
    `);
    const forumDataDays = Number(forumDayCountRows[0]?.data_days ?? 0);

    return {
      revision: revisionBaselines,
      forum: forumBaseline,
      revisionDataDays,
      forumDataDays,
    };
  }

  private async queryRecentRevisionCount(
    start: Date, end: Date, category: MarketCategory
  ): Promise<number> {
    const startTs = utcNaiveTimestampSql(start);
    const endTs = utcNaiveTimestampSql(end);
    const predicate = categoryPredicateSql(category);
    const rows = await this.prisma.$queryRaw<Array<{ cnt: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS cnt
      FROM "Revision" r
      JOIN "PageVersion" pv ON r."pageVersionId" = pv.id
      WHERE r.timestamp >= ${startTs}
        AND r.timestamp < ${endTs}
        AND pv."isDeleted" = false
        AND ${predicate}
    `);
    return Number(rows[0]?.cnt ?? 0);
  }

  private async queryRecentForumPostCount(start: Date, end: Date): Promise<number> {
    const startTs = utcNaiveTimestampSql(start);
    const endTs = utcNaiveTimestampSql(end);
    const rows = await this.prisma.$queryRaw<Array<{ cnt: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS cnt
      FROM "ForumPost"
      WHERE "createdAt" >= ${startTs}
        AND "createdAt" < ${endTs}
        AND "createdAt" IS NOT NULL
    `);
    return Number(rows[0]?.cnt ?? 0);
  }

  private getWindowBaseline(
    asOfTs: Date, windowHours: number, baseline?: HourlyBaseline
  ): number {
    if (!baseline) return 0;
    let sum = 0;
    for (let h = 0; h < windowHours; h++) {
      const ts = new Date(asOfTs.getTime() - h * HOUR_MS);
      const shifted = addUtc8Offset(ts);
      const dow = shifted.getUTCDay();
      const hour = shifted.getUTCHours();
      sum += baseline.get(dow * 24 + hour) ?? 0;
    }
    return sum;
  }

  private getDailyRevisionBaseline(
    asOfTs: Date, baseline?: HourlyBaseline
  ): number {
    if (!baseline) return 1;
    const shifted = addUtc8Offset(asOfTs);
    const dow = shifted.getUTCDay();
    let sum = 0;
    for (let h = 0; h < 24; h++) {
      sum += baseline.get(dow * 24 + h) ?? 0;
    }
    return Math.max(1, sum);
  }

  private computeMicroSignal(
    asOfTs: Date,
    category: MarketCategory,
    recentRevCount: number,
    recentForumCount: number,
    baselines: MicroBaselineContext,
    dVotesTotal: number
  ): number {
    // 1. Revision deviation
    const revBaseline = this.getWindowBaseline(
      asOfTs, MICRO_REV_WINDOW_HOURS, baselines.revision.get(category)
    );
    const revDev = baselines.revisionDataDays >= MICRO_MIN_BASELINE_DAYS
      ? (safeLog1p(recentRevCount) - safeLog1p(revBaseline)) / REV_MICRO_SCALE
      : 0;

    // 2. Forum deviation
    const forumBaseline = this.getWindowBaseline(
      asOfTs, MICRO_FORUM_WINDOW_HOURS, baselines.forum
    );
    const forumDev = baselines.forumDataDays >= MICRO_MIN_BASELINE_DAYS
      ? (safeLog1p(recentForumCount) - safeLog1p(forumBaseline)) / FORUM_MICRO_SCALE
      : 0;

    // 3. Vote amplitude modulation
    const voteAmp = 1 + VOTE_AMP_K * Math.tanh(Math.abs(dVotesTotal));

    // 4. Combine
    return voteAmp * (
      REV_MICRO_WEIGHT * clamp(revDev, -Z_CLAMP, Z_CLAMP)
      + FORUM_MICRO_WEIGHT * clamp(forumDev, -Z_CLAMP, Z_CLAMP)
    );
  }

  private async queryWindowStats(
    category: MarketCategory,
    startDate: Date,
    endDate: Date,
    options: { includeContentMetrics?: boolean } = {}
  ): Promise<CategoryWindowStats> {
    if (startDate.getTime() > endDate.getTime()) {
      return {
        revisions: 0,
        votesUp: 0,
        votesDown: 0,
        totalVotes: 0,
        newPages: 0,
        deletedPages: 0
      };
    }

    const predicate = categoryPredicateSql(category);
    const windowStartTs = startOfUtc8Day(startDate);
    const windowEndTsExclusive = addUtc8Days(startOfUtc8Day(endDate), 1);
    const includeContentMetrics = options.includeContentMetrics ?? true;

    const dailyRows = await this.prisma.$queryRaw<Array<{
      revisions: number | null;
      votes_up: number | null;
      votes_down: number | null;
      total_votes: number | null;
    }>>(Prisma.sql`
      SELECT
        COALESCE(SUM(pds.revisions), 0)::double precision AS revisions,
        COALESCE(SUM(pds.votes_up), 0)::double precision AS votes_up,
        COALESCE(SUM(pds.votes_down), 0)::double precision AS votes_down,
        COALESCE(SUM(pds.total_votes), 0)::double precision AS total_votes
      FROM "PageDailyStats" pds
      JOIN LATERAL (
        SELECT pv.tags
        FROM "PageVersion" pv
        WHERE pv."pageId" = pds."pageId"
          AND pv."isDeleted" = false
          AND pv."validFrom" <= (pds.date::timestamp + INTERVAL '1 day' - INTERVAL '8 hour')
          AND (pv."validTo" IS NULL OR pv."validTo" > (pds.date::timestamp + INTERVAL '1 day' - INTERVAL '8 hour'))
        ORDER BY pv."validFrom" DESC, pv.id DESC
        LIMIT 1
      ) pv ON TRUE
      WHERE pds.date >= ${startDate}::date
        AND pds.date <= ${endDate}::date
        AND ${predicate}
    `);
    const row = dailyRows[0];

    if (!includeContentMetrics) {
      return {
        revisions: Number(row?.revisions ?? 0) || 0,
        votesUp: Number(row?.votes_up ?? 0) || 0,
        votesDown: Number(row?.votes_down ?? 0) || 0,
        totalVotes: Number(row?.total_votes ?? 0) || 0,
        newPages: 0,
        deletedPages: 0
      };
    }

    const [newPageRows, deletedRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ count: number | null }>>(Prisma.sql`
        SELECT COUNT(*)::double precision AS count
        FROM "Page" p
        JOIN LATERAL (
          SELECT pv.tags, pv."isDeleted"
          FROM "PageVersion" pv
          WHERE pv."pageId" = p.id
            AND pv."validFrom" <= p."firstPublishedAt"
            AND (pv."validTo" IS NULL OR pv."validTo" > p."firstPublishedAt")
          ORDER BY pv."validFrom" DESC, pv.id DESC
          LIMIT 1
        ) pv ON TRUE
        WHERE p."firstPublishedAt" IS NOT NULL
          AND p."firstPublishedAt" >= ${windowStartTs}
          AND p."firstPublishedAt" < ${windowEndTsExclusive}
          AND pv."isDeleted" = false
          AND ${predicate}
      `),
      this.prisma.$queryRaw<Array<{ count: number | null }>>(Prisma.sql`
        SELECT COUNT(*)::double precision AS count
        FROM "PageVersion" pv
        WHERE pv."isDeleted" = true
          AND pv."validFrom" >= ${windowStartTs}
          AND pv."validFrom" < ${windowEndTsExclusive}
          AND EXISTS (
            SELECT 1
            FROM "PageVersion" prev_live
            WHERE prev_live."pageId" = pv."pageId"
              AND prev_live."validFrom" < pv."validFrom"
              AND prev_live."isDeleted" = false
            LIMIT 1
          )
          AND NOT EXISTS (
            SELECT 1
            FROM "PageVersion" prev_del
            WHERE prev_del."pageId" = pv."pageId"
              AND prev_del."validFrom" < pv."validFrom"
              AND prev_del."isDeleted" = true
          )
          AND ${predicate}
      `)
    ]);

    return {
      revisions: Number(row?.revisions ?? 0) || 0,
      votesUp: Number(row?.votes_up ?? 0) || 0,
      votesDown: Number(row?.votes_down ?? 0) || 0,
      totalVotes: Number(row?.total_votes ?? 0) || 0,
      newPages: Number(newPageRows[0]?.count ?? 0) || 0,
      deletedPages: Number(deletedRows[0]?.count ?? 0) || 0
    };
  }

  private async queryLivePageCountAt(category: MarketCategory, asOfTs: Date) {
    const predicate = categoryPredicateSql(category);
    const rows = await this.prisma.$queryRaw<Array<{ count: number | null }>>(Prisma.sql`
      SELECT COUNT(*)::double precision AS count
      FROM "Page" p
      JOIN LATERAL (
        SELECT pv.tags, pv."isDeleted"
        FROM "PageVersion" pv
        WHERE pv."pageId" = p.id
          AND pv."validFrom" <= ${asOfTs}
          AND (pv."validTo" IS NULL OR pv."validTo" > ${asOfTs})
        ORDER BY pv."validFrom" DESC, pv.id DESC
        LIMIT 1
      ) pv ON TRUE
      WHERE pv."isDeleted" = false
        AND ${predicate}
    `);
    return Number(rows[0]?.count ?? 0) || 0;
  }

  private async touchTaskWatermark(cursorTs: Date | null) {
    const existing = await this.prisma.analysisWatermark.findUnique({
      where: { task: TASK_NAME },
      select: { cursorTs: true }
    });
    await this.prisma.analysisWatermark.upsert({
      where: { task: TASK_NAME },
      update: {
        lastRunAt: new Date(),
        cursorTs: cursorTs ?? existing?.cursorTs ?? null
      },
      create: {
        task: TASK_NAME,
        lastRunAt: new Date(),
        cursorTs: cursorTs ?? null
      }
    });
  }
}

export async function runCategoryIndexTickJob(options: { forceFullBackfill?: boolean } = {}) {
  const job = new CategoryIndexTickJob();
  return job.run(options);
}
