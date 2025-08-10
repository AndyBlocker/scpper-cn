import { PrismaClient } from '@prisma/client';
import { VotingTimeSeriesCacheJob } from './VotingTimeSeriesCacheJob';
import { TextProcessor } from '../utils/TextProcessor';

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
  async analyze(options: { forceFullAnalysis?: boolean; forceFullHistory?: boolean; tasks?: string[] } = {}) {
    console.log('🔄 Starting incremental analysis...');

    try {
      const availableTasks = [
        'page_stats',
        'user_stats', 
        'site_stats',
        'search_index',
        'daily_aggregates',
        'voting_time_series_cache',
        'materialized_views',
        'interesting_facts',
        'time_milestones',
        'tag_records',
        'content_records',
        'rating_records',
        'user_activity_records'
      ];

      const tasksToRun = options.tasks || availableTasks;

      for (const taskName of tasksToRun) {
        console.log(`📊 Running task: ${taskName}`);
        await this.runTask(taskName, options.forceFullAnalysis, options);
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
  private async runTask(taskName: string, forceFullAnalysis = false, options: { forceFullHistory?: boolean } = {}) {
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

    // 增量查询：找出自水位线后变更的 pageVersion (优化版)
    const result = await this.prisma.$queryRaw<Array<{ id: number; lastChange: Date }>>`
      WITH cursor_check AS (
        SELECT COALESCE(${cursorTs}::timestamp, '1900-01-01'::timestamp) as cursor_ts
      ),
      vote_changes AS (
        SELECT v."pageVersionId" AS id, max(v."timestamp") AS changed_at
        FROM "Vote" v
        CROSS JOIN cursor_check c
        WHERE v."timestamp" > c.cursor_ts
        GROUP BY v."pageVersionId"
      ),
      revision_changes AS (
        SELECT r."pageVersionId" AS id, max(r."timestamp") AS changed_at
        FROM "Revision" r
        CROSS JOIN cursor_check c
        WHERE r."timestamp" > c.cursor_ts
        GROUP BY r."pageVersionId"
      ),
      attribution_changes AS (
        SELECT a."pageVerId" AS id, max(a."date") AS changed_at
        FROM "Attribution" a
        CROSS JOIN cursor_check c
        WHERE a."date" IS NOT NULL AND a."date" > c.cursor_ts
        GROUP BY a."pageVerId"
      )
      SELECT id, max(changed_at) AS "lastChange"
      FROM (
        SELECT id, changed_at FROM vote_changes
        UNION ALL
        SELECT id, changed_at FROM revision_changes
        UNION ALL
        SELECT id, changed_at FROM attribution_changes
      ) all_changes
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

    // 创建临时表
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
        FROM "Vote" v
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
   * 更新UserStats - 仅对相关用户进行计算
   */
  private async updateUserStats(changeSet: Array<{ id: number; lastChange: Date }>) {
    if (changeSet.length === 0) return;

    console.log(`👥 Updating UserStats for users affected by ${changeSet.length} page version changes...`);

    // 优化: 更高效的受影响用户查询
    const pageVersionIds = changeSet.map(c => c.id);

    const affectedUsers = await this.prisma.$queryRaw<Array<{ userId: number }>>`
      SELECT DISTINCT a."userId" 
      FROM "Attribution" a
      WHERE a."pageVerId" = ANY(${pageVersionIds}::int[])
        AND a."userId" IS NOT NULL
      UNION
      SELECT DISTINCT v."userId"
      FROM "Vote" v
      WHERE v."pageVersionId" = ANY(${pageVersionIds}::int[])
        AND v."userId" IS NOT NULL
    `;

    if (affectedUsers.length === 0) return;

    const userIds = affectedUsers.map(u => u.userId);

    // 创建临时表
    await this.prisma.$executeRaw`
      CREATE TEMP TABLE temp_affected_users ("userId" int PRIMARY KEY)
    `;

    // 插入用户ID到临时表
    await this.prisma.$executeRaw`
      INSERT INTO temp_affected_users SELECT unnest(${userIds}::int[])
    `;

    // 分析临时表
    await this.prisma.$executeRaw`
      ANALYZE temp_affected_users
    `;
      
    // 插入或更新UserStats
    await this.prisma.$executeRaw`
      WITH user_attribution_stats AS (
        SELECT 
          tau."userId",
          SUM(COALESCE(pv.rating, 0)::float) as total_rating,
          COUNT(CASE WHEN pv.rating IS NOT NULL THEN 1 END) as page_count
        FROM temp_affected_users tau
        JOIN "Attribution" a ON tau."userId" = a."userId"
        JOIN "PageVersion" pv ON a."pageVerId" = pv.id
        WHERE pv."validTo" IS NULL 
          AND pv."isDeleted" = false
        GROUP BY tau."userId"
      ),
      user_vote_stats AS (
        SELECT 
          tau."userId",
          COUNT(*) FILTER (WHERE v.direction = 1) as total_up,
          COUNT(*) FILTER (WHERE v.direction = -1) as total_down
        FROM temp_affected_users tau
        JOIN "Vote" v ON tau."userId" = v."userId"
        GROUP BY tau."userId"
      )
      INSERT INTO "UserStats" ("userId", "totalUp", "totalDown", "totalRating", "pageCount")
      SELECT 
        tau."userId",
        COALESCE(uvs.total_up, 0) as total_up,
        COALESCE(uvs.total_down, 0) as total_down,
        COALESCE(uas.total_rating, 0) as total_rating,
        COALESCE(uas.page_count, 0) as page_count
      FROM temp_affected_users tau
      LEFT JOIN user_attribution_stats uas ON tau."userId" = uas."userId"
      LEFT JOIN user_vote_stats uvs ON tau."userId" = uvs."userId"
      ON CONFLICT ("userId") DO UPDATE SET
        "totalUp" = EXCLUDED."totalUp",
        "totalDown" = EXCLUDED."totalDown",
        "totalRating" = EXCLUDED."totalRating",
        "pageCount" = EXCLUDED."pageCount"
    `;

    // 删除临时表
    await this.prisma.$executeRaw`
      DROP TABLE temp_affected_users
    `;

    console.log(`✅ UserStats updated for ${affectedUsers.length} affected users`);
  }

  /**
   * 更新SearchIndex - 增强版，支持搜索向量预计算和随机句子提取
   */
  private async updateSearchIndex(changeSet: Array<{ id: number; lastChange: Date }>) {
    if (changeSet.length === 0) return;

    console.log(`🔍 Updating enhanced SearchIndex for ${changeSet.length} page versions...`);

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
    console.log(`🔄 Updating enhanced search index for ${uniquePageIds.length} unique pages...`);

    // 分批处理，避免单次操作过大
    const batchSize = 500; // 减少批次大小，因为处理更复杂
    let processed = 0;
    let enhancedCount = 0;

    for (let i = 0; i < uniquePageIds.length; i += batchSize) {
      const batch = uniquePageIds.slice(i, i + batchSize);
      
      console.log(`  📦 Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(uniquePageIds.length/batchSize)} (${batch.length} pages)...`);
      
      // 1. 删除当前批次的现有搜索索引条目
      await this.prisma.$executeRaw`
        DELETE FROM "SearchIndex" 
        WHERE "pageId" = ANY(${batch}::int[])
      `;

      // 2. 获取原始数据用于处理
      const rawData = await this.prisma.$queryRaw<Array<{
        pageId: number;
        title: string | null;
        url: string;
        tags: string[];
        textContent: string | null;
        source: string | null;
      }>>`
        WITH latest_versions AS (
          SELECT pv."pageId",
                 pv.title,
                 p.url,
                 pv.tags,
                 pv."textContent",
                 pv.source,
                 ROW_NUMBER() OVER (PARTITION BY pv."pageId" ORDER BY pv."updatedAt" DESC) as rn
          FROM "PageVersion" pv
          JOIN "Page" p ON p.id = pv."pageId"
          WHERE pv."pageId" = ANY(${batch}::int[])
            AND pv."validTo" IS NULL 
            AND pv."isDeleted" = false
        )
        SELECT "pageId", title, url, tags, "textContent", source
        FROM latest_versions
        WHERE rn = 1
      `;

      if (rawData.length === 0) continue;

      // 3. 处理每个页面的数据 - 预计算增强字段
      const enhancedData = rawData.map(row => {
        try {
          // 使用TextProcessor计算增强字段
          const randomSentences = TextProcessor.extractRandomSentences(row.textContent || '', 4);
          const contentStats = TextProcessor.calculateContentStats(
            row.title || '',
            row.textContent || '',
            row.source || ''
          );

          return {
            pageId: row.pageId,
            title: row.title,
            url: row.url,
            tags: row.tags,
            text_content: row.textContent,
            source_content: row.source,
            random_sentences: randomSentences,
            content_stats: contentStats,
            updatedAt: new Date()
          };
        } catch (error) {
          console.warn(`⚠️  Failed to enhance page ${row.pageId}:`, error);
          // 降级到基础数据
          return {
            pageId: row.pageId,
            title: row.title,
            url: row.url,
            tags: row.tags,
            text_content: row.textContent,
            source_content: row.source,
            random_sentences: [],
            content_stats: {},
            updatedAt: new Date()
          };
        }
      });

      // 4. 直接插入到SearchIndex，避免临时表问题
      for (const row of enhancedData) {
        try {
          // 使用数据库函数计算搜索向量并直接插入
          await this.prisma.$executeRaw`
            INSERT INTO "SearchIndex" (
              "pageId", title, url, tags, text_content, source_content, 
              search_vector, random_sentences, content_stats, "updatedAt"
            ) VALUES (
              ${row.pageId},
              ${row.title},
              ${row.url},
              ${row.tags}::text[],
              ${row.text_content},
              ${row.source_content},
              calculate_search_vector_enhanced(${row.title}, ${row.text_content}, ${row.source_content}),
              ${row.random_sentences}::text[],
              ${JSON.stringify(row.content_stats)}::jsonb,
              ${row.updatedAt}
            )
            ON CONFLICT ("pageId") DO UPDATE SET
              title = EXCLUDED.title,
              url = EXCLUDED.url,
              tags = EXCLUDED.tags,
              text_content = EXCLUDED.text_content,
              source_content = EXCLUDED.source_content,
              search_vector = EXCLUDED.search_vector,
              random_sentences = EXCLUDED.random_sentences,
              content_stats = EXCLUDED.content_stats,
              "updatedAt" = EXCLUDED."updatedAt"
          `;
          enhancedCount++;
        } catch (error) {
          console.warn(`⚠️  Failed to insert enhanced data for page ${row.pageId}:`, error);
        }
      }

      processed += batch.length;
      console.log(`  📈 Progress: ${processed}/${uniquePageIds.length} (${Math.round(processed/uniquePageIds.length*100)}%) - enhanced ${enhancedData.length} pages`);
    }

    console.log(`✅ Enhanced SearchIndex updated for ${uniquePageIds.length} pages`);
    console.log(`🎯 Successfully enhanced ${enhancedCount}/${processed} pages with advanced features`);
    
    // 8. 更新统计信息
    await this.prisma.$executeRaw`ANALYZE "SearchIndex"`;
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

    let dateRange: Array<{ date: Date }>;
    
    if (shouldInitializeHistory) {
      console.log('🔄 Initializing complete historical daily aggregates...');
      // 优化: 使用索引友好的历史日期查询
      dateRange = await this.prisma.$queryRaw<Array<{ date: Date }>>`
        WITH vote_dates AS (
          SELECT date(v."timestamp") as date
          FROM "Vote" v
          WHERE v."timestamp" >= '2022-05-14'
          GROUP BY date(v."timestamp")
        )
        SELECT date FROM vote_dates
        ORDER BY date ASC
      `;
      console.log(`📊 Found ${dateRange.length} historical days to process`);
    } else {
      // 获取需要重新聚合的日期范围（最近变更的日期）
      dateRange = await this.prisma.$queryRaw<Array<{ date: Date }>>`
        SELECT DISTINCT date(v."timestamp") as date
        FROM "Vote" v
        WHERE v."timestamp" >= CURRENT_DATE - INTERVAL '30 days'  -- 扩展到30天
        ORDER BY date DESC
      `;
    }
    let cnt = 0;
    for (const { date } of dateRange) {
      // 优化: 更高效的PageDailyStats更新
      await this.prisma.$executeRaw`
        WITH daily_votes AS (
          SELECT 
            pv."pageId",
            COUNT(*) FILTER (WHERE v.direction = 1) as votes_up,
            COUNT(*) FILTER (WHERE v.direction = -1) as votes_down,
            COUNT(*) FILTER (WHERE v.direction != 0) as total_votes,
            COUNT(DISTINCT v."userId") FILTER (WHERE v."userId" IS NOT NULL) as unique_voters
          FROM "Vote" v
          JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
          WHERE date(v."timestamp") = ${date}::date
            AND pv."validTo" IS NULL 
            AND pv."isDeleted" = false
          GROUP BY pv."pageId"
        ),
        daily_revisions AS (
          SELECT 
            pv."pageId",
            COUNT(r.id) as revisions
          FROM "Revision" r
          JOIN "PageVersion" pv ON r."pageVersionId" = pv.id
          WHERE date(r."timestamp") = ${date}::date
          GROUP BY pv."pageId"
        )
        INSERT INTO "PageDailyStats" ("pageId", date, votes_up, votes_down, total_votes, unique_voters, revisions)
        SELECT 
          COALESCE(dv."pageId", dr."pageId") as "pageId",
          ${date}::date as date,
          COALESCE(dv.votes_up, 0) as votes_up,
          COALESCE(dv.votes_down, 0) as votes_down,
          COALESCE(dv.total_votes, 0) as total_votes,
          COALESCE(dv.unique_voters, 0) as unique_voters,
          COALESCE(dr.revisions, 0) as revisions
        FROM daily_votes dv
        FULL OUTER JOIN daily_revisions dr ON dv."pageId" = dr."pageId"
        ON CONFLICT ("pageId", date) DO UPDATE SET
          votes_up = EXCLUDED.votes_up,
          votes_down = EXCLUDED.votes_down,
          total_votes = EXCLUDED.total_votes,
          unique_voters = EXCLUDED.unique_voters,
          revisions = EXCLUDED.revisions
      `;

      // 优化: 更高效的UserDailyStats更新
      await this.prisma.$executeRaw`
        WITH daily_user_votes AS (
          SELECT 
            v."userId",
            COUNT(*) as votes_cast,
            MAX(v."timestamp") as last_vote
          FROM "Vote" v
          WHERE date(v."timestamp") = ${date}::date
            AND v."userId" IS NOT NULL
          GROUP BY v."userId"
        ),
        daily_user_revisions AS (
          SELECT 
            r."userId",
            MAX(r."timestamp") as last_revision
          FROM "Revision" r
          WHERE date(r."timestamp") = ${date}::date
            AND r."userId" IS NOT NULL
          GROUP BY r."userId"
        ),
        daily_user_attributions AS (
          SELECT 
            a."userId",
            COUNT(DISTINCT pv."pageId") FILTER (WHERE a.type = 'author') as pages_created,
            MAX(a."date") as last_attribution
          FROM "Attribution" a
          JOIN "PageVersion" pv ON a."pageVerId" = pv.id
          WHERE date(a."date") = ${date}::date
            AND a."userId" IS NOT NULL
          GROUP BY a."userId"
        ),
        all_user_activity AS (
          SELECT 
            COALESCE(duv."userId", dur."userId", dua."userId") as "userId",
            COALESCE(duv.votes_cast, 0) as votes_cast,
            COALESCE(dua.pages_created, 0) as pages_created,
            GREATEST(
              COALESCE(duv.last_vote, '1900-01-01'::timestamp),
              COALESCE(dur.last_revision, '1900-01-01'::timestamp),
              COALESCE(dua.last_attribution, '1900-01-01'::timestamp)
            ) as last_activity
          FROM daily_user_votes duv
          FULL OUTER JOIN daily_user_revisions dur ON duv."userId" = dur."userId"
          FULL OUTER JOIN daily_user_attributions dua ON COALESCE(duv."userId", dur."userId") = dua."userId"
        )
        INSERT INTO "UserDailyStats" ("userId", date, votes_cast, pages_created, last_activity)
        SELECT 
          "userId",
          ${date}::date as date,
          votes_cast,
          pages_created,
          last_activity
        FROM all_user_activity
        ON CONFLICT ("userId", date) DO UPDATE SET
          votes_cast = EXCLUDED.votes_cast,
          pages_created = EXCLUDED.pages_created,
          last_activity = EXCLUDED.last_activity
      `;
      cnt++;
      if(cnt % 10 === 0) {
        console.log(`  📈 Progress: ${cnt}/${dateRange.length} (${Math.round(cnt/dateRange.length*100)}%) - processed ${date}`);
      }
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
          SELECT DISTINCT
            p.id as "pageId",
            pv.title,
            pv.rating,
            a."userId",
            u."displayName"
          FROM "Page" p
          JOIN "PageVersion" pv ON p.id = pv."pageId" AND pv."validTo" IS NULL
          LEFT JOIN "Attribution" a ON pv.id = a."pageVerId" AND a.type = 'author'
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
      rating: number;
      voteCount: number;
    }>>`
      SELECT 
        p.id as "pageId",
        pv.title,
        pv.rating,
        pv."voteCount"
      FROM "Page" p
      JOIN "PageVersion" pv ON p.id = pv."pageId" AND pv."validTo" IS NULL
      WHERE NOT pv."isDeleted"
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
        value: page.rating.toString(),
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
      voteCount: number;
      rating: number;
    }>>`
      SELECT 
        p.id as "pageId",
        pv.title,
        pv."voteCount",
        pv.rating
      FROM "Page" p
      JOIN "PageVersion" pv ON p.id = pv."pageId" AND pv."validTo" IS NULL
      WHERE NOT pv."isDeleted"
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
        value: page.voteCount.toString(),
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
      SELECT 
        u.id as "userId",
        u."displayName",
        COUNT(DISTINCT pv."pageId") as "pageCount",
        SUM(pv.rating) as "totalRating"
      FROM "User" u
      JOIN "Attribution" a ON u.id = a."userId"
      JOIN "PageVersion" pv ON a."pageVerId" = pv.id
      WHERE pv."validTo" IS NULL AND NOT pv."isDeleted"
        AND a.type = 'author'
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
      SELECT 
        u.id as "userId",
        u."displayName",
        COUNT(DISTINCT pv."pageId") as "pageCount",
        SUM(pv.rating) as "totalRating",
        AVG(pv.rating) as "averageRating"
      FROM "User" u
      JOIN "Attribution" a ON u.id = a."userId"
      JOIN "PageVersion" pv ON a."pageVerId" = pv.id
      WHERE pv."validTo" IS NULL AND NOT pv."isDeleted"
        AND a.type = 'author'
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
      return await this.prisma.interestingFacts.update({
        where: { id: existing.id },
        data: {
          title: data.title,
          description: data.description,
          value: data.value,
          pageId: data.pageId,
          userId: data.userId,
          metadata: data.metadata,
          calculatedAt: new Date()
        }
      });
    } else {
      return await this.prisma.interestingFacts.create({
        data: {
          category: data.category,
          type: data.type,
          title: data.title,
          description: data.description,
          value: data.value,
          pageId: data.pageId,
          userId: data.userId,
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
export async function analyzeIncremental(options: { forceFullAnalysis?: boolean; tasks?: string[] } = {}) {
  const job = new IncrementalAnalyzeJob();
  await job.analyze(options);
}