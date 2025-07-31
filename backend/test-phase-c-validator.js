#!/usr/bin/env node

// PhaseC修复效果测试和投票记录验证脚本
import { GraphQLClient } from './src/core/client/GraphQLClient.js';
import { MAX_FIRST } from './src/config/RateLimitConfig.js';
import { Logger } from './src/utils/Logger.js';

class PhaseCValidator {
  constructor() {
    this.client = new GraphQLClient();
  }

  /**
   * 测试指定页面的PhaseC逻辑并验证投票计算
   */
  async testPage(url) {
    console.log(`=== 测试页面: ${url} ===\n`);

    // 第一步：获取页面基本信息
    const pageInfo = await this._getPageBasicInfo(url);
    console.log('📊 页面基本信息:');
    console.log(`  - 标题: ${pageInfo.title}`);
    console.log(`  - 页面Rating: ${pageInfo.rating}`);
    console.log(`  - 页面VoteCount: ${pageInfo.voteCount}`);
    console.log(`  - 修订数量: ${pageInfo.revisionCount}`);
    console.log('');

    // 第二步：使用修复后的PhaseC逻辑抓取详细数据
    const collected = await this._collectDetailedData(url);
    
    // 第三步：验证投票计算
    const validation = this._validateVoteCalculations(collected.votes, pageInfo);
    
    // 第四步：输出完整测试结果
    this._printTestResults(collected, validation, pageInfo);
    
    return {
      pageInfo,
      collected,
      validation,
      success: validation.ratingMatch && validation.voteCountMatch
    };
  }

  /**
   * 获取页面基本信息
   */
  async _getPageBasicInfo(url) {
    const query = /* GraphQL */`
      query GetPageBasicInfo($url: URL!) {
        page: wikidotPage(url: $url) {
          url
          title
          rating
          voteCount
          revisionCount
          commentCount
          createdAt
          createdBy {
            ... on WikidotUser {
              displayName
              wikidotId
            }
          }
        }
      }
    `;

    const res = await this.client.request(query, { url });
    return res.page;
  }

  /**
   * 使用修复后的PhaseC逻辑收集详细数据
   */
  async _collectDetailedData(url) {
    let afterRev = null;
    let afterVote = null;
    let requestCount = 0;
    const collected = { url, revisions: [], votes: [] };
    const requestLog = [];

    console.log('🔄 开始详细数据抓取...\n');

    // 修复后的逻辑：动态查询构建
    while (afterRev !== undefined || afterVote !== undefined) {
      requestCount++;
      const { query, variables } = this._buildQuery(url, afterRev, afterVote);
      
      // 记录请求信息
      const requestInfo = {
        requestNum: requestCount,
        hasRevisions: query.includes('revisions'),
        hasVotes: query.includes('fuzzyVoteRecords'),
        afterRev: afterRev === undefined ? 'COMPLETED' : afterRev || 'null',
        afterVote: afterVote === undefined ? 'COMPLETED' : afterVote || 'null'
      };
      requestLog.push(requestInfo);
      
      console.log(`请求 #${requestCount}:`);
      console.log(`  - 包含 revisions: ${requestInfo.hasRevisions ? '✅' : '❌'}`);
      console.log(`  - 包含 votes: ${requestInfo.hasVotes ? '✅' : '❌'}`);
      console.log(`  - afterRev: ${requestInfo.afterRev}`);
      console.log(`  - afterVote: ${requestInfo.afterVote}`);

      try {
        const res = await this.client.request(query, variables);
        const page = res.page;

        // 处理 revisions
        if (page.revisions) {
          const edges = page.revisions.edges;
          const beforeCount = collected.revisions.length;
          collected.revisions.push(...edges.map(e => e.node));
          const addedCount = collected.revisions.length - beforeCount;
          
          console.log(`  - 收到 ${addedCount} 个 revisions (总计: ${collected.revisions.length})`);
          
          if (page.revisions.pageInfo.hasNextPage) {
            afterRev = page.revisions.pageInfo.endCursor;
          } else {
            afterRev = undefined; // 标记抓取完，从查询中移除
            console.log(`  - revisions 抓取完成 ✅`);
          }
        }

        // 处理 votes
        if (page.fuzzyVoteRecords) {
          const edges = page.fuzzyVoteRecords.edges;
          const beforeCount = collected.votes.length;
          collected.votes.push(...edges.map(e => e.node));
          const addedCount = collected.votes.length - beforeCount;
          
          console.log(`  - 收到 ${addedCount} 个 votes (总计: ${collected.votes.length})`);
          
          if (page.fuzzyVoteRecords.pageInfo.hasNextPage) {
            afterVote = page.fuzzyVoteRecords.pageInfo.endCursor;
          } else {
            afterVote = undefined;
            console.log(`  - votes 抓取完成 ✅`);
          }
        }

        console.log('');
        
        // 安全限制：避免无限循环
        if (requestCount > 50) {
          console.log('⚠️  达到安全限制，停止测试');
          break;
        }

      } catch (error) {
        console.error(`  ❌ 请求失败: ${error.message}`);
        break;
      }
    }

    return { ...collected, requestCount, requestLog };
  }

