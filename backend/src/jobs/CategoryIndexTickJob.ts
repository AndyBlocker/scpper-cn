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
const INFLATION_ALPHA = 0.5;

const DRIFT_WINDOW_WEEKS = 26;
const DRIFT_MIN_HISTORY_WEEKS = 8;
const DRIFT_BETA_OVERALL = 0.95;
const DRIFT_BETA_TRANSLATION = 0.7;
const DRIFT_BETA_OTHERS = 0.2;

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
        const scoreRef = offsetHistory.length >= DRIFT_MIN_HISTORY_WEEKS ? median(offsetHistory) : 0;
        const driftBeta = category === 'OVERALL'
          ? DRIFT_BETA_OVERALL
          : category === 'TRANSLATION'
            ? DRIFT_BETA_TRANSLATION
            : DRIFT_BETA_OTHERS;
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
        const scoreProvisional = asOfTs.getTime() === weekStart.getTime()
          ? 0
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
            select: { indexMark: true }
          });
          indexOpen = latestAtWeekStart?.indexMark ? Number(latestAtWeekStart.indexMark) : INDEX_BASE;
          weekOpenCache.set(weekKey, indexOpen);
        }

        const baseIndexMark = indexOpen * Math.exp(INDEX_K * scoreProvisional);
        const noise = this.deterministicNoise(category, asOfTs, NOISE_AMPLITUDE);
        const indexMark = Number((baseIndexMark * (1 + noise)).toFixed(6));
        const voteCutoffDate = utcDateOnlyFromUtc8Day(startOfUtc8Day(addUtc8Days(asOfTs, -1)));

        try {
          await this.prisma.categoryIndexTick.create({
            data: {
              category,
              asOfTs,
              watermarkTs,
              voteCutoffDate,
              voteRuleVersion: 'utc8-t+1-v1',
              scoreSignalRaw: new Prisma.Decimal(scoreSignalRaw.toFixed(8)),
              scoreRef: new Prisma.Decimal(scoreRef.toFixed(8)),
              scoreProvisional: new Prisma.Decimal(scoreProvisional.toFixed(8)),
              indexMark: new Prisma.Decimal(indexMark.toFixed(6)),
              crowdDrag: new Prisma.Decimal(crowdDrag.toFixed(8)),
              noise: new Prisma.Decimal(noise.toFixed(8))
            }
          });
          generated += 1;
          if (!firstGenerated || asOfTs.getTime() < firstGenerated.getTime()) {
            firstGenerated = asOfTs;
          }
          if (!lastGenerated || asOfTs.getTime() > lastGenerated.getTime()) {
            lastGenerated = asOfTs;
          }
        } catch (error) {
          if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
            throw error;
          }
        }

        offsetHistory.push(scoreProvisional);
        if (offsetHistory.length > SCORE_HISTORY_WINDOW_PER_OFFSET) {
          offsetHistory.splice(0, offsetHistory.length - SCORE_HISTORY_WINDOW_PER_OFFSET);
        }
        categoryHistory.set(offsetBucket, offsetHistory);
        scoreHistory.set(category, categoryHistory);
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

  private async loadScoreHistoryByOffset() {
    const output = new Map<MarketCategory, CategoryOffsetHistory>();
    const totalTake = DRIFT_WINDOW_WEEKS * 7 * 24;

    for (const category of CATEGORY_LIST) {
      const rows = await this.prisma.categoryIndexTick.findMany({
        where: { category },
        select: { asOfTs: true, scoreProvisional: true },
        orderBy: { asOfTs: 'desc' },
        take: totalTake
      });

      const byOffset = new Map<number, number[]>();
      for (const row of rows.reverse()) {
        const value = Number(row.scoreProvisional);
        if (!Number.isFinite(value)) continue;
        const bucket = weeklyOffsetBucket(new Date(row.asOfTs));
        const values = byOffset.get(bucket) ?? [];
        values.push(value);
        if (values.length > SCORE_HISTORY_WINDOW_PER_OFFSET) {
          values.splice(0, values.length - SCORE_HISTORY_WINDOW_PER_OFFSET);
        }
        byOffset.set(bucket, values);
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
