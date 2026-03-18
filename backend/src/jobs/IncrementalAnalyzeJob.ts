// src/jobs/IncrementalAnalyzeJob.ts
import { PrismaClient, Prisma } from '@prisma/client';
import { getPrismaClient } from '../utils/db-connection';
import { VotingTimeSeriesCacheJob } from './VotingTimeSeriesCacheJob';
import { runDailySiteOverview } from './DailySiteOverviewJob.js';
import { computeUserCategoryBenchmarks } from './UserCategoryBenchmarksJob';
import { PageMetricMonitorJob } from './PageMetricMonitorJob';
import { UserFollowActivityJob } from './UserFollowActivityJob';
import { UserCollectionService } from '../services/UserCollectionService.js';
import { WikidotBindingVerifyJob } from './WikidotBindingVerifyJob.js';
import { TagDefinitionService } from '../services/TagDefinitionService.js';
import { runCategoryIndexTickJob } from './CategoryIndexTickJob.js';
import { runCategoryIndexForecastJob } from './CategoryIndexForecastJob.js';
// @ts-ignore - importing from scripts folder
// import updateSearchIndexIncremental from '../../scripts/update-search-index-incremental.js';

/**
 * 增量分析任务框架
 * 基于 reply.md 文档的完整重构方案
 * 使用水位线(watermark)机制，只处理变更的数据
 */

