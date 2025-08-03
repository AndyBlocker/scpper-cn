import { PrismaClient } from '@prisma/client';

/**
 * 分析用户投票交互模式，查找最高互动的用户对
 */
async function analyzeVoteInteractions() {
  const prisma = new PrismaClient();
  
  try {
    console.log('🔍 分析用户投票交互模式...');
    
    // 1. 查找投票数量最多的用户对 (单向)
    console.log('\n📊 单向投票数量最多的用户对 Top10:');
    const topSingleDirections = await prisma.$queryRaw<Array<{
      fromUserId: number;
      fromDisplayName: string;
      toUserId: number;
      toDisplayName: string;
      totalVotes: number;
      upvoteCount: number;
      downvoteCount: number;
    }>>`
      SELECT 
        uvi."fromUserId",
        u1."displayName" as "fromDisplayName",
        uvi."toUserId",
        u2."displayName" as "toDisplayName",
        uvi."totalVotes",
        uvi."upvoteCount",
        uvi."downvoteCount"
      FROM "UserVoteInteraction" uvi
      INNER JOIN "User" u1 ON uvi."fromUserId" = u1.id
      INNER JOIN "User" u2 ON uvi."toUserId" = u2.id
      ORDER BY uvi."totalVotes" DESC
      LIMIT 10
    `;

    topSingleDirections.forEach((interaction, index) => {
      console.log(`${index + 1}. ${interaction.fromDisplayName} → ${interaction.toDisplayName}`);
      console.log(`   总票数: ${interaction.totalVotes} (↑${interaction.upvoteCount} ↓${interaction.downvoteCount})`);
    });

    // 2. 查找相互投票最多的用户对
    console.log('\n🔄 相互投票数量最多的用户对 Top10:');
    const topMutualVotes = await prisma.$queryRaw<Array<{
      user1Id: number;
      user1Name: string;
      user2Id: number;
      user2Name: string;
      votes_1_to_2: number;
      votes_2_to_1: number;
      mutual_total: number;
      up_1_to_2: number;
      down_1_to_2: number;
      up_2_to_1: number;
      down_2_to_1: number;
    }>>`
      WITH mutual_votes AS (
        SELECT 
          LEAST(uvi1."fromUserId", uvi1."toUserId") as user1_id,
          GREATEST(uvi1."fromUserId", uvi1."toUserId") as user2_id,
          CASE 
            WHEN uvi1."fromUserId" < uvi1."toUserId" 
            THEN uvi1."totalVotes" 
            ELSE uvi2."totalVotes" 
          END as votes_1_to_2,
          CASE 
            WHEN uvi1."fromUserId" < uvi1."toUserId" 
            THEN uvi2."totalVotes" 
            ELSE uvi1."totalVotes" 
          END as votes_2_to_1,
          CASE 
            WHEN uvi1."fromUserId" < uvi1."toUserId" 
            THEN uvi1."upvoteCount" 
            ELSE uvi2."upvoteCount" 
          END as up_1_to_2,
          CASE 
            WHEN uvi1."fromUserId" < uvi1."toUserId" 
            THEN uvi1."downvoteCount" 
            ELSE uvi2."downvoteCount" 
          END as down_1_to_2,
          CASE 
            WHEN uvi1."fromUserId" < uvi1."toUserId" 
            THEN uvi2."upvoteCount" 
            ELSE uvi1."upvoteCount" 
          END as up_2_to_1,
          CASE 
            WHEN uvi1."fromUserId" < uvi1."toUserId" 
            THEN uvi2."downvoteCount" 
            ELSE uvi1."downvoteCount" 
          END as down_2_to_1
        FROM "UserVoteInteraction" uvi1
        INNER JOIN "UserVoteInteraction" uvi2 
          ON uvi1."fromUserId" = uvi2."toUserId" 
          AND uvi1."toUserId" = uvi2."fromUserId"
        WHERE uvi1."fromUserId" < uvi1."toUserId"  -- 避免重复
      )
      SELECT 
        mv.user1_id as "user1Id",
        u1."displayName" as "user1Name",
        mv.user2_id as "user2Id", 
        u2."displayName" as "user2Name",
        mv.votes_1_to_2,
        mv.votes_2_to_1,
        (mv.votes_1_to_2 + mv.votes_2_to_1) as mutual_total,
        mv.up_1_to_2,
        mv.down_1_to_2,
        mv.up_2_to_1,
        mv.down_2_to_1
      FROM mutual_votes mv
      INNER JOIN "User" u1 ON mv.user1_id = u1.id
      INNER JOIN "User" u2 ON mv.user2_id = u2.id
      ORDER BY mutual_total DESC
      LIMIT 10
    `;

    topMutualVotes.forEach((pair, index) => {
      console.log(`${index + 1}. ${pair.user1Name} ⇄ ${pair.user2Name}`);
      console.log(`   相互总票数: ${pair.mutual_total}`);
      console.log(`   ${pair.user1Name} → ${pair.user2Name}: ${pair.votes_1_to_2} (↑${pair.up_1_to_2} ↓${pair.down_1_to_2})`);
      console.log(`   ${pair.user2Name} → ${pair.user1Name}: ${pair.votes_2_to_1} (↑${pair.up_2_to_1} ↓${pair.down_2_to_1})`);
      console.log('');
    });

    // 3. 查找downvote最多的用户对
    console.log('\n👎 downvote数量最多的用户对 Top10:');
    const topDownvotes = await prisma.$queryRaw<Array<{
      fromUserId: number;
      fromDisplayName: string;
      toUserId: number;
      toDisplayName: string;
      downvoteCount: number;
      upvoteCount: number;
      totalVotes: number;
      downvoteRatio: number;
    }>>`
      SELECT 
        uvi."fromUserId",
        u1."displayName" as "fromDisplayName",
        uvi."toUserId",
        u2."displayName" as "toDisplayName",
        uvi."downvoteCount",
        uvi."upvoteCount",
        uvi."totalVotes",
        CASE 
          WHEN uvi."totalVotes" > 0 
          THEN uvi."downvoteCount"::float / uvi."totalVotes"::float
          ELSE 0
        END as "downvoteRatio"
      FROM "UserVoteInteraction" uvi
      INNER JOIN "User" u1 ON uvi."fromUserId" = u1.id
      INNER JOIN "User" u2 ON uvi."toUserId" = u2.id
      WHERE uvi."downvoteCount" > 0
      ORDER BY uvi."downvoteCount" DESC
      LIMIT 10
    `;

    topDownvotes.forEach((interaction, index) => {
      const ratio = (interaction.downvoteRatio * 100).toFixed(1);
      console.log(`${index + 1}. ${interaction.fromDisplayName} → ${interaction.toDisplayName}`);
      console.log(`   downvote: ${interaction.downvoteCount}, upvote: ${interaction.upvoteCount}, 总票数: ${interaction.totalVotes} (dv率: ${ratio}%)`);
    });

    // 4. 查找高度不平衡的投票关系（一方大量投另一方，但回投很少）
    console.log('\n⚖️ 高度不平衡的投票关系 Top10:');
    const imbalancedVotes = await prisma.$queryRaw<Array<{
      activeUserId: number;
      activeUserName: string;
      passiveUserId: number;
      passiveUserName: string;
      active_to_passive: number;
      passive_to_active: number;
      imbalance_ratio: number;
    }>>`
      WITH imbalanced_pairs AS (
        SELECT 
          uvi1."fromUserId" as active_user_id,
          uvi1."toUserId" as passive_user_id,
          uvi1."totalVotes" as active_to_passive,
          COALESCE(uvi2."totalVotes", 0) as passive_to_active,
          CASE 
            WHEN COALESCE(uvi2."totalVotes", 0) = 0 
            THEN uvi1."totalVotes"::float
            ELSE uvi1."totalVotes"::float / uvi2."totalVotes"::float
          END as imbalance_ratio
        FROM "UserVoteInteraction" uvi1
        LEFT JOIN "UserVoteInteraction" uvi2 
          ON uvi1."fromUserId" = uvi2."toUserId" 
          AND uvi1."toUserId" = uvi2."fromUserId"
        WHERE uvi1."totalVotes" >= 10  -- 至少10票才算
      )
      SELECT 
        ip.active_user_id as "activeUserId",
        u1."displayName" as "activeUserName",
        ip.passive_user_id as "passiveUserId",
        u2."displayName" as "passiveUserName",
        ip.active_to_passive,
        ip.passive_to_active,
        ip.imbalance_ratio
      FROM imbalanced_pairs ip
      INNER JOIN "User" u1 ON ip.active_user_id = u1.id
      INNER JOIN "User" u2 ON ip.passive_user_id = u2.id
      ORDER BY ip.imbalance_ratio DESC
      LIMIT 10
    `;

    imbalancedVotes.forEach((pair, index) => {
      console.log(`${index + 1}. ${pair.activeUserName} → ${pair.passiveUserName}`);
      console.log(`   单向投票: ${pair.active_to_passive}, 回投: ${pair.passive_to_active}, 不平衡比: ${pair.imbalance_ratio.toFixed(1)}:1`);
    });

    // 5. 统计信息
    console.log('\n📈 总体统计信息:');
    const overallStats = await prisma.$queryRaw<Array<{
      total_interactions: bigint;
      mutual_interactions: bigint;
      one_way_interactions: bigint;
      avg_votes_per_interaction: number;
      max_single_direction: number;
      users_with_interactions: bigint;
    }>>`
      WITH interaction_stats AS (
        SELECT 
          COUNT(*) as total_interactions,
          AVG("totalVotes"::float) as avg_votes_per_interaction,
          MAX("totalVotes") as max_single_direction,
          COUNT(DISTINCT "fromUserId") as users_with_interactions
        FROM "UserVoteInteraction"
      ),
      mutual_stats AS (
        SELECT 
          COUNT(*) as mutual_count
        FROM "UserVoteInteraction" uvi1
        WHERE EXISTS (
          SELECT 1 FROM "UserVoteInteraction" uvi2 
          WHERE uvi1."fromUserId" = uvi2."toUserId" 
          AND uvi1."toUserId" = uvi2."fromUserId"
        )
      )
      SELECT 
        interaction_stats.total_interactions,
        mutual_stats.mutual_count as mutual_interactions,
        (interaction_stats.total_interactions - mutual_stats.mutual_count) as one_way_interactions,
        interaction_stats.avg_votes_per_interaction,
        interaction_stats.max_single_direction,
        interaction_stats.users_with_interactions
      FROM interaction_stats, mutual_stats
    `;

    const stats = overallStats[0];
    console.log(`总交互对数: ${Number(stats.total_interactions)}`);
    console.log(`相互投票对数: ${Number(stats.mutual_interactions)}`);
    console.log(`单向投票对数: ${Number(stats.one_way_interactions)}`);
    console.log(`平均每对投票数: ${stats.avg_votes_per_interaction.toFixed(2)}`);
    console.log(`单向最高投票数: ${stats.max_single_direction}`);
    console.log(`有投票交互的用户数: ${Number(stats.users_with_interactions)}`);

  } catch (error) {
    console.error('❌ 分析失败:', error);
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
  analyzeVoteInteractions()
    .then(() => {
      console.log('🎉 分析完成！');
      process.exit(0);
    })
    .catch((error) => {
      console.error('💥 分析失败:', error);
      process.exit(1);
    });
}

export { analyzeVoteInteractions };