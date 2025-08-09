import { PrismaClient } from '@prisma/client';

/**
 * 增量分析任务框架
 * 基于 reply.md 文档的完整重构方案
 * 使用水位线(watermark)机制，只处理变更的数据
 */

export class IncrementalAnalyzeJob {
  private prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || new PrismaClient();
  }

  /**
   * 主分析入口点 - 增量模式
   */
  async analyze(options: { forceFullAnalysis?: boolean; tasks?: string[] } = {}) {
    console.log('🔄 Starting incremental analysis...');

    try {
      const availableTasks = [
        'page_stats',
        'user_stats', 
        'site_stats',
        'search_index',
        'daily_aggregates',
        'materialized_views'
      ];

      const tasksToRun = options.tasks || availableTasks;

      for (const taskName of tasksToRun) {
        console.log(`📊 Running task: ${taskName}`);
        await this.runTask(taskName, options.forceFullAnalysis);
      }

      console.log('✅ Incremental analysis completed successfully!');

    } catch (error) {
      console.error('❌ Incremental analysis failed:', error);
      throw error;
    }
  }

  /**
   * 运行单个分析任务
   */
  private async runTask(taskName: string, forceFullAnalysis = false) {
    try {
      // 获取变更集（受影响的 pageVersionId）
      const changeSet = await this.getChangeSet(taskName, forceFullAnalysis);
      
      if (changeSet.length === 0 && !forceFullAnalysis) {
        console.log(`⏭️ Task ${taskName}: No changes detected, skipping...`);
        return;
      }

      console.log(`🔍 Task ${taskName}: Processing ${changeSet.length} changed page versions`);

      // 根据任务类型执行相应的处理逻辑
      switch (taskName) {
        case 'page_stats':
          await this.updatePageStats(changeSet);
          break;
        case 'user_stats':
          await this.updateUserStats(changeSet);
          break;
        case 'site_stats':
          await this.updateSiteStats();
          break;
        case 'search_index':
          await this.updateSearchIndex(changeSet);
          break;
        case 'daily_aggregates':
          await this.updateDailyAggregates(changeSet);
          break;
        case 'materialized_views':
          await this.refreshMaterializedViews();
          break;
        default:
          console.warn(`⚠️ Unknown task: ${taskName}`);
      }

      // 更新水位线
      await this.updateWatermark(taskName, changeSet);

    } catch (error) {
      console.error(`❌ Task ${taskName} failed:`, error);
      throw error;
    }
  }

  /**
   * 获取变更集 - 找出自上次水位线后发生变化的 pageVersionId
   */
  private async getChangeSet(taskName: string, forceFullAnalysis = false): Promise<Array<{ id: number; lastChange: Date }>> {
    if (forceFullAnalysis) {
      // 强制全量分析 - 返回所有有效的 pageVersion
      const result = await this.prisma.$queryRaw<Array<{ id: number; lastChange: Date }>>`
        SELECT pv.id, pv."updatedAt" as "lastChange"
        FROM "PageVersion" pv
        WHERE pv."validTo" IS NULL AND pv."isDeleted" = false
      `;
      return result;
    }

    // 获取上次水位线时间戳
    const watermark = await this.prisma.analysisWatermark.findUnique({
      where: { task: taskName }
    });

    const cursorTs = watermark?.cursorTs;

    // 增量查询：找出自水位线后变更的 pageVersion
    const result = await this.prisma.$queryRaw<Array<{ id: number; lastChange: Date }>>`
      WITH w AS (
        SELECT ${cursorTs}::timestamp as cursor_ts
      ),
      changed_pv AS (
        SELECT DISTINCT v."pageVersionId" AS id, max(v."timestamp") AS changed_at
        FROM "Vote" v, w
        WHERE w.cursor_ts IS NULL OR v."timestamp" > w.cursor_ts
        GROUP BY v."pageVersionId"
        UNION
        SELECT DISTINCT r."pageVersionId" AS id, max(r."timestamp") AS changed_at
        FROM "Revision" r, w
        WHERE w.cursor_ts IS NULL OR r."timestamp" > w.cursor_ts
        GROUP BY r."pageVersionId"
        UNION
        SELECT DISTINCT a."pageVerId" AS id, max(a."date") AS changed_at
        FROM "Attribution" a, w
        WHERE a."date" IS NOT NULL AND (w.cursor_ts IS NULL OR a."date" > w.cursor_ts)
        GROUP BY a."pageVerId"
      )
      SELECT id, max(changed_at) AS "lastChange"
      FROM changed_pv
      GROUP BY id
    `;

    return result;
  }

  /**
   * 更新PageStats - 仅对变更的pageVersion进行计算
   */
  private async updatePageStats(changeSet: Array<{ id: number; lastChange: Date }>) {
    if (changeSet.length === 0) return;

    console.log(`📊 Updating PageStats for ${changeSet.length} page versions...`);

    // 提取pageVersionId列表
    const pageVersionIds = changeSet.map(c => c.id);

    await this.prisma.$executeRaw`
      WITH changed AS (
        SELECT unnest(${pageVersionIds}::int[]) AS id
      ),
      vote_stats AS (
        SELECT v."pageVersionId" AS id,
               COUNT(*) FILTER (WHERE v.direction=1) AS uv,
               COUNT(*) FILTER (WHERE v.direction=-1) AS dv
        FROM "Vote" v
        JOIN changed c ON c.id = v."pageVersionId"
        GROUP BY v."pageVersionId"
      )
      INSERT INTO "PageStats" ("pageVersionId", uv, dv, "wilson95", controversy, "likeRatio")
      SELECT vs.id, vs.uv, vs.dv,
             f_wilson_lower_bound(vs.uv::int, vs.dv::int) AS wilson95,
             f_controversy(vs.uv::int, vs.dv::int) AS controversy,
             CASE WHEN vs.uv+vs.dv=0 THEN 0 ELSE vs.uv::float/(vs.uv+vs.dv) END AS "likeRatio"
      FROM vote_stats vs
      ON CONFLICT ("pageVersionId") DO UPDATE SET
        uv = EXCLUDED.uv,
        dv = EXCLUDED.dv,
        "wilson95" = EXCLUDED."wilson95",
        controversy = EXCLUDED.controversy,
        "likeRatio" = EXCLUDED."likeRatio"
    `;

    console.log(`✅ PageStats updated for ${changeSet.length} page versions`);
  }

  /**
   * 更新UserStats - 仅对相关用户进行计算
   */
  private async updateUserStats(changeSet: Array<{ id: number; lastChange: Date }>) {
    if (changeSet.length === 0) return;

    console.log(`👥 Updating UserStats for users affected by ${changeSet.length} page version changes...`);

    // 找出受影响的用户（通过Attribution关联）
    const pageVersionIds = changeSet.map(c => c.id);

    const affectedUsers = await this.prisma.$queryRaw<Array<{ userId: number }>>`
      SELECT DISTINCT a."userId" 
      FROM "Attribution" a
      WHERE a."pageVerId" = ANY(${pageVersionIds}::int[])
        AND a."userId" IS NOT NULL
    `;

    if (affectedUsers.length === 0) return;

    const userIds = affectedUsers.map(u => u.userId);

    // 重新计算这些用户的统计数据
    await this.prisma.$executeRaw`
      WITH affected_users AS (
        SELECT unnest(${userIds}::int[]) AS "userId"
      ),
      user_attribution_stats AS (
        SELECT 
          u."userId",
          SUM(COALESCE(pv.rating, 0)::float) as total_rating,
          COUNT(*) as page_count
        FROM affected_users u
        INNER JOIN "Attribution" a ON u."userId" = a."userId"
        INNER JOIN "PageVersion" pv ON a."pageVerId" = pv.id
        WHERE pv."validTo" IS NULL 
          AND pv."isDeleted" = false
          AND pv.rating IS NOT NULL
        GROUP BY u."userId"
      ),
      user_vote_stats AS (
        SELECT 
          u."userId",
          SUM(CASE WHEN v.direction = 1 THEN 1 ELSE 0 END) as total_up,
          SUM(CASE WHEN v.direction = -1 THEN 1 ELSE 0 END) as total_down
        FROM affected_users u
        INNER JOIN "Vote" v ON u."userId" = v."userId"
        WHERE v."userId" IS NOT NULL
        GROUP BY u."userId"
      )
      INSERT INTO "UserStats" ("userId", "totalUp", "totalDown", "totalRating", "pageCount")
      SELECT 
        COALESCE(uas."userId", uvs."userId") as "userId",
        COALESCE(uvs.total_up, 0) as total_up,
        COALESCE(uvs.total_down, 0) as total_down,
        COALESCE(uas.total_rating, 0) as total_rating,
        COALESCE(uas.page_count, 0) as page_count
      FROM user_attribution_stats uas
      FULL OUTER JOIN user_vote_stats uvs ON uas."userId" = uvs."userId"
      ON CONFLICT ("userId") DO UPDATE SET
        "totalUp" = EXCLUDED."totalUp",
        "totalDown" = EXCLUDED."totalDown",
        "totalRating" = EXCLUDED."totalRating",
        "pageCount" = EXCLUDED."pageCount"
    `;

    console.log(`✅ UserStats updated for ${affectedUsers.length} affected users`);
  }

  /**
   * 更新SearchIndex - 使用批量删除-插入策略避免ON CONFLICT错误
   */
  private async updateSearchIndex(changeSet: Array<{ id: number; lastChange: Date }>) {
    if (changeSet.length === 0) return;

    console.log(`🔍 Updating SearchIndex for ${changeSet.length} page versions...`);

    // 获取需要更新的唯一pageId列表
    const pageIds = await this.prisma.$queryRaw<Array<{ pageId: number }>>`
      SELECT DISTINCT pv."pageId" as "pageId"
      FROM "PageVersion" pv
      WHERE pv.id = ANY(${changeSet.map(c => c.id)}::int[])
        AND pv."validTo" IS NULL 
        AND pv."isDeleted" = false
    `;

    if (pageIds.length === 0) return;

    const uniquePageIds = pageIds.map(p => p.pageId);
    console.log(`🔄 Updating search index for ${uniquePageIds.length} unique pages...`);

    // 分批处理，避免单次操作过大
    const batchSize = 1000;
    let processed = 0;

    for (let i = 0; i < uniquePageIds.length; i += batchSize) {
      const batch = uniquePageIds.slice(i, i + batchSize);
      
      // 1. 删除当前批次的现有搜索索引条目
      await this.prisma.$executeRaw`
        DELETE FROM "SearchIndex" 
        WHERE "pageId" = ANY(${batch}::int[])
      `;

      // 2. 插入当前批次的最新搜索索引条目
      const insertResult = await this.prisma.$executeRaw`
        INSERT INTO "SearchIndex" ("pageId", title, url, tags, text_content, source_content, "updatedAt")
        SELECT DISTINCT ON (pv."pageId")
          pv."pageId",
          pv.title,
          p.url,
          pv.tags,
          pv."textContent",
          pv.source,
          now()
        FROM "PageVersion" pv
        JOIN "Page" p ON p.id = pv."pageId"
        WHERE pv."pageId" = ANY(${batch}::int[])
          AND pv."validTo" IS NULL 
          AND pv."isDeleted" = false
        ORDER BY pv."pageId", pv."updatedAt" DESC
      `;

      processed += batch.length;
      console.log(`  📈 Progress: ${processed}/${uniquePageIds.length} (${Math.round(processed/uniquePageIds.length*100)}%) - inserted ${insertResult}`);
    }

    console.log(`✅ SearchIndex updated for ${uniquePageIds.length} pages`);
  }

  /**
   * 更新日聚合数据
   */
  private async updateDailyAggregates(changeSet: Array<{ id: number; lastChange: Date }>) {
    if (changeSet.length === 0) return;

    console.log(`📅 Updating daily aggregates...`);

    // 获取需要重新聚合的日期范围（最近变更的日期）
    const dateRange = await this.prisma.$queryRaw<Array<{ date: Date }>>`
      SELECT DISTINCT date(v."timestamp") as date
      FROM "Vote" v
      WHERE v."timestamp" >= CURRENT_DATE - INTERVAL '7 days'
      ORDER BY date DESC
    `;

    for (const { date } of dateRange) {
      // 更新PageDailyStats
      await this.prisma.$executeRaw`
        INSERT INTO "PageDailyStats" ("pageId", date, votes_up, votes_down, total_votes, unique_voters, revisions)
        SELECT 
          p.id as "pageId",
          ${date}::date as date,
          COUNT(v.id) FILTER (WHERE v.direction = 1) as votes_up,
          COUNT(v.id) FILTER (WHERE v.direction = -1) as votes_down,
          COUNT(v.id) FILTER (WHERE v.direction != 0) as total_votes,
          COUNT(DISTINCT v."userId") FILTER (WHERE v."userId" IS NOT NULL) as unique_voters,
          COALESCE(r_count.revisions, 0) as revisions
        FROM "Page" p
        JOIN "PageVersion" pv ON pv."pageId" = p.id AND pv."validTo" IS NULL AND pv."isDeleted" = false
        LEFT JOIN "Vote" v ON v."pageVersionId" = pv.id AND date(v."timestamp") = ${date}::date
        LEFT JOIN (
          SELECT pv2."pageId", COUNT(r.id) as revisions
          FROM "Revision" r
          JOIN "PageVersion" pv2 ON r."pageVersionId" = pv2.id
          WHERE date(r."timestamp") = ${date}::date
          GROUP BY pv2."pageId"
        ) r_count ON r_count."pageId" = p.id
        GROUP BY p.id, r_count.revisions
        HAVING COUNT(v.id) > 0 OR COALESCE(r_count.revisions, 0) > 0
        ON CONFLICT ("pageId", date) DO UPDATE SET
          votes_up = EXCLUDED.votes_up,
          votes_down = EXCLUDED.votes_down,
          total_votes = EXCLUDED.total_votes,
          unique_voters = EXCLUDED.unique_voters,
          revisions = EXCLUDED.revisions
      `;

      // 更新UserDailyStats
      await this.prisma.$executeRaw`
        INSERT INTO "UserDailyStats" ("userId", date, votes_cast, pages_created, last_activity)
        SELECT 
          u.id as "userId",
          ${date}::date as date,
          COUNT(v.id) as votes_cast,
          COALESCE(p_count.pages_created, 0) as pages_created,
          MAX(GREATEST(v."timestamp", r."timestamp", a."date")) as last_activity
        FROM "User" u
        LEFT JOIN "Vote" v ON v."userId" = u.id AND date(v."timestamp") = ${date}::date
        LEFT JOIN "Revision" r ON r."userId" = u.id AND date(r."timestamp") = ${date}::date
        LEFT JOIN "Attribution" a ON a."userId" = u.id AND date(a."date") = ${date}::date
        LEFT JOIN (
          SELECT a2."userId", COUNT(DISTINCT pv."pageId") as pages_created
          FROM "Attribution" a2
          JOIN "PageVersion" pv ON a2."pageVerId" = pv.id
          JOIN "Page" p ON pv."pageId" = p.id
          WHERE date(COALESCE(a2."date", p."createdAt")) = ${date}::date
            AND a2.type = 'author'
          GROUP BY a2."userId"
        ) p_count ON p_count."userId" = u.id
        WHERE v.id IS NOT NULL OR r.id IS NOT NULL OR a.id IS NOT NULL
        GROUP BY u.id, p_count.pages_created
        ON CONFLICT ("userId", date) DO UPDATE SET
          votes_cast = EXCLUDED.votes_cast,
          pages_created = EXCLUDED.pages_created,
          last_activity = EXCLUDED.last_activity
      `;
    }

    console.log(`✅ Daily aggregates updated for ${dateRange.length} days`);
  }

  /**
   * 更新站点统计
   */
  private async updateSiteStats() {
    console.log('🌐 Updating site statistics...');

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    await this.prisma.$executeRaw`
      INSERT INTO "SiteStats" (date, "totalUsers", "activeUsers", "totalPages", "totalVotes", "newUsersToday", "newPagesToday", "newVotesToday", "updatedAt")
      SELECT 
        ${today}::date as date,
        (SELECT COUNT(*) FROM "User") as "totalUsers",
        (SELECT COUNT(*) FROM "User" WHERE "firstActivityAt" IS NOT NULL) as "activeUsers",
        (SELECT COUNT(*) FROM "Page") as "totalPages",
        (SELECT COUNT(*) FROM "Vote") as "totalVotes",
        (SELECT COUNT(*) FROM "User" WHERE date("firstActivityAt") = ${today}::date) as "newUsersToday",
        (SELECT COUNT(*) FROM "Page" WHERE date("firstPublishedAt") = ${today}::date) as "newPagesToday",
        (SELECT COUNT(*) FROM "Vote" WHERE date("timestamp") = ${today}::date) as "newVotesToday",
        now() as "updatedAt"
      ON CONFLICT (date) DO UPDATE SET
        "totalUsers" = EXCLUDED."totalUsers",
        "activeUsers" = EXCLUDED."activeUsers",
        "totalPages" = EXCLUDED."totalPages",
        "totalVotes" = EXCLUDED."totalVotes",
        "newUsersToday" = EXCLUDED."newUsersToday",
        "newPagesToday" = EXCLUDED."newPagesToday",
        "newVotesToday" = EXCLUDED."newVotesToday",
        "updatedAt" = EXCLUDED."updatedAt"
    `;

    console.log('✅ Site statistics updated');
  }

  /**
   * 刷新物化视图
   */
  private async refreshMaterializedViews() {
    console.log('🔄 Refreshing materialized views...');

    try {
      // 刷新热门页面物化视图
      await this.prisma.$executeRaw`REFRESH MATERIALIZED VIEW CONCURRENTLY mv_top_pages_30d`;
      console.log('✅ mv_top_pages_30d refreshed');
    } catch (error) {
      console.error('❌ Failed to refresh materialized views:', error);
      // 非关键性操作，继续执行其他任务
    }
  }

  /**
   * 更新水位线
   */
  private async updateWatermark(taskName: string, changeSet: Array<{ id: number; lastChange: Date }>) {
    if (changeSet.length === 0) return;

    const latestChange = new Date(Math.max(...changeSet.map(c => c.lastChange.getTime())));

    await this.prisma.analysisWatermark.upsert({
      where: { task: taskName },
      update: {
        lastRunAt: new Date(),
        cursorTs: latestChange
      },
      create: {
        task: taskName,
        lastRunAt: new Date(),
        cursorTs: latestChange
      }
    });

    console.log(`🔖 Watermark updated for ${taskName}: ${latestChange.toISOString()}`);
  }

  /**
   * 获取分析统计信息
   */
  async getAnalysisStats() {
    const watermarks = await this.prisma.analysisWatermark.findMany({
      orderBy: { task: 'asc' }
    });

    const stats = await this.prisma.$queryRaw`
      SELECT 
        (SELECT COUNT(*) FROM "Page") as pages,
        (SELECT COUNT(*) FROM "PageVersion") as page_versions,
        (SELECT COUNT(*) FROM "User") as users,
        (SELECT COUNT(*) FROM "Vote") as votes,
        (SELECT COUNT(*) FROM "Revision") as revisions,
        (SELECT COUNT(*) FROM "PageStats") as analyzed_pages,
        (SELECT COUNT(*) FROM "UserStats") as analyzed_users,
        (SELECT COUNT(*) FROM "SearchIndex") as indexed_pages
    `;

    return {
      watermarks,
      statistics: (stats as any)[0]
    };
  }

  /**
   * 清理过期缓存
   */
  async cleanupExpiredCache() {
    console.log('🧹 Cleaning up expired cache...');
    
    const deletedCount = await this.prisma.leaderboardCache.deleteMany({
      where: {
        expiresAt: {
          lt: new Date()
        }
      }
    });

    console.log(`✅ Cleaned up ${deletedCount.count} expired cache entries`);
  }
}

/**
 * 便捷的分析入口函数
 */
export async function analyzeIncremental(options: { forceFullAnalysis?: boolean; tasks?: string[] } = {}) {
  const job = new IncrementalAnalyzeJob();
  await job.analyze(options);
}