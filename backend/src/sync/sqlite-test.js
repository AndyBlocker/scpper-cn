import { GraphQLClient } from 'graphql-request';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

// 使用简单的文件存储进行测试，避免数据库依赖
class SimpleSyncTester {
  constructor() {
    this.cromClient = new GraphQLClient(process.env.CROM_API_URL || 'https://apiv1.crom.avn.sh/graphql');
    this.stats = {
      startTime: null,
      endTime: null,
      pagesProcessed: 0,
      usersProcessed: 0,
      voteRecordsCount: 0,
      revisionsCount: 0,
      errors: [],
      rateLimitInfo: null
    };
    this.data = {
      pages: [],
      users: [],
      voteRecords: [],
      revisions: []
    };
  }

  async testDataRetrieval() {
    console.log('🧪 测试CROM API数据获取和分析\n');
    console.log('目标站点:', process.env.TARGET_SITE_URL || 'http://scp-wiki-cn.wikidot.com');
    
    this.stats.startTime = new Date();
    
    try {
      // 1. 测试页面数据获取
      await this.fetchPagesData(20); // 测试20个页面
      
      // 2. 测试用户数据获取
      await this.fetchUsersData();
      
      // 3. 数据分析
      this.analyzeData();
      
      // 4. 生成报告
      this.generateReport();
      
    } catch (error) {
      console.error('❌ 测试失败:', error.message);
      this.stats.errors.push({
        type: 'general',
        error: error.message
      });
    }
  }

  async fetchPagesData(batchSize = 20) {
    console.log(`📄 获取 ${batchSize} 个页面的完整数据...\n`);
    
    const pageQuery = `
      query TestPageSync($filter: QueryPagesFilter, $first: Int) {
        pages(filter: $filter, first: $first) {
          edges {
            node {
              url
              wikidotInfo {
                title
                category
                wikidotId
                rating
                voteCount
                realtimeRating
                realtimeVoteCount
                commentCount
                createdAt
                revisionCount
                source
                textContent
                tags
                isPrivate
                thumbnailUrl
                
                createdBy {
                  name
                  wikidotInfo {
                    displayName
                    wikidotId
                    unixName
                  }
                }
                
                parent {
                  url
                  wikidotInfo {
                    title
                  }
                }
                
                children {
                  url
                  wikidotInfo {
                    title
                  }
                }
                
                coarseVoteRecords {
                  timestamp
                  userWikidotId
                  direction
                  user {
                    name
                  }
                }
                
                revisions {
                  index
                  wikidotId
                  timestamp
                  type
                  userWikidotId
                  comment
                  user {
                    name
                  }
                }
              }
              
              attributions {
                type
                user {
                  name
                  wikidotInfo {
                    displayName
                    wikidotId
                  }
                }
                date
                order
                isCurrent
              }
              
              alternateTitles {
                type
                title
              }
              
              translations {
                url
                wikidotInfo {
                  title
                }
              }
              
              translationOf {
                url
                wikidotInfo {
                  title
                }
              }
            }
            cursor
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
        rateLimit {
          cost
          remaining
          resetAt
        }
      }
    `;
    
    try {
      const result = await this.cromClient.request(pageQuery, {
        filter: {
          url: { startsWith: process.env.TARGET_SITE_URL || 'http://scp-wiki-cn.wikidot.com' }
        },
        first: batchSize
      });
      
      this.stats.rateLimitInfo = result.rateLimit;
      console.log(`✅ 成功获取 ${result.pages.edges.length} 个页面`);
      console.log(`💰 Rate limit cost: ${result.rateLimit.cost}`);
      console.log(`💰 Remaining: ${result.rateLimit.remaining}`);
      console.log(`⏰ Reset at: ${result.rateLimit.resetAt}\n`);
      
      // 处理页面数据
      for (const edge of result.pages.edges) {
        const page = edge.node;
        const info = page.wikidotInfo;
        
        // 存储页面信息
        const pageData = {
          url: page.url,
          title: info.title,
          wikidotId: info.wikidotId,
          category: info.category,
          rating: info.rating,
          voteCount: info.voteCount,
          realtimeRating: info.realtimeRating,
          realtimeVoteCount: info.realtimeVoteCount,
          commentCount: info.commentCount,
          createdAt: info.createdAt,
          revisionCount: info.revisionCount,
          sourceLength: info.source?.length || 0,
          textContentLength: info.textContent?.length || 0,
          tagsCount: info.tags?.length || 0,
          isPrivate: info.isPrivate,
          createdByUser: info.createdBy?.name,
          parentUrl: info.parent?.url,
          childrenCount: info.children?.length || 0,
          voteRecordsCount: info.coarseVoteRecords?.length || 0,
          revisionsCount: info.revisions?.length || 0,
          attributionsCount: page.attributions?.length || 0,
          alternateTitlesCount: page.alternateTitles?.length || 0,
          translationsCount: page.translations?.length || 0,
          hasTranslationOf: !!page.translationOf
        };
        
        this.data.pages.push(pageData);
        this.stats.pagesProcessed++;
        
        // 存储投票记录
        if (info.coarseVoteRecords) {
          for (const vote of info.coarseVoteRecords) {
            this.data.voteRecords.push({
              pageUrl: page.url,
              pageTitle: info.title,
              userWikidotId: vote.userWikidotId,
              userName: vote.user?.name,
              timestamp: vote.timestamp,
              direction: vote.direction
            });
            this.stats.voteRecordsCount++;
          }
        }
        
        // 存储修订记录
        if (info.revisions) {
          for (const revision of info.revisions) {
            this.data.revisions.push({
              pageUrl: page.url,
              pageTitle: info.title,
              revisionIndex: revision.index,
              wikidotId: revision.wikidotId,
              timestamp: revision.timestamp,
              type: revision.type,
              userWikidotId: revision.userWikidotId,
              userName: revision.user?.name,
              comment: revision.comment
            });
            this.stats.revisionsCount++;
          }
        }
        
        console.log(`   📝 ${info.title}`);
        console.log(`      评分: ${info.rating} (${info.voteCount} votes)`);
        console.log(`      投票记录: ${info.coarseVoteRecords?.length || 0} 条`);
        console.log(`      修订记录: ${info.revisions?.length || 0} 条`);
        console.log(`      内容长度: ${info.source?.length || 0} 字符`);
        console.log('');
      }
      
    } catch (error) {
      console.error('❌ 页面数据获取失败:', error.message);
      this.stats.errors.push({
        type: 'page_fetch',
        error: error.message
      });
    }
  }

