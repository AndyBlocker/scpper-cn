import { Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../utils/db-connection.js';

type MarketCategory = 'OVERALL' | 'TRANSLATION' | 'SCP' | 'TALE' | 'GOI' | 'WANDERERS';

type ForecastRunSummary = {
  upserted: number;
  fromAsOfTs: string | null;
  toAsOfTs: string | null;
  sourceTickTs: string | null;
};

type TickPoint = {
  asOfTs: Date;
  scoreProvisional: number;
  indexMark: number;
};

const CATEGORY_LIST: MarketCategory[] = [
  'OVERALL',
  'TRANSLATION',
  'SCP',
  'TALE',
  'GOI',
  'WANDERERS'
];

const TASK_NAME = 'category_index_forecast';
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const HOURLY_TICKS_PER_DAY = 24;
const DEFAULT_LOOKBACK_DAYS = 35;

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

function dayCloseTs(settleDay: Date) {
  return addUtc8Days(startOfUtc8Day(settleDay), 1);
}

function findLastTickAtOrBefore(ticks: TickPoint[], targetTs: Date) {
  if (!ticks.length) return null;
  let left = 0;
  let right = ticks.length - 1;
  let answer: TickPoint | null = null;
  const target = targetTs.getTime();

  while (left <= right) {
    const middle = Math.floor((left + right) / 2);
    const tick = ticks[middle]!;
    const value = tick.asOfTs.getTime();
    if (value <= target) {
      answer = tick;
      left = middle + 1;
    } else {
      right = middle - 1;
    }
  }
  return answer;
}

export class CategoryIndexForecastJob {
  private prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || getPrismaClient();
  }

  async run(options: { lookbackDays?: number } = {}): Promise<ForecastRunSummary> {
    const ready = await this.isForecastTableReady();
    if (!ready) {
      await this.touchTaskWatermark(null);
      return {
        upserted: 0,
        fromAsOfTs: null,
        toAsOfTs: null,
        sourceTickTs: null
      };
    }

    const nowAsOf = floorToUtc8Hour(new Date());
    const latestTick = await this.prisma.categoryIndexTick.findFirst({
      orderBy: { asOfTs: 'desc' },
      select: { asOfTs: true }
    });
    if (!latestTick?.asOfTs) {
      await this.touchTaskWatermark(null);
      return {
        upserted: 0,
        fromAsOfTs: null,
        toAsOfTs: null,
        sourceTickTs: null
      };
    }

    const sourceTickTs = floorToUtc8Hour(new Date(latestTick.asOfTs));
    const sourceUpperBound = minDate(sourceTickTs, nowAsOf);
    const maxSettleDay = addUtc8Days(startOfUtc8Day(sourceUpperBound), -1);

    const lookbackDays = Math.max(3, Math.min(180, Math.floor(options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS)));
    const startSettleDay = addUtc8Days(maxSettleDay, -(lookbackDays - 1));
    const earliestNeededCloseTs = dayCloseTs(addUtc8Days(startSettleDay, -1));
    const latestNeededCloseTs = dayCloseTs(maxSettleDay);
    if (latestNeededCloseTs.getTime() < earliestNeededCloseTs.getTime()) {
      await this.touchTaskWatermark(null);
      return {
        upserted: 0,
        fromAsOfTs: null,
        toAsOfTs: null,
        sourceTickTs: sourceTickTs.toISOString()
      };
    }

    let upserted = 0;
    let firstGenerated: Date | null = null;
    let lastGenerated: Date | null = null;

    for (const category of CATEGORY_LIST) {
      const anchor = await this.prisma.categoryIndexTick.findFirst({
        where: {
          category,
          asOfTs: { lte: earliestNeededCloseTs }
        },
        orderBy: { asOfTs: 'desc' },
        select: {
          asOfTs: true,
          scoreProvisional: true,
          indexMark: true
        }
      });
      const rows = await this.prisma.categoryIndexTick.findMany({
        where: {
          category,
          asOfTs: {
            gt: earliestNeededCloseTs,
            lte: latestNeededCloseTs
          }
        },
        orderBy: { asOfTs: 'asc' },
        select: {
          asOfTs: true,
          scoreProvisional: true,
          indexMark: true
        }
      });

      const points: TickPoint[] = [
        ...(anchor ? [anchor] : []),
        ...rows
      ].map((row) => ({
        asOfTs: new Date(row.asOfTs),
        scoreProvisional: Number(row.scoreProvisional),
        indexMark: Number(row.indexMark)
      })).filter((row) => (
        Number.isFinite(row.scoreProvisional)
        && Number.isFinite(row.indexMark)
        && row.indexMark > 0
      ));
      if (points.length === 0) continue;

      for (
        let settleDayTs = startSettleDay.getTime();
        settleDayTs <= maxSettleDay.getTime();
        settleDayTs += 24 * HOUR_MS
      ) {
        const settleDay = startOfUtc8Day(new Date(settleDayTs));
        const prevSettleDay = addUtc8Days(settleDay, -1);
        const prevCloseTs = dayCloseTs(prevSettleDay);
        const closeTs = dayCloseTs(settleDay);
        const prevTick = findLastTickAtOrBefore(points, prevCloseTs);
        const closeTick = findLastTickAtOrBefore(points, closeTs);
        if (!prevTick || !closeTick) {
          continue;
        }

        const prevScore = prevTick.scoreProvisional;
        const dayCloseScore = closeTick.scoreProvisional;
        const prevDayCloseIndex = prevTick.indexMark;
        const dayCloseIndex = closeTick.indexMark;
        if (!Number.isFinite(prevDayCloseIndex) || !Number.isFinite(dayCloseIndex) || prevDayCloseIndex <= 0 || dayCloseIndex <= 0) {
          continue;
        }
        const isStale = prevTick.asOfTs.getTime() < prevCloseTs.getTime() || closeTick.asOfTs.getTime() < closeTs.getTime();
        const dayStart = startOfUtc8Day(settleDay);
        const logRatio = Math.log(dayCloseIndex / prevDayCloseIndex);

        for (let hourOffset = 1; hourOffset <= HOURLY_TICKS_PER_DAY; hourOffset += 1) {
          const asOfTs = addUtc8Hours(dayStart, hourOffset);
          const u = hourOffset / HOURLY_TICKS_PER_DAY;
          const forecastScore = prevScore + (dayCloseScore - prevScore) * u;
          const forecastIndex = prevDayCloseIndex * Math.exp(logRatio * u);

          await this.prisma.$executeRaw(Prisma.sql`
            INSERT INTO "CategoryIndexForecastTick" (
              "category",
              "as_of_ts",
              "settle_day",
              "hour_offset",
              "forecast_score",
              "forecast_index",
              "day_close_score",
              "day_close_index",
              "prev_day_close_index",
              "is_stale"
            )
            VALUES (
              ${category},
              ${asOfTs},
              ${settleDay}::date,
              ${hourOffset},
              ${new Prisma.Decimal(forecastScore.toFixed(8))},
              ${new Prisma.Decimal(forecastIndex.toFixed(8))},
              ${new Prisma.Decimal(dayCloseScore.toFixed(8))},
              ${new Prisma.Decimal(dayCloseIndex.toFixed(8))},
              ${new Prisma.Decimal(prevDayCloseIndex.toFixed(8))},
              ${isStale}
            )
            ON CONFLICT ("category", "as_of_ts")
            DO UPDATE SET
              "settle_day" = EXCLUDED."settle_day",
              "hour_offset" = EXCLUDED."hour_offset",
              "forecast_score" = EXCLUDED."forecast_score",
              "forecast_index" = EXCLUDED."forecast_index",
              "day_close_score" = EXCLUDED."day_close_score",
              "day_close_index" = EXCLUDED."day_close_index",
              "prev_day_close_index" = EXCLUDED."prev_day_close_index",
              "is_stale" = EXCLUDED."is_stale"
          `);
          upserted += 1;
          if (!firstGenerated || asOfTs.getTime() < firstGenerated.getTime()) {
            firstGenerated = asOfTs;
          }
          if (!lastGenerated || asOfTs.getTime() > lastGenerated.getTime()) {
            lastGenerated = asOfTs;
          }
        }
      }
    }

    await this.touchTaskWatermark(lastGenerated ?? null);

    return {
      upserted,
      fromAsOfTs: firstGenerated?.toISOString() ?? null,
      toAsOfTs: lastGenerated?.toISOString() ?? null,
      sourceTickTs: sourceTickTs.toISOString()
    };
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
        cursorTs
      }
    });
  }

  private async isForecastTableReady() {
    const rows = await this.prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT to_regclass('public."CategoryIndexForecastTick"') IS NOT NULL AS "exists"
    `;
    return Boolean(rows[0]?.exists);
  }
}

export async function runCategoryIndexForecastJob(options: { lookbackDays?: number } = {}) {
  const job = new CategoryIndexForecastJob();
  return job.run(options);
}
