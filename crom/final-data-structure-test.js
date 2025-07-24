import { CromClient } from './client.js';
import fs from 'fs';

class FinalDataStructureClient extends CromClient {
  
  // 获取完整的页面数据结构
  async getCompletePageStructure(baseUrl) {
    console.log('📄 获取完整页面数据结构\n');
    
    const completePageQuery = `
      query CompletePageStructure($filter: QueryPagesFilter) {
        pages(filter: $filter, first: 1) {
          edges {
            node {
              # 基础URL
              url
              
              # 完整的Wikidot信息
              wikidotInfo {
                # 基础元数据
                title
                category
                wikidotId
                createdAt
                revisionCount
                isPrivate
                commentCount
                thumbnailUrl
                
                # 评分和投票
                rating
                realtimeRating
                voteCount
                realtimeVoteCount
                
                # 内容
                source
                textContent
                
                # 标签
                tags
                
                # 页面关系
                parent {
                  url
                  wikidotInfo {
                    title
                    wikidotId
                  }
                }
                
                children {
                  url
                  wikidotInfo {
                    title
                    wikidotId
                  }
                }
                
                # 作者信息
                createdBy {
                  name
                  wikidotInfo {
                    displayName
                    wikidotId
                    unixName
                  }
                  statistics {
                    rank
                    totalRating
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
                
                # 完整投票记录
                coarseVoteRecords {
                  timestamp
                  userWikidotId
                  direction
                  user {
                    name
                    wikidotInfo {
                      displayName
                      wikidotId
                      unixName
                    }
                  }
                }
                
                # 完整修订历史
                revisions {
                  index
                  wikidotId
                  timestamp
                  type
                  userWikidotId
                  comment
                  user {
                    name
                    wikidotInfo {
                      displayName
                      wikidotId
                      unixName
                    }
                  }
                }
              }
              
              # 替代标题
              alternateTitles {
                type
                title
              }
              
              # 完整贡献者信息
              attributions {
                type
                user {
                  name
                  wikidotInfo {
                    displayName
                    wikidotId
                    unixName
                  }
                  statistics {
                    rank
                    totalRating
                    pageCount
                  }
                }
                date
                order
                isCurrent
              }
              
              # 翻译关系
              translations {
                url
                wikidotInfo {
                  title
                  wikidotId
                }
              }
              
              translationOf {
                url
                wikidotInfo {
                  title
                  wikidotId
                }
              }
              
              # 成人内容关系
              adultContentPage {
                url
                wikidotInfo {
                  title
                  wikidotId
                }
              }
              
              adultSplashPage {
                url
                wikidotInfo {
                  title
                  wikidotId
                }
              }
            }
            cursor
          }
          pageInfo {
            hasNextPage
            hasPreviousPage
            startCursor
            endCursor
          }
        }
        rateLimit {
          cost
          limit
          remaining
          resetAt
        }
      }
    `;

    try {
      const result = await this.client.request(completePageQuery, {
        filter: {
          url: { startsWith: baseUrl }
        }
      });

      return result;
    } catch (error) {
      console.error(`❌ 页面查询失败: ${error.message}`);
      if (error.response?.errors) {
        console.error('GraphQL errors:', error.response.errors.map(e => e.message));
      }
      return null;
    }
  }
  
