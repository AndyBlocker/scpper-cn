#!/usr/bin/env node

import { PrismaClient } from '@prisma/client';

/**
 * 查询页面或用户信息的工具脚本
 * 支持查询页面和用户，但不显示完整的投票记录全量
 */

const prisma = new PrismaClient();

// 命令行参数解析
const args = process.argv.slice(2);
const queryType = args[0]; // 'page' 或 'user'
const queryValue = args[1]; // URL 或 用户名

async function queryPage(urlOrId) {
  console.log(`🔍 查询页面: ${urlOrId}`);
  console.log('='.repeat(60));

  try {
    let page;
    
    // 支持通过URL或ID查询
    if (urlOrId.startsWith('http')) {
      // 通过URL查询，获取最新实例
      const urlMapping = await prisma.urlMapping.findUnique({
        where: { url: urlOrId },
        include: {
          currentPage: {
            include: {
              voteRecords: {
                take: 10, // 只显示前10条投票记录
                orderBy: { timestamp: 'desc' },
                select: {
                  userName: true,
                  direction: true,
                  timestamp: true
                }
              },
              revisions: {
                take: 5, // 只显示前5条修订记录
                orderBy: { timestamp: 'desc' },
                select: {
                  revisionIndex: true,
                  userName: true,
                  timestamp: true,
                  type: true,
                  comment: true,
                  sourceVersionId: true,
                  sourceVersion: {
                    select: {
                      sourceHash: true,
                      isCurrentVersion: true
                    }
                  }
                }
              },
              attributions: {
                select: {
                  userName: true,
                  attributionType: true,
                  date: true
                }
              },
              alternateTitles: {
                select: {
                  type: true,
                  title: true
                }
              }
            }
          }
        }
      });
      
      if (!urlMapping) {
        console.log('❌ 未找到该URL的页面');
        return;
      }
      
      page = urlMapping.currentPage;
      
      // 显示URL映射信息
      console.log('🗺️  URL映射信息:');
      console.log(`   当前实例版本: ${urlMapping.currentInstanceVersion}`);
      console.log(`   总实例数: ${urlMapping.totalInstances}`);
      console.log(`   最后更新: ${urlMapping.lastUpdatedAt.toLocaleString()}`);
      console.log('');
      
    } else if (!isNaN(urlOrId)) {
      // 通过ID查询
      page = await prisma.page.findUnique({
        where: { id: parseInt(urlOrId) },
        include: {
          voteRecords: {
            take: 10,
            orderBy: { timestamp: 'desc' },
            select: {
              userName: true,
              direction: true,
              timestamp: true
            }
          },
          revisions: {
            take: 5,
            orderBy: { timestamp: 'desc' },
            select: {
              revisionIndex: true,
              userName: true,
              timestamp: true,
              type: true,
              comment: true,
              sourceVersionId: true,
              sourceVersion: {
                select: {
                  sourceHash: true,
                  isCurrentVersion: true
                }
              }
            }
          },
          attributions: {
            select: {
              userName: true,
              attributionType: true,
              date: true
            }
          },
          alternateTitles: {
            select: {
              type: true,
              title: true
            }
          }
        }
      });
    } else {
      // 通过标题模糊搜索
      const pages = await prisma.page.findMany({
        where: {
          title: {
            contains: urlOrId,
            mode: 'insensitive'
          },
          isDeleted: false
        },
        take: 5,
        select: {
          id: true,
          url: true,
          title: true,
          rating: true,
          voteCount: true,
          instanceVersion: true
        }
      });
      
      if (pages.length === 0) {
        console.log('❌ 未找到匹配的页面');
        return;
      }
      
      if (pages.length > 1) {
        console.log('🔍 找到多个匹配的页面:');
        pages.forEach((p, i) => {
          console.log(`   ${i + 1}. [ID: ${p.id}] ${p.title}`);
          console.log(`      URL: ${p.url}`);
          console.log(`      评分: ${p.rating} (${p.voteCount} 票) 版本: ${p.instanceVersion}`);
        });
        console.log('');
        console.log('请使用具体的ID或URL查询单个页面');
        return;
      }
      
      // 只有一个结果，查询详细信息
      page = await prisma.page.findUnique({
        where: { id: pages[0].id },
        include: {
          voteRecords: {
            take: 10,
            orderBy: { timestamp: 'desc' },
            select: {
              userName: true,
              direction: true,
              timestamp: true
            }
          },
          revisions: {
            take: 5,
            orderBy: { timestamp: 'desc' },
            select: {
              revisionIndex: true,
              userName: true,
              timestamp: true,
              type: true,
              comment: true,
              sourceVersionId: true,
              sourceVersion: {
                select: {
                  sourceHash: true,
                  isCurrentVersion: true
                }
              }
            }
          },
          attributions: {
            select: {
              userName: true,
              attributionType: true,
              date: true
            }
          },
          alternateTitles: {
            select: {
              type: true,
              title: true
            }
          }
        }
      });
    }
    
    if (!page) {
      console.log('❌ 未找到该页面');
      return;
    }

    // 显示页面基本信息
    console.log('📄 页面基本信息:');
    console.log(`   ID: ${page.id}`);
    console.log(`   标题: ${page.title}`);
    console.log(`   URL: ${page.url}`);
    console.log(`   实例版本: ${page.instanceVersion}`);
    console.log(`   URL实例ID: ${page.urlInstanceId}`);
    console.log(`   分类: ${page.category || 'N/A'}`);
    console.log(`   创建者: ${page.createdByUser || 'Unknown'} (ID: ${page.createdByWikidotId || 'N/A'})`);
    console.log(`   状态: ${page.isDeleted ? '已删除' : '活跃'} ${page.isPrivate ? '私有' : '公开'}`);
    console.log('');

    // 显示统计信息
    console.log('📊 统计信息:');
    console.log(`   评分: ${page.rating}`);
    console.log(`   投票数: ${page.voteCount}`);
    console.log(`   评论数: ${page.commentCount}`);
    console.log(`   修订数: ${page.revisionCount}`);
    console.log(`   威尔逊分数: ${page.wilsonScore ? Number(page.wilsonScore).toFixed(4) : 'N/A'}`);
    console.log(`   好评率: ${page.upVoteRatio ? (Number(page.upVoteRatio) * 100).toFixed(2) + '%' : 'N/A'}`);
    console.log(`   争议度: ${page.controversyScore ? Number(page.controversyScore).toFixed(4) : 'N/A'}`);
    console.log('');

    // 显示时间信息
    console.log('⏰ 时间信息:');
    console.log(`   创建时间: ${page.createdAt ? page.createdAt.toLocaleString() : 'N/A'}`);
    console.log(`   最后编辑: ${page.lastEditedAt ? page.lastEditedAt.toLocaleString() : 'N/A'}`);
    console.log(`   实例创建: ${page.instanceCreatedAt.toLocaleString()}`);
    console.log(`   最后同步: ${page.lastSyncedAt.toLocaleString()}`);
    console.log(`   最后分析: ${page.lastAnalyzedAt ? page.lastAnalyzedAt.toLocaleString() : 'N/A'}`);
    console.log('');

    // 显示标签
    if (page.tags && page.tags.length > 0) {
      console.log('🏷️  标签:');
      console.log(`   ${page.tags.join(', ')}`);
      console.log('');
    }

    // 显示源代码信息
    if (page.source || page.sourceHash) {
      console.log('📝 源代码信息:');
      console.log(`   内容长度: ${page.contentLength} 字符`);
      console.log(`   源代码Hash: ${page.sourceHash || 'N/A'}`);
      if (page.source) {
        const preview = page.source.length > 200 ? 
          page.source.substring(0, 200) + '...' : 
          page.source;
        console.log(`   内容预览: ${preview}`);
      }
      
      // 查询源代码版本控制信息
      try {
        const sourceVersions = await prisma.sourceVersion.findMany({
          where: { pageId: page.id },
          orderBy: { capturedAt: 'desc' },
          take: 20,
          select: {
            id: true,
            sourceHash: true,
            isCurrentVersion: true,
            capturedAt: true,
            contentLength: true,
            _count: {
              select: { revisions: true }
            }
          }
        });
        
        if (sourceVersions.length > 0) {
          console.log(`   版本控制: ${sourceVersions.length} 个源代码版本`);
          sourceVersions.forEach((ver, i) => {
            const current = ver.isCurrentVersion ? ' (当前)' : '';
            const revCount = ver._count.revisions;
            console.log(`     版本${i + 1}: ${ver.sourceHash.substring(0, 12)}... ${ver.contentLength}字符${current}`);
            console.log(`     捕获: ${ver.capturedAt.toLocaleString()} 关联${revCount}个修订`);
          });
        }
      } catch (sourceVersionError) {
        console.log('   版本控制信息查询跳过');
      }
      
      console.log('');
    }

    // 显示投票记录（前10条）
    if (page.voteRecords && page.voteRecords.length > 0) {
      console.log(`🗳️  最近投票记录 (显示前10条，共${page.voteCount}条):`);
      page.voteRecords.forEach((vote, i) => {
        const direction = vote.direction > 0 ? '👍' : '👎';
        console.log(`   ${i + 1}. ${direction} ${vote.userName} - ${vote.timestamp.toLocaleString()}`);
      });
      console.log('');
    }

    // 显示修订记录（前5条）
    if (page.revisions && page.revisions.length > 0) {
      console.log(`📝 最近修订记录 (显示前5条，共${page.revisionCount}条):`);
      page.revisions.forEach((rev, i) => {
        console.log(`   ${i + 1}. #${rev.revisionIndex} by ${rev.userName || 'Unknown'}`);
        console.log(`      时间: ${rev.timestamp.toLocaleString()}`);
        console.log(`      类型: ${rev.type} ${rev.comment ? `- ${rev.comment}` : ''}`);
        
        // 显示关联的源代码版本信息
        if (rev.sourceVersion) {
          const hashPreview = rev.sourceVersion.sourceHash.substring(0, 12);
          const versionStatus = rev.sourceVersion.isCurrentVersion ? ' (当前版本)' : '';
          console.log(`      源代码: ${hashPreview}...${versionStatus}`);
        } else if (rev.sourceVersionId) {
          console.log(`      源代码: 版本ID ${rev.sourceVersionId}`);
        }
      });
      console.log('');
    }

    // 显示贡献者
    if (page.attributions && page.attributions.length > 0) {
      console.log('👥 贡献者:');
      const grouped = page.attributions.reduce((acc, attr) => {
        if (!acc[attr.attributionType]) acc[attr.attributionType] = [];
        acc[attr.attributionType].push(attr);
        return acc;
      }, {});
      
      Object.entries(grouped).forEach(([type, attrs]) => {
        console.log(`   ${type}: ${attrs.map(a => a.userName).join(', ')}`);
      });
      console.log('');
    }

    // 显示备用标题
    if (page.alternateTitles && page.alternateTitles.length > 0) {
      console.log('📑 备用标题:');
      page.alternateTitles.forEach((alt, i) => {
        console.log(`   ${i + 1}. [${alt.type}] ${alt.title}`);
      });
      console.log('');
    }

    // 检查是否有其他实例
    if (urlOrId.startsWith('http')) {
      const allInstances = await prisma.page.findMany({
        where: { url: page.url },
        select: {
          id: true,
          instanceVersion: true,
          isDeleted: true,
          instanceCreatedAt: true,
          instanceDeletedAt: true
        },
        orderBy: { instanceVersion: 'desc' }
      });
      
      if (allInstances.length > 1) {
        console.log(`🔄 页面实例历史 (共${allInstances.length}个实例):`);
        allInstances.forEach((inst, i) => {
          const status = inst.isDeleted ? '已删除' : '活跃';
          const current = inst.id === page.id ? ' (当前)' : '';
          console.log(`   版本${inst.instanceVersion}: ID ${inst.id} - ${status}${current}`);
          console.log(`      创建: ${inst.instanceCreatedAt.toLocaleString()}`);
          if (inst.instanceDeletedAt) {
            console.log(`      删除: ${inst.instanceDeletedAt.toLocaleString()}`);
          }
        });
      }
    }

  } catch (error) {
    console.error('❌ 查询页面时发生错误:', error);
  }
}

