import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

// 基于数据库的用户查询系统
// 支持页面历史版本和删除页面查询
class DatabaseUserQuery {
  constructor() {
    this.prisma = new PrismaClient();
  }

  async getUserProfile(userId) {
    console.log(`🔍 查询用户: ${userId}`);
    
    try {
      // 获取用户基本信息
      const user = await this.prisma.user.findUnique({
        where: { 
          ...(typeof userId === 'number' ? { wikidotId: userId } : { name: userId })
        },
        include: {
          attributions: {
            include: {
              page: {
                select: {
                  url: true,
                  title: true,
                  rating: true,
                  voteCount: true,
                  isDeleted: true,
                  deletedAt: true,
                  createdAt: true
                }
              }
            }
          }
        }
      });

      if (!user) {
        return { error: `用户 ${userId} 未找到` };
      }

      // 获取用户创建的页面（包括删除的）
      const createdPages = await this.prisma.page.findMany({
        where: { createdByUser: user.name },
        select: {
          url: true,
          title: true,
          rating: true,
          voteCount: true,
          createdAt: true,
          isDeleted: true,
          deletedAt: true,
          deletionReason: true
        },
        orderBy: { createdAt: 'desc' }
      });

      // 分离活跃和删除的页面
      const activePages = createdPages.filter(p => !p.isDeleted);
      const deletedPages = createdPages.filter(p => p.isDeleted);

      // 获取用户的投票统计
      const voteStats = await this.getUserVoteStatistics(user.name);

      // 获取用户的编辑统计
      const editStats = await this.getUserEditStatistics(user.name);

      // 计算当前有效评分（排除删除页面）
      const currentScore = activePages.reduce((sum, page) => sum + (page.rating || 0), 0);

      return {
        基本信息: {
          用户名: user.name,
          显示名: user.displayName,
          用户ID: user.wikidotId,
          排名: user.rank,
          最后同步: user.lastSyncedAt?.toISOString().split('T')[0]
        },
        评分统计: {
          当前总评分: currentScore,
          历史最高评分: user.totalRating, // 包含已删除页面的历史最高分
          平均页面评分: user.meanRating?.toFixed(1) || 'N/A',
          数据库排名: user.rank
        },
        页面统计: {
          活跃页面数: activePages.length,
          删除页面数: deletedPages.length,
          总页面数: createdPages.length,
          页面删除率: createdPages.length > 0 ? 
            `${(deletedPages.length / createdPages.length * 100).toFixed(1)}%` : '0%'
        },
        投票统计: voteStats,
        编辑统计: editStats,
        活跃页面: activePages.slice(0, 10).map(page => ({
          标题: page.title,
          评分: page.rating,
          投票数: page.voteCount,
          创建时间: page.createdAt?.toISOString().split('T')[0]
        })),
        删除页面: deletedPages.map(page => ({
          标题: page.title,
          删除前评分: page.rating,
          删除时间: page.deletedAt?.toISOString().split('T')[0],
          删除原因: page.deletionReason
        }))
      };

    } catch (error) {
      console.error('查询用户信息失败:', error);
      return { error: `查询失败: ${error.message}` };
    }
  }

  async getUserVoteStatistics(userName) {
    // 获取用户投票统计
    const voteStats = await this.prisma.$queryRaw`
      SELECT 
        COUNT(*) as total_votes,
        SUM(CASE WHEN direction > 0 THEN 1 ELSE 0 END) as upvotes,
        SUM(CASE WHEN direction < 0 THEN 1 ELSE 0 END) as downvotes
      FROM vote_records 
      WHERE user_name = ${userName}
    `;

    const stats = voteStats[0];
    
    return {
      总投票数: parseInt(stats.total_votes),
      upvote数: parseInt(stats.upvotes),
      downvote数: parseInt(stats.downvotes),
      正面比例: stats.total_votes > 0 ? 
        `${(stats.upvotes / stats.total_votes * 100).toFixed(1)}%` : '0%'
    };
  }

  async getUserEditStatistics(userName) {
    // 获取用户编辑统计
    const editStats = await this.prisma.$queryRaw`
      SELECT 
        COUNT(*) as total_edits,
        COUNT(DISTINCT page_url) as edited_pages,
        MAX(timestamp) as last_edit
      FROM revisions 
      WHERE user_name = ${userName}
    `;

    const stats = editStats[0];
    
    return {
      总编辑次数: parseInt(stats.total_edits),
      编辑页面数: parseInt(stats.edited_pages),
      最后编辑时间: stats.last_edit ? 
        new Date(stats.last_edit).toISOString().split('T')[0] : 'N/A'
    };
  }

  async getPageHistory(pageUrl) {
    console.log(`📚 查询页面历史: ${pageUrl}`);
    
    try {
      const page = await this.prisma.page.findUnique({
        where: { url: pageUrl },
        include: {
          pageHistories: {
            orderBy: { versionNumber: 'desc' }
          }
        }
      });

      if (!page) {
        return { error: `页面 ${pageUrl} 未找到` };
      }

      return {
        页面信息: {
          标题: page.title,
          URL: page.url,
          当前状态: page.isDeleted ? '已删除' : '活跃',
          创建者: page.createdByUser,
          当前评分: page.rating,
          删除时间: page.deletedAt?.toISOString().split('T')[0] || 'N/A'
        },
        版本历史: page.pageHistories.map(version => ({
          版本号: version.versionNumber,
          时间: version.capturedAt.toISOString().split('T')[0],
          变更类型: version.changeType,
          变更原因: version.changeReason,
          当时评分: version.rating,
          当时投票数: version.voteCount,
          revision数量: version.revisionCount || 0
        }))
      };

    } catch (error) {
      console.error('查询页面历史失败:', error);
      return { error: `查询失败: ${error.message}` };
    }
  }

