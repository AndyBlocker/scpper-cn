// src/jobs/TrackingAnomalyCheckJob.ts
import { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../utils/db-connection.js';
import { Logger } from '../utils/Logger.js';

/**
 * 追踪反作弊 / 数据质量检查（纯只读报告，不写库）。
 *
 * 1) 缓存投毒监控：若 Wikidot 把某登录浏览者的 %%number%% 烤进整页缓存再发给他人，会表现为
 *    "单 wikidotId 短时间跨大量 /24 子网且每子网≈1 次"。正常移动轮换是少量子网×多次。
 * 2) 看后投票校验：对带组件的页面(有 PageViewEvent 数据),已知 clientHash 的用户(发过用户像素)
 *    若投了票却无任何浏览记录(读取图谱 UserPageView 无该对) → 疑似脚本/API 刷票或换票。
 *    依赖 analyze-read-graph 已构建 UserPageView。
 */

export type TrackingAnomalyOptions = {
  days?: number;
  topN?: number;
};

const DEFAULT_DAYS = 30;
const DEFAULT_TOPN = 20;
// 缓存投毒阈值：子网数≥此值 且 每子网事件<1.5 视为可疑
const POISON_MIN_SUBNETS = 15;
const POISON_MAX_EV_PER_SUBNET = 1.5;
// 看后投票：只对"投票数≥此值且其中带组件页≥此值"的用户评估，避免小样本噪声
const VWV_MIN_COMPONENT_VOTES = 10;

function num(v: unknown): number {
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const x = Number(v); return Number.isFinite(x) ? x : 0; }
  return 0;
}

export class TrackingAnomalyCheckJob {
  private prisma: PrismaClient;
  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? getPrismaClient();
  }

  async run(options: TrackingAnomalyOptions = {}): Promise<void> {
    const days = options.days ?? DEFAULT_DAYS;
    const topN = options.topN ?? DEFAULT_TOPN;
    Logger.info(`[tracking-anomaly] 检查窗口 ${days} 天, top ${topN}`);
    await this.checkCachePoisoning(days, topN);
    await this.checkVoteWithoutView(days, topN);
  }

  /** 缓存投毒：单 wikidotId 跨异常多 /24 且每子网≈1 次。 */
  private async checkCachePoisoning(days: number, topN: number): Promise<void> {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(`
      SELECT username, "wikidotId", count(*) ev,
             count(DISTINCT split_part("clientIp",'.',1)||'.'||split_part("clientIp",'.',2)||'.'||split_part("clientIp",'.',3)) subnets,
             round(count(*)::numeric / NULLIF(count(DISTINCT split_part("clientIp",'.',1)||'.'||split_part("clientIp",'.',2)||'.'||split_part("clientIp",'.',3)),0), 2) ev_per_subnet
      FROM "UserPixelEvent"
      WHERE "createdAt" > now() - INTERVAL '${days} days' AND "clientIp" IS NOT NULL
      GROUP BY username, "wikidotId"
      HAVING count(DISTINCT split_part("clientIp",'.',1)||'.'||split_part("clientIp",'.',2)||'.'||split_part("clientIp",'.',3)) >= ${POISON_MIN_SUBNETS}
         AND count(*)::numeric / NULLIF(count(DISTINCT split_part("clientIp",'.',1)||'.'||split_part("clientIp",'.',2)||'.'||split_part("clientIp",'.',3)),0) < ${POISON_MAX_EV_PER_SUBNET}
      ORDER BY subnets DESC LIMIT ${topN}
    `);
    if (rows.length === 0) {
      Logger.info('[tracking-anomaly] 缓存投毒: 无可疑(身份数据健康)');
      return;
    }
    Logger.warn(`[tracking-anomaly] 缓存投毒嫌疑 ${rows.length} 个 wikidotId(可能被烤进整页缓存发给他人):`);
    for (const r of rows) {
      Logger.warn(`  - ${r.username}(${r.wikidotId}) 子网=${num(r.subnets)} 事件=${num(r.ev)} 每子网=${r.ev_per_subnet}`);
    }
  }

  /** 看后投票：带组件页 + 已知用户 + 有投票但读取图谱无浏览记录。 */
  private async checkVoteWithoutView(days: number, topN: number): Promise<void> {
    const rows = await this.prisma.$queryRawUnsafe<any[]>(`
      WITH known_users AS (        -- 发过用户像素 = 我们掌握其 clientHash 的登录用户
        SELECT DISTINCT "userId" FROM "UserPixelEvent" WHERE "userId" IS NOT NULL
      ),
      component_pages AS (         -- 有 PageViewEvent 数据 = 该页带组件(像素触发过)
        SELECT DISTINCT "pageId" FROM "PageViewEvent"
      ),
      latest_votes AS (            -- 用户在带组件页的当前有效 upvote/downvote(按 voter,page 取最新)
        SELECT "userId", "pageId" FROM (
          SELECT v."userId", pv."pageId", v.direction,
                 row_number() OVER (PARTITION BY v."userId", pv."pageId" ORDER BY v.timestamp DESC, v.id DESC) rn
          FROM "Vote" v JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
          WHERE v."userId" IN (SELECT "userId" FROM known_users)
            AND pv."pageId" IN (SELECT "pageId" FROM component_pages)
            AND v.timestamp > now() - INTERVAL '${days} days'
        ) z WHERE rn = 1 AND direction <> 0
      ),
      per_user AS (
        SELECT lv."userId",
               count(*) component_votes,
               count(*) FILTER (WHERE upv."userId" IS NULL) votes_without_view
        FROM latest_votes lv
        LEFT JOIN "UserPageView" upv ON upv."userId" = lv."userId" AND upv."pageId" = lv."pageId"
        GROUP BY lv."userId"
      )
      SELECT u.username, u."wikidotId", pu.component_votes, pu.votes_without_view,
             round(100.0 * pu.votes_without_view / NULLIF(pu.component_votes,0)) pct_no_view
      FROM per_user pu JOIN "User" u ON u.id = pu."userId"
      WHERE pu.component_votes >= ${VWV_MIN_COMPONENT_VOTES}
      ORDER BY pct_no_view DESC, pu.votes_without_view DESC
      LIMIT ${topN}
    `);
    if (rows.length === 0) {
      Logger.info('[tracking-anomaly] 看后投票: 无足量样本或无可疑');
      return;
    }
    Logger.info(`[tracking-anomaly] 看后投票 top ${rows.length}(带组件页投票但读取图谱无浏览记录占比高=脚本/换票嫌疑):`);
    for (const r of rows) {
      Logger.info(`  - ${r.username}(${r.wikidotId}) 带组件页投票=${num(r.component_votes)} 无浏览=${num(r.votes_without_view)} (${num(r.pct_no_view)}%)`);
    }
    Logger.info('[tracking-anomaly] 注意: 组件覆盖不全, 高占比仅为线索需人工复核(用户可能关像素/用其他设备)');
  }
}