async function queryUser(userName) {
  console.log(`👤 查询用户: ${userName}`);
  console.log('='.repeat(60));

  try {
    const user = await prisma.user.findUnique({
      where: { name: userName }
    });

    if (!user) {
      // 尝试模糊搜索
      const users = await prisma.user.findMany({
        where: {
          OR: [
            { displayName: { contains: userName, mode: 'insensitive' } },
            { name: { contains: userName, mode: 'insensitive' } }
          ]
        },
        take: 10,
        select: {
          name: true,
          displayName: true,
          totalRating: true,
          pageCount: true,
          isActive: true
        }
      });

      if (users.length === 0) {
        console.log('❌ 未找到该用户');
        return;
      }

      console.log('🔍 找到匹配的用户:');
      users.forEach((u, i) => {
        const status = u.isActive ? '🟢 活跃' : '⚪ 非活跃';
        console.log(`   ${i + 1}. ${u.displayName} (@${u.name}) ${status}`);
        console.log(`      页面: ${u.pageCount} 总评分: ${u.totalRating}`);
      });
      console.log('');
      console.log('请使用准确的用户名查询详细信息');
      return;
    }

    // 显示用户基本信息
    console.log('👤 用户基本信息:');
    console.log(`   用户名: ${user.name}`);
    console.log(`   显示名称: ${user.displayName}`);
    console.log(`   Wikidot ID: ${user.wikidotId || 'N/A'}`);
    console.log(`   Unix名称: ${user.unixName || 'N/A'}`);
    console.log(`   状态: ${user.isActive ? '🟢 活跃' : '⚪ 非活跃'}`);
    console.log('');

    // 显示统计信息
    console.log('📊 创作统计:');
    console.log(`   总页面数: ${user.pageCount}`);
    console.log(`   总评分: ${user.totalRating}`);
    console.log(`   平均评分: ${user.meanRating.toFixed(2)}`);
    console.log(`   SCP页面: ${user.pageCountScp}`);
    console.log(`   故事页面: ${user.pageCountTale}`);
    console.log(`   GOI格式: ${user.pageCountGoiFormat}`);
    console.log('');

    // 显示时间信息
    console.log('⏰ 时间信息:');
    console.log(`   加入时间: ${user.joinTime ? user.joinTime.toLocaleString() : 'N/A'}`);
    console.log(`   最后同步: ${user.lastSyncedAt.toLocaleString()}`);
    console.log(`   最后分析: ${user.lastAnalyzedAt ? user.lastAnalyzedAt.toLocaleString() : 'N/A'}`);
    console.log('');

    // 查询用户创建的页面（前10个最高评分）
    const userPages = await prisma.page.findMany({
      where: {
        createdByUser: user.name,
        isDeleted: false
      },
      orderBy: { rating: 'desc' },
      take: 10,
      select: {
        id: true,
        title: true,
        url: true,
        rating: true,
        voteCount: true,
        category: true,
        createdAt: true
      }
    });

    if (userPages.length > 0) {
      console.log(`📄 用户页面 (显示前10个最高评分，共${user.pageCount}个页面):`);
      userPages.forEach((page, i) => {
        console.log(`   ${i + 1}. [${page.rating}分] ${page.title}`);
        console.log(`      分类: ${page.category || 'N/A'} 投票: ${page.voteCount}`);
        console.log(`      创建: ${page.createdAt ? page.createdAt.toLocaleDateString() : 'N/A'}`);
        console.log(`      URL: ${page.url}`);
        console.log('');
      });
    }

    // 查询用户投票记录统计（不显示具体记录）
    const [upvotes, downvotes] = await Promise.all([
      prisma.voteRecord.count({
        where: {
          userName: user.name,
          direction: { gt: 0 }
        }
      }),
      prisma.voteRecord.count({
        where: {
          userName: user.name,
          direction: { lt: 0 }
        }
      })
    ]);

    console.log('🗳️  投票活动统计:');
    console.log(`   上票: ${upvotes}`);
    console.log(`   下票: ${downvotes}`);
    console.log(`   总投票: ${upvotes + downvotes}`);
    console.log('');

    // 查询用户贡献统计
    const contributions = await prisma.attribution.groupBy({
      by: ['attributionType'],
      where: { userName: user.name },
      _count: { attributionType: true }
    });

    if (contributions.length > 0) {
      console.log('👥 贡献统计:');
      contributions.forEach(contrib => {
        console.log(`   ${contrib.attributionType}: ${contrib._count.attributionType}`);
      });
      console.log('');
    }

    // 查询投票关系（如果存在）
    let voteRelations = [];
    try {
      // 注意：user_vote_relations 是原生SQL表，不是Prisma模型
      const voteRelationsRaw = await prisma.$queryRawUnsafe(`
        SELECT 
          from_user_name, to_user_name,
          upvotes_given, downvotes_given, total_interactions
        FROM user_vote_relations 
        WHERE from_user_name = $1 OR to_user_name = $1
        ORDER BY total_interactions DESC
        LIMIT 5
      `, user.name);
      
      voteRelations = voteRelationsRaw.map(rel => ({
        fromUserId: rel.from_user_name,
        toUserId: rel.to_user_name,
        upvotes: rel.upvotes_given,
        downvotes: rel.downvotes_given,
        totalVotes: rel.total_interactions
      }));
    } catch (relError) {
      // 如果表不存在或查询失败，继续执行
      console.log('   投票关系查询跳过（表可能不存在）');
    }

    if (voteRelations.length > 0) {
      console.log('🤝 投票关系 (显示前5个):');
      voteRelations.forEach((rel, i) => {
        const isFrom = rel.fromUserId === user.name;
        const otherUser = isFrom ? rel.toUserId : rel.fromUserId;
        const relationship = isFrom ? `给 ${otherUser}` : `来自 ${otherUser}`;
        console.log(`   ${i + 1}. ${relationship}: +${rel.upvotes} -${rel.downvotes} (总计${rel.totalVotes})`);
      });
    }

  } catch (error) {
    console.error('❌ 查询用户时发生错误:', error);
  }
}

