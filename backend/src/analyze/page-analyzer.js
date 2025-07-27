/**
 * 文件路径: src/analyze/page-analyzer.js
 * 功能概述: SCPPER-CN 页面质量分析器模块
 * 
 * 主要功能:
 * - 威尔逊置信区间计算，提供更准确的页面质量评估
 * - 页面争议度分析，基于上票下票分布计算
 * - 页面质量排名和置信区间下界计算
 * - 好评率统计和小样本偏差校正
 * - 自动数据库表结构更新和字段添加
 * - 页面质量分析报告生成
 * 
 * 核心特性:
 * - 威尔逊得分公式：更保守的质量评估，避免小样本偏差
 * - 95%置信区间计算（z=1.96），提供统计学可靠性
 * - 争议度计算：识别争议性页面
 * - 批量页面数据处理和性能优化
 * 
 * 数据库字段:
 * - wilsonScore: 威尔逊置信区间得分 (0-1)
 * - upVoteRatio: 好评率 (0-1)
 * - controversyScore: 争议度得分
 * - lastAnalyzedAt: 最后分析时间
 */
export class PageAnalyzer {
  constructor(prisma) {
    this.prisma = prisma;
    this.stats = {
      pagesProcessed: 0,
      wilsonScoresCalculated: 0,
      errors: []
    };
    
    // 威尔逊置信区间参数
    this.WILSON_Z_SCORE = 1.96; // 95%置信区间的z值
  }
  