  /**
   * 验证投票计算逻辑
   */
  _validateVoteCalculations(votes, pageInfo) {
    // 先检查投票方向的实际值
    const directionStats = {};
    votes.forEach(v => {
      directionStats[v.direction] = (directionStats[v.direction] || 0) + 1;
    });

    console.log('🔍 投票方向统计:', directionStats);

    // 计算投票统计 (使用数字: 1=赞成, -1=反对, 0=中性/撤销)
    const upvotes = votes.filter(v => v.direction === 1).length;
    const downvotes = votes.filter(v => v.direction === -1).length;
    const neutralVotes = votes.filter(v => v.direction === 0).length;
    const calculatedRating = upvotes - downvotes;
    
    // 对于voteCount，需要考虑用户重复投票的情况，只计算每个用户的最新投票
    const latestVotes = this._getLatestVotesPerUser(votes);
    const activeUpvotes = latestVotes.filter(v => v.direction === 1).length;
    const activeDownvotes = latestVotes.filter(v => v.direction === -1).length;
    const activeRating = activeUpvotes - activeDownvotes;
    const activeVoteCount = latestVotes.filter(v => v.direction !== 0).length;

    // 检查重复投票
    const voteKeys = votes.map(v => `${v.userWikidotId}-${v.timestamp}-${v.direction}`);
    const uniqueVoteKeys = new Set(voteKeys);
    const duplicateVotes = voteKeys.length - uniqueVoteKeys.size;

    // 检查用户重复投票
    const userVotes = new Map();
    votes.forEach(vote => {
      const userId = vote.userWikidotId;
      if (!userVotes.has(userId)) {
        userVotes.set(userId, []);
      }
      userVotes.get(userId).push(vote);
    });

    const duplicateUserVotes = Array.from(userVotes.entries())
      .filter(([userId, userVoteList]) => userVoteList.length > 1);

    return {
      // 原始统计（所有投票记录）
      allVotes: {
        upvotes,
        downvotes,
        neutralVotes,
        total: votes.length,
        rating: calculatedRating
      },
      // 活跃统计（每用户最新投票）
      activeVotes: {
        upvotes: activeUpvotes,
        downvotes: activeDownvotes,
        total: activeVoteCount,
        rating: activeRating
      },
      // 页面数据
      pageRating: pageInfo.rating,
      pageVoteCount: pageInfo.voteCount,
      // 匹配检查
      ratingMatch: activeRating === pageInfo.rating,
      voteCountMatch: activeVoteCount === pageInfo.voteCount,
      // 重复检查
      duplicateVotes,
      duplicateUserVotes: duplicateUserVotes.length,
      duplicateUserVoteDetails: duplicateUserVotes,
      latestVotesCount: latestVotes.length
    };
  }

