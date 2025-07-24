import fs from 'fs';
import path from 'path';

// SCP Foundation CN 用户查询系统
class UserQuery {
  constructor() {
    this.userDatabase = null;
    this.rankings = null;
    this.loadDatabase();
  }

  loadDatabase() {
    try {
      const userDbPath = './user-analysis/user-database.json';
      const rankingsPath = this.findLatestRankings();
      
      if (fs.existsSync(userDbPath)) {
        this.userDatabase = JSON.parse(fs.readFileSync(userDbPath, 'utf8'));
        console.log(`✅ 用户数据库已加载: ${Object.keys(this.userDatabase).length} 用户`);
      } else {
        console.log('❌ 用户数据库未找到，请先运行 user-analytics.js');
        return;
      }

      if (rankingsPath && fs.existsSync(rankingsPath)) {
        this.rankings = JSON.parse(fs.readFileSync(rankingsPath, 'utf8'));
        console.log(`✅ 排行榜数据已加载: ${rankingsPath}`);
      }
    } catch (error) {
      console.error(`❌ 加载数据库失败: ${error.message}`);
    }
  }

  findLatestRankings() {
    const analysisDir = './user-analysis';
    if (!fs.existsSync(analysisDir)) return null;
    
    const files = fs.readdirSync(analysisDir);
    const rankingsFiles = files
      .filter(f => f.startsWith('rankings-') && f.endsWith('.json'))
      .sort()
      .reverse();
    
    return rankingsFiles.length > 0 ? path.join(analysisDir, rankingsFiles[0]) : null;
  }

  // 根据用户ID查询用户信息
  getUserById(wikidotId) {
    if (!this.userDatabase) {
      return { error: '用户数据库未加载' };
    }

    const user = this.userDatabase[wikidotId];
    if (!user) {
      return { error: `用户 ID ${wikidotId} 未找到` };
    }

    return this.formatUserProfile(user);
  }

  // 根据用户名查询用户信息
  getUserByName(userName) {
    if (!this.userDatabase) {
      return { error: '用户数据库未加载' };
    }

    const users = Object.values(this.userDatabase);
    const user = users.find(u => u.name.toLowerCase() === userName.toLowerCase());
    
    if (!user) {
      // 尝试模糊匹配
      const fuzzyMatches = users.filter(u => 
        u.name.toLowerCase().includes(userName.toLowerCase())
      ).slice(0, 5);
      
      if (fuzzyMatches.length > 0) {
        return {
          error: `用户 "${userName}" 未找到`,
          suggestions: fuzzyMatches.map(u => ({ id: u.wikidotId, name: u.name }))
        };
      }
      
      return { error: `用户 "${userName}" 未找到` };
    }

    return this.formatUserProfile(user);
  }

  // 格式化用户档案
  formatUserProfile(user) {
    const profile = {
      基本信息: {
        用户ID: user.wikidotId,
        用户名: user.name,
        显示名: user.displayName,
        数据源: Array.from(user.sources || new Set()).join(', '),
        是否活跃: user.isActive ? '✅ 是' : '❌ 否',
        活跃度评分: user.activityScore
      },
      评分与排名: {
        总评分: user.score,
        全站排名: user.rank,
        排名百分位: this.calculatePercentile(user.rank)
      },
      创作统计: {
        创作页面数: user.pagesCreated,
        收到总评分: user.score, // 使用页面rating总和
        收到总投票数: user.totalVotesReceived,
        平均页面评分: user.pagesCreated > 0 ? 
          (user.score / user.pagesCreated).toFixed(1) : 'N/A'
      },
      投票统计: {
        总投票数: user.totalVotesCast,
        投出upvote数: user.upvotesCast,
        投出downvote数: user.downvotesCast,
        投票正面比例: user.totalVotesCast > 0 ? 
          `${(user.upvotesCast / user.totalVotesCast * 100).toFixed(1)}%` : 'N/A'
      },
      编辑统计: {
        修订次数: user.revisionsCount,
        最后活跃时间: user.lastActiveTime || 'N/A'
      },
      社交关系: {
        最多给我upvote的用户: user.mostUpvotedBy.slice(0, 5).map(r => 
          `${r.userName} (${r.count}次)`
        ),
        最多给我downvote的用户: user.mostDownvotedBy.slice(0, 5).map(r => 
          `${r.userName} (${r.count}次)`
        ),
        我最多upvote的用户: user.mostUpvotedTo.slice(0, 5).map(r => 
          `${r.userName} (${r.count}次)`
        ),
        我最多downvote的用户: user.mostDownvotedTo.slice(0, 5).map(r => 
          `${r.userName} (${r.count}次)`
        )
      }
    };

    return profile;
  }

  calculatePercentile(rank) {
    if (!this.userDatabase) return 'N/A';
    
    const totalUsers = Object.keys(this.userDatabase).length;
    const percentile = ((totalUsers - rank + 1) / totalUsers * 100).toFixed(1);
    return `前 ${percentile}%`;
  }

