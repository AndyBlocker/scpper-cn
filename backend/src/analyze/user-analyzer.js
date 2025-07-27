/**
 * 文件路径: src/analyze/user-analyzer.js
 * 功能概述: SCPPER-CN 用户数据分析器模块
 * 
 * 主要功能:
 * - 计算用户加入时间（joinTime），基于首次活动时间
 * - 活跃用户自动标记（3个月内有任何活动）
 * - 用户活动统计：投票、修订、创建页面等数据统计
 * - 用户生命周期分析和加入分布统计
 * - 自动数据库表结构更新和字段添加
 * - 用户详细活动分析和报告生成
 * 
 * 核心特性:
 * - 智能用户加入时间检测（voting/revision/createPage 活动）
 * - 活跃用户时间窗口管理（默认3个月）
 * - 批量用户数据处理和性能优化
 * - 详细的用户统计和分析报告
 * 
 * 数据库字段:
 * - joinTime: 用户首次活动时间
 * - isActive: 活跃用户标记
 * - lastAnalyzedAt: 最后分析时间
 */
export class UserAnalyzer {
  constructor(prisma) {
    this.prisma = prisma;
    this.stats = {
      usersProcessed: 0,
      joinTimesCalculated: 0,
      activeUsersMarked: 0,
      errors: []
    };
    
    // 活跃用户时间窗口（3个月）
    this.ACTIVE_USER_WINDOW_MONTHS = 3;
  }
  