  async fetchUsersData() {
    console.log('👤 获取用户数据...\n');
    
    const userQuery = `
      query TestUserSync($filter: SearchUsersFilter) {
        searchUsers(query: "", filter: $filter) {
          name
          wikidotInfo {
            displayName
            wikidotId
            unixName
          }
          statistics {
            rank
            totalRating
            meanRating
            pageCount
            pageCountScp
            pageCountTale
            pageCountGoiFormat
            pageCountArtwork
            pageCountLevel
            pageCountEntity
            pageCountObject
          }
        }
        rateLimit {
          cost
          remaining
        }
      }
    `;
    
    try {
      const result = await this.cromClient.request(userQuery, {
        filter: {
          anyBaseUrl: [process.env.TARGET_SITE_URL || 'http://scp-wiki-cn.wikidot.com']
        }
      });
      
      console.log(`✅ 成功获取 ${result.searchUsers.length} 个用户`);
      console.log(`💰 Rate limit cost: ${result.rateLimit.cost}\n`);
      
      // 存储用户数据
      for (const user of result.searchUsers) {
        const userData = {
          name: user.name,
          displayName: user.wikidotInfo?.displayName,
          wikidotId: user.wikidotInfo?.wikidotId,
          unixName: user.wikidotInfo?.unixName,
          rank: user.statistics?.rank,
          totalRating: user.statistics?.totalRating,
          meanRating: user.statistics?.meanRating,
          pageCount: user.statistics?.pageCount,
          pageCountScp: user.statistics?.pageCountScp,
          pageCountTale: user.statistics?.pageCountTale,
          pageCountGoiFormat: user.statistics?.pageCountGoiFormat,
          pageCountArtwork: user.statistics?.pageCountArtwork,
          pageCountLevel: user.statistics?.pageCountLevel,
          pageCountEntity: user.statistics?.pageCountEntity,
          pageCountObject: user.statistics?.pageCountObject
        };
        
        this.data.users.push(userData);
        this.stats.usersProcessed++;
        
        console.log(`   👤 ${user.name} (${user.wikidotInfo?.displayName || 'N/A'})`);
        console.log(`      排名: ${user.statistics?.rank || 'N/A'}, 总评分: ${user.statistics?.totalRating || 'N/A'}`);
        console.log(`      页面数: ${user.statistics?.pageCount || 'N/A'}`);
      }
      
    } catch (error) {
      console.error('❌ 用户数据获取失败:', error.message);
      this.stats.errors.push({
        type: 'user_fetch',
        error: error.message
      });
    }
  }

