/**
 * 文件路径: src/analyze/analyze-example.js
 * 功能概述: SCPPER-CN 数据分析功能使用示例和演示脚本
 * 
 * 主要功能:
 * - 演示用户数据分析功能的完整使用流程
 * - 展示页面质量分析和威尔逊置信区间计算
 * - 提供威尔逊得分计算的实例比较
 * - 数据库分析结果的查询和展示示例
 * - 用户加入时间、活跃状态、投票统计等分析
 * - 页面威尔逊得分、争议度、质量排名等分析
 * 
 * 核心特性:
 * - 完整的分析功能演示流程
 * - 威尔逊置信区间 vs 普通好评率的对比说明
 * - 实用的数据查询和统计示例
 * 
 * 使用方式:
 * - node src/analyze/analyze-example.js
 * - 作为学习和测试分析功能的参考实现
 */

import { PrismaClient } from '@prisma/client';
import { UserAnalyzer } from './user-analyzer.js';
import { PageAnalyzer } from './page-analyzer.js';
import dotenv from 'dotenv';

dotenv.config();

async function runAnalysisExample() {
  const prisma = new PrismaClient();
  
  try {
    console.log('🚀 SCPPER-CN 数据分析功能示例');
    console.log('='.repeat(80));
    
    // 1. 用户数据分析示例
    console.log('\n👤 用户数据分析示例:');
    console.log('-'.repeat(50));
    
    const userAnalyzer = new UserAnalyzer(prisma);
    
    // 确保数据库表结构
    await userAnalyzer.ensureUserTableFields();
    
    // 运行完整的用户分析
    await userAnalyzer.analyzeAndUpdateUserData();
    
    // 查询特定用户的分析数据
    console.log('\n📊 查询特定用户分析数据:');
    const sampleUsers = await prisma.user.findMany({
      where: { joinTime: { not: null } },
      orderBy: { joinTime: 'asc' },
      take: 3
    });
    
    for (const user of sampleUsers) {
      const userAnalysis = await userAnalyzer.getUserAnalysis(user.wikidotId);
      if (userAnalysis) {
        console.log(`\n   用户: ${userAnalysis.user.displayName}`);
        console.log(`   加入时间: ${userAnalysis.user.joinTime?.toISOString().split('T')[0]}`);
        console.log(`   活跃状态: ${userAnalysis.user.isActive ? '🟢 活跃' : '🔴 不活跃'}`);
        console.log(`   统计: ${userAnalysis.stats.totalVotes}票 | ${userAnalysis.stats.totalRevisions}修订 | ${userAnalysis.stats.totalPagesCreated}页面`);
      }
    }
    
    // 2. 页面数据分析示例
    console.log('\n\n📄 页面数据分析示例:');
    console.log('-'.repeat(50));
    
    const pageAnalyzer = new PageAnalyzer(prisma);
    
    // 确保数据库表结构
    await pageAnalyzer.ensurePageTableFields();
    
    // 运行完整的页面分析
    await pageAnalyzer.analyzeAndUpdatePageData();
    
    // 查询威尔逊得分最高的页面
    console.log('\n🏆 威尔逊得分最高的页面:');
    const topPages = await prisma.page.findMany({
      where: { 
        wilsonScore: { not: null },
        voteCount: { gte: 5 }
      },
      orderBy: { wilsonScore: 'desc' },
      take: 5,
      select: {
        title: true,
        url: true,
        rating: true,
        voteCount: true,
        wilsonScore: true,
        upVoteRatio: true
      }
    });
    
    topPages.forEach((page, i) => {
      console.log(`\n   ${i + 1}. ${page.title.substring(0, 60)}...`);
      console.log(`      威尔逊得分: ${page.wilsonScore?.toFixed(4)}`);
      console.log(`      评分: ${page.rating} | 投票数: ${page.voteCount} | 好评率: ${(page.upVoteRatio * 100).toFixed(1)}%`);
    });
    
    // 查询特定页面的详细分析
    console.log('\n📊 特定页面详细分析:');
    if (topPages.length > 0) {
      const pageAnalysis = await pageAnalyzer.getPageAnalysis(topPages[0].url);
      if (pageAnalysis) {
        console.log(`\n   页面: ${pageAnalysis.page.title}`);
        console.log(`   威尔逊得分: ${pageAnalysis.metrics.wilsonScore.toFixed(4)}`);
        console.log(`   争议度: ${pageAnalysis.metrics.controversyScore.toFixed(4)}`);
        console.log(`   质量排名: #${pageAnalysis.metrics.qualityRank}`);
        console.log(`   超过: ${pageAnalysis.comparisons.betterThanPercentage.toFixed(1)}% 的页面`);
        console.log(`   投票明细: ↑${pageAnalysis.voteBreakdown.upVotes} ↓${pageAnalysis.voteBreakdown.downVotes}`);
      }
    }
    
    // 3. 威尔逊置信区间计算示例
    console.log('\n\n🧮 威尔逊置信区间计算示例:');
    console.log('-'.repeat(50));
    
    const examples = [
      { upVotes: 10, totalVotes: 10, description: '10/10 (100%好评)' },
      { upVotes: 100, totalVotes: 100, description: '100/100 (100%好评)' },
      { upVotes: 8, totalVotes: 10, description: '8/10 (80%好评)' },
      { upVotes: 80, totalVotes: 100, description: '80/100 (80%好评)' },
      { upVotes: 5, totalVotes: 10, description: '5/10 (50%好评)' },
      { upVotes: 50, totalVotes: 100, description: '50/100 (50%好评)' }
    ];
    
    examples.forEach(ex => {
      const wilsonScore = pageAnalyzer.calculateWilsonScore(ex.upVotes, ex.totalVotes);
      const upVoteRatio = ex.upVotes / ex.totalVotes;
      console.log(`   ${ex.description}:`);
      console.log(`      普通好评率: ${(upVoteRatio * 100).toFixed(1)}%`);
      console.log(`      威尔逊得分: ${(wilsonScore * 100).toFixed(1)}% (更保守的估计)`);
      console.log('');
    });
    
    console.log('\n✅ 分析示例完成！');
    console.log('\n💡 提示: 威尔逊置信区间为投票数较少的页面提供了更保守的质量评估，');
    console.log('    避免了小样本页面因为几个好评就排名很高的问题。');
    
  } catch (error) {
    console.error(`❌ 分析示例运行失败: ${error.message}`);
    console.error(error.stack);
  } finally {
    await prisma.$disconnect();
  }
}

// 单独的威尔逊得分计算函数，供外部使用
export function calculateWilsonScore(upVotes, totalVotes, confidenceLevel = 0.95) {
  if (totalVotes === 0) return 0;
  
  // 根据置信水平确定z值
  const zValues = {
    0.90: 1.645,
    0.95: 1.96,
    0.99: 2.576
  };
  
  const z = zValues[confidenceLevel] || 1.96;
  const n = totalVotes;
  const p = upVotes / n;
  
  const numerator = p + (z * z) / (2 * n) - z / (2 * n) * Math.sqrt(4 * n * p * (1 - p) + z * z);
  const denominator = 1 + (z * z) / n;
  
  const wilsonScore = numerator / denominator;
  return Math.max(0, Math.min(1, wilsonScore));
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  runAnalysisExample().catch(console.error);
}

export { runAnalysisExample };