  async getDeletedPages(limit = 20) {
    console.log(`🗑️  查询最近删除的页面 (前${limit}个)`);
    
    try {
      const deletedPages = await this.prisma.page.findMany({
        where: { isDeleted: true },
        orderBy: { deletedAt: 'desc' },
        take: limit,
        select: {
          url: true,
          title: true,
          rating: true,
          voteCount: true,
          createdByUser: true,
          createdAt: true,
          deletedAt: true,
          deletionReason: true
        }
      });

      return {
        删除统计: {
          查询数量: deletedPages.length,
          最新删除: deletedPages[0]?.deletedAt?.toISOString().split('T')[0] || 'N/A'
        },
        删除页面列表: deletedPages.map(page => ({
          标题: page.title,
          创建者: page.createdByUser,
          删除前评分: page.rating,
          删除前投票数: page.voteCount,
          存活时间: this.calculateDaysBetween(page.createdAt, page.deletedAt),
          删除时间: page.deletedAt?.toISOString().split('T')[0],
          删除原因: page.deletionReason
        }))
      };

    } catch (error) {
      console.error('查询删除页面失败:', error);
      return { error: `查询失败: ${error.message}` };
    }
  }

  async getUserRankings(includeDeleted = false, limit = 50) {
    console.log(`🏆 查询用户排行榜 (前${limit}名, ${includeDeleted ? '包含' : '排除'}删除页面)`);
    
    try {
      let users;
      
      if (includeDeleted) {
        // 包含删除页面的历史排名
        users = await this.prisma.user.findMany({
          orderBy: { totalRating: 'desc' },
          take: limit,
          select: {
            name: true,
            totalRating: true,
            pageCount: true,
            rank: true
          }
        });
      } else {
        // 仅基于当前活跃页面的排名
        users = await this.prisma.$queryRaw`
          SELECT 
            u.name,
            u.rank,
            COUNT(p.url) as active_page_count,
            COALESCE(SUM(p.rating), 0) as current_score
          FROM users u
          LEFT JOIN pages p ON p.created_by_user = u.name AND p.is_deleted = false
          GROUP BY u.name, u.rank
          ORDER BY current_score DESC
          LIMIT ${limit}
        `;
      }

      return {
        排行榜类型: includeDeleted ? '历史总评分' : '当前活跃页面评分',
        用户排名: users.map((user, index) => ({
          排名: index + 1,
          用户名: user.name,
          评分: includeDeleted ? user.totalRating : parseInt(user.current_score),
          页面数: includeDeleted ? user.pageCount : parseInt(user.active_page_count),
          数据库排名: user.rank
        }))
      };

    } catch (error) {
      console.error('查询排行榜失败:', error);
      return { error: `查询失败: ${error.message}` };
    }
  }

  calculateDaysBetween(date1, date2) {
    if (!date1 || !date2) return 'N/A';
    const diffTime = Math.abs(new Date(date2) - new Date(date1));
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return `${diffDays}天`;
  }

  async disconnect() {
    await this.prisma.$disconnect();
  }
}

// 命令行接口
async function runQuery() {
  const query = new DatabaseUserQuery();
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
🔍 SCP Foundation CN 数据库用户查询系统

使用方法:
  node database-user-query.js user <用户名或ID>     # 查询用户详细信息
  node database-user-query.js history <页面URL>    # 查询页面历史版本
  node database-user-query.js deleted [数量]       # 查询删除的页面
  node database-user-query.js rankings [类型]      # 查询用户排行榜

排行榜类型:
  current  - 仅基于当前活跃页面 (默认)
  all      - 包含删除页面的历史总分

示例:
  node database-user-query.js user "AndyBlocker"
  node database-user-query.js user 3405622
  node database-user-query.js history "http://scp-wiki-cn.wikidot.com/scp-cn-3301"
  node database-user-query.js deleted 10
  node database-user-query.js rankings current
    `);
    await query.disconnect();
    return;
  }

  const command = args[0];
  let result;

  try {
    switch (command) {
      case 'user':
        if (args[1]) {
          const userId = isNaN(args[1]) ? args[1] : parseInt(args[1]);
          result = await query.getUserProfile(userId);
        } else {
          result = { error: '请提供用户名或用户ID' };
        }
        break;

      case 'history':
        if (args[1]) {
          result = await query.getPageHistory(args[1]);
        } else {
          result = { error: '请提供页面URL' };
        }
        break;

      case 'deleted':
        const limit = parseInt(args[1]) || 20;
        result = await query.getDeletedPages(limit);
        break;

      case 'rankings':
        const type = args[1] || 'current';
        const includeDeleted = type === 'all';
        const rankLimit = parseInt(args[2]) || 50;
        result = await query.getUserRankings(includeDeleted, rankLimit);
        break;

      default:
        result = { error: `未知命令: ${command}` };
    }

    console.log('\\n' + JSON.stringify(result, null, 2));

  } catch (error) {
    console.error('执行查询失败:', error);
    result = { error: `执行失败: ${error.message}` };
  } finally {
    await query.disconnect();
  }
}

export { DatabaseUserQuery };

if (import.meta.url === \`file://\${process.argv[1]}\`) {
  runQuery();
}