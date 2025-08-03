import { PrismaClient } from '@prisma/client';

/**
 * 添加用户投票模式分析表
 * 
 * 执行此脚本将创建两个新表：
 * 1. UserVoteInteraction - 用户间投票交互统计
 * 2. UserTagPreference - 用户标签偏好统计
 */

async function addVotePatternTables() {
  const prisma = new PrismaClient();
  
  try {
    console.log('🔧 开始创建用户投票模式分析表...');
    
    // 创建用户间投票交互统计表
    console.log('📊 创建UserVoteInteraction表...');
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS "UserVoteInteraction" (
        "fromUserId" INTEGER NOT NULL,
        "toUserId" INTEGER NOT NULL,
        "upvoteCount" INTEGER NOT NULL DEFAULT 0,
        "downvoteCount" INTEGER NOT NULL DEFAULT 0,
        "totalVotes" INTEGER NOT NULL DEFAULT 0,
        "lastVoteAt" TIMESTAMP,
        "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        
        PRIMARY KEY ("fromUserId", "toUserId"),
        
        CONSTRAINT "UserVoteInteraction_fromUserId_fkey" 
          FOREIGN KEY ("fromUserId") REFERENCES "User"("id") ON DELETE CASCADE,
        CONSTRAINT "UserVoteInteraction_toUserId_fkey" 
          FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE CASCADE,
        CONSTRAINT "UserVoteInteraction_different_users" 
          CHECK ("fromUserId" != "toUserId")
      )
    `;
    
    // 创建用户标签偏好统计表
    console.log('🏷️ 创建UserTagPreference表...');
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS "UserTagPreference" (
        "userId" INTEGER NOT NULL,
        "tag" VARCHAR(255) NOT NULL,
        "upvoteCount" INTEGER NOT NULL DEFAULT 0,
        "downvoteCount" INTEGER NOT NULL DEFAULT 0,
        "totalVotes" INTEGER NOT NULL DEFAULT 0,
        "lastVoteAt" TIMESTAMP,
        "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        
        PRIMARY KEY ("userId", "tag"),
        
        CONSTRAINT "UserTagPreference_userId_fkey" 
          FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE
      )
    `;
    
    // 创建索引以优化查询性能
    console.log('🚀 创建性能优化索引...');
    
    // UserVoteInteraction 相关索引
    await prisma.$executeRaw`
      CREATE INDEX IF NOT EXISTS "UserVoteInteraction_fromUserId_totalVotes_idx" 
      ON "UserVoteInteraction"("fromUserId", "totalVotes" DESC)
    `;
    
    await prisma.$executeRaw`
      CREATE INDEX IF NOT EXISTS "UserVoteInteraction_toUserId_totalVotes_idx" 
      ON "UserVoteInteraction"("toUserId", "totalVotes" DESC)
    `;
    
    await prisma.$executeRaw`
      CREATE INDEX IF NOT EXISTS "UserVoteInteraction_lastVoteAt_idx" 
      ON "UserVoteInteraction"("lastVoteAt" DESC)
    `;
    
    // UserTagPreference 相关索引
    await prisma.$executeRaw`
      CREATE INDEX IF NOT EXISTS "UserTagPreference_userId_totalVotes_idx" 
      ON "UserTagPreference"("userId", "totalVotes" DESC)
    `;
    
    await prisma.$executeRaw`
      CREATE INDEX IF NOT EXISTS "UserTagPreference_tag_totalVotes_idx" 
      ON "UserTagPreference"("tag", "totalVotes" DESC)
    `;
    
    // 验证表创建成功
    const interactionCount = await prisma.$queryRaw`
      SELECT COUNT(*) as count FROM "UserVoteInteraction"
    `;
    
    const preferenceCount = await prisma.$queryRaw`
      SELECT COUNT(*) as count FROM "UserTagPreference"  
    `;
    
    console.log('✅ 数据库表创建完成！');
    console.log(`📊 UserVoteInteraction表记录数: ${(interactionCount as any)[0].count}`);
    console.log(`🏷️ UserTagPreference表记录数: ${(preferenceCount as any)[0].count}`);
    
    // 显示表结构信息
    console.log('\n📋 表结构信息:');
    console.log('UserVoteInteraction: 用户间投票交互统计');
    console.log('  - fromUserId: 投票者ID');
    console.log('  - toUserId: 页面作者ID');
    console.log('  - upvoteCount: upvote数量');
    console.log('  - downvoteCount: downvote数量');
    console.log('  - totalVotes: 总投票数');
    console.log('  - lastVoteAt: 最后投票时间');
    
    console.log('\nUserTagPreference: 用户标签偏好统计');
    console.log('  - userId: 用户ID');
    console.log('  - tag: 标签名称');
    console.log('  - upvoteCount: 对该标签的upvote数量');
    console.log('  - downvoteCount: 对该标签的downvote数量');
    console.log('  - totalVotes: 对该标签的总投票数');
    console.log('  - lastVoteAt: 最后投票时间');
    
  } catch (error) {
    console.error('❌ 创建表失败:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// 如果直接运行此脚本
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 检查是否为直接运行
if (import.meta.url === `file://${process.argv[1]}`) {
  addVotePatternTables()
    .then(() => {
      console.log('🎉 脚本执行完成！');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 脚本执行失败:', error);
      process.exit(1);
    });
}

export { addVotePatternTables };