  /**
   * 分析并更新所有用户数据
   */
  async analyzeAndUpdateUserData() {
    console.log('👤 开始分析用户数据...');
    
    try {
      // 1. 计算用户joinTime
      await this.calculateUserJoinTimes();
      
      // 2. 标记活跃用户
      await this.markActiveUsers();
      
      // 3. 生成用户统计报告
      await this.generateUserAnalysisReport();
      
      console.log(`✅ 用户数据分析完成: ${this.stats.usersProcessed} 个用户`);
      
    } catch (error) {
      console.error(`❌ 用户数据分析失败: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * 计算用户的joinTime（首次活动时间）
   * 基于首次voting/revision/createPage的时间
   */
  async calculateUserJoinTimes() {
    console.log('📅 计算用户joinTime...');
    
    // 使用原生SQL查询获取每个用户的首次活动时间
    const joinTimeQuery = `
      WITH user_activities AS (
        -- 投票活动
        SELECT 
          v."userWikidotId" as user_id,
          MIN(v.timestamp) as first_activity_time,
          'vote' as activity_type
        FROM "VoteRecord" v
        WHERE v.timestamp IS NOT NULL
        GROUP BY v."userWikidotId"
        
        UNION ALL
        
        -- 修订活动
        SELECT 
          r."userWikidotId" as user_id,
          MIN(r.timestamp) as first_activity_time,
          'revision' as activity_type
        FROM "Revision" r
        WHERE r.timestamp IS NOT NULL
        GROUP BY r."userWikidotId"
        
        UNION ALL
        
        -- 创建页面活动
        SELECT 
          p."createdByWikidotId" as user_id,
          MIN(p."createdAt") as first_activity_time,
          'create_page' as activity_type
        FROM "Page" p
        WHERE p."createdAt" IS NOT NULL 
          AND p."createdByWikidotId" IS NOT NULL
        GROUP BY p."createdByWikidotId"
      ),
      earliest_activities AS (
        SELECT 
          user_id,
          MIN(first_activity_time) as join_time
        FROM user_activities
        GROUP BY user_id
      )
      SELECT 
        ea.user_id,
        ea.join_time,
        u.displayName as user_name
      FROM earliest_activities ea
      LEFT JOIN "User" u ON ea.user_id = u."wikidotId"
      ORDER BY ea.join_time
    `;
    
    const joinTimeResults = await this.prisma.$queryRawUnsafe(joinTimeQuery);
    
    console.log(`   找到 ${joinTimeResults.length} 个用户的joinTime数据`);
    
    // 批量更新用户joinTime
    const batchSize = 100;
    for (let i = 0; i < joinTimeResults.length; i += batchSize) {
      const batch = joinTimeResults.slice(i, i + batchSize);
      
      try {
        const updatePromises = batch.map(result => 
          this.prisma.user.upsert({
            where: { wikidotId: String(result.user_id) },
            update: { 
              joinTime: new Date(result.join_time),
              lastAnalyzedAt: new Date()
            },
            create: {
              name: result.user_name || `User_${result.user_id}`,
              wikidotId: String(result.user_id),
              displayName: result.user_name || `User_${result.user_id}`,
              joinTime: new Date(result.join_time),
              lastAnalyzedAt: new Date()
            }
          })
        );
        
        await Promise.all(updatePromises);
        
        this.stats.joinTimesCalculated += batch.length;
        
        if (this.stats.joinTimesCalculated % 500 === 0) {
          console.log(`   已处理 ${this.stats.joinTimesCalculated}/${joinTimeResults.length} 个用户...`);
        }
        
      } catch (error) {
        console.error(`❌ 批次更新joinTime失败: ${error.message}`);
        this.stats.errors.push({
          type: 'join_time_update_error',
          batch: { start: i, end: i + batch.length },
          error: error.message
        });
      }
    }
    
    console.log(`✅ joinTime计算完成: ${this.stats.joinTimesCalculated} 个用户`);
  }
  
  /**
   * 标记活跃用户（3个月内有任何activity）
   */
  async markActiveUsers() {
    console.log('🎯 标记活跃用户...');
    
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - this.ACTIVE_USER_WINDOW_MONTHS);
    
    // 查询3个月内有活动的用户
    const activeUsersQuery = `
      WITH recent_activities AS (
        -- 最近投票
        SELECT DISTINCT v."userWikidotId" as user_id
        FROM "VoteRecord" v
        WHERE v.timestamp >= $1
        
        UNION
        
        -- 最近修订
        SELECT DISTINCT r."userWikidotId" as user_id
        FROM "Revision" r
        WHERE r.timestamp >= $1
        
        UNION
        
        -- 最近创建页面
        SELECT DISTINCT p.createdByWikidotId as user_id
        FROM "Page" p
        WHERE p.createdAt >= $1
          AND p.createdByWikidotId IS NOT NULL
      )
      SELECT user_id FROM recent_activities
    `;
    
    const activeUserIds = await this.prisma.$queryRawUnsafe(activeUsersQuery, threeMonthsAgo);
    const activeIds = activeUserIds.map(row => parseInt(row.user_id));
    
    console.log(`   找到 ${activeIds.length} 个活跃用户`);
    
    // 先将所有用户标记为不活跃
    await this.prisma.user.updateMany({
      data: { 
        isActive: false,
        lastAnalyzedAt: new Date()
      }
    });
    
    // 然后将活跃用户标记为活跃
    if (activeIds.length > 0) {
      const batchSize = 1000;
      for (let i = 0; i < activeIds.length; i += batchSize) {
        const batch = activeIds.slice(i, i + batchSize);
        
        try {
          await this.prisma.user.updateMany({
            where: { wikidotId: { in: batch } },
            data: { 
              isActive: true,
              lastAnalyzedAt: new Date()
            }
          });
          
          this.stats.activeUsersMarked += batch.length;
          
        } catch (error) {
          console.error(`❌ 批次标记活跃用户失败: ${error.message}`);
          this.stats.errors.push({
            type: 'active_user_mark_error',
            batch: { start: i, end: i + batch.length },
            error: error.message
          });
        }
      }
    }
    
    console.log(`✅ 活跃用户标记完成: ${this.stats.activeUsersMarked} 个活跃用户`);
  }
  
  /**
   * 生成用户分析统计报告
   */
  async generateUserAnalysisReport() {
    console.log('\n📈 生成用户分析统计报告...');
    
    try {
      // 1. 总体统计
      const totalUsers = await this.prisma.user.count();
      const activeUsers = await this.prisma.user.count({
        where: { isActive: true }
      });
      const usersWithJoinTime = await this.prisma.user.count({
        where: { joinTime: { not: null } }
      });
      
      // 2. 按加入时间统计（年度分布）
      const joinTimeDistribution = await this.prisma.$queryRawUnsafe(`
        SELECT 
          EXTRACT(YEAR FROM "joinTime") as join_year,
          COUNT(*) as user_count
        FROM "User"
        WHERE "joinTime" IS NOT NULL
        GROUP BY EXTRACT(YEAR FROM "joinTime")
        ORDER BY join_year
      `);
      
      // 3. 最早的用户
      const earliestUsers = await this.prisma.user.findMany({
        where: { joinTime: { not: null } },
        orderBy: { joinTime: 'asc' },
        take: 10,
        select: {
          displayName: true,
          wikidotId: true,
          joinTime: true,
          isActive: true
        }
      });
      
      // 4. 最新的用户
      const newestUsers = await this.prisma.user.findMany({
        where: { joinTime: { not: null } },
        orderBy: { joinTime: 'desc' },
        take: 10,
        select: {
          displayName: true,
          wikidotId: true,
          joinTime: true,
          isActive: true
        }
      });
      
      // 5. 活跃度统计
      const activityStats = await this.prisma.$queryRawUnsafe(`
        SELECT 
          COUNT(CASE WHEN "isActive" = true THEN 1 END) as active_count,
          COUNT(CASE WHEN "isActive" = false THEN 1 END) as inactive_count,
          ROUND(AVG(CASE WHEN "isActive" = true THEN 1.0 ELSE 0.0 END) * 100, 2) as active_percentage
        FROM "User"
        WHERE "joinTime" IS NOT NULL
      `);
      
      // 打印报告
      console.log('\n📊 用户分析统计报告');
      console.log('='.repeat(80));
      console.log(`📈 总用户数: ${totalUsers.toLocaleString()}`);
      console.log(`🎯 活跃用户数: ${activeUsers.toLocaleString()}`);
      console.log(`📅 有joinTime的用户: ${usersWithJoinTime.toLocaleString()}`);
      console.log(`📊 活跃率: ${activityStats[0]?.active_percentage || 0}%`);
      
      console.log('\n📅 用户加入年度分布:');
      joinTimeDistribution.forEach(stat => {
        console.log(`   ${stat.join_year}: ${stat.user_count}人`);
      });
      
      console.log('\n🏆 最早加入的用户 (Top 10):');
      earliestUsers.forEach((user, i) => {
        const status = user.isActive ? '🟢' : '🔴';
        console.log(`   ${i + 1}. ${status} ${user.displayName} (${user.joinTime?.toISOString().split('T')[0]})`);
      });
      
      console.log('\n🆕 最新加入的用户 (Top 10):');
      newestUsers.forEach((user, i) => {
        const status = user.isActive ? '🟢' : '🔴';
        console.log(`   ${i + 1}. ${status} ${user.displayName} (${user.joinTime?.toISOString().split('T')[0]})`);
      });
      
    } catch (error) {
      console.error(`❌ 生成用户分析报告失败: ${error.message}`);
    }
  }
  
  /**
   * 查询特定用户的详细分析数据
   */
  async getUserAnalysis(userId) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { wikidotId: userId },
        include: {
          _count: {
            select: {
              voteRecords: true,
              revisions: true,
              createdPages: true
            }
          }
        }
      });
      
      if (!user) {
        return null;
      }
      
      // 获取最近活动
      const recentActivities = await this.prisma.$queryRawUnsafe(`
        SELECT 'vote' as type, timestamp, NULL as page_title
        FROM "VoteRecord" 
        WHERE "userWikidotId" = $1
        
        UNION ALL
        
        SELECT 'revision' as type, timestamp, NULL as page_title
        FROM "Revision" 
        WHERE "userWikidotId" = $1
        
        UNION ALL
        
        SELECT 'create_page' as type, "createdAt" as timestamp, title as page_title
        FROM "Page" 
        WHERE createdByWikidotId = $1
        
        ORDER BY timestamp DESC
        LIMIT 20
      `, userId);
      
      return {
        user,
        recentActivities,
        stats: {
          totalVotes: user._count.voteRecords,
          totalRevisions: user._count.revisions,
          totalPagesCreated: user._count.createdPages
        }
      };
      
    } catch (error) {
      console.error(`❌ 查询用户分析失败: ${error.message}`);
      return null;
    }
  }
  
  /**
   * 确保用户表包含必要的字段
   */
  async ensureUserTableFields() {
    try {
      // 添加joinTime字段
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE "User" 
        ADD COLUMN IF NOT EXISTS "joinTime" TIMESTAMP
      `);
      
      // 添加isActive字段
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE "User" 
        ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN DEFAULT false
      `);
      
      // 添加lastAnalyzedAt字段
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE "User" 
        ADD COLUMN IF NOT EXISTS "lastAnalyzedAt" TIMESTAMP
      `);
      
      // 创建索引
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_users_join_time 
        ON "User"("joinTime")
      `);
      
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_users_is_active 
        ON "User"("isActive")
      `);
      
    } catch (error) {
      console.log(`   用户表字段创建信息: ${error.message}`);
    }
  }
}