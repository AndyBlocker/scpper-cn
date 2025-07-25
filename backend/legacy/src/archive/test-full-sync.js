import { GraphQLClient } from 'graphql-request';
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();
const cromClient = new GraphQLClient(process.env.CROM_API_URL);

class FullSyncTester {
  constructor() {
    this.stats = {
      startTime: null,
      endTime: null,
      pagesProcessed: 0,
      usersProcessed: 0,
      voteRecordsInserted: 0,
      revisionsInserted: 0,
      errors: [],
      rateLimitInfo: null
    };
  }

  async testSmallBatch() {
    console.log('🧪 测试小批量数据同步 (10个页面)\n');
    
    this.stats.startTime = new Date();
    
    try {
      // 1. 测试页面数据获取
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
      
      console.log('📄 获取页面数据...');
      const pageResult = await cromClient.request(pageQuery, {
        filter: {
          url: { startsWith: process.env.TARGET_SITE_URL }
        },
        first: 10
      });
      
      this.stats.rateLimitInfo = pageResult.rateLimit;
      console.log(`✅ 获取了 ${pageResult.pages.edges.length} 个页面`);
      console.log(`💰 Rate limit cost: ${pageResult.rateLimit.cost}`);
      console.log(`💰 Remaining: ${pageResult.rateLimit.remaining}`);
      
      // 2. 处理和存储页面数据
      console.log('\n💾 存储页面数据到数据库...');
      
      for (const edge of pageResult.pages.edges) {
        const page = edge.node;
        const info = page.wikidotInfo;
        
        try {
          // 存储页面基础信息
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
            createdAt: info.createdAt ? new Date(info.createdAt) : null,
            revisionCount: info.revisionCount,
            source: info.source,
            textContent: info.textContent,
            tags: info.tags || [],
            isPrivate: info.isPrivate || false,
            createdByUser: info.createdBy?.name,
            parentUrl: info.parent?.url,
            thumbnailUrl: info.thumbnailUrl,
            lastSyncedAt: new Date()
          };
          
          const savedPage = await prisma.page.upsert({
            where: { url: page.url },
            update: pageData,
            create: pageData
          });
          
          this.stats.pagesProcessed++;
          
          // 存储投票记录
          if (info.coarseVoteRecords && info.coarseVoteRecords.length > 0) {
            const voteRecords = info.coarseVoteRecords.map(vote => ({
              pageUrl: page.url,
              userWikidotId: vote.userWikidotId,
              userName: vote.user?.name,
              timestamp: new Date(vote.timestamp),
              direction: vote.direction
            }));
            
            // 批量插入投票记录（忽略重复）
            for (const vote of voteRecords) {
              try {
                await prisma.voteRecord.upsert({
                  where: {
                    pageUrl_userWikidotId_timestamp: {
                      pageUrl: vote.pageUrl,
                      userWikidotId: vote.userWikidotId,
                      timestamp: vote.timestamp
                    }
                  },
                  update: {},
                  create: vote
                });
                this.stats.voteRecordsInserted++;
              } catch (error) {
                // 忽略重复键错误
                if (!error.message.includes('unique constraint')) {
                  console.log(`⚠️ 投票记录插入失败: ${error.message}`);
                }
              }
            }
          }
          
          // 存储修订记录
          if (info.revisions && info.revisions.length > 0) {
            const revisions = info.revisions.map(rev => ({
              pageUrl: page.url,
              revisionIndex: rev.index,
              wikidotId: rev.wikidotId,
              timestamp: new Date(rev.timestamp),
              type: rev.type,
              userWikidotId: rev.userWikidotId,
              userName: rev.user?.name,
              comment: rev.comment
            }));
            
            for (const revision of revisions) {
              try {
                await prisma.revision.upsert({
                  where: {
                    pageUrl_revisionIndex: {
                      pageUrl: revision.pageUrl,
                      revisionIndex: revision.revisionIndex
                    }
                  },
                  update: revision,
                  create: revision
                });
                this.stats.revisionsInserted++;
              } catch (error) {
                console.log(`⚠️ 修订记录插入失败: ${error.message}`);
              }
            }
          }
          
          // 存储页面关系
          const relations = [];
          if (info.parent) {
            relations.push({
              pageUrl: page.url,
              relatedUrl: info.parent.url,
              relationType: 'parent'
            });
          }
          
          if (info.children) {
            for (const child of info.children) {
              relations.push({
                pageUrl: page.url,
                relatedUrl: child.url,
                relationType: 'child'
              });
            }
          }
          
          if (page.translations) {
            for (const translation of page.translations) {
              relations.push({
                pageUrl: page.url,
                relatedUrl: translation.url,
                relationType: 'translation'
              });
            }
          }
          
          if (page.translationOf) {
            relations.push({
              pageUrl: page.url,
              relatedUrl: page.translationOf.url,
              relationType: 'translation_of'
            });
          }
          
          // 插入关系数据
          for (const relation of relations) {
            try {
              await prisma.pageRelation.upsert({
                where: {
                  pageUrl_relatedUrl_relationType: {
                    pageUrl: relation.pageUrl,
                    relatedUrl: relation.relatedUrl,
                    relationType: relation.relationType
                  }
                },
                update: {},
                create: relation
              });
            } catch (error) {
              // 忽略外键约束错误（related page不存在）
              if (!error.message.includes('foreign key constraint')) {
                console.log(`⚠️ 页面关系插入失败: ${error.message}`);
              }
            }
          }
          
          // 存储贡献者信息
          if (page.attributions && page.attributions.length > 0) {
            for (const attr of page.attributions) {
              try {
                await prisma.attribution.upsert({
                  where: {
                    pageUrl_userName_attributionType: {
                      pageUrl: page.url,
                      userName: attr.user.name,
                      attributionType: attr.type
                    }
                  },
                  update: {
                    date: attr.date ? new Date(attr.date) : null,
                    orderIndex: attr.order,
                    isCurrent: attr.isCurrent
                  },
                  create: {
                    pageUrl: page.url,
                    userName: attr.user.name,
                    attributionType: attr.type,
                    date: attr.date ? new Date(attr.date) : null,
                    orderIndex: attr.order,
                    isCurrent: attr.isCurrent
                  }
                });
              } catch (error) {
                console.log(`⚠️ 贡献者信息插入失败: ${error.message}`);
              }
            }
          }
          
          // 存储替代标题
          if (page.alternateTitles && page.alternateTitles.length > 0) {
            for (const altTitle of page.alternateTitles) {
              try {
                await prisma.alternateTitle.create({
                  data: {
                    pageUrl: page.url,
                    type: altTitle.type,
                    title: altTitle.title
                  }
                });
              } catch (error) {
                // 忽略重复插入错误
                if (!error.message.includes('unique constraint')) {
                  console.log(`⚠️ 替代标题插入失败: ${error.message}`);
                }
              }
            }
          }
          
          console.log(`✅ 处理页面: ${info.title} (${this.stats.pagesProcessed}/10)`);
          
        } catch (error) {
          console.log(`❌ 页面处理失败 ${page.url}: ${error.message}`);
          this.stats.errors.push({
            type: 'page_processing',
            url: page.url,
            error: error.message
          });
        }
      }
      
      // 3. 测试用户数据同步
      console.log('\n👤 测试用户数据同步...');
      await this.testUserSync();
      
      this.stats.endTime = new Date();
      
      // 4. 生成测试报告
      this.generateTestReport();
      
    } catch (error) {
      console.error('❌ 测试失败:', error.message);
      this.stats.errors.push({
        type: 'general',
        error: error.message
      });
    }
  }
  
  async testUserSync() {
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
      const userResult = await cromClient.request(userQuery, {
        filter: {
          anyBaseUrl: [process.env.TARGET_SITE_URL]
        }
      });
      
      console.log(`✅ 获取了 ${userResult.searchUsers.length} 个用户`);
      console.log(`💰 Rate limit cost: ${userResult.rateLimit.cost}`);
      
      // 存储用户数据
      for (const user of userResult.searchUsers) {
        try {
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
            pageCountObject: user.statistics?.pageCountObject,
            lastSyncedAt: new Date()
          };
          
          await prisma.user.upsert({
            where: { name: user.name },
            update: userData,
            create: userData
          });
          
          this.stats.usersProcessed++;
          
        } catch (error) {
          console.log(`⚠️ 用户处理失败 ${user.name}: ${error.message}`);
          this.stats.errors.push({
            type: 'user_processing',
            name: user.name,
            error: error.message
          });
        }
      }
      
    } catch (error) {
      console.log(`❌ 用户同步失败: ${error.message}`);
      this.stats.errors.push({
        type: 'user_sync',
        error: error.message
      });
    }
  }
  
  generateTestReport() {
    const duration = this.stats.endTime - this.stats.startTime;
    const durationMinutes = Math.round(duration / 1000 / 60 * 100) / 100;
    
    const report = {
      testSummary: {
        duration: `${durationMinutes} minutes`,
        pagesProcessed: this.stats.pagesProcessed,
        usersProcessed: this.stats.usersProcessed,
        voteRecordsInserted: this.stats.voteRecordsInserted,
        revisionsInserted: this.stats.revisionsInserted,
        errors: this.stats.errors.length,
        rateLimitUsed: this.stats.rateLimitInfo?.cost || 0
      },
      rateLimitInfo: this.stats.rateLimitInfo,
      errors: this.stats.errors,
      timestamp: new Date().toISOString()
    };
    
    // 保存测试报告
    fs.writeFileSync('./test-sync-report.json', JSON.stringify(report, null, 2));
    
    console.log('\n📊 测试完成报告:');
    console.log('=' .repeat(50));
    console.log(`⏱️  总耗时: ${durationMinutes} 分钟`);
    console.log(`📄 处理页面: ${this.stats.pagesProcessed}`);
    console.log(`👤 处理用户: ${this.stats.usersProcessed}`);
    console.log(`🗳️  插入投票记录: ${this.stats.voteRecordsInserted}`);
    console.log(`📝 插入修订记录: ${this.stats.revisionsInserted}`);
    console.log(`❌ 错误数量: ${this.stats.errors.length}`);
    console.log(`💰 Rate limit消耗: ${this.stats.rateLimitInfo?.cost || 0}`);
    console.log(`💰 Rate limit剩余: ${this.stats.rateLimitInfo?.remaining || 0}`);
    
    if (this.stats.errors.length > 0) {
      console.log('\n⚠️  错误详情:');
      this.stats.errors.forEach((error, i) => {
        console.log(`${i + 1}. ${error.type}: ${error.error}`);
      });
    }
    
    console.log('\n💾 完整报告已保存到: ./test-sync-report.json');
    
    // 估算全量同步时间
    if (this.stats.pagesProcessed > 0 && durationMinutes > 0) {
      const pagesPerMinute = this.stats.pagesProcessed / durationMinutes;
      const estimatedFullSyncMinutes = Math.round(30849 / pagesPerMinute);
      const estimatedFullSyncHours = Math.round(estimatedFullSyncMinutes / 60 * 10) / 10;
      
      console.log('\n🔮 全量同步预估:');
      console.log(`📊 处理速度: ${pagesPerMinute.toFixed(1)} 页面/分钟`);
      console.log(`⏱️  预估时间: ${estimatedFullSyncMinutes} 分钟 (~${estimatedFullSyncHours} 小时)`);
      console.log(`💰 预估Rate Limit: ${Math.round((this.stats.rateLimitInfo?.cost || 0) * 30849 / this.stats.pagesProcessed)}`);
    }
  }
}

// 主函数
async function runTest() {
  console.log('🚀 SCPPER-CN 全量数据同步测试\n');
  console.log('目标站点:', process.env.TARGET_SITE_URL);
  console.log('数据库:', process.env.DATABASE_URL);
  console.log('');
  
  const tester = new FullSyncTester();
  
  try {
    // 检查数据库连接
    await prisma.$connect();
    console.log('✅ 数据库连接成功');
    
    // 开始测试
    await tester.testSmallBatch();
    
  } catch (error) {
    console.error('❌ 测试失败:', error.message);
  } finally {
    await prisma.$disconnect();
  }
}

// 运行测试
runTest().catch(console.error);