  analyzeData() {
    console.log('\n📊 数据分析结果:\n');
    
    // 页面统计
    console.log('📄 页面数据分析:');
    if (this.data.pages.length > 0) {
      const avgRating = this.data.pages.reduce((sum, p) => sum + (p.rating || 0), 0) / this.data.pages.length;
      const avgVoteCount = this.data.pages.reduce((sum, p) => sum + (p.voteCount || 0), 0) / this.data.pages.length;
      const avgContentLength = this.data.pages.reduce((sum, p) => sum + p.sourceLength, 0) / this.data.pages.length;
      const pagesWithVotes = this.data.pages.filter(p => p.voteRecordsCount > 0).length;
      const pagesWithRevisions = this.data.pages.filter(p => p.revisionsCount > 0).length;
      
      console.log(`   总页面数: ${this.data.pages.length}`);
      console.log(`   平均评分: ${avgRating.toFixed(2)}`);
      console.log(`   平均投票数: ${avgVoteCount.toFixed(1)}`);
      console.log(`   平均内容长度: ${Math.round(avgContentLength)} 字符`);
      console.log(`   有投票记录的页面: ${pagesWithVotes}/${this.data.pages.length} (${(pagesWithVotes/this.data.pages.length*100).toFixed(1)}%)`);
      console.log(`   有修订记录的页面: ${pagesWithRevisions}/${this.data.pages.length} (${(pagesWithRevisions/this.data.pages.length*100).toFixed(1)}%)`);
      
      // 评分分布
      const ratingRanges = {
        'negative': this.data.pages.filter(p => (p.rating || 0) < 0).length,
        'low (0-10)': this.data.pages.filter(p => (p.rating || 0) >= 0 && (p.rating || 0) <= 10).length,
        'medium (11-50)': this.data.pages.filter(p => (p.rating || 0) > 10 && (p.rating || 0) <= 50).length,
        'high (51-100)': this.data.pages.filter(p => (p.rating || 0) > 50 && (p.rating || 0) <= 100).length,
        'very high (>100)': this.data.pages.filter(p => (p.rating || 0) > 100).length
      };
      
      console.log('   评分分布:');
      Object.entries(ratingRanges).forEach(([range, count]) => {
        console.log(`     ${range}: ${count} 页面`);
      });
    }
    
    console.log('');
    
    // 投票记录分析
    console.log('🗳️ 投票记录分析:');
    if (this.data.voteRecords.length > 0) {
      const upvotes = this.data.voteRecords.filter(v => v.direction > 0).length;
      const downvotes = this.data.voteRecords.filter(v => v.direction < 0).length;
      const uniqueVoters = new Set(this.data.voteRecords.map(v => v.userWikidotId)).size;
      
      console.log(`   总投票记录: ${this.data.voteRecords.length}`);
      console.log(`   Upvotes: ${upvotes} (${(upvotes/this.data.voteRecords.length*100).toFixed(1)}%)`);
      console.log(`   Downvotes: ${downvotes} (${(downvotes/this.data.voteRecords.length*100).toFixed(1)}%)`);
      console.log(`   独立投票者: ${uniqueVoters}`);
      
      // 投票网络分析示例
      console.log('\n   💡 投票网络分析样例:');
      this.analyzeVotingNetwork();
    }
    
    console.log('');
    
    // 用户统计
    console.log('👤 用户数据分析:');
    if (this.data.users.length > 0) {
      const usersWithPages = this.data.users.filter(u => u.pageCount > 0).length;
      const avgRating = this.data.users.reduce((sum, u) => sum + (u.totalRating || 0), 0) / this.data.users.length;
      const avgPageCount = this.data.users.reduce((sum, u) => sum + (u.pageCount || 0), 0) / this.data.users.length;
      
      console.log(`   总用户数: ${this.data.users.length}`);
      console.log(`   有页面的用户: ${usersWithPages}/${this.data.users.length} (${(usersWithPages/this.data.users.length*100).toFixed(1)}%)`);
      console.log(`   平均用户评分: ${avgRating.toFixed(1)}`);
      console.log(`   平均页面数: ${avgPageCount.toFixed(1)}`);
      
      // 显示排名前5的用户
      const topUsers = this.data.users
        .filter(u => u.totalRating > 0)
        .sort((a, b) => (b.totalRating || 0) - (a.totalRating || 0))
        .slice(0, 5);
      
      if (topUsers.length > 0) {
        console.log('   排名前5用户:');
        topUsers.forEach((user, i) => {
          console.log(`     ${i+1}. ${user.name}: ${user.totalRating} 评分, ${user.pageCount} 页面`);
        });
      }
    }
  }