function showHelp() {
  console.log('📖 查询页面或用户信息工具');
  console.log('='.repeat(50));
  console.log('');
  console.log('用法:');
  console.log('  npm run query page <URL|ID|标题关键词>');
  console.log('  npm run query user <用户名|显示名称关键词>');
  console.log('  node query-page-user.js page <URL|ID|标题关键词>');
  console.log('  node query-page-user.js user <用户名|显示名称关键词>');
  console.log('');
  console.log('示例:');
  console.log('  npm run query page http://scp-wiki-cn.wikidot.com/scp-173');
  console.log('  npm run query page 12345');
  console.log('  npm run query page "SCP-173"');
  console.log('  npm run query user "Dr_Gears"');
  console.log('  npm run query user "博士"');
  console.log('');
  console.log('说明:');
  console.log('  - 页面查询支持URL、ID或标题关键词');
  console.log('  - 用户查询支持精确用户名或显示名称关键词');
  console.log('  - 投票记录只显示前10条，不会显示完整数据');
  console.log('  - 修订记录只显示前5条，包含源代码版本信息');
  console.log('  - 源代码版本控制显示前20个版本');
  console.log('  - 支持实例版本控制和URL映射查询');
}

async function main() {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    showHelp();
    return;
  }

  if (args.length < 2) {
    console.error('❌ 参数不足，请使用 --help 查看用法');
    return;
  }

  try {
    if (queryType === 'page') {
      await queryPage(queryValue);
    } else if (queryType === 'user') {
      await queryUser(queryValue);
    } else {
      console.error('❌ 无效的查询类型，请使用 "page" 或 "user"');
      showHelp();
    }
  } catch (error) {
    console.error('❌ 发生错误:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// 运行主函数
main();