  // 获取完整的用户数据结构
  async getCompleteUserStructure(baseUrl) {
    console.log('👤 获取完整用户数据结构\n');
    
    const completeUserQuery = `
      query CompleteUserStructure($filter: SearchUsersFilter) {
        searchUsers(query: "", filter: $filter) {
          # 基础用户信息
          name
          
          # Wikidot信息
          wikidotInfo {
            displayName
            wikidotId
            unixName
          }
          
          # 作者页面信息
          authorInfos {
            site
            authorPage {
              url
              wikidotInfo {
                title
                wikidotId
                createdAt
                rating
                voteCount
              }
            }
          }
          
          # 完整统计信息
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
          
          # 用户的页面 (带分页)
          attributedPages(first: 5, sort: { key: RATING, order: DESC }) {
            edges {
              node {
                url
                wikidotInfo {
                  title
                  rating
                  voteCount
                  createdAt
                  tags
                }
              }
            }
            pageInfo {
              hasNextPage
              endCursor
            }
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
      const result = await this.client.request(completeUserQuery, {
        filter: {
          anyBaseUrl: [baseUrl]
        }
      });

      return result;
    } catch (error) {
      console.error(`❌ 用户查询失败: ${error.message}`);
      if (error.response?.errors) {
        console.error('GraphQL errors:', error.response.errors.map(e => e.message));
      }
      return null;
    }
  }
  
  // 获取聚合统计信息
  async getAggregateStatistics(baseUrl) {
    console.log('📊 获取聚合统计信息\n');
    
    const aggregateQuery = `
      query AggregateStatistics($filter: QueryAggregatePageWikidotInfosFilter) {
        aggregatePageWikidotInfos(filter: $filter) {
          _count
          rating {
            sum
            mean
            min
            max
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
      const result = await this.client.request(aggregateQuery, {
        filter: {
          url: { startsWith: baseUrl }
        }
      });

      return result;
    } catch (error) {
      console.error(`❌ 聚合查询失败: ${error.message}`);
      return null;
    }
  }
  
  // 获取站点信息
  async getSiteInformation() {
    console.log('🌐 获取站点信息\n');
    
    const siteQuery = `
      query SiteInformation {
        sites {
          type
          displayName
          url
          language
          recentlyCreatedUrl
        }
        rateLimit {
          cost
          remaining
          resetAt
        }
      }
    `;

    try {
      const result = await this.client.request(siteQuery);
      return result;
    } catch (error) {
      console.error(`❌ 站点查询失败: ${error.message}`);
      return null;
    }
  }
}

async function finalDataStructureTest() {
  const client = new FinalDataStructureClient();
  const cnBaseUrl = 'http://scp-wiki-cn.wikidot.com';
  
  console.log('🎯 最终数据结构确认和项目设计\n');
  console.log('=' .repeat(60));

  try {
    // 1. 页面数据结构
    console.log('1. 页面数据结构测试');
    const pageStructure = await client.getCompletePageStructure(cnBaseUrl);
    
    if (pageStructure) {
      console.log(`   ✅ 页面查询成功`);
      console.log(`   💰 Cost: ${pageStructure.rateLimit.cost}`);
      console.log(`   📄 获取页面数: ${pageStructure.pages.edges.length}`);
      
      if (pageStructure.pages.edges.length > 0) {
        const page = pageStructure.pages.edges[0].node;
        const info = page.wikidotInfo;
        
        console.log(`   📊 样本页面数据完整性:`);
        console.log(`      基础信息: ✅ (title: ${info.title})`);
        console.log(`      评分数据: ✅ (rating: ${info.rating}, votes: ${info.voteCount})`);
        console.log(`      投票记录: ✅ (${info.coarseVoteRecords?.length || 0} records)`);
        console.log(`      修订历史: ✅ (${info.revisions?.length || 0} revisions)`);
        console.log(`      内容数据: ✅ (${info.source?.length || 0} chars)`);
        console.log(`      标签数据: ✅ (${info.tags?.length || 0} tags)`);
        console.log(`      贡献者: ✅ (${page.attributions?.length || 0} attributions)`);
        console.log(`      翻译关系: ✅ (${page.translations?.length || 0} translations)`);
      }
      
      // 保存页面结构样本
      fs.writeFileSync('./final-page-structure.json', JSON.stringify(pageStructure, null, 2));
      console.log('   💾 页面结构保存到 ./final-page-structure.json');
    }

    console.log('');

    // 2. 用户数据结构
    console.log('2. 用户数据结构测试');
    const userStructure = await client.getCompleteUserStructure(cnBaseUrl);
    
    if (userStructure) {
      console.log(`   ✅ 用户查询成功`);
      console.log(`   💰 Cost: ${userStructure.rateLimit.cost}`);
      console.log(`   👤 获取用户数: ${userStructure.searchUsers.length}`);
      
      if (userStructure.searchUsers.length > 0) {
        const user = userStructure.searchUsers[0];
        
        console.log(`   📊 样本用户数据完整性:`);
        console.log(`      基础信息: ✅ (name: ${user.name})`);
        console.log(`      Wikidot信息: ✅ (id: ${user.wikidotInfo?.wikidotId || 'N/A'})`);
        console.log(`      统计数据: ✅ (rank: ${user.statistics?.rank}, rating: ${user.statistics?.totalRating})`);
        console.log(`      作者页面: ✅ (${user.authorInfos?.length || 0} sites)`);
        console.log(`      关联页面: ✅ (${user.attributedPages?.edges?.length || 0} pages shown)`);
      }
      
      // 保存用户结构样本
      fs.writeFileSync('./final-user-structure.json', JSON.stringify(userStructure, null, 2));
      console.log('   💾 用户结构保存到 ./final-user-structure.json');
    }

    console.log('');

    // 3. 聚合统计
    console.log('3. 聚合统计测试');
    const aggregateStats = await client.getAggregateStatistics(cnBaseUrl);
    
    if (aggregateStats) {
      console.log(`   ✅ 聚合查询成功`);
      console.log(`   💰 Cost: ${aggregateStats.rateLimit.cost}`);
      
      const stats = aggregateStats.aggregatePageWikidotInfos;
      console.log(`   📊 统计数据:`);
      console.log(`      总页面数: ${stats._count}`);
      console.log(`      总评分: ${stats.rating.sum}`);
      console.log(`      平均评分: ${stats.rating.mean?.toFixed(2)}`);
      console.log(`      评分范围: ${stats.rating.min} ~ ${stats.rating.max}`);
    }

    console.log('');

    // 4. 站点信息
    console.log('4. 站点信息测试');
    const siteInfo = await client.getSiteInformation();
    
    if (siteInfo) {
      console.log(`   ✅ 站点查询成功`);
      console.log(`   💰 Cost: ${siteInfo.rateLimit.cost}`);
      console.log(`   🌐 站点数量: ${siteInfo.sites.length}`);
      
      const cnSite = siteInfo.sites.find(s => s.url === cnBaseUrl);
      if (cnSite) {
        console.log(`   🇨🇳 CN站点信息:`);
        console.log(`      名称: ${cnSite.displayName}`);
        console.log(`      类型: ${cnSite.type}`);
        console.log(`      语言: ${cnSite.language}`);
        console.log(`      URL: ${cnSite.url}`);
      }
    }

    console.log('');
    console.log('=' .repeat(60));
    console.log('🎯 最终数据结构确认完成\n');
    
    // 输出项目设计建议
    console.log('🏗️ 项目架构设计建议:\n');
    
    console.log('📦 1. 数据层 (Database Schema)');
    console.log('   📄 Pages 表:');
    console.log('      - url (主键), title, category, wikidot_id');
    console.log('      - rating, vote_count, created_at, revision_count');
    console.log('      - source, text_content, tags, is_private');
    console.log('      - created_by_user_id, parent_url, thumbnail_url');
    console.log('      - last_synced_at, is_deleted');
    console.log('');
    console.log('   👤 Users 表:');
    console.log('      - name (主键), display_name, wikidot_id, unix_name');
    console.log('      - rank, total_rating, mean_rating, page_count');
    console.log('      - page_count_scp, page_count_tale, etc.');
    console.log('      - last_synced_at');
    console.log('');
    console.log('   🗳️ VoteRecords 表:');
    console.log('      - page_url, user_wikidot_id, timestamp, direction');
    console.log('      - user_name (冗余，便于查询)');
    console.log('');
    console.log('   📝 Revisions 表:');
    console.log('      - page_url, revision_index, wikidot_id, timestamp');
    console.log('      - type, user_wikidot_id, comment');
    console.log('');
    console.log('   🔗 PageRelations 表:');
    console.log('      - page_url, related_url, relation_type');
    console.log('      - (parent/child, translation, adult_content)');
    console.log('');
    console.log('   👥 Attributions 表:');
    console.log('      - page_url, user_name, attribution_type');
    console.log('      - date, order, is_current');
    console.log('');
    
    console.log('🔄 2. 同步服务 (Sync Service)');
    console.log('   📅 每日同步任务:');
    console.log('      - 全量页面同步 (51分钟)');
    console.log('      - 全量用户同步 (~10分钟)');
    console.log('      - 数据一致性检查');
    console.log('      - 删除页面检测 (URL不再存在)');
    console.log('');
    console.log('   📊 实时统计更新:');
    console.log('      - 聚合数据缓存');
    console.log('      - 排名计算');
    console.log('      - 投票网络分析');
    console.log('');
    
    console.log('🌐 3. Web前端 (Frontend)');
    console.log('   📈 数据展示页面:');
    console.log('      - 页面浏览和搜索');
    console.log('      - 用户排名和统计');
    console.log('      - 投票关系图谱');
    console.log('      - 历史趋势分析');
    console.log('      - 被删除页面归档');
    console.log('');
    console.log('   🔍 高级功能:');
    console.log('      - 谁给我upvote/downvote最多');
    console.log('      - 我给谁upvote/downvote最多');
    console.log('      - 页面修订历史可视化');
    console.log('      - 作者关系网络');
    console.log('      - 标签云和分类统计');
    console.log('');
    
    console.log('⚡ 4. 技术栈建议');
    console.log('   🗄️ 数据库: PostgreSQL (支持JSON字段和复杂查询)');
    console.log('   🔧 后端: Node.js + Express/Fastify + Prisma ORM');
    console.log('   🎨 前端: React/Vue + D3.js (数据可视化) + Cytoscape.js (关系图)');
    console.log('   📊 缓存: Redis (聚合数据和排名缓存)');
    console.log('   ⏰ 任务调度: node-cron 或 Bull Queue');
    console.log('   📦 容器化: Docker + docker-compose');
    
    console.log('\n🚀 准备开始项目实施！');

  } catch (error) {
    console.error('❌ 最终测试失败:', error.message);
    if (error.response?.errors) {
      console.error('Response errors:', error.response.errors.map(e => e.message));
    }
  }
}

// 运行最终测试
finalDataStructureTest().catch(console.error);