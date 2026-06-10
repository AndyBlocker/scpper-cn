// src/jobs/ReadGraphJob.ts
import { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../utils/db-connection.js';
import { Logger } from '../utils/Logger.js';

/**
 * 读取图谱构建 Job。
 *
 * UserPixelEvent = "登录用户 X(wikidotId) 用 clientHash=H 浏览了带组件的页面"(无页面字段)。
 * PageViewEvent  = "clientHash=H 浏览了页面 Y"(匿名/登录通吃)。
 * 两者皆带 clientHash + createdAt → 按 (clientHash, ±MATCH_WINDOW) join 即可重建
 * "用户 X 浏览了页面 Y" 的读取图谱，聚合到 (userId, pageId) 写入 UserPageView。**零改组件**。
 *
 * 增量：按 UserPixelEvent.createdAt 时间窗处理(默认近 --hours 小时)，upsert 幂等可重跑。
 * 全程只读两事件表，仅写 UserPageView。
 */

const MATCH_WINDOW_SECONDS = 15; // 与 check-tracking-health 同口径
const DEFAULT_HOURS = 26;        // 增量默认回看(略大于小时级调度间隔，容错)

export type ReadGraphOptions = {
  hours?: number;     // 处理近 N 小时的 UserPixelEvent
  full?: boolean;     // 全量重建(忽略 hours)
  dryRun?: boolean;
};

function num(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const x = Number(v); return Number.isFinite(x) ? x : 0; }
  return 0;
}

export class ReadGraphJob {
  private prisma: PrismaClient;
  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? getPrismaClient();
  }

  async run(options: ReadGraphOptions = {}): Promise<{ upserted: number; window: string }> {
    const dryRun = Boolean(options.dryRun);
    const full = Boolean(options.full);
    const hours = options.hours ?? DEFAULT_HOURS;
    const windowSql = full ? "TIMESTAMP 'epoch'" : `now() - INTERVAL '${hours} hours'`;
    Logger.info(`[read-graph] start${dryRun ? ' [dry-run]' : ''} ${full ? '[full]' : `[since ${hours}h]`}`);

    // 预览：本窗能产出多少 (user,page) 对
    const preview = await this.prisma.$queryRawUnsafe<Array<{ pairs: bigint; users: bigint; pages: bigint }>>(`
      WITH up AS (
        SELECT "clientHash", "userId", "wikidotId", "createdAt"
        FROM "UserPixelEvent"
        WHERE "createdAt" >= ${windowSql} AND "clientHash" IS NOT NULL
      )
      SELECT count(DISTINCT (up."userId", pv."pageId"))::bigint pairs,
             count(DISTINCT up."userId")::bigint users,
             count(DISTINCT pv."pageId")::bigint pages
      FROM up
      JOIN "PageViewEvent" pv
        ON pv."clientHash" = up."clientHash"
       AND pv."createdAt" BETWEEN up."createdAt" - INTERVAL '${MATCH_WINDOW_SECONDS} seconds'
                              AND up."createdAt" + INTERVAL '${MATCH_WINDOW_SECONDS} seconds'
    `);
    const pairs = num(preview[0]?.pairs);
    Logger.info(`[read-graph] 窗内可产出 ${pairs} 个(用户,页面)对 / ${num(preview[0]?.users)} 用户 / ${num(preview[0]?.pages)} 页`);

    if (dryRun) return { upserted: 0, window: full ? 'full' : `${hours}h` };

    // 聚合 upsert：firstViewedAt 取最小、lastViewedAt 取最大、viewCount 累加(去重到 voter 像素事件计数)。
    // 冲突(已存在该 user-page)：扩展首末次区间、累加次数。幂等：重跑同窗只会刷新区间/次数(不重复累计因
    // 我们以"匹配事件对"为计数源，且窗口固定→重跑结果一致地覆盖)。
    const affected = await this.prisma.$executeRawUnsafe(`
      WITH up AS (
        SELECT "clientHash", "userId", "wikidotId", "createdAt"
        FROM "UserPixelEvent"
        WHERE "createdAt" >= ${windowSql} AND "clientHash" IS NOT NULL
      ),
      matched AS (
        SELECT up."userId", up."wikidotId", pv."pageId", up."createdAt" AS viewed_at
        FROM up
        JOIN "PageViewEvent" pv
          ON pv."clientHash" = up."clientHash"
         AND pv."createdAt" BETWEEN up."createdAt" - INTERVAL '${MATCH_WINDOW_SECONDS} seconds'
                                AND up."createdAt" + INTERVAL '${MATCH_WINDOW_SECONDS} seconds'
      ),
      agg AS (
        SELECT "userId", min("wikidotId") AS wikidot_id, "pageId",
               min(viewed_at) AS first_v, max(viewed_at) AS last_v, count(*) AS cnt
        FROM matched GROUP BY "userId", "pageId"
      )
      INSERT INTO "UserPageView" ("userId","wikidotId","pageId","firstViewedAt","lastViewedAt","viewCount","updatedAt")
      SELECT "userId", wikidot_id, "pageId", first_v, last_v, cnt, now() FROM agg
      ON CONFLICT ("userId","pageId") DO UPDATE SET
        "firstViewedAt" = LEAST("UserPageView"."firstViewedAt", EXCLUDED."firstViewedAt"),
        "lastViewedAt"  = GREATEST("UserPageView"."lastViewedAt", EXCLUDED."lastViewedAt"),
        "viewCount"     = GREATEST("UserPageView"."viewCount", EXCLUDED."viewCount"),
        "wikidotId"     = COALESCE("UserPageView"."wikidotId", EXCLUDED."wikidotId"),
        "updatedAt"     = now()
    `);
    const n = num(affected);
    Logger.info(`[read-graph] upsert 完成，影响 ${n} 行`);
    return { upserted: n, window: full ? 'full' : `${hours}h` };
  }
}