  analyzeVotingNetwork() {
    // 分析用户之间的投票关系
    const userVoteMap = new Map();
    
    for (const vote of this.data.voteRecords) {
      if (!vote.userName || !vote.userWikidotId) continue;
      
      if (!userVoteMap.has(vote.userName)) {
        userVoteMap.set(vote.userName, {
          userId: vote.userWikidotId,
          upvotes: 0,
          downvotes: 0,
          pagesVoted: new Set()
        });
      }
      
      const userStats = userVoteMap.get(vote.userName);
      if (vote.direction > 0) {
        userStats.upvotes++;
      } else if (vote.direction < 0) {
        userStats.downvotes++;
      }
      userStats.pagesVoted.add(vote.pageUrl);
    }
    
    // 找出最活跃的投票者
    const activeVoters = Array.from(userVoteMap.entries())
      .map(([name, stats]) => ({
        name,
        ...stats,
        totalVotes: stats.upvotes + stats.downvotes,
        pagesVotedCount: stats.pagesVoted.size
      }))
      .sort((a, b) => b.totalVotes - a.totalVotes)
      .slice(0, 3);
    
    console.log('     最活跃投票者:');
    activeVoters.forEach((voter, i) => {
      console.log(`       ${i+1}. ${voter.name}: ${voter.totalVotes} 票 (↑${voter.upvotes}, ↓${voter.downvotes})`);
    });
    
    // 分析作者-投票者关系
    this.analyzeAuthorVoterRelationships();
  }

  analyzeAuthorVoterRelationships() {
    // 找出页面作者和给他们投票的用户关系
    const authorVoteMap = new Map();
    
    for (const page of this.data.pages) {
      if (!page.createdByUser) continue;
      
      if (!authorVoteMap.has(page.createdByUser)) {
        authorVoteMap.set(page.createdByUser, {
          pagesCreated: 0,
          totalUpvotes: 0,
          totalDownvotes: 0,
          voters: new Map()
        });
      }
      
      const authorStats = authorVoteMap.get(page.createdByUser);
      authorStats.pagesCreated++;
      
      // 统计对该作者页面的投票
      const pageVotes = this.data.voteRecords.filter(v => v.pageUrl === page.url);
      for (const vote of pageVotes) {
        if (!vote.userName) continue;
        
        if (vote.direction > 0) {
          authorStats.totalUpvotes++;
        } else if (vote.direction < 0) {
          authorStats.totalDownvotes++;
        }
        
        if (!authorStats.voters.has(vote.userName)) {
          authorStats.voters.set(vote.userName, { upvotes: 0, downvotes: 0 });
        }
        
        const voterStats = authorStats.voters.get(vote.userName);
        if (vote.direction > 0) {
          voterStats.upvotes++;
        } else if (vote.direction < 0) {
          voterStats.downvotes++;
        }
      }
    }
    
    // 找出最受欢迎的作者
    const popularAuthors = Array.from(authorVoteMap.entries())
      .filter(([author, stats]) => stats.totalUpvotes + stats.totalDownvotes > 0)
      .sort((a, b) => b[1].totalUpvotes - a[1].totalUpvotes)
      .slice(0, 3);
    
    if (popularAuthors.length > 0) {
      console.log('     最受欢迎作者:');
      popularAuthors.forEach(([author, stats], i) => {
        console.log(`       ${i+1}. ${author}: ↑${stats.totalUpvotes}, ↓${stats.totalDownvotes} (${stats.pagesCreated} 页面)`);
        
        // 显示给该作者投票最多的用户
        const topVoters = Array.from(stats.voters.entries())
          .map(([voter, voteStats]) => ({
            voter,
            totalVotes: voteStats.upvotes + voteStats.downvotes,
            upvotes: voteStats.upvotes
          }))
          .sort((a, b) => b.totalVotes - a.totalVotes)
          .slice(0, 2);
        
        if (topVoters.length > 0) {
          console.log(`         主要支持者: ${topVoters.map(v => `${v.voter}(${v.totalVotes}票)`).join(', ')}`);
        }
      });
    }
  }

