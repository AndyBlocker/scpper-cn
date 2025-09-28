// src/jobs/UserDataCompletenessJob.ts
import { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../utils/db-connection';

/**
 * 用户数据完整性填充任务
 * 填充 User 表中缺失的关键字段：
 * - username: 从 wikidotId 映射获取
 * - isGuest: 根据 wikidotId 判断（小于0为游客）
 * - firstActivityAt: 从最早的活动记录推算
 * - lastActivityAt: 从最近的活动记录推算
 */
export class UserDataCompletenessJob {
  private prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || getPrismaClient();
  }

  /**
   * 执行用户数据完整性填充
   */
  async execute(): Promise<void> {
    console.log('🔧 Starting user data completeness job...');
    
    try {
      // 1. 填充 isGuest 字段
      await this.updateIsGuestField();
      
      // 2. 填充 username 字段
      await this.updateUsernameField();
      
      // 3. 填充 firstActivityAt 字段
      await this.updateFirstActivityAt();
      
      // 4. 填充 lastActivityAt 字段
      await this.updateLastActivityAt();
      
      // 5. 显示统计信息
      await this.showStatistics();
      
      console.log('✅ User data completeness job completed');
    } catch (error) {
      console.error('❌ User data completeness job failed:', error);
      throw error;
    }
  }

  /**
   * 更新 isGuest 字段 - 已废弃，保留空实现以保持兼容性
   */
  private async updateIsGuestField(): Promise<void> {
    // isGuest 字段已废弃，不再使用
    console.log('⏭️ Skipping isGuest field update (deprecated)');
  }

  /**
   * 更新 username 字段
   * - 游客用户：使用 guest_ 前缀
   * - 没有 displayName 的用户：设为 (user deleted)
   * - 其他用户：基于 displayName 生成
   */
  private async updateUsernameField(): Promise<void> {
    console.log('📝 Updating username field...');
    
    // 对于游客用户（wikidotId < 0），使用特定格式
    const guestResult = await this.prisma.$executeRaw`
      UPDATE "User"
      SET "username" = CONCAT('guest_', ABS("wikidotId"))
      WHERE "wikidotId" < 0 AND "username" IS NULL
    `;
    
    console.log(`  ✓ Updated ${guestResult} guest usernames`);
    
    // 对于没有 displayName 的用户，设为 (user deleted)
    const deletedResult = await this.prisma.$executeRaw`
      UPDATE "User"
      SET "username" = '(user deleted)'
      WHERE "wikidotId" >= 0 
        AND "username" IS NULL 
        AND "displayName" IS NULL
    `;
    
    console.log(`  ✓ Marked ${deletedResult} users as deleted`);
    
    // 对于有 displayName 的用户，基于 displayName 生成
    const normalResult = await this.prisma.$executeRaw`
      UPDATE "User"
      SET "username" = LOWER(REPLACE("displayName", ' ', '_'))
      WHERE "wikidotId" >= 0 
        AND "username" IS NULL 
        AND "displayName" IS NOT NULL
    `;
    
    console.log(`  ✓ Updated ${normalResult} normal usernames`);
  }

  /**
   * 更新 firstActivityAt 字段
   */
  private async updateFirstActivityAt(): Promise<void> {
    console.log('📝 Updating firstActivityAt field...');
    
    // 使用 CTE 计算每个用户的最早活动时间
    const result = await this.prisma.$executeRaw`
      WITH user_first_activity AS (
        SELECT 
          "userId",
          MIN(activity_time) as first_activity,
          activity_type,
          activity_details
        FROM (
          -- 投票活动
          SELECT 
            v."userId", 
            v."timestamp" as activity_time,
            'vote' as activity_type,
            CONCAT('Voted on page') as activity_details
          FROM "Vote" v
          WHERE v."userId" IS NOT NULL
          
          UNION ALL
          
          -- 修订活动
          SELECT 
            r."userId",
            r."timestamp" as activity_time,
            'revision' as activity_type,
            CONCAT('Created revision #', r."revisionNumber") as activity_details
          FROM "Revision" r
          WHERE r."userId" IS NOT NULL
          
          UNION ALL
          
          -- 页面创建活动（通过 Attribution）
          SELECT 
            a."userId",
            a."date" as activity_time,
            'attribution' as activity_type,
            CONCAT('Attributed as ', a."type") as activity_details
          FROM "Attribution" a
          WHERE a."userId" IS NOT NULL AND a."date" IS NOT NULL
        ) all_activities
        GROUP BY "userId", activity_type, activity_details
        ORDER BY "userId", first_activity
      ),
      -- 获取每个用户的真正第一次活动
      user_absolute_first AS (
        SELECT DISTINCT ON ("userId")
          "userId",
          first_activity,
          activity_type,
          activity_details
        FROM user_first_activity
        ORDER BY "userId", first_activity
      )
      UPDATE "User" u
      SET 
        "firstActivityAt" = uaf.first_activity,
        "firstActivityType" = uaf.activity_type,
        "firstActivityDetails" = uaf.activity_details
      FROM user_absolute_first uaf
      WHERE u.id = uaf."userId"
        AND u."firstActivityAt" IS NULL
    `;
    
    console.log(`  ✓ Updated ${result} users' first activity timestamps`);
  }

  /**
   * 更新 lastActivityAt 字段
   */
  private async updateLastActivityAt(): Promise<void> {
    console.log('📝 Updating lastActivityAt field...');
    
    // 使用 CTE 计算每个用户的最近活动时间
    const result = await this.prisma.$executeRaw`
      WITH user_last_activity AS (
        SELECT 
          "userId",
          MAX(activity_time) as last_activity
        FROM (
          -- 投票活动
          SELECT v."userId", v."timestamp" as activity_time
          FROM "Vote" v
          WHERE v."userId" IS NOT NULL
          
          UNION ALL
          
          -- 修订活动
          SELECT r."userId", r."timestamp" as activity_time
          FROM "Revision" r
          WHERE r."userId" IS NOT NULL
          
          UNION ALL
          
          -- 页面创建活动（通过 Attribution）
          SELECT a."userId", a."date" as activity_time
          FROM "Attribution" a
          WHERE a."userId" IS NOT NULL AND a."date" IS NOT NULL
        ) all_activities
        GROUP BY "userId"
      )
      UPDATE "User" u
      SET "lastActivityAt" = ula.last_activity
      FROM user_last_activity ula
      WHERE u.id = ula."userId"
        AND (u."lastActivityAt" IS NULL OR u."lastActivityAt" < ula.last_activity)
    `;
    
    console.log(`  ✓ Updated ${result} users' last activity timestamps`);
  }

  /**
   * 显示统计信息
   */
  private async showStatistics(): Promise<void> {
    console.log('\n📊 User data completeness statistics:');
    
    const stats = await this.prisma.$queryRaw<Array<{
      total_users: bigint;
      users_with_username: bigint;
      users_with_is_guest: bigint;
      users_with_first_activity: bigint;
      users_with_last_activity: bigint;
      guest_users: bigint;
      registered_users: bigint;
    }>>`
      SELECT 
        COUNT(*) as total_users,
        COUNT("username") as users_with_username,
        COUNT("isGuest") as users_with_is_guest,
        COUNT("firstActivityAt") as users_with_first_activity,
        COUNT("lastActivityAt") as users_with_last_activity,
        COUNT(*) FILTER (WHERE "isGuest" = true) as guest_users,
        COUNT(*) FILTER (WHERE "isGuest" = false) as registered_users
      FROM "User"
    `;
    
    const stat = stats[0];
    console.log(`  Total users: ${stat.total_users}`);
    console.log(`  Users with username: ${stat.users_with_username} (${(Number(stat.users_with_username) / Number(stat.total_users) * 100).toFixed(1)}%)`);
    console.log(`  Users with isGuest: ${stat.users_with_is_guest} (${(Number(stat.users_with_is_guest) / Number(stat.total_users) * 100).toFixed(1)}%)`);
    console.log(`  Users with firstActivityAt: ${stat.users_with_first_activity} (${(Number(stat.users_with_first_activity) / Number(stat.total_users) * 100).toFixed(1)}%)`);
    console.log(`  Users with lastActivityAt: ${stat.users_with_last_activity} (${(Number(stat.users_with_last_activity) / Number(stat.total_users) * 100).toFixed(1)}%)`);
    console.log(`  Guest users: ${stat.guest_users}`);
    console.log(`  Registered users: ${stat.registered_users}`);
  }

  /**
   * 获取需要更新的用户列表（用于增量更新）
   */
  async getUsersNeedingUpdate(): Promise<number[]> {
    const users = await this.prisma.user.findMany({
      where: {
        OR: [
          { username: null },
          { isGuest: null },
          { firstActivityAt: null },
          { lastActivityAt: null }
        ]
      },
      select: { id: true }
    });
    
    return users.map(u => u.id);
  }
}

/**
 * 便捷的执行函数
 */
export async function updateUserDataCompleteness(prisma?: PrismaClient) {
  const job = new UserDataCompletenessJob(prisma);
  await job.execute();
}