  // 搜索用户
  searchUsers(query, limit = 10) {
    if (!this.userDatabase) {
      return { error: '用户数据库未加载' };
    }

    const users = Object.values(this.userDatabase);
    const results = users
      .filter(user => 
        user.name.toLowerCase().includes(query.toLowerCase()) ||
        user.displayName.toLowerCase().includes(query.toLowerCase())
      )
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(user => ({
        用户ID: user.wikidotId,
        用户名: user.name,
        评分: user.score,
        排名: user.rank,
        创作页面数: user.pagesCreated,
        是否活跃: user.isActive
      }));

    return {
      查询: query,
      结果数: results.length,
      用户列表: results
    };
  }

  // 获取排行榜
  getRankings(category = '按评分排名', limit = 20) {
    if (!this.rankings) {
      return { error: '排行榜数据未加载' };
    }

    const validCategories = ['按评分排名', '顶级创作者', '顶级投票者'];
    if (!validCategories.includes(category)) {
      return { 
        error: `无效分类，请选择: ${validCategories.join(', ')}`,
        可用分类: validCategories
      };
    }

    const ranking = this.rankings.rankings[category];
    if (!ranking) {
      return { error: `分类 "${category}" 数据未找到` };
    }

    return {
      分类: category,
      数据时间: this.rankings.metadata.生成时间,
      排行榜: ranking.slice(0, limit)
    };
  }

  // 获取统计概览
  getStatistics() {
    if (!this.rankings) {
      return { error: '统计数据未加载' };
    }

    return {
      数据时间: this.rankings.metadata.生成时间,
      统计信息: this.rankings.statistics
    };
  }

  // 比较两个用户
  compareUsers(userId1, userId2) {
    const user1 = this.getUserById(userId1);
    const user2 = this.getUserById(userId2);

    if (user1.error || user2.error) {
      return { 
        error: `用户查询失败: ${user1.error || user2.error}` 
      };
    }

    const comparison = {
      用户对比: {
        用户1: `${user1.基本信息.用户名} (ID: ${user1.基本信息.用户ID})`,
        用户2: `${user2.基本信息.用户名} (ID: ${user2.基本信息.用户ID})`
      },
      评分对比: {
        用户1评分: user1.评分与排名.总评分,
        用户2评分: user2.评分与排名.总评分,
        评分差距: user1.评分与排名.总评分 - user2.评分与排名.总评分,
        排名差距: user2.评分与排名.全站排名 - user1.评分与排名.全站排名
      },
      创作对比: {
        用户1页面数: user1.创作统计.创作页面数,
        用户2页面数: user2.创作统计.创作页面数,
        用户1平均评分: user1.创作统计.平均页面评分,
        用户2平均评分: user2.创作统计.平均页面评分
      },
      投票对比: {
        用户1投票数: user1.投票统计.总投票数,
        用户2投票数: user2.投票统计.总投票数,
        用户1正面比例: user1.投票统计.投票正面比例,
        用户2正面比例: user2.投票统计.投票正面比例
      },
      活跃度对比: {
        用户1活跃度: user1.基本信息.活跃度评分,
        用户2活跃度: user2.基本信息.活跃度评分,
        用户1是否活跃: user1.基本信息.是否活跃,
        用户2是否活跃: user2.基本信息.是否活跃
      }
    };

    return comparison;
  }
}

// 命令行接口
function runQuery() {
  const query = new UserQuery();
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
🔍 SCP Foundation CN 用户查询系统

使用方法:
  node user-query.js id <用户ID>           # 根据ID查询用户
  node user-query.js name <用户名>         # 根据名称查询用户  
  node user-query.js search <关键词>       # 搜索用户
  node user-query.js rankings [分类]       # 查看排行榜
  node user-query.js stats                 # 查看统计信息
  node user-query.js compare <ID1> <ID2>   # 比较两个用户

排行榜分类: 按评分排名, 顶级创作者, 顶级投票者

示例:
  node user-query.js id 123456
  node user-query.js name "用户名"  
  node user-query.js search "关键词"
  node user-query.js rankings 按评分排名
  node user-query.js compare 123456 789012
    `);
    return;
  }

  const command = args[0];
  let result;

  switch (command) {
    case 'id':
      if (args[1]) {
        result = query.getUserById(parseInt(args[1]));
      } else {
        result = { error: '请提供用户ID' };
      }
      break;

    case 'name':
      if (args[1]) {
        result = query.getUserByName(args[1]);
      } else {
        result = { error: '请提供用户名' };
      }
      break;

    case 'search':
      if (args[1]) {
        result = query.searchUsers(args[1], parseInt(args[2]) || 10);
      } else {
        result = { error: '请提供搜索关键词' };
      }
      break;

    case 'rankings':
      result = query.getRankings(args[1] || '按评分排名', parseInt(args[2]) || 20);
      break;

    case 'stats':
      result = query.getStatistics();
      break;

    case 'compare':
      if (args[1] && args[2]) {
        result = query.compareUsers(parseInt(args[1]), parseInt(args[2]));
      } else {
        result = { error: '请提供两个用户ID进行比较' };
      }
      break;

    default:
      result = { error: `未知命令: ${command}` };
  }

  console.log('\n' + JSON.stringify(result, null, 2));
}

export { UserQuery };

if (import.meta.url === `file://${process.argv[1]}`) {
  runQuery();
}