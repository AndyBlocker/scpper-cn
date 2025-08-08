import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function checkVoteDataStructure() {
  console.log('🔍 检查Vote表数据结构和时间精度...\n');
  
  try {
    // 1. 检查Vote表的基本统计
    const voteCount = await prisma.vote.count();
    console.log(`📊 Vote表总记录数: ${voteCount}`);
    
    if (voteCount === 0) {
      console.log('❌ Vote表没有数据，无法进行进一步分析');
      return;
    }

    // 2. 检查timestamp字段的时间精度和分布
    console.log('\n⏰ 检查timestamp字段的时间精度...');
    
    const timestampSample = await prisma.$queryRaw<Array<{
      timestamp: Date,
      date_part: string,
      time_part: string,
      has_time: boolean
    }>>`
      SELECT 
        "timestamp",
        DATE("timestamp")::text as date_part,
        TIME("timestamp")::text as time_part,
        CASE 
          WHEN TIME("timestamp") != '00:00:00' THEN true
          ELSE false
        END as has_time
      FROM "Vote" 
      ORDER BY "timestamp" DESC 
      LIMIT 10
    `;
    
    console.log('最新10条Vote记录的时间信息:');
    timestampSample.forEach((record, i) => {
      console.log(`${i + 1}. ${record.timestamp.toISOString()} | 日期: ${record.date_part} | 时间: ${record.time_part} | 有具体时间: ${record.has_time}`);
    });

    // 3. 统计有具体时间的记录比例
    const timeAnalysis = await prisma.$queryRaw<Array<{
      total_votes: bigint,
      votes_with_time: bigint,
      votes_date_only: bigint,
      percentage_with_time: number
    }>>`
      SELECT 
        COUNT(*) as total_votes,
        COUNT(*) FILTER (WHERE TIME("timestamp") != '00:00:00') as votes_with_time,
        COUNT(*) FILTER (WHERE TIME("timestamp") = '00:00:00') as votes_date_only,
        (COUNT(*) FILTER (WHERE TIME("timestamp") != '00:00:00') * 100.0 / COUNT(*))::numeric as percentage_with_time
      FROM "Vote"
    `;

    const analysis = timeAnalysis[0];
    console.log('\n📈 时间精度分析:');
    console.log(`总投票数: ${analysis.total_votes}`);
    console.log(`有具体时间的投票: ${analysis.votes_with_time} (${Number(analysis.percentage_with_time).toFixed(1)}%)`);
    console.log(`只有日期的投票: ${analysis.votes_date_only} (${(100 - Number(analysis.percentage_with_time)).toFixed(1)}%)`);

    // 4. 检查最早和最晚的投票时间
    const dateRange = await prisma.$queryRaw<Array<{
      earliest_vote: Date,
      latest_vote: Date,
      date_span_days: number
    }>>`
      SELECT 
        MIN("timestamp") as earliest_vote,
        MAX("timestamp") as latest_vote,
        EXTRACT(DAYS FROM (MAX("timestamp") - MIN("timestamp")))::int as date_span_days
      FROM "Vote"
    `;

    const range = dateRange[0];
    console.log('\n📅 投票时间范围:');
    console.log(`最早投票: ${range.earliest_vote.toISOString()}`);
    console.log(`最晚投票: ${range.latest_vote.toISOString()}`);
    console.log(`时间跨度: ${range.date_span_days} 天`);

    // 5. 检查每日投票分布（最近30天）
    console.log('\n📊 最近30天每日投票分布:');
    
    const dailyVotes = await prisma.$queryRaw<Array<{
      vote_date: string,
      vote_count: bigint,
      unique_users: bigint,
      unique_pages: bigint
    }>>`
      SELECT 
        DATE("timestamp")::text as vote_date,
        COUNT(*) as vote_count,
        COUNT(DISTINCT "userId") FILTER (WHERE "userId" IS NOT NULL) as unique_users,
        COUNT(DISTINCT "pageVersionId") as unique_pages
      FROM "Vote"
      WHERE "timestamp" >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY DATE("timestamp")
      ORDER BY vote_date DESC
      LIMIT 10
    `;

    dailyVotes.forEach(day => {
      console.log(`${day.vote_date}: ${day.vote_count} 投票 | ${day.unique_users} 用户 | ${day.unique_pages} 页面`);
    });

    // 6. 检查投票方向分布
    console.log('\n👍👎 投票方向分布:');
    
    const directionStats = await prisma.$queryRaw<Array<{
      direction: number,
      vote_count: bigint,
      percentage: number
    }>>`
      SELECT 
        "direction",
        COUNT(*) as vote_count,
        (COUNT(*) * 100.0 / (SELECT COUNT(*) FROM "Vote"))::numeric as percentage
      FROM "Vote"
      GROUP BY "direction"
      ORDER BY "direction" DESC
    `;

    directionStats.forEach(stat => {
      const dirText = stat.direction > 0 ? 'Upvote' : stat.direction < 0 ? 'Downvote' : 'Neutral';
      console.log(`${dirText} (${stat.direction}): ${stat.vote_count} (${Number(stat.percentage).toFixed(1)}%)`);
    });

    // 7. 检查匿名投票vs已注册用户投票
    console.log('\n👤 用户投票统计:');
    
    const userStats = await prisma.$queryRaw<Array<{
      user_type: string,
      vote_count: bigint,
      percentage: number
    }>>`
      SELECT 
        CASE 
          WHEN "userId" IS NOT NULL THEN 'Registered User'
          ELSE 'Anonymous'
        END as user_type,
        COUNT(*) as vote_count,
        (COUNT(*) * 100.0 / (SELECT COUNT(*) FROM "Vote"))::numeric as percentage
      FROM "Vote"
      GROUP BY CASE WHEN "userId" IS NOT NULL THEN 'Registered User' ELSE 'Anonymous' END
      ORDER BY vote_count DESC
    `;

    userStats.forEach(stat => {
      console.log(`${stat.user_type}: ${stat.vote_count} (${Number(stat.percentage).toFixed(1)}%)`);
    });

    // 8. 根据分析结果给出建议
    console.log('\n💡 数据预处理建议:');
    
    const hasTimeData = Number(analysis.percentage_with_time) > 10;
    
    if (hasTimeData) {
      console.log('✅ Vote数据包含较多具体时间信息，可以进行小时级别的分析');
      console.log('- 可以分析投票的小时分布模式');
      console.log('- 可以进行用户活跃时段分析');
    } else {
      console.log('⚠️  Vote数据主要是日级别精度，需要调整分析策略');
      console.log('- 避免小时级别的分析');
      console.log('- 专注于日级别的趋势分析');
      console.log('- 可以分析每日投票总量、用户活跃度等指标');
    }

  } catch (error) {
    console.error('❌ 检查过程中发生错误:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// 执行检查
checkVoteDataStructure().catch(console.error);