  /**
   * 分析并更新所有页面数据
   */
  async analyzeAndUpdatePageData() {
    console.log('📄 开始分析页面数据...');
    
    try {
      // 1. 计算威尔逊置信区间
      await this.calculateWilsonScores();
      
      // 2. 生成页面分析报告
      await this.generatePageAnalysisReport();
      
      console.log(`✅ 页面数据分析完成: ${this.stats.pagesProcessed} 个页面`);
      
    } catch (error) {
      console.error(`❌ 页面数据分析失败: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * 计算威尔逊置信区间下界
   * 公式: S = (p + z²/(2n) - z/(2n) * sqrt(4np(1-p) + z²)) / (1 + z²/n)
   * 其中: p为好评率, n为总投票数, z为正态分布95%分位数(1.96)
   */
  calculateWilsonScore(upVotes, totalVotes) {
    // 输入验证和边界情况处理
    if (!totalVotes || totalVotes <= 0 || !Number.isFinite(totalVotes)) {
      return 0; // 没有投票的页面威尔逊得分为0
    }
    
    if (!upVotes || upVotes < 0 || !Number.isFinite(upVotes)) {
      upVotes = 0; // 处理负数或无效的upVotes
    }
    
    if (upVotes > totalVotes) {
      upVotes = totalVotes; // upVotes不能超过totalVotes
    }
    
    const n = totalVotes;
    const p = upVotes / n; // 好评率
    const z = this.WILSON_Z_SCORE;
    
    // 检查sqrt内的值是否为负数
    const sqrtContent = 4 * n * p * (1 - p) + z * z;
    if (sqrtContent < 0) {
      console.warn(`威尔逊得分计算警告: sqrt内容为负数 ${sqrtContent}, upVotes=${upVotes}, totalVotes=${totalVotes}`);
      return 0;
    }
    
    // 威尔逊置信区间下界公式
    const numerator = p + (z * z) / (2 * n) - z / (2 * n) * Math.sqrt(sqrtContent);
    const denominator = 1 + (z * z) / n;
    
    if (denominator === 0) {
      console.warn(`威尔逊得分计算警告: 分母为0, n=${n}, z=${z}`);
      return 0;
    }
    
    const wilsonScore = numerator / denominator;
    
    // 确保结果在[0,1]范围内并且是有效数值
    if (!Number.isFinite(wilsonScore)) {
      console.warn(`威尔逊得分计算警告: 结果不是有效数值 ${wilsonScore}, upVotes=${upVotes}, totalVotes=${totalVotes}`);
      return 0;
    }
    
    return Math.max(0, Math.min(1, wilsonScore));
  }
  
  /**
   * 批量计算并更新所有页面的威尔逊得分
   */
  async calculateWilsonScores() {
    console.log('🧮 计算页面威尔逊置信区间...');
    
    // 获取所有页面的投票统计
    const pagesWithVoteStats = await this.prisma.$queryRawUnsafe(`
      SELECT 
        p.url,
        p.title,
        p.rating,
        p."voteCount",
        COALESCE(vote_stats.up_votes, 0) as up_votes,
        COALESCE(vote_stats.down_votes, 0) as down_votes,
        COALESCE(vote_stats.total_votes, 0) as total_votes
      FROM "Page" p
      LEFT JOIN (
        SELECT 
          v."pageId",
          COUNT(CASE WHEN v.direction > 0 THEN 1 END) as up_votes,
          COUNT(CASE WHEN v.direction < 0 THEN 1 END) as down_votes,
          COUNT(*) as total_votes
        FROM "VoteRecord" v
        WHERE v.direction != 0
        GROUP BY v."pageId"
      ) vote_stats ON p.id = vote_stats."pageId"
      ORDER BY p.url
    `);
    
    console.log(`   找到 ${pagesWithVoteStats.length} 个页面需要计算威尔逊得分`);
    
    // 批量处理页面
    const batchSize = 200;
    for (let i = 0; i < pagesWithVoteStats.length; i += batchSize) {
      const batch = pagesWithVoteStats.slice(i, i + batchSize);
      
      try {
        const updatePromises = batch.map(page => {
          // 安全的数值转换
          const safeParseInt = (value) => {
            const parsed = parseInt(value);
            return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
          };
          
          const upVotes = safeParseInt(page.up_votes);
          const downVotes = safeParseInt(page.down_votes);
          const totalVotes = safeParseInt(page.total_votes);
          
          const wilsonScore = this.calculateWilsonScore(upVotes, totalVotes);
          
          // 计算一些额外的统计数据
          const upVoteRatio = totalVotes > 0 ? upVotes / totalVotes : 0;
          const controversyScore = this.calculateControversyScore(upVotes, downVotes);
          
          return this.prisma.page.updateMany({
            where: { 
              url: page.url,
              instanceDeletedAt: null  // 只更新活跃实例
            },
            data: {
              wilsonScore: wilsonScore,
              upVoteRatio: upVoteRatio,
              controversyScore: controversyScore,
              lastAnalyzedAt: new Date()
            }
          });
        });
        
        await Promise.all(updatePromises);
        
        this.stats.wilsonScoresCalculated += batch.length;
        this.stats.pagesProcessed += batch.length;
        
        if (this.stats.pagesProcessed % 1000 === 0) {
          console.log(`   已处理 ${this.stats.pagesProcessed}/${pagesWithVoteStats.length} 个页面...`);
        }
        
      } catch (error) {
        console.error(`❌ 批次计算威尔逊得分失败: ${error.message}`);
        this.stats.errors.push({
          type: 'wilson_score_calculation_error',
          batch: { start: i, end: i + batch.length },
          error: error.message
        });
      }
    }
    
    console.log(`✅ 威尔逊得分计算完成: ${this.stats.wilsonScoresCalculated} 个页面`);
  }
  
  /**
   * 计算争议度得分
   * 基于上票和下票的比例，争议度高的内容通常上票和下票都很多
   */
  calculateControversyScore(upVotes, downVotes) {
    // 输入验证
    if (!Number.isFinite(upVotes) || upVotes < 0) upVotes = 0;
    if (!Number.isFinite(downVotes) || downVotes < 0) downVotes = 0;
    
    const totalVotes = upVotes + downVotes;
    if (totalVotes === 0) {
      return 0;
    }
    
    const maxVotes = Math.max(upVotes, downVotes);
    if (maxVotes === 0) {
      return 0; // 防止除零
    }
    
    // 争议度计算：当上票和下票接近时争议度最高
    const ratio = Math.min(upVotes, downVotes) / maxVotes;
    const magnitude = Math.log(totalVotes + 1); // 投票总数的影响
    
    const controversyScore = ratio * magnitude;
    
    // 确保返回有效数值
    return Number.isFinite(controversyScore) ? controversyScore : 0;
  }
  
  /**
   * 生成页面分析统计报告
   */
  async generatePageAnalysisReport() {
    console.log('\n📈 生成页面分析统计报告...');
    
    try {
      // 1. 总体统计
      const totalPages = await this.prisma.page.count();
      const pagesWithVotes = await this.prisma.page.count({
        where: { voteCount: { gt: 0 } }
      });
      const pagesWithWilsonScore = await this.prisma.page.count({
        where: { wilsonScore: { not: null } }
      });
      
      // 2. 威尔逊得分分布
      const wilsonDistribution = await this.prisma.$queryRawUnsafe(`
        SELECT 
          CASE 
            WHEN "wilsonScore" >= 0.8 THEN '0.8-1.0'
            WHEN "wilsonScore" >= 0.6 THEN '0.6-0.8'
            WHEN "wilsonScore" >= 0.4 THEN '0.4-0.6'
            WHEN "wilsonScore" >= 0.2 THEN '0.2-0.4'
            ELSE '0.0-0.2'
          END as score_range,
          COUNT(*) as page_count
        FROM "Page"
        WHERE "wilsonScore" IS NOT NULL
        GROUP BY score_range
        ORDER BY score_range DESC
      `);
      
      // 3. 威尔逊得分排名前10的页面
      const topPagesByWilson = await this.prisma.page.findMany({
        where: { 
          wilsonScore: { not: null },
          voteCount: { gte: 5 } // 至少5票才参与排名
        },
        orderBy: { wilsonScore: 'desc' },
        take: 10,
        select: {
          title: true,
          url: true,
          rating: true,
          voteCount: true,
          wilsonScore: true,
          upVoteRatio: true
        }
      });
      
      // 4. 争议度最高的页面
      const mostControversialPages = await this.prisma.page.findMany({
        where: { 
          controversyScore: { not: null },
          voteCount: { gte: 10 }
        },
        orderBy: { controversyScore: 'desc' },
        take: 10,
        select: {
          title: true,
          url: true,
          rating: true,
          voteCount: true,
          controversyScore: true,
          upVoteRatio: true
        }
      });
      
      // 5. 投票数vs威尔逊得分相关性分析
      const correlationData = await this.prisma.$queryRawUnsafe(`
        SELECT 
          CASE 
            WHEN "voteCount" >= 100 THEN '100+'
            WHEN "voteCount" >= 50 THEN '50-99'
            WHEN "voteCount" >= 20 THEN '20-49'
            WHEN "voteCount" >= 10 THEN '10-19'
            WHEN "voteCount" >= 5 THEN '5-9'
            ELSE '1-4'
          END as vote_range,
          COUNT(*) as page_count,
          AVG("wilsonScore") as avg_wilson_score,
          AVG("upVoteRatio") as avg_up_vote_ratio
        FROM "Page"
        WHERE "wilsonScore" IS NOT NULL AND "voteCount" > 0
        GROUP BY vote_range
        ORDER BY MIN("voteCount")
      `);
      
      // 打印报告
      console.log('\n📊 页面分析统计报告');
      console.log('='.repeat(80));
      console.log(`📈 总页面数: ${totalPages.toLocaleString()}`);
      console.log(`🗳️  有投票页面数: ${pagesWithVotes.toLocaleString()}`);
      console.log(`🧮 有威尔逊得分页面数: ${pagesWithWilsonScore.toLocaleString()}`);
      
      console.log('\n📊 威尔逊得分分布:');
      wilsonDistribution.forEach(dist => {
        console.log(`   ${dist.score_range}: ${dist.page_count}个页面`);
      });
      
      console.log('\n🏆 威尔逊得分排名前10 (≥5票):');
      topPagesByWilson.forEach((page, i) => {
        console.log(`   ${i + 1}. ${page.title.substring(0, 50)}...`);
        console.log(`      威尔逊得分: ${page.wilsonScore?.toFixed(4)} | 评分: ${page.rating} | 投票: ${page.voteCount} | 好评率: ${(page.upVoteRatio * 100).toFixed(1)}%`);
      });
      
      console.log('\n🔥 争议度最高页面 (≥10票):');
      mostControversialPages.forEach((page, i) => {
        console.log(`   ${i + 1}. ${page.title.substring(0, 50)}...`);
        console.log(`      争议度: ${page.controversyScore?.toFixed(4)} | 评分: ${page.rating} | 投票: ${page.voteCount} | 好评率: ${(page.upVoteRatio * 100).toFixed(1)}%`);
      });
      
      console.log('\n📈 投票数vs威尔逊得分关系:');
      correlationData.forEach(data => {
        console.log(`   ${data.vote_range}票: ${data.page_count}页面, 平均威尔逊: ${parseFloat(data.avg_wilson_score).toFixed(4)}, 平均好评率: ${(parseFloat(data.avg_up_vote_ratio) * 100).toFixed(1)}%`);
      });
      
    } catch (error) {
      console.error(`❌ 生成页面分析报告失败: ${error.message}`);
    }
  }
  
  /**
   * 获取页面的详细分析数据
   */
  async getPageAnalysis(pageUrl) {
    try {
      const page = await this.prisma.page.findUnique({
        where: { url: pageUrl },
        include: {
          _count: {
            select: {
              voteRecords: true,
              revisions: true
            }
          }
        }
      });
      
      if (!page) {
        return null;
      }
      
      // 获取投票详情
      const voteDetails = await this.prisma.$queryRawUnsafe(`
        SELECT 
          direction,
          COUNT(*) as count
        FROM "VoteRecord"
        WHERE "pageUrl" = $1
        GROUP BY direction
        ORDER BY direction
      `, pageUrl);
      
      // 重新计算威尔逊得分以确保准确性
      const upVotes = voteDetails.find(v => v.direction > 0)?.count || 0;
      const downVotes = voteDetails.find(v => v.direction < 0)?.count || 0;
      const totalVotes = parseInt(upVotes) + parseInt(downVotes);
      
      const wilsonScore = this.calculateWilsonScore(parseInt(upVotes), totalVotes);
      const upVoteRatio = totalVotes > 0 ? upVotes / totalVotes : 0;
      const controversyScore = this.calculateControversyScore(parseInt(upVotes), parseInt(downVotes));
      
      return {
        page,
        voteBreakdown: {
          upVotes,
          downVotes,
          totalVotes,
          upVoteRatio
        },
        metrics: {
          wilsonScore,
          controversyScore,
          qualityRank: await this.getPageQualityRank(pageUrl, wilsonScore)
        },
        comparisons: {
          betterThanPercentage: await this.getBetterThanPercentage(wilsonScore)
        }
      };
      
    } catch (error) {
      console.error(`❌ 查询页面分析失败: ${error.message}`);
      return null;
    }
  }
  
  /**
   * 获取页面在威尔逊得分中的排名
   */
  async getPageQualityRank(pageUrl, wilsonScore) {
    const betterPages = await this.prisma.page.count({
      where: {
        wilsonScore: { gt: wilsonScore },
        voteCount: { gt: 0 }
      }
    });
    
    return betterPages + 1;
  }
  
  /**
   * 计算页面威尔逊得分超过的页面百分比
   */
  async getBetterThanPercentage(wilsonScore) {
    const totalPagesWithScore = await this.prisma.page.count({
      where: { 
        wilsonScore: { not: null },
        voteCount: { gt: 0 }
      }
    });
    
    const worsePages = await this.prisma.page.count({
      where: {
        wilsonScore: { lt: wilsonScore },
        voteCount: { gt: 0 }
      }
    });
    
    return totalPagesWithScore > 0 ? (worsePages / totalPagesWithScore) * 100 : 0;
  }
  
  /**
   * 确保页面表包含必要的字段
   */
  async ensurePageTableFields() {
    try {
      // 添加wilsonScore字段
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE "Page" 
        ADD COLUMN IF NOT EXISTS "wilsonScore" DECIMAL(10,8)
      `);
      
      // 添加upVoteRatio字段
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE "Page" 
        ADD COLUMN IF NOT EXISTS "upVoteRatio" DECIMAL(5,4)
      `);
      
      // 添加controversyScore字段
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE "Page" 
        ADD COLUMN IF NOT EXISTS "controversyScore" DECIMAL(10,6)
      `);
      
      // 添加lastAnalyzedAt字段
      await this.prisma.$executeRawUnsafe(`
        ALTER TABLE "Page" 
        ADD COLUMN IF NOT EXISTS "lastAnalyzedAt" TIMESTAMP
      `);
      
      // 创建索引
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_pages_wilson_score 
        ON "Page"("wilsonScore" DESC)
      `);
      
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_pages_controversy_score 
        ON "Page"("controversyScore" DESC)
      `);
      
      await this.prisma.$executeRawUnsafe(`
        CREATE INDEX IF NOT EXISTS idx_pages_up_vote_ratio 
        ON "Page"("upVoteRatio" DESC)
      `);
      
    } catch (error) {
      console.log(`   页面表字段创建信息: ${error.message}`);
    }
  }
}