  /**
   * 获取每个用户的最新投票（按时间戳排序）
   */
  _getLatestVotesPerUser(votes) {
    const userLatestVotes = new Map();
    
    // 按用户分组并找到最新投票
    votes.forEach(vote => {
      const userId = vote.userWikidotId;
      const existing = userLatestVotes.get(userId);
      
      if (!existing || new Date(vote.timestamp) > new Date(existing.timestamp)) {
        userLatestVotes.set(userId, vote);
      }
    });
    
    return Array.from(userLatestVotes.values());
  }

  /**
   * 输出测试结果
   */
  _printTestResults(collected, validation, pageInfo) {
    console.log('=== 📋 数据收集结果 ===');
    console.log(`总请求数: ${collected.requestCount}`);
    console.log(`抓取的 revisions: ${collected.revisions.length}`);
    console.log(`抓取的 votes: ${collected.votes.length}`);
    console.log('');

    console.log('=== 🔍 投票数据验证 ===');
    console.log('所有投票记录统计:');
    console.log(`  - 赞成票: ${validation.allVotes.upvotes}, 反对票: ${validation.allVotes.downvotes}, 中性: ${validation.allVotes.neutralVotes}`);
    console.log(`  - 总记录: ${validation.allVotes.total}, Rating: ${validation.allVotes.rating}`);
    console.log('活跃投票统计 (每用户最新):');
    console.log(`  - 赞成票: ${validation.activeVotes.upvotes}, 反对票: ${validation.activeVotes.downvotes}`);
    console.log(`  - 有效投票: ${validation.activeVotes.total}, Rating: ${validation.activeVotes.rating}`);
    console.log(`页面显示 - Rating: ${validation.pageRating}, VoteCount: ${validation.pageVoteCount}`);
    console.log('');

    console.log('=== ✅ 验证结果 ===');
    console.log(`Rating 匹配: ${validation.ratingMatch ? '✅ 通过' : '❌ 失败'} (计算: ${validation.activeVotes.rating} vs 页面: ${validation.pageRating})`);
    console.log(`VoteCount 匹配: ${validation.voteCountMatch ? '✅ 通过' : '❌ 失败'} (计算: ${validation.activeVotes.total} vs 页面: ${validation.pageVoteCount})`);
    console.log(`重复投票检查: ${validation.duplicateVotes === 0 ? '✅ 无重复' : `❌ 发现 ${validation.duplicateVotes} 个重复`}`);
    console.log(`用户重复投票: ${validation.duplicateUserVotes === 0 ? '✅ 无重复' : `⚠️ ${validation.duplicateUserVotes} 个用户有投票变更（正常现象）`}`);

    if (validation.duplicateUserVotes > 0) {
      console.log('\n⚠️  用户重复投票详情:');
      validation.duplicateUserVoteDetails.slice(0, 5).forEach(([userId, votes]) => {
        console.log(`  用户 ${userId}: ${votes.length} 个投票`);
        votes.forEach(vote => {
          console.log(`    - ${vote.direction} at ${vote.timestamp}`);
        });
      });
      if (validation.duplicateUserVoteDetails.length > 5) {
        console.log(`  ... 还有 ${validation.duplicateUserVoteDetails.length - 5} 个用户`);
      }
    }

    console.log('');
    console.log('=== 📊 请求优化验证 ===');
    const invalidRequests = collected.requestLog.filter(req => 
      (req.afterRev === 'COMPLETED' && req.hasRevisions) ||
      (req.afterVote === 'COMPLETED' && req.hasVotes)
    );
    
    console.log(`无效请求检查: ${invalidRequests.length === 0 ? '✅ 无无效请求' : `❌ ${invalidRequests.length} 个无效请求`}`);
    
    // 显示请求详情
    console.log('\n📝 请求详情:');
    collected.requestLog.forEach(req => {
      const revIcon = req.hasRevisions ? '📄' : '⭕';
      const voteIcon = req.hasVotes ? '🗳️' : '⭕';
      console.log(`  #${req.requestNum}: ${revIcon} ${voteIcon} | afterRev=${req.afterRev} | afterVote=${req.afterVote}`);
    });

    console.log('\n=== 🎯 总体评估 ===');
    const overallSuccess = validation.ratingMatch && validation.voteCountMatch && 
                          validation.duplicateVotes === 0 && invalidRequests.length === 0;
    console.log(`PhaseC 修复效果: ${overallSuccess ? '🎉 完全成功！' : '⚠️ 需要进一步检查'}`);
  }