export class IncrementalAnalyzeJob {
  private prisma: PrismaClient;
  private interestingFactsCleared = false;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || getPrismaClient();
  }

  /**
   * 主分析入口点 - 增量模式
   */
  async analyze(options: { forceFullAnalysis?: boolean; forceFullHistory?: boolean; tasks?: string[] } = {}) {
    console.log('🔄 Starting incremental analysis...');

    try {
      const availableTasks = [
        'page_stats',
        'user_stats', 
        'user_data_completeness',
        'user_social_analysis',
        'site_stats',
        'daily_aggregates',
        // Tick depends on fresh daily aggregates; keep it early so market data is
        // not blocked behind slower downstream reporting jobs.
        'category_index_tick',
        'category_index_forecast',
        'voting_time_series_cache',
        'materialized_views',
        'interesting_facts',
        'time_milestones',
        'tag_records',
        'content_records',
        'rating_records',
        'user_activity_records',
        'search_index',
        'series_stats',
        'trending_stats',
        'site_overview_daily',
        'page_metric_alerts',
        'user_follow_alerts',
        'user_collection_sanitizer',
        // 新增：作者分类基准
        'category_benchmarks',
        // 标签验证缓存刷新
        'tag_validation_cache',
        // Wikidot 账号绑定验证
        'wikidot_binding_verify'
      ];

      const disableBindingVerifyByEnv = ['1', 'true', 'yes', 'on'].includes(
        String(process.env.DISABLE_WIKIDOT_BINDING_VERIFY ?? '').trim().toLowerCase()
      );

      const requestedTasks = options.tasks || availableTasks;
      const tasksToRun = requestedTasks.filter((taskName) => {
        if (taskName !== 'wikidot_binding_verify') return true;
        if (!disableBindingVerifyByEnv) return true;
        console.log('⏭️ Task wikidot_binding_verify: disabled by DISABLE_WIKIDOT_BINDING_VERIFY');
        return false;
      });

      if (tasksToRun.length === 0) {
        console.log('ℹ️ No analysis tasks selected after environment filtering.');
        return;
      }

      const forceFullHistory = options.forceFullHistory ?? options.forceFullAnalysis ?? false;

      // 如果是强制全量分析，先清理相关分析数据
      if (options.forceFullAnalysis) {
        console.log('🧹 Cleaning analysis data for full rebuild...');
        await this.cleanAnalysisData(tasksToRun);
      }

      const failedTasks: Array<{ name: string; error: unknown }> = [];

      for (const taskName of tasksToRun) {
        console.log(`📊 Running task: ${taskName}`);
        try {
          await this.runTask(taskName, options.forceFullAnalysis, { forceFullHistory });
        } catch (taskError) {
          console.error(`❌ Task ${taskName} failed:`, taskError);
          failedTasks.push({ name: taskName, error: taskError });
        }
      }

      if (failedTasks.length > 0) {
        const names = failedTasks.map(t => t.name).join(', ');
        console.error(`⚠️ Incremental analysis completed with ${failedTasks.length} failed task(s): ${names}`);
        throw new Error(`${failedTasks.length} task(s) failed: ${names}`, { cause: failedTasks[0]!.error });
      }

      console.log('✅ Incremental analysis completed successfully!');

    } catch (error) {
      console.error('❌ Incremental analysis failed:', error);
      throw error;
    }
  }

  /**
   * 清理分析数据（用于全量重建）
   */
  private async cleanAnalysisData(tasks: string[]) {
    console.log('🗑️ Cleaning analysis data for tasks:', tasks.join(', '));

    for (const taskName of tasks) {
      try {
        switch (taskName) {
          case 'page_stats':
            await this.prisma.pageStats.deleteMany({});
            console.log('  ✓ PageStats cleared');
            break;
          case 'user_stats':
            await this.prisma.userStats.deleteMany({});
            console.log('  ✓ UserStats cleared');
            break;
          case 'user_data_completeness':
            // User表的firstActivityAt和lastActivityAt字段需要重置
            await this.prisma.$executeRaw`
              UPDATE "User" 
              SET "firstActivityAt" = NULL, 
                  "firstActivityType" = NULL,
                  "firstActivityDetails" = NULL,
                  "lastActivityAt" = NULL
            `;
            console.log('  ✓ User activity timestamps cleared');
            break;
          case 'user_social_analysis':
            await this.prisma.userTagPreference.deleteMany({});
            await this.prisma.userVoteInteraction.deleteMany({});
            console.log('  ✓ User social analysis data cleared');
            break;
          case 'site_stats':
            await this.prisma.siteStats.deleteMany({});
            console.log('  ✓ SiteStats cleared');
            break;
          case 'daily_aggregates':
            await this.prisma.userDailyStats.deleteMany({});
            console.log('  ✓ UserDailyStats cleared (PageDailyStats preserved to retain view history)');
            break;
          case 'voting_time_series_cache':
            // 清理Page表中的votingTimeSeriesCache字段
            await this.prisma.$executeRaw`
              UPDATE "Page" 
              SET "votingTimeSeriesCache" = NULL,
                  "votingCacheUpdatedAt" = NULL
            `;
            // 清理User表中的attributionVotingTimeSeriesCache字段
            await this.prisma.$executeRaw`
              UPDATE "User" 
              SET "attributionVotingTimeSeriesCache" = NULL,
                  "attributionVotingCacheUpdatedAt" = NULL
            `;
            console.log('  ✓ Voting time series cache cleared');
            break;
          case 'interesting_facts':
          case 'time_milestones':
          case 'tag_records':
          case 'content_records':
          case 'rating_records':
          case 'user_activity_records':
            // 这些都使用InterestingFacts表，只清理一次
            if (!this.interestingFactsCleared) {
              await this.prisma.interestingFacts.deleteMany({});
              console.log('  ✓ InterestingFacts cleared');
              this.interestingFactsCleared = true;
            }
            break;
          case 'search_index':
            // SearchIndex表在当前schema中不存在，跳过清理
            console.log('  ⚠️ Search index tables not found in schema, skipping');
            break;
          case 'series_stats':
            await this.prisma.seriesStats.deleteMany({});
            console.log('  ✓ SeriesStats cleared');
            break;
          case 'trending_stats':
            await this.prisma.trendingStats.deleteMany({});
            console.log('  ✓ TrendingStats cleared');
            break;
          case 'site_overview_daily':
            // 非破坏性汇总，清空后可由任务重建
            if ((this.prisma as any).siteOverviewDaily) {
              await (this.prisma as any).siteOverviewDaily.deleteMany({});
              console.log('  ✓ SiteOverviewDaily cleared');
            } else {
              console.log('  ⚠️ SiteOverviewDaily model not found in Prisma client, skipping');
            }
            break;
          case 'category_benchmarks':
            // 仅清理本任务键，避免影响其它榜单缓存
            await this.prisma.leaderboardCache.deleteMany({
              where: {
                key: { in: ['category_benchmarks_author_rating_v2', 'category_benchmarks_author_rating'] }
              }
            });
            console.log('  ✓ Category benchmarks cache cleared');
            break;
          case 'category_index_tick':
            await this.prisma.categoryIndexTick.deleteMany({});
            console.log('  ✓ Category index ticks cleared');
            break;
          case 'category_index_forecast':
            await (this.prisma as any).categoryIndexForecastTick?.deleteMany?.({});
            console.log('  ✓ Category index forecast ticks cleared');
            break;
          case 'tag_validation_cache':
            await this.prisma.$executeRaw`DELETE FROM "TagValidationCache"`;
            console.log('  ✓ TagValidationCache cleared');
            break;
          case 'materialized_views':
            // 物化视图需要先DROP再重建，这里只记录日志
            console.log('  ⚠️ Materialized views will be refreshed (not dropped)');
            break;
          default:
            console.warn(`  ⚠️ Unknown task for cleaning: ${taskName}`);
        }
      } catch (error) {
        console.error(`  ❌ Failed to clean ${taskName}:`, error);
        throw error;
      }
    }

    // 清理水位线表，以确保全量分析
    await this.prisma.analysisWatermark.deleteMany({});
    console.log('  ✓ Analysis watermarks cleared');

    console.log('✅ Analysis data cleanup completed');
  }

  /**
   * 运行单个分析任务
   */
  private async runTask(taskName: string, forceFullAnalysis = false, options: { forceFullHistory?: boolean } = {}) {
    // Acquire task-level advisory lock to avoid concurrent runs of the same task
    const lockResult = await this.prisma.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_lock(hashtext(${taskName})) as locked
    `;
    if (!lockResult[0]?.locked) {
      console.log(`⏭️ Task ${taskName}: another worker holds the lock, skipping...`);
      return;
    }

    try {
      // 获取变更集（受影响的 pageVersionId）
      const changeSet = await this.getChangeSet(taskName, forceFullAnalysis);

      if (changeSet.length === 0 && !forceFullAnalysis) {
        const alwaysRunTasks = new Set([
          'site_overview_daily',
          'category_benchmarks',
          'category_index_tick',
          'category_index_forecast',
          'materialized_views',
          'series_stats',
          'trending_stats',
          'page_metric_alerts',
          'wikidot_binding_verify',
          'tag_validation_cache'
        ]);
        if (taskName === 'site_stats') {
          await this.refreshSiteStatsTimestamp();
          return;
        }
        if (!alwaysRunTasks.has(taskName)) {
          console.log(`⏭️ Task ${taskName}: No changes detected, skipping...`);
          return;
        }
      }

      const changeLabel = taskName === 'user_data_completeness' ? 'changed records' : 'changed page versions';
      console.log(`🔍 Task ${taskName}: Processing ${changeSet.length} ${changeLabel}`);

      // 根据任务类型执行相应的处理逻辑
      switch (taskName) {
        case 'page_stats':
          await this.updatePageStats(changeSet);
          break;
        case 'user_stats':
          await this.updateUserStats(changeSet);
          break;
        case 'user_data_completeness':
          await this.updateUserDataCompleteness(changeSet);
          break;
        case 'user_social_analysis':
          await this.updateUserSocialAnalysis(changeSet);
          break;
        case 'site_stats':
          await this.updateSiteStats();
          break;
        case 'daily_aggregates':
          await this.updateDailyAggregates(changeSet, { forceFullHistory: options.forceFullHistory });
          break;
        case 'voting_time_series_cache':
          await this.updateVotingTimeSeriesCache(changeSet);
          break;
        case 'materialized_views':
          await this.refreshMaterializedViews();
          break;
        case 'interesting_facts':
          await this.updateInterestingFacts(changeSet);
          break;
        case 'time_milestones':
          await this.updateTimeMilestones(changeSet);
          break;
        case 'tag_records':
          await this.updateTagRecords(changeSet);
          break;
        case 'content_records':
          await this.updateContentRecords(changeSet);
          break;
        case 'rating_records':
          await this.updateRatingRecords(changeSet);
          break;
        case 'user_activity_records':
          await this.updateUserActivityRecords(changeSet);
          break;
        case 'search_index':
          await this.updateSearchIndex();
          break;
        case 'series_stats':
          await this.updateSeriesStats();
          break;
        case 'trending_stats':
          await this.updateTrendingStats();
          break;
        case 'site_overview_daily':
          // Compute or refresh daily overview snapshots
          if (forceFullAnalysis) {
            // Full history rebuild: derive earliest date from UserDailyStats or Votes
            const rows = await this.prisma.$queryRaw<Array<{ min_date: Date | null }>>`
              WITH candidates AS (
                SELECT MIN(date) AS d FROM "UserDailyStats"
                UNION ALL
          SELECT MIN(date(v."timestamp")) AS d FROM "Vote" v
        )
              SELECT MIN(d) AS min_date FROM candidates
            `;
            const minDate = rows?.[0]?.min_date ? new Date(rows[0].min_date) : null;
            if (!minDate) {
              console.log('ℹ️ Task site_overview_daily: no historical data to process (skipping full rebuild).');
            } else {
              await runDailySiteOverview({ startDate: minDate.toISOString().slice(0, 10), endDate: undefined });
            }
          } else {
            // Incremental: recompute recent 30 days window for stability
            const end = new Date();
            const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
            await runDailySiteOverview({ startDate: start.toISOString().slice(0,10), endDate: end.toISOString().slice(0,10) });
          }
          break;
        case 'category_benchmarks':
          await computeUserCategoryBenchmarks(this.prisma);
          break;
        case 'category_index_tick': {
          const summary = await runCategoryIndexTickJob({
            forceFullBackfill: Boolean(forceFullAnalysis || options.forceFullHistory)
          });
          console.log(
            `✅ Category index tick generated=${summary.generated}, window=${summary.fromAsOfTs ?? '-'} -> ${summary.toAsOfTs ?? '-'}, sourceWatermark=${summary.sourceWatermarkTs ?? '-'}`
          );
          break;
        }
        case 'category_index_forecast': {
          const summary = await runCategoryIndexForecastJob({
            lookbackDays: forceFullAnalysis || options.forceFullHistory ? 120 : 45
          });
          console.log(
            `✅ Category index forecast upserted=${summary.upserted}, window=${summary.fromAsOfTs ?? '-'} -> ${summary.toAsOfTs ?? '-'}, sourceTick=${summary.sourceTickTs ?? '-'}`
          );
          break;
        }
        case 'page_metric_alerts': {
          const monitor = new PageMetricMonitorJob(this.prisma);
          await monitor.run(changeSet.map(item => item.id));
          break;
        }
        case 'user_follow_alerts': {
          const job = new UserFollowActivityJob(this.prisma);
          await job.run(changeSet.map(item => item.id));
          break;
        }
        case 'user_collection_sanitizer': {
          const service = new UserCollectionService(this.prisma);
          await service.pruneInvalidItems();
          break;
        }
        case 'tag_validation_cache': {
          await this.refreshTagValidationCache();
          break;
        }
        case 'wikidot_binding_verify': {
          const job = new WikidotBindingVerifyJob(this.prisma);
          await job.run();
          break;
        }
        default:
          console.warn(`⚠️ Unknown task: ${taskName}`);
      }

      // 更新水位线
      if (taskName !== 'category_index_tick' && taskName !== 'category_index_forecast') {
        await this.updateWatermark(taskName, changeSet);
      }

    } catch (error) {
      console.error(`❌ Task ${taskName} failed:`, error);
      throw error;
    } finally {
      // Release advisory lock and verify it was actually released
      const unlockResult = await this.prisma.$queryRaw<[{ pg_advisory_unlock: boolean }]>`
        SELECT pg_advisory_unlock(hashtext(${taskName}))
      `;
      if (unlockResult?.[0]?.pg_advisory_unlock !== true) {
        console.warn(`⚠️ pg_advisory_unlock returned false for task ${taskName} — lock may not have been held`);
      }
    }
  }

  /**
   * 获取变更集 - 找出自上次水位线后发生变化的 pageVersionId
   */
  private async getChangeSet(taskName: string, forceFullAnalysis = false): Promise<Array<{ id: number; lastChange: Date }>> {
    if (taskName === 'category_index_tick' || taskName === 'category_index_forecast') {
      return [];
    }

    if (forceFullAnalysis) {
      if (taskName === 'user_data_completeness') {
        const result = await this.prisma.$queryRaw<Array<{ id: number; lastChange: Date }>>`
          WITH page_changes AS (
            SELECT pv.id, pv."updatedAt" as "lastChange"
            FROM "PageVersion" pv
            WHERE pv."validTo" IS NULL AND pv."isDeleted" = false
          ),
          forum_changes AS (
            SELECT
              (-u.id) AS id,
              MAX(COALESCE(fp."editedAt", fp."createdAt", fp."syncedAt")) AS "lastChange"
            FROM "ForumPost" fp
            JOIN "User" u ON u."wikidotId" = fp."createdByWikidotId"
            WHERE fp."isDeleted" = false
              AND fp."createdByType" = 'user'
              AND COALESCE(fp."editedAt", fp."createdAt", fp."syncedAt") IS NOT NULL
            GROUP BY u.id
          )
          SELECT id, "lastChange"
          FROM (
            SELECT id, "lastChange" FROM page_changes
            UNION ALL
            SELECT id, "lastChange" FROM forum_changes
          ) all_changes
          ORDER BY "lastChange" DESC
        `;
        return result;
      }

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

    // 如果没有水位线，进行全量分析
    if (!cursorTs) {
      console.log(`No watermark found for task ${taskName}, performing full analysis`);
      if (taskName === 'user_data_completeness') {
        const result = await this.prisma.$queryRaw<Array<{ id: number; lastChange: Date }>>`
          WITH page_changes AS (
            SELECT pv.id, pv."updatedAt" as "lastChange"
            FROM "PageVersion" pv
            WHERE pv."validTo" IS NULL AND pv."isDeleted" = false
          ),
          forum_changes AS (
            SELECT
              (-u.id) AS id,
              MAX(COALESCE(fp."editedAt", fp."createdAt", fp."syncedAt")) AS "lastChange"
            FROM "ForumPost" fp
            JOIN "User" u ON u."wikidotId" = fp."createdByWikidotId"
            WHERE fp."isDeleted" = false
              AND fp."createdByType" = 'user'
              AND COALESCE(fp."editedAt", fp."createdAt", fp."syncedAt") IS NOT NULL
            GROUP BY u.id
          )
          SELECT id, "lastChange"
          FROM (
            SELECT id, "lastChange" FROM page_changes
            UNION ALL
            SELECT id, "lastChange" FROM forum_changes
          ) all_changes
          ORDER BY "lastChange" DESC
        `;
        return result;
      }

      const result = await this.prisma.$queryRaw<Array<{ id: number; lastChange: Date }>>`
        SELECT pv.id, pv."updatedAt" as "lastChange"
        FROM "PageVersion" pv
        WHERE pv."validTo" IS NULL AND pv."isDeleted" = false
      `;
      return result;
    }

    // 增量查询：找出自水位线后变更的 pageVersion（包含等于游标时间的记录，避免并列时间戳被跳过）
    // 修复：确保正确处理 PageVersion 的更新
    //
    // 时区处理说明：
    // - 数据库使用 timestamp without time zone，存储的是本地时间
    // - Prisma 读取时错误地将其解释为 UTC 时间，但数值部分是正确的
    // - 使用 ISO 字符串去掉 Z 后缀，让 PostgreSQL 将其解释为不带时区的本地时间
    const cursorTsStr = cursorTs.toISOString().replace('Z', '');
    let result: Array<{ id: number; lastChange: Date }>;
    if (taskName === 'user_data_completeness') {
      result = await this.prisma.$queryRaw<Array<{ id: number; lastChange: Date }>>`
        WITH cursor_check AS (
          SELECT ${cursorTsStr}::timestamp as cursor_ts
        ),
        -- 检查投票变化
        vote_changes AS (
          SELECT v."pageVersionId" AS id, max(v."timestamp") AS changed_at
          FROM "Vote" v
          CROSS JOIN cursor_check c
          WHERE v."timestamp" >= c.cursor_ts
          GROUP BY v."pageVersionId"
        ),
        -- 检查修订版本变化
        revision_changes AS (
          SELECT r."pageVersionId" AS id, max(r."timestamp") AS changed_at
          FROM "Revision" r
          CROSS JOIN cursor_check c
          WHERE r."timestamp" >= c.cursor_ts
          GROUP BY r."pageVersionId"
        ),
        -- 检查归属变化
        attribution_changes AS (
          SELECT a."pageVerId" AS id, max(a."date") AS changed_at
          FROM "Attribution" a
          CROSS JOIN cursor_check c
          WHERE a."date" IS NOT NULL AND a."date" >= c.cursor_ts
          GROUP BY a."pageVerId"
        ),
        -- 检查页面版本本身的更新（重要：包括新创建的页面）
        page_version_changes AS (
          SELECT pv.id, pv."updatedAt" AS changed_at
          FROM "PageVersion" pv
          CROSS JOIN cursor_check c
          WHERE pv."updatedAt" >= c.cursor_ts
            AND pv."validTo" IS NULL
            AND pv."isDeleted" = false
        ),
        -- 检查页面表的更新
        page_changes AS (
          SELECT pv.id, p."updatedAt" AS changed_at
          FROM "Page" p
          JOIN "PageVersion" pv ON pv."pageId" = p.id AND pv."validTo" IS NULL
          CROSS JOIN cursor_check c
          WHERE p."updatedAt" >= c.cursor_ts
            AND pv."isDeleted" = false
        ),
        -- 检查论坛发帖变化（负 userId 作为增量变更标记）
        forum_changes AS (
          SELECT
            (-u.id) AS id,
            MAX(COALESCE(fp."editedAt", fp."createdAt", fp."syncedAt")) AS changed_at
          FROM "ForumPost" fp
          JOIN "User" u ON u."wikidotId" = fp."createdByWikidotId"
          CROSS JOIN cursor_check c
          WHERE fp."isDeleted" = false
            AND fp."createdByType" = 'user'
            AND COALESCE(fp."editedAt", fp."createdAt", fp."syncedAt") >= c.cursor_ts
          GROUP BY u.id
        )
        SELECT id, max(changed_at) AS "lastChange"
        FROM (
          SELECT id, changed_at FROM vote_changes
          UNION ALL
          SELECT id, changed_at FROM revision_changes
          UNION ALL
          SELECT id, changed_at FROM attribution_changes
          UNION ALL
          SELECT id, changed_at FROM page_version_changes
          UNION ALL
          SELECT id, changed_at FROM page_changes
          UNION ALL
          SELECT id, changed_at FROM forum_changes
        ) all_changes
        GROUP BY id
        ORDER BY "lastChange" DESC
      `;
    } else {
      result = await this.prisma.$queryRaw<Array<{ id: number; lastChange: Date }>>`
        WITH cursor_check AS (
          SELECT ${cursorTsStr}::timestamp as cursor_ts
        ),
        -- 检查投票变化
        vote_changes AS (
          SELECT v."pageVersionId" AS id, max(v."timestamp") AS changed_at
          FROM "Vote" v
          CROSS JOIN cursor_check c
          WHERE v."timestamp" >= c.cursor_ts
          GROUP BY v."pageVersionId"
        ),
        -- 检查修订版本变化
        revision_changes AS (
          SELECT r."pageVersionId" AS id, max(r."timestamp") AS changed_at
          FROM "Revision" r
          CROSS JOIN cursor_check c
          WHERE r."timestamp" >= c.cursor_ts
          GROUP BY r."pageVersionId"
        ),
        -- 检查归属变化
        attribution_changes AS (
          SELECT a."pageVerId" AS id, max(a."date") AS changed_at
          FROM "Attribution" a
          CROSS JOIN cursor_check c
          WHERE a."date" IS NOT NULL AND a."date" >= c.cursor_ts
          GROUP BY a."pageVerId"
        ),
        -- 检查页面版本本身的更新（重要：包括新创建的页面）
        page_version_changes AS (
          SELECT pv.id, pv."updatedAt" AS changed_at
          FROM "PageVersion" pv
          CROSS JOIN cursor_check c
          WHERE pv."updatedAt" >= c.cursor_ts
            AND pv."validTo" IS NULL
            AND pv."isDeleted" = false
        ),
        -- 检查页面表的更新
        page_changes AS (
          SELECT pv.id, p."updatedAt" AS changed_at
          FROM "Page" p
          JOIN "PageVersion" pv ON pv."pageId" = p.id AND pv."validTo" IS NULL
          CROSS JOIN cursor_check c
          WHERE p."updatedAt" >= c.cursor_ts
            AND pv."isDeleted" = false
        )
        SELECT id, max(changed_at) AS "lastChange"
        FROM (
          SELECT id, changed_at FROM vote_changes
          UNION ALL
          SELECT id, changed_at FROM revision_changes
          UNION ALL
          SELECT id, changed_at FROM attribution_changes
          UNION ALL
          SELECT id, changed_at FROM page_version_changes
          UNION ALL
          SELECT id, changed_at FROM page_changes
        ) all_changes
        GROUP BY id
        ORDER BY "lastChange" DESC
      `;
    }

    console.log(`Task ${taskName}: Found ${result.length} changed records since ${cursorTs.toISOString()}`);
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

    // 创建临时表（使用 IF NOT EXISTS 防止重复创建，ON COMMIT DROP 确保清理）
    await this.prisma.$executeRaw`
      DROP TABLE IF EXISTS temp_changed_versions
    `;
    await this.prisma.$executeRaw`
      CREATE TEMP TABLE temp_changed_versions (id int PRIMARY KEY)
    `;

    // 插入数据到临时表
    await this.prisma.$executeRaw`
      INSERT INTO temp_changed_versions SELECT unnest(${pageVersionIds}::int[])
    `;

    // 分析临时表
    await this.prisma.$executeRaw`
      ANALYZE temp_changed_versions
    `;
      
    // 插入或更新PageStats
    await this.prisma.$executeRaw`
      WITH vote_stats AS (
        SELECT v."pageVersionId" AS id,
               COUNT(*) FILTER (WHERE v.direction = 1) AS uv,
               COUNT(*) FILTER (WHERE v.direction = -1) AS dv
        FROM "LatestVote" v
        WHERE v."pageVersionId" = ANY(${pageVersionIds}::int[])
        GROUP BY v."pageVersionId"
      )
      INSERT INTO "PageStats" ("pageVersionId", uv, dv, "wilson95", controversy, "likeRatio")
      SELECT tcv.id, 
             COALESCE(vs.uv, 0), 
             COALESCE(vs.dv, 0),
             f_wilson_lower_bound(COALESCE(vs.uv, 0)::int, COALESCE(vs.dv, 0)::int) AS wilson95,
             f_controversy(COALESCE(vs.uv, 0)::int, COALESCE(vs.dv, 0)::int) AS controversy,
             CASE WHEN COALESCE(vs.uv, 0) + COALESCE(vs.dv, 0) = 0 THEN 0 
                  ELSE COALESCE(vs.uv, 0)::float / (COALESCE(vs.uv, 0) + COALESCE(vs.dv, 0)) END AS "likeRatio"
      FROM temp_changed_versions tcv
      LEFT JOIN vote_stats vs ON tcv.id = vs.id
      ON CONFLICT ("pageVersionId") DO UPDATE SET
        uv = EXCLUDED.uv,
        dv = EXCLUDED.dv,
        "wilson95" = EXCLUDED."wilson95",
        controversy = EXCLUDED.controversy,
        "likeRatio" = EXCLUDED."likeRatio"
    `;

    // 删除临时表
    await this.prisma.$executeRaw`
      DROP TABLE temp_changed_versions
    `;

    console.log(`✅ PageStats updated for ${changeSet.length} page versions`);
  }

  /**
   * 更新UserStats - 使用完整的UserRatingJob进行计算
   */
  private async updateUserStats(changeSet: Array<{ id: number; lastChange: Date }>) {
    if (changeSet.length === 0) return;

    console.log(`👥 Updating UserStats using UserRatingJob...`);

    // 导入 UserRatingJob
    const { UserRatingSystem } = await import('./UserRatingJob.js');
    
    // 创建 UserRatingSystem 实例并运行完整的评分计算
    const ratingSystem = new UserRatingSystem(this.prisma);
    await ratingSystem.updateUserRatingsAndRankings();

    console.log(`✅ UserStats updated with complete rating calculations`);
  }


  /**
   * 更新日聚合数据
   */
  private async updateDailyAggregates(changeSet: Array<{ id: number; lastChange: Date }>, options?: { forceFullHistory?: boolean }) {
    if (changeSet.length === 0 && !options?.forceFullHistory) return;

    console.log(`📅 Updating daily aggregates...`);

    // 检查是否需要初始化历史数据
    const existingRecordsCount = await this.prisma.pageDailyStats.count();
    const shouldInitializeHistory = existingRecordsCount === 0 || options?.forceFullHistory;

    const startOfDay = (input: Date) => {
      const value = new Date(input);
      value.setHours(0, 0, 0, 0);
      return value;
    };

    const addDays = (input: Date, days: number) => {
      const value = new Date(input);
      value.setDate(value.getDate() + days);
      return value;
    };

    let windowStart: Date | null = null;
    let windowEnd: Date | null = null;

    if (shouldInitializeHistory) {
      console.log('🔄 Initializing complete historical daily aggregates...');

      const range = await this.prisma.$queryRaw<Array<{ min_ts: Date | null; max_ts: Date | null }>>`
        WITH ranges AS (
          SELECT MIN(v."timestamp") AS min_ts, MAX(v."timestamp") AS max_ts FROM "Vote" v
          UNION ALL
          SELECT MIN(r."timestamp") AS min_ts, MAX(r."timestamp") AS max_ts FROM "Revision" r
          UNION ALL
          SELECT MIN(a."date") AS min_ts, MAX(a."date") AS max_ts FROM "Attribution" a WHERE a."date" IS NOT NULL
        )
        SELECT MIN(min_ts) AS min_ts, MAX(max_ts) AS max_ts FROM ranges
      `;

      const minTs = range[0]?.min_ts || null;
      const maxTs = range[0]?.max_ts || null;

      if (!minTs || !maxTs) {
        console.log('ℹ️ No historical activity detected. Skipping daily aggregates initialization.');
        return;
      }

      windowStart = startOfDay(new Date(minTs));
      windowEnd = addDays(startOfDay(new Date(maxTs)), 1);

      console.log(`📊 Rebuilding aggregates window ${windowStart.toISOString().slice(0, 10)} → ${windowEnd.toISOString().slice(0, 10)}`);
    } else {
      const minChange = changeSet.reduce<Date | null>((acc, item) => {
        const change = item.lastChange ? new Date(item.lastChange) : null;
        if (!change) return acc;
        return !acc || change < acc ? change : acc;
      }, null);

      const rollingWindowStart = startOfDay(addDays(new Date(), -30));
      const effectiveMin = minChange ? startOfDay(minChange) : null;

      windowStart = effectiveMin && effectiveMin < rollingWindowStart ? effectiveMin : rollingWindowStart;
      windowEnd = addDays(startOfDay(new Date()), 1);

      console.log(`📈 Incremental aggregates window ${windowStart.toISOString().slice(0, 10)} → ${windowEnd.toISOString().slice(0, 10)}`);
    }

    if (!windowStart || !windowEnd || windowStart >= windowEnd) {
      console.log('ℹ️ Daily aggregates window is empty. Skipping update.');
      return;
    }

    const startIso = windowStart.toISOString();
    const endIso = windowEnd.toISOString();

    await this.prisma.$executeRaw`
      WITH live_pv AS (
        SELECT id AS "pageVersionId", "pageId"
        FROM "PageVersion"
        WHERE "validTo" IS NULL AND "isDeleted" = false
      ),
      agg AS (
        SELECT 
          t."pageId",
          t.dt::date AS date,
          SUM(t.votes_up)::int       AS votes_up,
          SUM(t.votes_down)::int     AS votes_down,
          SUM(t.total_votes)::int    AS total_votes,
          SUM(t.unique_voters)::int  AS unique_voters,
          SUM(t.revisions)::int      AS revisions
        FROM (
          SELECT 
            pv."pageId",
            date_trunc('day', v."timestamp") AS dt,
            COUNT(*) FILTER (WHERE v.direction = 1)      AS votes_up,
            COUNT(*) FILTER (WHERE v.direction = -1)     AS votes_down,
            COUNT(*) FILTER (WHERE v.direction != 0)     AS total_votes,
            COUNT(DISTINCT v."userId") FILTER (WHERE v."userId" IS NOT NULL) AS unique_voters,
            0::bigint                                   AS revisions
          FROM "Vote" v
          JOIN live_pv pv ON pv."pageVersionId" = v."pageVersionId"
          WHERE v."timestamp" >= ${startIso}::timestamp AND v."timestamp" < ${endIso}::timestamp
          GROUP BY pv."pageId", date_trunc('day', v."timestamp")

          UNION ALL

          SELECT 
            pv."pageId",
            date_trunc('day', r."timestamp") AS dt,
            0::bigint, 0::bigint, 0::bigint, 0::bigint,
            COUNT(*) AS revisions
          FROM "Revision" r
          JOIN live_pv pv ON pv."pageVersionId" = r."pageVersionId"
          WHERE r."timestamp" >= ${startIso}::timestamp AND r."timestamp" < ${endIso}::timestamp
          GROUP BY pv."pageId", date_trunc('day', r."timestamp")
        ) t
        GROUP BY t."pageId", t.dt
      )
      INSERT INTO "PageDailyStats" ("pageId", date, votes_up, votes_down, total_votes, unique_voters, revisions)
      SELECT "pageId", date, votes_up, votes_down, total_votes, unique_voters, revisions
      FROM agg
      ON CONFLICT ("pageId", date) DO UPDATE SET
        votes_up      = EXCLUDED.votes_up,
        votes_down    = EXCLUDED.votes_down,
        total_votes   = EXCLUDED.total_votes,
        unique_voters = EXCLUDED.unique_voters,
        revisions     = EXCLUDED.revisions
    `;

    await this.prisma.$executeRaw`
      WITH effective_attributions AS (
        SELECT a.*
        FROM (
          SELECT 
            a.*,
            BOOL_OR(a.type <> 'SUBMITTER') OVER (PARTITION BY a."pageVerId") AS has_non_submitter
          FROM "Attribution" a
        ) a
        WHERE NOT (a.has_non_submitter AND a.type = 'SUBMITTER')
      ),
      agg AS (
        SELECT 
          x."userId",
          x.dt::date AS date,
          SUM(x.votes_cast)::int     AS votes_cast,
          SUM(x.pages_created)::int  AS pages_created,
          MAX(x.last_activity)       AS last_activity
        FROM (
          SELECT 
            v."userId",
            date_trunc('day', v."timestamp") AS dt,
            COUNT(*) AS votes_cast,
            0::bigint AS pages_created,
            MAX(v."timestamp") AS last_activity
          FROM "Vote" v
          WHERE v."userId" IS NOT NULL
            AND v."timestamp" >= ${startIso}::timestamp AND v."timestamp" < ${endIso}::timestamp
          GROUP BY v."userId", date_trunc('day', v."timestamp")

          UNION ALL

          SELECT 
            r."userId",
            date_trunc('day', r."timestamp") AS dt,
            0::bigint AS votes_cast,
            0::bigint AS pages_created,
            MAX(r."timestamp") AS last_activity
          FROM "Revision" r
          WHERE r."userId" IS NOT NULL
            AND r."timestamp" >= ${startIso}::timestamp AND r."timestamp" < ${endIso}::timestamp
          GROUP BY r."userId", date_trunc('day', r."timestamp")

          UNION ALL

          SELECT 
            a."userId",
            date_trunc('day', a."date") AS dt,
            0::bigint AS votes_cast,
            COUNT(DISTINCT pv."pageId") AS pages_created,
            MAX(a."date") AS last_activity
          FROM effective_attributions a
          JOIN "PageVersion" pv ON pv.id = a."pageVerId"
          WHERE a."userId" IS NOT NULL
            AND a."date" IS NOT NULL
            AND a."date" >= ${startIso}::timestamp AND a."date" < ${endIso}::timestamp
          GROUP BY a."userId", date_trunc('day', a."date")
        ) x
        GROUP BY x."userId", x.dt
      )
      INSERT INTO "UserDailyStats" ("userId", date, votes_cast, pages_created, last_activity)
      SELECT "userId", date, votes_cast, pages_created, last_activity
      FROM agg
      ON CONFLICT ("userId", date) DO UPDATE SET
        votes_cast    = EXCLUDED.votes_cast,
        pages_created = EXCLUDED.pages_created,
        last_activity = EXCLUDED.last_activity
    `;

    const windowDays = Math.ceil((windowEnd.getTime() - windowStart.getTime()) / (24 * 60 * 60 * 1000));
    console.log(`✅ Daily aggregates refreshed over ${windowDays} day(s)`);
  }

  /**
   * 更新用户数据完整性
   * 基于变更集中涉及的用户进行增量更新
   */
  private async updateUserDataCompleteness(changeSet: Array<{ id: number; lastChange: Date }>) {
    if (changeSet.length === 0) return;
    
    console.log('🔧 Updating user data completeness...');
    
    // 约定：id > 0 为 pageVersionId；id < 0 为 forum 变更标记（其绝对值为 userId）
    const pageVersionIds = changeSet.filter(c => c.id > 0).map(c => c.id);
    const forumUserIds = Array.from(new Set(
      changeSet
        .filter(c => c.id < 0)
        .map(c => Math.abs(c.id))
    ));
    
    const affectedUsers = await this.prisma.$queryRaw<Array<{ userId: number }>>`
      WITH effective_attributions AS (
        SELECT a.*
        FROM (
          SELECT 
            a.*,
            BOOL_OR(a.type <> 'SUBMITTER') OVER (PARTITION BY a."pageVerId") AS has_non_submitter
          FROM "Attribution" a
          WHERE a."pageVerId" = ANY(${pageVersionIds}::int[])
        ) a
        WHERE NOT (a.has_non_submitter AND a.type = 'SUBMITTER')
      ),
      page_affected_users AS (
        SELECT DISTINCT "userId"
        FROM (
          -- 投票的用户
          SELECT v."userId"
          FROM "Vote" v
          WHERE v."pageVersionId" = ANY(${pageVersionIds}::int[])
            AND v."userId" IS NOT NULL

          UNION

          -- 创建修订的用户
          SELECT r."userId"
          FROM "Revision" r
          WHERE r."pageVersionId" = ANY(${pageVersionIds}::int[])
            AND r."userId" IS NOT NULL

          UNION

          -- 页面归属的用户
          SELECT a."userId"
          FROM effective_attributions a
          WHERE a."pageVerId" = ANY(${pageVersionIds}::int[])
            AND a."userId" IS NOT NULL
        ) affected_users
      ),
      forum_affected_users AS (
        SELECT u.id AS "userId"
        FROM "User" u
        WHERE u.id = ANY(${forumUserIds}::int[])
      )
      SELECT DISTINCT "userId" 
      FROM (
        SELECT "userId" FROM page_affected_users
        UNION
        SELECT "userId" FROM forum_affected_users
      ) affected_users
    `;
    
    if (affectedUsers.length === 0) return;
    
    const userIds = affectedUsers.map(u => u.userId);
    console.log(`  📝 Updating data completeness for ${userIds.length} affected users`);

    // 针对特定用户进行更新
    await this.prisma.$executeRaw`
      WITH effective_attributions AS (
        SELECT a.*
        FROM (
          SELECT
            a.*,
            BOOL_OR(a.type <> 'SUBMITTER') OVER (PARTITION BY a."pageVerId") AS has_non_submitter
          FROM "Attribution" a
        ) a
        WHERE NOT (a.has_non_submitter AND a.type = 'SUBMITTER')
      ),
      all_activity AS (
        SELECT
          v."userId",
          v."timestamp" AS activity_time,
          'vote'::text AS activity_type,
          'Voted on page'::text AS activity_details
        FROM "Vote" v
        WHERE v."userId" = ANY(${userIds}::int[])

        UNION ALL

        SELECT
          r."userId",
          r."timestamp" AS activity_time,
          'revision'::text AS activity_type,
          CONCAT('Created revision #', r."wikidotId") AS activity_details
        FROM "Revision" r
        WHERE r."userId" = ANY(${userIds}::int[])

        UNION ALL

        SELECT
          a."userId",
          a."date" AS activity_time,
          'attribution'::text AS activity_type,
          CONCAT('Attributed as ', a."type") AS activity_details
        FROM effective_attributions a
        WHERE a."userId" = ANY(${userIds}::int[])
          AND a."date" IS NOT NULL

        UNION ALL

        SELECT
          u.id AS "userId",
          fp."createdAt" AS activity_time,
          'forum_post'::text AS activity_type,
          'Forum post'::text AS activity_details
        FROM "ForumPost" fp
        JOIN "User" u ON u."wikidotId" = fp."createdByWikidotId"
        WHERE u.id = ANY(${userIds}::int[])
          AND fp."createdAt" IS NOT NULL
          AND fp."isDeleted" = false
          AND fp."createdByType" = 'user'
      ),
      user_first_activity AS (
        SELECT DISTINCT ON ("userId")
          "userId",
          activity_time AS first_activity,
          activity_type,
          activity_details
        FROM all_activity
        ORDER BY "userId", activity_time ASC
      ),
      user_last_activity AS (
        SELECT
          "userId",
          MAX(activity_time) AS last_activity
        FROM all_activity
        GROUP BY "userId"
      ),
      merged AS (
        SELECT
          COALESCE(ufa."userId", ula."userId") AS "userId",
          ufa.first_activity,
          ufa.activity_type,
          ufa.activity_details,
          ula.last_activity
        FROM user_first_activity ufa
        FULL OUTER JOIN user_last_activity ula ON ula."userId" = ufa."userId"
      )
      UPDATE "User" u
      SET
        "firstActivityAt" = CASE
          WHEN m.first_activity IS NULL THEN u."firstActivityAt"
          WHEN u."firstActivityAt" IS NULL OR u."firstActivityAt" > m.first_activity
          THEN m.first_activity
          ELSE u."firstActivityAt"
        END,
        "firstActivityType" = CASE
          WHEN m.first_activity IS NULL THEN u."firstActivityType"
          WHEN u."firstActivityAt" IS NULL OR u."firstActivityAt" > m.first_activity
          THEN m.activity_type
          ELSE u."firstActivityType"
        END,
        "firstActivityDetails" = CASE
          WHEN m.first_activity IS NULL THEN u."firstActivityDetails"
          WHEN u."firstActivityAt" IS NULL OR u."firstActivityAt" > m.first_activity
          THEN m.activity_details
          ELSE u."firstActivityDetails"
        END,
        "lastActivityAt" = CASE
          WHEN m.last_activity IS NULL THEN u."lastActivityAt"
          ELSE GREATEST(COALESCE(u."lastActivityAt", '1900-01-01'::timestamp), m.last_activity)
        END,
        "username" = CASE
          WHEN u."username" IS NULL AND u."wikidotId" < 0 THEN CONCAT('guest_', ABS(u."wikidotId"))
          WHEN u."username" IS NULL AND u."displayName" IS NULL THEN '(user deleted)'
          WHEN u."username" IS NULL AND u."displayName" IS NOT NULL THEN LOWER(REPLACE(u."displayName", ' ', '_'))
          ELSE u."username"
        END
      FROM merged m
      WHERE u.id = m."userId"
        AND u.id = ANY(${userIds}::int[])
    `;
    
    console.log('✅ User data completeness updated');
  }

  /**
   * 更新用户社交分析
   * 基于变更集中涉及的用户进行增量更新
   */
  private async updateUserSocialAnalysis(changeSet: Array<{ id: number; lastChange: Date }>) {
    if (changeSet.length === 0) return;
    
    console.log('🔍 Updating user social analysis...');
    
    // 从变更集中提取受影响的用户
    const pageVersionIds = changeSet.map(c => c.id);
    
    // 找出有新投票活动的用户
    const votingUsers = await this.prisma.$queryRaw<Array<{ userId: number }>>`
      SELECT DISTINCT v."userId"
      FROM "Vote" v
      WHERE v."pageVersionId" = ANY(${pageVersionIds}::int[])
        AND v."userId" IS NOT NULL
        AND v.direction != 0
    `;
    
    if (votingUsers.length === 0) {
      console.log('  ⏭️ No voting activity to analyze, skipping...');
      return;
    }
    
    const userIds = votingUsers.map(u => u.userId);
    console.log(`  📊 Analyzing social patterns for ${userIds.length} users`);

    // 更新标签偏好（仅针对有新投票的用户）
    await this.prisma.$executeRaw`
      WITH user_tag_votes AS (
        SELECT 
          v."userId",
          unnest(pv.tags) as tag,
          v.direction,
          v.timestamp
        FROM "Vote" v
        JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
        WHERE v."userId" = ANY(${userIds}::int[])
          AND v.direction != 0
          AND pv.tags IS NOT NULL
          AND array_length(pv.tags, 1) > 0
          AND pv."validTo" IS NULL
          AND pv."isDeleted" = false
      ),
      tag_stats AS (
        SELECT 
          "userId",
          tag,
          COUNT(*) FILTER (WHERE direction = 1) as upvote_count,
          COUNT(*) FILTER (WHERE direction = -1) as downvote_count,
          COUNT(*) as total_votes,
          MAX(timestamp) as last_vote_at
        FROM user_tag_votes
        WHERE tag NOT IN ('页面', '重定向', '管理', '_cc')
        GROUP BY "userId", tag
        HAVING COUNT(*) >= 3
      )
      INSERT INTO "UserTagPreference" (
        "userId", tag, "upvoteCount", "downvoteCount", 
        "totalVotes", "lastVoteAt", "createdAt", "updatedAt"
      )
      SELECT 
        "userId", tag, upvote_count, downvote_count,
        total_votes, last_vote_at, NOW(), NOW()
      FROM tag_stats
      ON CONFLICT ("userId", tag) DO UPDATE SET
        "upvoteCount" = EXCLUDED."upvoteCount",
        "downvoteCount" = EXCLUDED."downvoteCount",
        "totalVotes" = EXCLUDED."totalVotes",
        "lastVoteAt" = EXCLUDED."lastVoteAt",
        "updatedAt" = NOW()
    `;
    
    // 更新用户投票交互（基于新的投票活动）
    await this.prisma.$executeRaw`
      WITH effective_attributions AS (
        SELECT a.*
        FROM (
          SELECT 
            a.*,
            BOOL_OR(a.type <> 'SUBMITTER') OVER (PARTITION BY a."pageVerId") AS has_non_submitter
          FROM "Attribution" a
        ) a
        WHERE NOT (a.has_non_submitter AND a.type = 'SUBMITTER')
      ),
      affected_pairs AS (
        SELECT DISTINCT 
          v."userId" AS from_user_id,
          a."userId" AS to_user_id
        FROM "Vote" v
        JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
        JOIN effective_attributions a ON a."pageVerId" = pv.id
        WHERE v."pageVersionId" = ANY(${pageVersionIds}::int[])
          AND v."userId" IS NOT NULL
          AND a."userId" IS NOT NULL
          AND v."userId" != a."userId"
          AND v.direction != 0
      ),
      all_interactions AS (
        SELECT 
          v."userId" AS from_user_id,
          a."userId" AS to_user_id,
          v.direction,
          v.timestamp
        FROM "Vote" v
        JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
        JOIN effective_attributions a ON a."pageVerId" = pv.id
        WHERE v."userId" IS NOT NULL
          AND a."userId" IS NOT NULL
          AND v."userId" != a."userId"
          AND v.direction != 0
          AND pv."validTo" IS NULL
          AND pv."isDeleted" = false
      ),
      interaction_stats AS (
        SELECT 
          ai.from_user_id,
          ai.to_user_id,
          COUNT(*) FILTER (WHERE ai.direction = 1) AS upvote_count,
          COUNT(*) FILTER (WHERE ai.direction = -1) AS downvote_count,
          COUNT(*) AS total_votes,
          MAX(ai.timestamp) AS last_vote_at
        FROM all_interactions ai
        JOIN affected_pairs ap
          ON ai.from_user_id = ap.from_user_id
         AND ai.to_user_id = ap.to_user_id
        GROUP BY ai.from_user_id, ai.to_user_id
      )
      INSERT INTO "UserVoteInteraction" (
        "fromUserId", "toUserId", "upvoteCount", "downvoteCount",
        "totalVotes", "lastVoteAt", "createdAt", "updatedAt"
      )
      SELECT 
        from_user_id, to_user_id, upvote_count, downvote_count,
        total_votes, last_vote_at, NOW(), NOW()
      FROM interaction_stats
      WHERE total_votes > 0
      ON CONFLICT ("fromUserId", "toUserId") DO UPDATE SET
        "upvoteCount" = EXCLUDED."upvoteCount",
        "downvoteCount" = EXCLUDED."downvoteCount",
        "totalVotes" = EXCLUDED."totalVotes",
        "lastVoteAt" = EXCLUDED."lastVoteAt",
        "updatedAt" = NOW()
    `;
    
    console.log('✅ User social analysis updated');
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
        -- 60-day active users: any user with lastActivityAt within past 60 days
        (SELECT COUNT(*) FROM "User" WHERE "lastActivityAt" IS NOT NULL AND "lastActivityAt" >= (${today}::date - INTERVAL '60 days')) as "activeUsers",
        (SELECT COUNT(*) FROM "Page" WHERE "isDeleted" IS NOT TRUE) as "totalPages",
        (
          SELECT COUNT(*)
          FROM "Vote" v
          JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
          WHERE pv."validTo" IS NULL AND pv."isDeleted" = false
        ) as "totalVotes",
        (SELECT COUNT(*) FROM "User" WHERE date("firstActivityAt") = ${today}::date) as "newUsersToday",
        (SELECT COUNT(*) FROM "Page" WHERE date("firstPublishedAt") = ${today}::date) as "newPagesToday",
        (
          SELECT COUNT(*)
          FROM "Vote" v
          JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
          WHERE date(v."timestamp") = ${today}::date
            AND pv."validTo" IS NULL AND pv."isDeleted" = false
        ) as "newVotesToday",
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
   * Refresh SiteStats.updatedAt when no changes occurred but we still ran the scheduler.
   */
  private async refreshSiteStatsTimestamp() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const updatedToday = await this.prisma.$executeRaw<number>`
      UPDATE "SiteStats"
      SET "updatedAt" = now()
      WHERE date = ${today}::date
    `;

    if (!updatedToday) {
      await this.prisma.$executeRaw`
        UPDATE "SiteStats" AS s
        SET "updatedAt" = now()
        FROM (
          SELECT date
          FROM "SiteStats"
          ORDER BY date DESC
          LIMIT 1
        ) latest
        WHERE s.date = latest.date
      `;
    }

    console.log('⏱️ Site statistics timestamp refreshed (no data changes)');
  }

  /**
   * 更新Voting时间序列缓存
   */
  private async updateVotingTimeSeriesCache(changeSet: Array<{ id: number; lastChange: Date }>) {
    if (changeSet.length === 0) return;

    console.log(`📊 Updating voting time series cache for changes...`);

    // 对于voting cache，我们使用专门的Job来处理，因为它有自己的逻辑来确定哪些页面和用户需要更新
    const votingCacheJob = new VotingTimeSeriesCacheJob(this.prisma);
    
    // 使用增量更新模式，查看最近24小时的变化
    await votingCacheJob.execute({
      forceFullRebuild: false,
      lookbackHours: 24,
      batchSize: 200
    });

    console.log('✅ Voting time series cache updated');
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
      console.error('❌ Failed to refresh mv_top_pages_30d:', error);
    }

    try {
      // 刷新站点概览物化视图
      await this.prisma.$executeRaw`REFRESH MATERIALIZED VIEW mv_site_overview`;
      console.log('✅ mv_site_overview refreshed');
    } catch (error) {
      console.error('❌ Failed to refresh mv_site_overview:', error);
      // 非关键性操作，继续执行其他任务
    }
  }

  /**
   * 更新搜索索引
   */
  private async updateSearchIndex() {
    console.log('🔍 Updating search index...');
    
    try {
      // const result = await updateSearchIndexIncremental();
      // console.log(`✅ Search index updated: ${result.pagesUpdated} pages, ${result.usersUpdated} users`);
      console.log('⚠️ Search index update temporarily disabled');
    } catch (error) {
      console.error('❌ Failed to update search index:', error);
      throw error;
    }
  }

  /**
   * 更新系列统计
   */
  private async updateSeriesStats() {
    console.log('📊 Updating series statistics...');
    
    try {
      // 获取所有SCP-CN页面
      const scpPages = await this.prisma.$queryRaw<Array<{
        url: string;
        pageId: number;
        rating: number | null;
      }>>`
        SELECT 
          p."currentUrl" AS url,
          p.id as "pageId",
          pv.rating
        FROM "Page" p
        INNER JOIN "PageVersion" pv ON p.id = pv."pageId"
        WHERE pv."validTo" IS NULL 
          AND pv."isDeleted" = false
          AND p."currentUrl" ~ '/scp-cn-[0-9]{3,4}($|/)'
          AND p."currentUrl" NOT LIKE '%deleted:%'
          AND '原创' = ANY(pv.tags)
          AND NOT ('待删除' = ANY(pv.tags))
          AND NOT ('待刪除' = ANY(pv.tags))
      `;
      
      // 统计每个系列的使用情况（按编号去重）
      const seriesUsage = new Map<number, {
        numbers: Set<number>; // 已使用编号集合，去重避免同一编号多页面导致溢出
        milestonePageId?: number;
        milestoneRating?: number;
      }>();
      
      for (const page of scpPages) {
        const match = page.url.match(/\/scp-cn-(\d{3,4})(?:$|\/)/);
        if (match) {
          const num = parseInt(match[1]);
          let seriesNumber: number;
          
          // 系列1有效编号为 002-999（共998个）；排除001
          if (num >= 2 && num <= 999) {
            seriesNumber = 1;
          } else if (num >= 1000 && num <= 9999) {
            seriesNumber = Math.floor(num / 1000) + 1;
          } else {
            continue; // 超出范围
          }
          
          const stats = seriesUsage.get(seriesNumber) || { numbers: new Set<number>() };
          stats.numbers.add(num);
          
          // 记录里程碑页面（评分最高的页面）
          if (!stats.milestonePageId || (page.rating && page.rating > (stats.milestoneRating || 0))) {
            stats.milestonePageId = page.pageId;
            stats.milestoneRating = page.rating || 0;
          }
          
          seriesUsage.set(seriesNumber, stats);
        }
      }
      
      // 更新数据库
      for (let seriesNumber = 1; seriesNumber <= 10; seriesNumber++) {
        const stats = seriesUsage.get(seriesNumber) || { numbers: new Set<number>() };
        // 系列1使用编号 002-999，共 998 个槽位；其余系列 000-999，共 1000 个
        const totalSlots = seriesNumber === 1 ? 998 : 1000;
        const usedSlots = stats.numbers.size;
        const usagePercentage = (usedSlots / totalSlots) * 100;
        const isOpen = seriesNumber <= 6; // 根据实际情况调整
        
        await this.prisma.seriesStats.upsert({
          where: { seriesNumber },
          update: {
            isOpen,
            usedSlots,
            usagePercentage,
            milestonePageId: stats.milestonePageId,
            lastUpdated: new Date()
          },
          create: {
            seriesNumber,
            isOpen,
            totalSlots,
            usedSlots,
            usagePercentage,
            milestonePageId: stats.milestonePageId,
            lastUpdated: new Date()
          }
        });
      }
      
      console.log('✅ Series statistics updated');
    } catch (error) {
      console.error('❌ Failed to update series statistics:', error);
      throw error;
    }
  }

  /**
   * 为标签生成稳定的整数ID
   */
  private getTagId(tagName: string): number {
    let hash = 0;
    for (let i = 0; i < tagName.length; i++) {
      const char = tagName.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  /**
   * 更新趋势统计
   */
  private async updateTrendingStats() {
    console.log('📈 Updating trending statistics...');
    
    try {
      // 清理过期的趋势数据（可选）
      // 保留最近的数据用于历史分析
      await this.prisma.trendingStats.deleteMany({
        where: {
          calculatedAt: {
            lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) // 删除超过7天的数据
          }
        }
      });
      
      // 1. 24小时热门页面（按Wilson分数增量）
      const trending24h = await this.prisma.$queryRaw<Array<{
        pageId: number;
        title: string;
        currentRating: number;
        currentWilson: number;
        prevWilson: number;
        wilsonGain: number;
        newVotes: number;
      }>>`
        WITH current_stats AS (
          SELECT 
            pv."pageId",
            pv.title,
            pv.rating as current_rating,
            ps."wilson95" as current_wilson
          FROM "PageVersion" pv
          JOIN "PageStats" ps ON pv.id = ps."pageVersionId"
          WHERE pv."validTo" IS NULL 
            AND pv."isDeleted" = false
        ),
        votes_24h AS (
          SELECT 
            pv."pageId",
            COUNT(*) as new_votes,
            COUNT(*) FILTER (WHERE v.direction = 1) as new_upvotes,
            COUNT(*) FILTER (WHERE v.direction = -1) as new_downvotes
          FROM "Vote" v
          JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
          WHERE v."timestamp" >= NOW() - INTERVAL '24 hours'
            AND pv."validTo" IS NULL
          GROUP BY pv."pageId"
        ),
        prev_stats AS (
          SELECT 
            pv."pageId",
            f_wilson_lower_bound(
              COUNT(*) FILTER (WHERE v.direction = 1 AND v."timestamp" < NOW() - INTERVAL '24 hours'),
              COUNT(*) FILTER (WHERE v.direction = -1 AND v."timestamp" < NOW() - INTERVAL '24 hours')
            ) as prev_wilson
          FROM "PageVersion" pv
          LEFT JOIN "Vote" v ON v."pageVersionId" = pv.id
          WHERE pv."validTo" IS NULL
          GROUP BY pv."pageId"
        )
        SELECT 
          cs."pageId",
          cs.title,
          cs.current_rating,
          cs.current_wilson,
          COALESCE(ps.prev_wilson, 0) as prev_wilson,
          cs.current_wilson - COALESCE(ps.prev_wilson, 0) as wilson_gain,
          COALESCE(v24.new_votes, 0) as new_votes
        FROM current_stats cs
        LEFT JOIN votes_24h v24 ON cs."pageId" = v24."pageId"
        LEFT JOIN prev_stats ps ON cs."pageId" = ps."pageId"
        WHERE v24.new_votes > 0
        ORDER BY wilson_gain DESC
        LIMIT 20
      `;
      
      // 保存24小时趋势
      for (let i = 0; i < trending24h.length; i++) {
        const item = trending24h[i];
        await this.prisma.trendingStats.upsert({
          where: {
            statType_period_entityId_entityType: {
              statType: 'wilson_gain',
              period: '24h',
              entityId: item.pageId,
              entityType: 'page'
            }
          },
          update: {
            name: item.title || `Page ${item.pageId}`,
            score: new Prisma.Decimal(item.wilsonGain || 0),
            metadata: {
              currentRating: item.currentRating,
              currentWilson: item.currentWilson,
              prevWilson: item.prevWilson,
              newVotes: item.newVotes,
              rank: i + 1
            },
            calculatedAt: new Date()
          },
          create: {
            statType: 'wilson_gain',
            name: item.title || `Page ${item.pageId}`,
            entityId: item.pageId,
            entityType: 'page',
            score: new Prisma.Decimal(item.wilsonGain || 0),
            period: '24h',
            metadata: {
              currentRating: item.currentRating,
              currentWilson: item.currentWilson,
              prevWilson: item.prevWilson,
              newVotes: item.newVotes,
              rank: i + 1
            },
            calculatedAt: new Date()
          }
        });
      }
      
      // 2. 7天热门页面（按总投票数）
      const trending7d = await this.prisma.$queryRaw<Array<{
        pageId: number;
        title: string;
        rating: number;
        voteCount: number;
        recentVotes: number;
      }>>`
        SELECT 
          p.id as "pageId",
          pv.title,
          pv.rating,
          pv."voteCount",
          COUNT(v.id) as recent_votes
        FROM "Page" p
        JOIN "PageVersion" pv ON p.id = pv."pageId" AND pv."validTo" IS NULL
        JOIN "Vote" v ON v."pageVersionId" = pv.id
        WHERE v."timestamp" >= NOW() - INTERVAL '7 days'
          AND pv."isDeleted" = false
        GROUP BY p.id, pv.title, pv.rating, pv."voteCount"
        ORDER BY recent_votes DESC
        LIMIT 20
      `;
      
      // 保存7天趋势
      for (let i = 0; i < trending7d.length; i++) {
        const item = trending7d[i];
        await this.prisma.trendingStats.upsert({
          where: {
            statType_period_entityId_entityType: {
              statType: 'vote_activity',
              period: '7d',
              entityId: item.pageId,
              entityType: 'page'
            }
          },
          update: {
            name: item.title || `Page ${item.pageId}`,
            score: new Prisma.Decimal(item.recentVotes || 0),
            metadata: {
              rating: item.rating,
              totalVotes: item.voteCount,
              recentVotes: item.recentVotes,
              rank: i + 1
            },
            calculatedAt: new Date()
          },
          create: {
            statType: 'vote_activity',
            name: item.title || `Page ${item.pageId}`,
            entityId: item.pageId,
            entityType: 'page',
            score: new Prisma.Decimal(item.recentVotes || 0),
            period: '7d',
            metadata: {
              rating: item.rating,
              totalVotes: item.voteCount,
              recentVotes: item.recentVotes,
              rank: i + 1
            },
            calculatedAt: new Date()
          }
        });
      }
      
      // 3. 热门标签（7天内）
      const trendingTags = await this.prisma.$queryRaw<Array<{
        tag: string;
        pageCount: number;
        totalVotes: number;
        avgRating: number;
      }>>`
        SELECT 
          unnest(pv.tags) as tag,
          COUNT(DISTINCT pv."pageId") as page_count,
          SUM(vote_count.votes_7d) as total_votes,
          AVG(pv.rating) as avg_rating
        FROM "PageVersion" pv
        JOIN (
          SELECT 
            v."pageVersionId",
            COUNT(*) as votes_7d
          FROM "Vote" v
          WHERE v."timestamp" >= NOW() - INTERVAL '7 days'
          GROUP BY v."pageVersionId"
        ) vote_count ON pv.id = vote_count."pageVersionId"
        WHERE pv."validTo" IS NULL 
          AND pv."isDeleted" = false
        GROUP BY tag
        HAVING COUNT(DISTINCT pv."pageId") >= 3
        ORDER BY total_votes DESC
        LIMIT 10
      `;
      
      // 保存标签趋势
      for (let i = 0; i < trendingTags.length; i++) {
        const item = trendingTags[i];
        const tagId = this.getTagId(item.tag);
        
        await this.prisma.trendingStats.upsert({
          where: {
            statType_period_entityId_entityType: {
              statType: 'tag_activity',
              period: '7d',
              entityId: tagId,
              entityType: 'tag'
            }
          },
          update: {
            name: item.tag,
            score: new Prisma.Decimal(item.totalVotes || 0),
            metadata: {
              pageCount: item.pageCount,
              avgRating: item.avgRating,
              rank: i + 1
            },
            calculatedAt: new Date()
          },
          create: {
            statType: 'tag_activity',
            name: item.tag,
            entityId: tagId,
            entityType: 'tag',
            score: new Prisma.Decimal(item.totalVotes || 0),
            period: '7d',
            metadata: {
              pageCount: item.pageCount,
              avgRating: item.avgRating,
              rank: i + 1
            },
            calculatedAt: new Date()
          }
        });
      }
      
      console.log('✅ Trending statistics updated');
    } catch (error) {
      console.error('❌ Failed to update trending statistics:', error);
      throw error;
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
        (
          SELECT COUNT(*)
          FROM "Vote" v
          JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
          WHERE pv."validTo" IS NULL AND pv."isDeleted" = false
        ) as votes,
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

  /**
   * 更新有趣事实统计
   */
  private async updateInterestingFacts(changeSet: Array<{ id: number; lastChange: Date }>) {
    console.log('🎉 Updating interesting facts...');
    
    // 调用所有子任务来更新各类有趣统计
    await Promise.all([
      this.updateTimeMilestones(changeSet),
      this.updateTagRecords(changeSet),
      this.updateContentRecords(changeSet),
      this.updateRatingRecords(changeSet),
      this.updateUserActivityRecords(changeSet)
    ]);
    
    console.log('✅ Interesting facts updated');
  }

  /**
   * 更新时间里程碑统计
   */
  private async updateTimeMilestones(changeSet: Array<{ id: number; lastChange: Date }>) {
    console.log('📅 Updating time milestones...');
    
    // 计算各种时间里程碑
    await Promise.all([
      this.calculateVotingMilestones(),
      this.calculatePageCreationMilestones(),
      this.calculateUserMilestones()
    ]);
    
    console.log('✅ Time milestones updated');
  }

  /**
   * 计算投票里程碑
   */
  private async calculateVotingMilestones() {
    // 第10万个、20万个、50万个...投票
    const milestones = [10000, 20000, 50000, 100000, 200000, 500000, 1000000];
    
    for (const milestone of milestones) {
      try {
        const voteResult = await this.prisma.$queryRaw<Array<{
          id: number;
          pageVersionId: number;
          userId: number | null;
          timestamp: Date;
          pageTitle: string;
          userDisplayName: string | null;
        }>>`
          WITH numbered_votes AS (
            SELECT 
              v.id,
              v."pageVersionId", 
              v."userId",
              v.timestamp,
              pv.title as "pageTitle",
              u."displayName" as "userDisplayName",
              ROW_NUMBER() OVER (ORDER BY v.timestamp) as vote_number
            FROM "Vote" v
            JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
            LEFT JOIN "User" u ON v."userId" = u.id
            WHERE v.direction != 0
          )
          SELECT * FROM numbered_votes WHERE vote_number = ${milestone}
        `;
        
        if (voteResult.length > 0) {
          const vote = voteResult[0];
          
          await this.upsertInterestingFact({
            category: 'time_milestone',
            type: `vote_milestone_${milestone}`,
            dateContext: null,
            tagContext: null,
            rank: 1,
            title: `第 ${milestone.toLocaleString()} 个投票`,
            description: `网站历史上的第 ${milestone.toLocaleString()} 个投票`,
            value: vote.timestamp.toISOString(),
            pageId: await this.getPageIdFromVersionId(vote.pageVersionId),
            userId: vote.userId,
            metadata: {
              voteId: vote.id,
              pageTitle: vote.pageTitle,
              userDisplayName: vote.userDisplayName,
              timestamp: vote.timestamp
            }
          });
        }
      } catch (error) {
        console.warn(`Failed to calculate voting milestone ${milestone}:`, error);
      }
    }
  }

  /**
   * 计算页面创建里程碑
   */
  private async calculatePageCreationMilestones() {
    // 整万个用户、页面等
    const milestones = [1000, 5000, 10000, 20000, 50000];
    
    for (const milestone of milestones) {
      try {
        const pageResult = await this.prisma.$queryRaw<Array<{
          id: number;
          title: string;
          createdAt: Date;
          rating: number | null;
        }>>`
          WITH numbered_pages AS (
            SELECT 
              p.id,
              pv.title,
              pv."createdAt",
              pv.rating,
              ROW_NUMBER() OVER (ORDER BY pv."createdAt") as page_number
            FROM "Page" p
            JOIN "PageVersion" pv ON p.id = pv."pageId" AND pv."validTo" IS NULL
            WHERE NOT pv."isDeleted"
          )
          SELECT * FROM numbered_pages WHERE page_number = ${milestone}
        `;
        
        if (pageResult.length > 0) {
          const page = pageResult[0];
          
          await this.upsertInterestingFact({
            category: 'time_milestone',
            type: `page_milestone_${milestone}`,
            dateContext: null,
            tagContext: null,
            rank: 1,
            title: `第 ${milestone.toLocaleString()} 个页面`,
            description: `网站的第 ${milestone.toLocaleString()} 个页面`,
            value: page.createdAt.toISOString(),
            pageId: page.id,
            metadata: {
              pageTitle: page.title,
              createdAt: page.createdAt,
              rating: page.rating
            }
          });
        }
      } catch (error) {
        console.warn(`Failed to calculate page milestone ${milestone}:`, error);
      }
    }
  }

  /**
   * 计算用户里程碑
   */
  private async calculateUserMilestones() {
    const milestones = [1000, 5000, 10000, 20000, 50000];
    
    for (const milestone of milestones) {
      try {
        const userResult = await this.prisma.$queryRaw<Array<{
          id: number;
          displayName: string | null;
          firstActivityAt: Date | null;
        }>>`
          WITH numbered_users AS (
            SELECT 
              u.id,
              u."displayName",
              u."firstActivityAt",
              ROW_NUMBER() OVER (ORDER BY u.id) as user_number
            FROM "User" u
          )
          SELECT * FROM numbered_users WHERE user_number = ${milestone}
        `;
        
        if (userResult.length > 0) {
          const user = userResult[0];
          
          await this.upsertInterestingFact({
            category: 'time_milestone',
            type: `user_milestone_${milestone}`,
            dateContext: null,
            tagContext: null,
            rank: 1,
            title: `第 ${milestone.toLocaleString()} 个用户`,
            description: `网站的第 ${milestone.toLocaleString()} 个注册用户`,
            value: user.firstActivityAt?.toISOString() || new Date().toISOString(),
            userId: user.id,
            metadata: {
              displayName: user.displayName,
              firstActivityAt: user.firstActivityAt
            }
          });
        }
      } catch (error) {
        console.warn(`Failed to calculate user milestone ${milestone}:`, error);
      }
    }
  }

  /**
   * 更新标签记录
   */
  private async updateTagRecords(changeSet: Array<{ id: number; lastChange: Date }>) {
    console.log('🏷️ Updating tag records...');
    
    await Promise.all([
      this.calculateTagLeaderboards(),
      this.calculateTagMilestones()
    ]);
    
    console.log('✅ Tag records updated');
  }

  /**
   * 刷新 TagValidationCache（all + invalid + untranslated）
   */
  private async refreshTagValidationCache() {
    console.log('🏷️ Refreshing TagValidationCache...');

    // 检查 TagDefinition 表是否有数据，避免空定义表导致所有标签被误判为 invalid
    const defCount = await this.prisma.tagDefinition.count();
    if (defCount === 0) {
      console.log('⏭️ TagDefinition table is empty — skipping invalid/untranslated cache to avoid false positives. Run "npm run tags -- --sync" first.');
    }

    const service = new TagDefinitionService(this.prisma);

    // all 标签缓存不依赖 TagDefinition，始终可以安全刷新
    const allCount = await service.computeAndCacheAllTags();
    console.log(`  ✅ all: ${allCount} tags`);

    // invalid 和 untranslated 依赖 TagDefinition，仅在有定义数据时刷新
    if (defCount > 0) {
      const invalidCount = await service.computeAndCacheInvalidTags();
      console.log(`  ✅ invalid: ${invalidCount} tags`);

      const untranslatedCount = await service.computeAndCacheUntranslatedTags();
      console.log(`  ✅ untranslated: ${untranslatedCount} tags`);
    }

    console.log('✅ TagValidationCache refreshed');
  }

  /**
   * 计算标签排行榜
   */
  private async calculateTagLeaderboards() {
    // 获取热门标签
    const popularTags = await this.prisma.$queryRaw<Array<{ tag: string; count: number }>>`
      SELECT 
        tag,
        COUNT(*) as count
      FROM (
        SELECT unnest(tags) as tag
        FROM "PageVersion"
        WHERE "validTo" IS NULL AND NOT "isDeleted"
      ) tag_list
      WHERE tag NOT IN ('原创', '译文', '指导', '页面', '重定向')
      GROUP BY tag
      HAVING COUNT(*) >= 5
      ORDER BY count DESC
      LIMIT 50
    `;

    for (const { tag } of popularTags) {
      try {
        // 该标签下评分最高的页面
        const highestRated = await this.prisma.$queryRaw<Array<{
          pageId: number;
          title: string;
          rating: number;
          userId: number | null;
          displayName: string | null;
        }>>`
          WITH effective_attributions AS (
            SELECT a.*
            FROM (
              SELECT 
                a.*,
                BOOL_OR(a.type <> 'SUBMITTER') OVER (PARTITION BY a."pageVerId") AS has_non_submitter
              FROM "Attribution" a
            ) a
            WHERE NOT (a.has_non_submitter AND a.type = 'SUBMITTER')
          )
          SELECT DISTINCT
            p.id as "pageId",
            pv.title,
            pv.rating,
            a."userId",
            u."displayName"
          FROM "Page" p
          JOIN "PageVersion" pv ON p.id = pv."pageId" AND pv."validTo" IS NULL
          LEFT JOIN effective_attributions a ON pv.id = a."pageVerId" AND a."userId" IS NOT NULL
          LEFT JOIN "User" u ON a."userId" = u.id
          WHERE pv.tags @> ARRAY[${tag}] AND NOT pv."isDeleted"
          ORDER BY pv.rating DESC
          LIMIT 1
        `;
        
        if (highestRated.length > 0) {
          const page = highestRated[0];
          
          await this.upsertInterestingFact({
            category: 'tag_record',
            type: 'highest_rated',
            dateContext: null,
            tagContext: tag,
            rank: 1,
            title: `"${tag}" 标签最高评分`,
            description: `在 "${tag}" 标签下评分最高的页面`,
            value: page.rating.toString(),
            pageId: page.pageId,
            userId: page.userId,
            metadata: {
              tag,
              pageTitle: page.title,
              rating: page.rating,
              authorName: page.displayName
            }
          });
        }

        // 该标签下最具争议的页面
        const mostControversial = await this.prisma.$queryRaw<Array<{
          pageId: number;
          title: string;
          controversy: number;
          rating: number;
        }>>`
          SELECT 
            p.id as "pageId",
            pv.title,
            ps.controversy,
            pv.rating
          FROM "Page" p
          JOIN "PageVersion" pv ON p.id = pv."pageId" AND pv."validTo" IS NULL
          JOIN "PageStats" ps ON pv.id = ps."pageVersionId"
          WHERE pv.tags @> ARRAY[${tag}] AND NOT pv."isDeleted"
            AND ps.controversy > 0
          ORDER BY ps.controversy DESC
          LIMIT 1
        `;
        
        if (mostControversial.length > 0) {
          const page = mostControversial[0];
          
          await this.upsertInterestingFact({
            category: 'tag_record',
            type: 'most_controversial',
            dateContext: null,
            tagContext: tag,
            rank: 1,
            title: `"${tag}" 标签最具争议`,
            description: `在 "${tag}" 标签下最具争议的页面`,
            value: page.controversy.toString(),
            pageId: page.pageId,
            metadata: {
              tag,
              pageTitle: page.title,
              controversy: page.controversy,
              rating: page.rating
            }
          });
        }
      } catch (error) {
        console.warn(`Failed to calculate records for tag ${tag}:`, error);
      }
    }
  }

  /**
   * 计算标签里程碑
   */
  private async calculateTagMilestones() {
    // 找出第一个达到特定评分的页面
    const ratingMilestones = [50, 100, 200, 300, 500];
    
    for (const rating of ratingMilestones) {
      try {
        const firstHighRated = await this.prisma.$queryRaw<Array<{
          pageId: number;
          title: string;
          rating: number;
          createdAt: Date;
          tags: string[];
        }>>`
          SELECT 
            p.id as "pageId",
            pv.title,
            pv.rating,
            pv."createdAt",
            pv.tags
          FROM "Page" p
          JOIN "PageVersion" pv ON p.id = pv."pageId" AND pv."validTo" IS NULL
          WHERE pv.rating >= ${rating} AND NOT pv."isDeleted"
          ORDER BY pv."createdAt" ASC
          LIMIT 1
        `;
        
        if (firstHighRated.length > 0) {
          const page = firstHighRated[0];
          
          await this.upsertInterestingFact({
            category: 'rating_milestone',
            type: `first_${rating}_rating`,
            dateContext: null,
            tagContext: null,
            rank: 1,
            title: `首个 ${rating}+ 评分页面`,
            description: `网站历史上第一个达到 ${rating} 评分的页面`,
            value: page.rating.toString(),
            pageId: page.pageId,
            metadata: {
              pageTitle: page.title,
              rating: page.rating,
              createdAt: page.createdAt,
              tags: page.tags
            }
          });
        }
      } catch (error) {
        console.warn(`Failed to calculate rating milestone ${rating}:`, error);
      }
    }
  }

  /**
   * 更新内容记录
   */
  private async updateContentRecords(changeSet: Array<{ id: number; lastChange: Date }>) {
    console.log('📝 Updating content records...');
    
    await Promise.all([
      this.calculateContentLengthRecords(),
      this.calculateContentComplexityRecords()
    ]);
    
    console.log('✅ Content records updated');
  }

  /**
   * 计算内容长度记录
   */
  private async calculateContentLengthRecords() {
    // 最长源码
    const longestSource = await this.prisma.$queryRaw<Array<{
      pageId: number;
      title: string;
      sourceLength: number;
    }>>`
      SELECT 
        p.id as "pageId",
        pv.title,
        LENGTH(pv.source) as "sourceLength"
      FROM "Page" p
      JOIN "PageVersion" pv ON p.id = pv."pageId" AND pv."validTo" IS NULL
      WHERE NOT pv."isDeleted" AND pv.source IS NOT NULL
      ORDER BY LENGTH(pv.source) DESC
      LIMIT 1
    `;
    
    if (longestSource.length > 0) {
      const page = longestSource[0];
      
      await this.upsertInterestingFact({
        category: 'content_record',
        type: 'longest_source',
        dateContext: null,
        tagContext: null,
        rank: 1,
        title: '最长的页面源码',
        description: '网站上源码最长的页面',
        value: page.sourceLength.toString(),
        pageId: page.pageId,
        metadata: {
          pageTitle: page.title,
          sourceLength: page.sourceLength
        }
      });
    }

    // 最短源码（排除重定向等）
    const shortestSource = await this.prisma.$queryRaw<Array<{
      pageId: number;
      title: string;
      sourceLength: number;
    }>>`
      SELECT 
        p.id as "pageId",
        pv.title,
        LENGTH(pv.source) as "sourceLength"
      FROM "Page" p
      JOIN "PageVersion" pv ON p.id = pv."pageId" AND pv."validTo" IS NULL
      WHERE NOT pv."isDeleted" 
        AND pv.source IS NOT NULL 
        AND LENGTH(pv.source) > 100
        AND NOT (pv.tags @> ARRAY['重定向'])
      ORDER BY LENGTH(pv.source) ASC
      LIMIT 1
    `;
    
    if (shortestSource.length > 0) {
      const page = shortestSource[0];
      
      await this.upsertInterestingFact({
        category: 'content_record',
        type: 'shortest_source',
        dateContext: null,
        tagContext: null,
        rank: 1,
        title: '最短的页面源码',
        description: '网站上源码最短的页面（排除重定向）',
        value: page.sourceLength.toString(),
        pageId: page.pageId,
        metadata: {
          pageTitle: page.title,
          sourceLength: page.sourceLength
        }
      });
    }
  }

  /**
   * 计算内容复杂度记录
   */
  private async calculateContentComplexityRecords() {
    // 标签最多的页面
    const mostTaggedPage = await this.prisma.$queryRaw<Array<{
      pageId: number;
      title: string;
      tagCount: number;
      tags: string[];
    }>>`
      SELECT 
        p.id as "pageId",
        pv.title,
        COALESCE(array_length(pv.tags, 1), 0) as "tagCount",
        pv.tags
      FROM "Page" p
      JOIN "PageVersion" pv ON p.id = pv."pageId" AND pv."validTo" IS NULL
      WHERE NOT pv."isDeleted" AND pv.tags IS NOT NULL
        AND array_length(pv.tags, 1) > 0
      ORDER BY array_length(pv.tags, 1) DESC
      LIMIT 1
    `;
    
    if (mostTaggedPage.length > 0) {
      const page = mostTaggedPage[0];
      
      await this.upsertInterestingFact({
        category: 'content_record',
        type: 'most_tags',
        dateContext: null,
        tagContext: null,
        rank: 1,
        title: '标签最多的页面',
        description: '拥有最多标签的页面',
        value: page.tagCount.toString(),
        pageId: page.pageId,
        metadata: {
          pageTitle: page.title,
          tagCount: page.tagCount,
          tags: page.tags
        }
      });
    }
  }

  /**
   * 更新评分记录
   */
  private async updateRatingRecords(changeSet: Array<{ id: number; lastChange: Date }>) {
    console.log('⭐ Updating rating records...');
    
    await Promise.all([
      this.calculateRatingExtremums(),
      this.calculateVotingRecords()
    ]);
    
    console.log('✅ Rating records updated');
  }

  /**
   * 计算评分极值
   */
  private async calculateRatingExtremums() {
    // 历史最高评分
    const highestRated = await this.prisma.$queryRaw<Array<{
      pageId: number;
      title: string;
      rating: number | null;
      voteCount: number | null;
    }>>`
      SELECT 
        p.id as "pageId",
        pv.title,
        pv.rating,
        pv."voteCount"
      FROM "Page" p
      JOIN "PageVersion" pv ON p.id = pv."pageId" AND pv."validTo" IS NULL
      WHERE NOT pv."isDeleted" AND pv.rating IS NOT NULL
      ORDER BY pv.rating DESC
      LIMIT 1
    `;
    
    if (highestRated.length > 0) {
      const page = highestRated[0];
      
      await this.upsertInterestingFact({
        category: 'rating_record',
        type: 'highest_rating_all_time',
        dateContext: null,
        tagContext: null,
        rank: 1,
        title: '历史最高评分',
        description: '网站历史上评分最高的页面',
        value: page.rating == null ? undefined : page.rating.toString(),
        pageId: page.pageId,
        metadata: {
          pageTitle: page.title,
          rating: page.rating,
          voteCount: page.voteCount
        }
      });
    }

    // 获得票数最多的页面
    const mostVoted = await this.prisma.$queryRaw<Array<{
      pageId: number;
      title: string;
      voteCount: number | null;
      rating: number | null;
    }>>`
      SELECT 
        p.id as "pageId",
        pv.title,
        pv."voteCount",
        pv.rating
      FROM "Page" p
      JOIN "PageVersion" pv ON p.id = pv."pageId" AND pv."validTo" IS NULL
      WHERE NOT pv."isDeleted" AND pv."voteCount" IS NOT NULL
      ORDER BY pv."voteCount" DESC
      LIMIT 1
    `;
    
    if (mostVoted.length > 0) {
      const page = mostVoted[0];
      
      await this.upsertInterestingFact({
        category: 'rating_record',
        type: 'most_votes_all_time',
        dateContext: null,
        tagContext: null,
        rank: 1,
        title: '票数最多的页面',
        description: '获得投票数最多的页面',
        value: page.voteCount == null ? undefined : page.voteCount.toString(),
        pageId: page.pageId,
        metadata: {
          pageTitle: page.title,
          voteCount: page.voteCount,
          rating: page.rating
        }
      });
    }
  }

  /**
   * 计算投票记录
   */
  private async calculateVotingRecords() {
    // 单日投票最多的页面
    const mostVotesInDay = await this.prisma.$queryRaw<Array<{
      pageId: number;
      title: string;
      voteDate: Date;
      dailyVotes: number;
      totalRating: number;
    }>>`
      SELECT 
        p.id as "pageId",
        pv.title,
        date(v.timestamp) as "voteDate",
        COUNT(*) as "dailyVotes",
        pv.rating as "totalRating"
      FROM "Vote" v
      JOIN "PageVersion" pv ON v."pageVersionId" = pv.id AND pv."validTo" IS NULL
      JOIN "Page" p ON pv."pageId" = p.id
      WHERE NOT pv."isDeleted"
      GROUP BY p.id, pv.title, date(v.timestamp), pv.rating
      ORDER BY "dailyVotes" DESC
      LIMIT 1
    `;
    
    if (mostVotesInDay.length > 0) {
      const record = mostVotesInDay[0];
      
      await this.upsertInterestingFact({
        category: 'rating_record',
        type: 'most_votes_single_day',
        dateContext: null,
        tagContext: null,
        rank: 1,
        title: '单日票数最多',
        description: '单日内获得投票数最多的页面',
        value: record.dailyVotes.toString(),
        pageId: record.pageId,
        metadata: {
          pageTitle: record.title,
          voteDate: record.voteDate,
          dailyVotes: Number(record.dailyVotes),
          totalRating: record.totalRating
        }
      });
    }
  }

  /**
   * 更新用户活动记录
   */
  private async updateUserActivityRecords(changeSet: Array<{ id: number; lastChange: Date }>) {
    console.log('👤 Updating user activity records...');
    
    await Promise.all([
      this.calculateUserVotingRecords(),
      this.calculateUserContributionRecords()
    ]);
    
    console.log('✅ User activity records updated');
  }

  /**
   * 计算用户投票记录
   */
  private async calculateUserVotingRecords() {
    // 单日投票最多的用户
    const mostVotesInDay = await this.prisma.$queryRaw<Array<{
      userId: number;
      displayName: string | null;
      voteDate: Date;
      dailyVotes: number;
    }>>`
      SELECT 
        u.id as "userId",
        u."displayName",
        date(v.timestamp) as "voteDate",
        COUNT(*) as "dailyVotes"
      FROM "Vote" v
      JOIN "User" u ON v."userId" = u.id
      GROUP BY u.id, u."displayName", date(v.timestamp)
      ORDER BY "dailyVotes" DESC
      LIMIT 1
    `;
    
    if (mostVotesInDay.length > 0) {
      const record = mostVotesInDay[0];
      
      await this.upsertInterestingFact({
        category: 'user_activity_record',
        type: 'most_votes_single_day',
        dateContext: null,
        tagContext: null,
        rank: 1,
        title: '单日投票最多用户',
        description: '单日内投票数最多的用户',
        value: record.dailyVotes.toString(),
        userId: record.userId,
        metadata: {
          displayName: record.displayName,
          voteDate: record.voteDate,
          dailyVotes: Number(record.dailyVotes)
        }
      });
    }

    // 总投票数最多的用户
    const mostVotesTotal = await this.prisma.$queryRaw<Array<{
      userId: number;
      displayName: string | null;
      totalVotes: number;
    }>>`
      SELECT 
        u.id as "userId",
        u."displayName",
        COUNT(*) as "totalVotes"
      FROM "Vote" v
      JOIN "User" u ON v."userId" = u.id
      GROUP BY u.id, u."displayName"
      ORDER BY "totalVotes" DESC
      LIMIT 1
    `;
    
    if (mostVotesTotal.length > 0) {
      const record = mostVotesTotal[0];
      
      await this.upsertInterestingFact({
        category: 'user_activity_record',
        type: 'most_votes_total',
        dateContext: null,
        tagContext: null,
        rank: 1,
        title: '投票总数最多用户',
        description: '历史总投票数最多的用户',
        value: record.totalVotes.toString(),
        userId: record.userId,
        metadata: {
          displayName: record.displayName,
          totalVotes: Number(record.totalVotes)
        }
      });
    }
  }

  /**
   * 计算用户贡献记录
   */
  private async calculateUserContributionRecords() {
    // 页面贡献最多的用户
    const mostContributions = await this.prisma.$queryRaw<Array<{
      userId: number;
      displayName: string | null;
      pageCount: number;
      totalRating: number;
    }>>`
      WITH effective_attributions AS (
        SELECT a.*
        FROM (
          SELECT 
            a.*,
            BOOL_OR(a.type <> 'SUBMITTER') OVER (PARTITION BY a."pageVerId") AS has_non_submitter
          FROM "Attribution" a
        ) a
        WHERE NOT (a.has_non_submitter AND a.type = 'SUBMITTER')
      )
      SELECT 
        u.id as "userId",
        u."displayName",
        COUNT(DISTINCT pv."pageId") as "pageCount",
        SUM(pv.rating) as "totalRating"
      FROM "User" u
      JOIN effective_attributions a ON u.id = a."userId"
      JOIN "PageVersion" pv ON a."pageVerId" = pv.id
      WHERE pv."validTo" IS NULL AND NOT pv."isDeleted"
      GROUP BY u.id, u."displayName"
      ORDER BY "pageCount" DESC
      LIMIT 1
    `;
    
    if (mostContributions.length > 0) {
      const record = mostContributions[0];
      
      await this.upsertInterestingFact({
        category: 'user_activity_record',
        type: 'most_pages_authored',
        dateContext: null,
        tagContext: null,
        rank: 1,
        title: '页面贡献最多用户',
        description: '创作页面数量最多的用户',
        value: record.pageCount.toString(),
        userId: record.userId,
        metadata: {
          displayName: record.displayName,
          pageCount: Number(record.pageCount),
          totalRating: Number(record.totalRating || 0)
        }
      });
    }

    // 总评分最高的用户
    const highestTotalRating = await this.prisma.$queryRaw<Array<{
      userId: number;
      displayName: string | null;
      pageCount: number;
      totalRating: number;
      averageRating: number;
    }>>`
      WITH effective_attributions AS (
        SELECT a.*
        FROM (
          SELECT 
            a.*,
            BOOL_OR(a.type <> 'SUBMITTER') OVER (PARTITION BY a."pageVerId") AS has_non_submitter
          FROM "Attribution" a
        ) a
        WHERE NOT (a.has_non_submitter AND a.type = 'SUBMITTER')
      )
      SELECT 
        u.id as "userId",
        u."displayName",
        COUNT(DISTINCT pv."pageId") as "pageCount",
        SUM(pv.rating) as "totalRating",
        AVG(pv.rating) as "averageRating"
      FROM "User" u
      JOIN effective_attributions a ON u.id = a."userId"
      JOIN "PageVersion" pv ON a."pageVerId" = pv.id
      WHERE pv."validTo" IS NULL AND NOT pv."isDeleted"
        AND pv.rating IS NOT NULL
      GROUP BY u.id, u."displayName"
      HAVING COUNT(DISTINCT pv."pageId") >= 3  -- 至少3个页面才有意义
      ORDER BY "totalRating" DESC
      LIMIT 1
    `;
    
    if (highestTotalRating.length > 0) {
      const record = highestTotalRating[0];
      
      await this.upsertInterestingFact({
        category: 'user_activity_record',
        type: 'highest_total_rating',
        dateContext: null,
        tagContext: null,
        rank: 1,
        title: '总评分最高用户',
        description: '所创作页面总评分最高的用户',
        value: record.totalRating.toString(),
        userId: record.userId,
        metadata: {
          displayName: record.displayName,
          pageCount: Number(record.pageCount),
          totalRating: Number(record.totalRating),
          averageRating: Number(record.averageRating)
        }
      });
    }
  }

  /**
   * 辅助方法：upsert有趣事实记录（处理null值问题）
   */
  private async upsertInterestingFact(data: {
    category: string;
    type: string;
    dateContext: Date | null;
    tagContext: string | null;
    rank: number;
    title: string;
    description?: string;
    value?: string;
    pageId?: number | null;
    userId?: number | null;
    metadata?: any;
  }) {
    // Find existing record with the same unique constraint values
    const existing = await this.prisma.interestingFacts.findFirst({
      where: {
        category: data.category,
        type: data.type,
        dateContext: data.dateContext,
        tagContext: data.tagContext,
        rank: data.rank
      }
    });

    if (existing) {
      // Update existing record
      return await this.prisma.interestingFacts.update({
        where: { id: existing.id },
        data: {
          title: data.title,
          description: data.description,
          value: data.value,
          pageId: data.pageId ?? null,
          userId: data.userId ?? null,
          metadata: data.metadata,
          calculatedAt: new Date()
        }
      });
    } else {
      // Create new record
      return await this.prisma.interestingFacts.create({
        data: {
          category: data.category,
          type: data.type,
          title: data.title,
          description: data.description,
          value: data.value,
          pageId: data.pageId ?? null,
          userId: data.userId ?? null,
          dateContext: data.dateContext,
          tagContext: data.tagContext,
          rank: data.rank,
          metadata: data.metadata,
          calculatedAt: new Date()
        }
      });
    }
  }

  /**
   * 辅助方法：从PageVersion ID获取Page ID
   */
  private async getPageIdFromVersionId(pageVersionId: number): Promise<number | null> {
    try {
      const result = await this.prisma.pageVersion.findUnique({
        where: { id: pageVersionId },
        select: { pageId: true }
      });
      return result?.pageId || null;
    } catch (error) {
      console.warn(`Failed to get pageId for version ${pageVersionId}:`, error);
      return null;
    }
  }
}

/**
 * 便捷的分析入口函数
 */
export async function analyzeIncremental(options: { forceFullAnalysis?: boolean; forceFullHistory?: boolean; tasks?: string[] } = {}) {
  const job = new IncrementalAnalyzeJob();
  await job.analyze(options);
}