  generateReport() {
    this.stats.endTime = new Date();
    const duration = this.stats.endTime - this.stats.startTime;
    const durationSeconds = Math.round(duration / 1000);
    
    // 全量同步估算
    const estimatedFullPages = 30849;
    const pagesPerSecond = this.stats.pagesProcessed / durationSeconds;
    const estimatedFullSyncSeconds = Math.round(estimatedFullPages / pagesPerSecond);
    const estimatedFullSyncMinutes = Math.round(estimatedFullSyncSeconds / 60);
    const estimatedRateLimitCost = Math.round((this.stats.rateLimitInfo?.cost || 0) * estimatedFullPages / this.stats.pagesProcessed);
    
    const report = {
      testSummary: {
        duration: `${durationSeconds} seconds`,
        pagesProcessed: this.stats.pagesProcessed,
        usersProcessed: this.stats.usersProcessed,
        voteRecordsCount: this.stats.voteRecordsCount,
        revisionsCount: this.stats.revisionsCount,
        errors: this.stats.errors.length,
        rateLimitUsed: this.stats.rateLimitInfo?.cost || 0
      },
      fullSyncEstimation: {
        totalPages: estimatedFullPages,
        estimatedDuration: `${estimatedFullSyncMinutes} minutes`,
        estimatedRateLimitCost: estimatedRateLimitCost,
        processingRate: `${pagesPerSecond.toFixed(2)} pages/second`
      },
      dataQuality: {
        averageVoteRecordsPerPage: this.stats.voteRecordsCount / this.stats.pagesProcessed,
        averageRevisionsPerPage: this.stats.revisionsCount / this.stats.pagesProcessed,
        pagesWithContent: this.data.pages.filter(p => p.sourceLength > 0).length,
        pagesWithVotes: this.data.pages.filter(p => p.voteRecordsCount > 0).length
      },
      sampleData: {
        pages: this.data.pages,
        users: this.data.users,
        voteRecords: this.data.voteRecords.slice(0, 50), // 只保存前50条作为样例
        revisions: this.data.revisions.slice(0, 50)
      },
      errors: this.stats.errors,
      timestamp: new Date().toISOString()
    };
    
    // 保存完整报告
    fs.writeFileSync('./sync-test-report.json', JSON.stringify(report, null, 2));
    
    console.log('\n📋 最终测试报告:');
    console.log('=' .repeat(60));
    console.log(`⏱️  测试耗时: ${durationSeconds} 秒`);
    console.log(`📄 处理页面: ${this.stats.pagesProcessed} 个`);
    console.log(`👤 处理用户: ${this.stats.usersProcessed} 个`);
    console.log(`🗳️  投票记录: ${this.stats.voteRecordsCount} 条`);
    console.log(`📝 修订记录: ${this.stats.revisionsCount} 条`);
    console.log(`💰 Rate Limit消耗: ${this.stats.rateLimitInfo?.cost || 0} 点`);
    console.log(`💰 Rate Limit剩余: ${this.stats.rateLimitInfo?.remaining || 0} 点`);
    
    console.log('\n🔮 全量同步预估:');
    console.log(`📊 处理速度: ${pagesPerSecond.toFixed(2)} 页面/秒`);
    console.log(`⏱️  预估时间: ${estimatedFullSyncMinutes} 分钟 (~${Math.round(estimatedFullSyncMinutes/60*10)/10} 小时)`);
    console.log(`💰 预估Rate Limit: ${estimatedRateLimitCost} 点`);
    console.log(`📈 配额占用: ${((estimatedRateLimitCost/300000)*100).toFixed(1)}% (5分钟窗口)`);
    
    console.log('\n📊 数据质量评估:');
    console.log(`📄 平均投票记录/页面: ${(this.stats.voteRecordsCount/this.stats.pagesProcessed).toFixed(1)}`);
    console.log(`📝 平均修订记录/页面: ${(this.stats.revisionsCount/this.stats.pagesProcessed).toFixed(1)}`);
    console.log(`✅ 有内容的页面: ${this.data.pages.filter(p => p.sourceLength > 0).length}/${this.stats.pagesProcessed}`);
    console.log(`🗳️  有投票的页面: ${this.data.pages.filter(p => p.voteRecordsCount > 0).length}/${this.stats.pagesProcessed}`);
    
    if (this.stats.errors.length > 0) {
      console.log('\n⚠️  错误统计:');
      console.log(`❌ 总错误数: ${this.stats.errors.length}`);
    } else {
      console.log('\n✅ 测试完成，无错误');
    }
    
    console.log('\n💾 详细报告已保存到: ./sync-test-report.json');
    console.log('\n🚀 建议下一步:');
    console.log('   1. 检查数据质量和完整性');
    console.log('   2. 设置PostgreSQL数据库');
    console.log('   3. 实现完整的数据同步脚本');
    console.log('   4. 开发投票网络分析功能');
    console.log('   5. 构建Web前端界面');
  }
}

// 运行测试
async function runTest() {
  const tester = new SimpleSyncTester();
  await tester.testDataRetrieval();
}

runTest().catch(console.error);