  /**
   * 修复后的动态查询构建方法
   */
  _buildQuery(url, afterRev, afterVote) {
    const vars = { url };
    const queryParts = [];
    const varDeclarations = ['$url: URL!'];
    
    // 只在连接未完成时添加对应的查询字段
    if (afterRev !== undefined) {
      vars.afterRev = afterRev;
      varDeclarations.push('$afterRev: ID');
      queryParts.push(`
          revisions(first: ${MAX_FIRST}, after: $afterRev) {
            edges { 
              node { 
                wikidotId 
                timestamp 
                type 
                user { 
                  ... on WikidotUser { 
                    displayName 
                    wikidotId 
                  } 
                }
                comment
              } 
            }
            pageInfo { hasNextPage endCursor }
          }`);
    }
    
    if (afterVote !== undefined) {
      vars.afterVote = afterVote;
      varDeclarations.push('$afterVote: ID');
      queryParts.push(`
          fuzzyVoteRecords(first: ${MAX_FIRST}, after: $afterVote) {
            edges { 
              node { 
                direction 
                timestamp 
                userWikidotId
                user {
                  ... on WikidotUser {
                    displayName
                    wikidotId
                  }
                }
              } 
            }
            pageInfo { hasNextPage endCursor }
          }`);
    }

    const gql = /* GraphQL */`
      query ComplexPage(${varDeclarations.join(', ')}) {
        page: wikidotPage(url: $url) {
          url${queryParts.join('')}
        }
      }
    `;
    return { query: gql, variables: vars };
  }

  /**
   * 批量测试多个页面
   */
  async testMultiplePages(urls) {
    console.log('🚀 开始批量测试...\n');
    const results = [];

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      console.log(`\n${'='.repeat(80)}`);
      console.log(`测试进度: ${i + 1}/${urls.length}`);
      
      try {
        const result = await this.testPage(url);
        results.push({ url, ...result, success: true });
      } catch (error) {
        console.error(`❌ 测试失败: ${error.message}`);
        results.push({ url, success: false, error: error.message });
      }
      
      // 避免请求过于频繁
      if (i < urls.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // 汇总结果
    console.log(`\n${'='.repeat(80)}`);
    console.log('📊 批量测试汇总');
    console.log(`${'='.repeat(80)}`);
    
    const successful = results.filter(r => r.success && r.validation?.ratingMatch && r.validation?.voteCountMatch);
    const failed = results.filter(r => !r.success || !r.validation?.ratingMatch || !r.validation?.voteCountMatch);
    
    console.log(`✅ 成功: ${successful.length}/${results.length}`);
    console.log(`❌ 失败: ${failed.length}/${results.length}`);
    
    if (failed.length > 0) {
      console.log('\n失败的页面:');
      failed.forEach(result => {
        console.log(`  - ${result.url}: ${result.error || '投票验证失败'}`);
      });
    }

    return results;
  }
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  const validator = new PhaseCValidator();
  
  // 可以测试单个页面或多个页面
  const testUrls = [
    'http://scp-wiki-cn.wikidot.com/scp-cn-3301', // 高投票量页面
    'http://scp-wiki-cn.wikidot.com/scp-173',     // 经典页面
    'http://scp-wiki-cn.wikidot.com/scp-cn-001'   // 另一个高投票页面
  ];

  if (process.argv.length > 2) {
    // 如果提供了命令行参数，测试指定页面
    const url = process.argv[2];
    validator.testPage(url).catch(console.error);
  } else {
    // 否则运行批量测试
    validator.testMultiplePages(testUrls).catch(console.error);
  }
}

export { PhaseCValidator };