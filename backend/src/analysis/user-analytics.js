import fs from 'fs';
import path from 'path';

// SCP Foundation CN 用户数据分析系统
// 
// 数据结构说明（用于后续可视化开发）:
// 
// 时间序列数据可视化准备:
// - pages: 包含createdAt时间戳，可用于页面创建时间线
// - voteRecords: 包含完整的投票历史和时间戳，支持rating变化可视化
// - revisions: 包含修订时间戳，可分析编辑活跃度时间线
// 
// 可视化建议:
// 1. 页面rating时间线: 基于voteRecords按时间累计计算每个页面的rating变化
// 2. 用户活跃度热图: 基于投票和修订的timestamp分析用户活跃时间模式
// 3. 社区成长曲线: 基于页面createdAt分析内容增长趋势
// 4. 投票网络图: 基于最终有效投票关系构建用户互动网络
//
class UserAnalytics {
  constructor() {
    this.users = new Map(); // userWikidotId -> UserProfile
    this.usersByName = new Map(); // userName -> UserProfile  
    this.pagesByAuthor = new Map(); // userWikidotId -> [pages]
    this.voteRelationships = new Map(); // voterWikidotId -> Map(authorWikidotId -> {upvotes, downvotes})
    this.stats = {
      totalUsers: 0,
      activeUsers: 0,
      totalPages: 0,
      totalVotes: 0,
      totalRevisions: 0
    };
  }

  async analyzeUserData() {
    console.log('🔍 SCP Foundation CN 用户数据分析系统');
    console.log('=' .repeat(80));
    console.log(`开始时间: ${new Date().toLocaleString()}\n`);

    // 1. 加载数据
    console.log('📥 加载数据文件...');
    const data = await this.loadLatestData();
    
    // 2. 提取所有用户
    console.log('👤 提取用户信息...');
    await this.extractAllUsers(data);
    
    // 3. 计算用户评分和排名
    console.log('📊 计算用户评分...');
    await this.calculateUserScores(data);
    
    // 4. 分析投票关系
    console.log('🗳️  分析投票关系...');
    await this.analyzeVoteRelationships(data);
    
    // 5. 定义活跃用户
    console.log('⚡ 识别活跃用户...');
    await this.identifyActiveUsers();
    
    // 6. 生成综合分析
    console.log('📈 生成分析报告...');
    const analysis = await this.generateAnalysis();
    
    // 7. 保存结果
    console.log('💾 保存分析结果...');
    await this.saveAnalysis(analysis);
    
    console.log('\n✅ 用户数据分析完成!');
    return analysis;
  }

  async loadLatestData() {
    // 查找最新的完整数据文件
    // 
    // 时间序列数据说明:
    // - pages[].createdAt: 页面创建时间 (ISO 8601格式)
    // - voteRecords[].timestamp: 投票时间 (ISO 8601格式，包含投票历史变更)
    // - revisions[].timestamp: 修订时间 (ISO 8601格式)
    // - attributions[].date: 贡献者归属时间 (可能为null)
    //
    const dataDirs = ['./final-sync-data', './resume-sync-data', './full-sync-data'];
    let dataFile = null;
    
    for (const dir of dataDirs) {
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir);
        
        // 查找complete-data文件
        const completeDataFiles = files.filter(f => f.startsWith('complete-data-')).sort().reverse();
        if (completeDataFiles.length > 0) {
          dataFile = path.join(dir, completeDataFiles[0]);
          console.log(`   📁 使用数据文件: ${dataFile}`);
          break;
        }
        
        // 查找分离的数据文件
        const latestPages = files.filter(f => f.startsWith('pages-data-')).sort().pop();
        const latestVotes = files.filter(f => f.startsWith('votes-data-')).sort().pop();
        const latestRevisions = files.filter(f => f.startsWith('revisions-data-')).sort().pop();
        
        if (latestPages && latestVotes && latestRevisions) {
          console.log(`   📄 页面数据: ${latestPages}`);
          console.log(`   🗳️  投票数据: ${latestVotes}`);
          console.log(`   📝 修订数据: ${latestRevisions}`);
          
          const data = {
            pages: JSON.parse(fs.readFileSync(path.join(dir, latestPages), 'utf8')),
            votes: JSON.parse(fs.readFileSync(path.join(dir, latestVotes), 'utf8')),
            revisions: JSON.parse(fs.readFileSync(path.join(dir, latestRevisions), 'utf8')),
            attributions: [] // 分离文件中可能没有attributions
          };
          
          console.log(`   加载完成: ${data.pages.length} 页面, ${data.votes.length} 投票, ${data.revisions.length} 修订, ${data.attributions.length} 合著信息\n`);
          return data;
        }
      }
    }
    
    if (dataFile) {
      // 加载完整数据文件
      const completeData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      const data = {
        pages: completeData.pages || [],
        votes: completeData.voteRecords || [],
        revisions: completeData.revisions || [],
        attributions: completeData.attributions || []
      };
      
      console.log(`   加载完成: ${data.pages.length} 页面, ${data.votes.length} 投票, ${data.revisions.length} 修订, ${data.attributions.length} 合著信息\n`);
      return data;
    }
    
    throw new Error('未找到数据文件，请先运行数据同步脚本');
  }

  async extractAllUsers(data) {
    const userSources = new Set();
    
    // 从投票记录提取用户
    data.votes.forEach(vote => {
      if (vote.userWikidotId && vote.userName) {
        this.addUser(vote.userWikidotId, vote.userName, 'voter');
        userSources.add('votes');
        
        // 更新最后活跃时间（投票也是活跃行为）
        const user = this.users.get(vote.userWikidotId);
        if (user && vote.timestamp) {
          const voteTime = new Date(vote.timestamp);
          if (!user.lastActiveTime || voteTime > new Date(user.lastActiveTime)) {
            user.lastActiveTime = vote.timestamp;
          }
        }
      }
    });
    
    // 从修订记录提取用户
    data.revisions.forEach(revision => {
      if (revision.userWikidotId && revision.userName) {
        this.addUser(revision.userWikidotId, revision.userName, 'editor');
        userSources.add('revisions');
        
        // 统计修订次数和最后活跃时间
        const user = this.users.get(revision.userWikidotId);
        if (user) {
          user.revisionsCount++;
          
          // 更新最后活跃时间
          const revisionTime = new Date(revision.timestamp);
          if (!user.lastActiveTime || revisionTime > new Date(user.lastActiveTime)) {
            user.lastActiveTime = revision.timestamp;
          }
        }
      }
    });
    
    // 从页面创建者提取用户
    data.pages.forEach(page => {
      if (page.createdByUser) {
        // 注意：页面数据中只有用户名，没有wikidotId
        // 尝试从其他源匹配wikidotId
        const wikidotId = this.findUserWikidotIdByName(page.createdByUser);
        if (wikidotId) {
          this.addUser(wikidotId, page.createdByUser, 'author');
          userSources.add('pages');
        } else {
          // 创建一个临时用户记录，稍后可能会合并
          this.addUserByNameOnly(page.createdByUser, 'author');
        }
      }
    });

    // 从attributions数据提取用户（合著者信息）
    if (data.attributions && data.attributions.length > 0) {
      data.attributions.forEach(attribution => {
        if (attribution.userName) {
          // 尝试从其他源匹配wikidotId
          const wikidotId = this.findUserWikidotIdByName(attribution.userName);
          if (wikidotId) {
            this.addUser(wikidotId, attribution.userName, 'coauthor');
            userSources.add('attributions');
          } else {
            this.addUserByNameOnly(attribution.userName, 'coauthor');
          }
        }
      });
    }
    
    this.stats.totalUsers = this.users.size;
    console.log(`   发现用户: ${this.stats.totalUsers} 个`);
    console.log(`   数据源: ${Array.from(userSources).join(', ')}\n`);
  }

  addUser(wikidotId, userName, source) {
    if (!this.users.has(wikidotId)) {
      this.users.set(wikidotId, {
        wikidotId: wikidotId,
        name: userName,
        displayName: userName,
        sources: new Set(),
        
        // 统计数据
        score: 0,
        rank: 0,
        
        // 创作数据
        pagesCreated: 0,
        totalRatingReceived: 0, // 作为作者收到的总评分
        totalVotesReceived: 0,  // 作为作者收到的总投票数
        
        // 投票数据
        totalVotesCast: 0,      // 总投票数
        upvotesCast: 0,         // 投出的upvote数
        downvotesCast: 0,       // 投出的downvote数
        
        // 编辑数据
        revisionsCount: 0,      // 修订次数
        lastActiveTime: null,   // 最后活跃时间
        
        // 关系数据
        mostUpvotedBy: [],      // 最多给我upvote的用户
        mostDownvotedBy: [],    // 最多给我downvote的用户
        mostUpvotedTo: [],      // 我最多upvote的用户
        mostDownvotedTo: [],    // 我最多downvote的用户
        
        // 活跃度标记
        isActive: false,
        activityScore: 0
      });
      this.usersByName.set(userName, this.users.get(wikidotId));
    }
    
    this.users.get(wikidotId).sources.add(source);
  }

  addUserByNameOnly(userName, source) {
    if (!this.usersByName.has(userName)) {
      // 使用负数作为临时wikidotId，避免与真实ID冲突
      const tempId = -(this.usersByName.size + 1);
      this.addUser(tempId, userName, source);
    } else {
      this.usersByName.get(userName).sources.add(source);
    }
  }

  findUserWikidotIdByName(userName) {
    const user = this.usersByName.get(userName);
    return user && user.wikidotId > 0 ? user.wikidotId : null;
  }

  async calculateUserScores(data) {
    // 构建页面作者映射 - 包括所有合著者
    const pageAuthorsMap = new Map(); // pageUrl -> Set(authorWikidotIds)
    const pageStatsMap = new Map(); // pageUrl -> {rating, voteCount}
    
    // 首先收集页面统计信息
    data.pages.forEach(page => {
      pageStatsMap.set(page.url, {
        rating: page.rating || 0,
        voteCount: page.voteCount || 0
      });
      
      // 初始化作者集合
      if (!pageAuthorsMap.has(page.url)) {
        pageAuthorsMap.set(page.url, new Set());
      }
      
      // 添加创建者
      if (page.createdByUser) {
        const wikidotId = this.findUserWikidotIdByName(page.createdByUser);
        if (wikidotId) {
          pageAuthorsMap.get(page.url).add(wikidotId);
        }
      }
    });

    // 从attributions数据中添加所有合著者
    if (data.attributions && data.attributions.length > 0) {
      console.log(`   处理合著者信息: ${data.attributions.length} 条记录`);
      
      data.attributions.forEach(attribution => {
        if (attribution.userName && attribution.pageUrl) {
          const wikidotId = this.findUserWikidotIdByName(attribution.userName);
          if (wikidotId) {
            if (!pageAuthorsMap.has(attribution.pageUrl)) {
              pageAuthorsMap.set(attribution.pageUrl, new Set());
            }
            pageAuthorsMap.get(attribution.pageUrl).add(wikidotId);
          }
        }
      });
    } else {
      console.log('   ⚠️  未找到attributions数据，仅使用createdByUser信息');
    }

    // 统计每个用户的创作数据
    const userPageCounts = new Map(); // wikidotId -> pageCount
    pageAuthorsMap.forEach((authors, pageUrl) => {
      const pageStats = pageStatsMap.get(pageUrl);
      if (pageStats) {
        authors.forEach(authorWikidotId => {
          if (this.users.has(authorWikidotId)) {
            const user = this.users.get(authorWikidotId);
            
            // 每个合著者都获得页面的完整评分和投票数
            user.pagesCreated++;
            user.totalRatingReceived += pageStats.rating;
            user.totalVotesReceived += pageStats.voteCount;
            
            if (!userPageCounts.has(authorWikidotId)) {
              userPageCounts.set(authorWikidotId, 0);
            }
            userPageCounts.set(authorWikidotId, userPageCounts.get(authorWikidotId) + 1);
          }
        });
      }
    });

    // 设置用户score为页面rating的总和（简化处理）
    pageAuthorsMap.forEach((authors, pageUrl) => {
      const pageStats = pageStatsMap.get(pageUrl);
      if (pageStats) {
        authors.forEach(authorWikidotId => {
          if (this.users.has(authorWikidotId)) {
            const user = this.users.get(authorWikidotId);
            // 使用页面rating作为score，每个合著者都获得完整rating
            user.score += pageStats.rating;
          }
        });
      }
    });

    // 排序用户并分配排名
    const sortedUsers = Array.from(this.users.values())
      .sort((a, b) => b.score - a.score);
    
    sortedUsers.forEach((user, index) => {
      user.rank = index + 1;
    });

    console.log(`   计算完成: 平均分 ${(sortedUsers.reduce((sum, u) => sum + u.score, 0) / sortedUsers.length).toFixed(1)}`);
    console.log(`   最高分: ${sortedUsers[0]?.score || 0} (${sortedUsers[0]?.name})`);
    console.log(`   最低分: ${sortedUsers[sortedUsers.length-1]?.score || 0}\n`);
  }

  async analyzeVoteRelationships(data) {
    // 分析投票关系 - 为可视化准备社交网络数据
    //
    // 数据结构 (用于网络图可视化):
    // - pageAuthorsMap: Map<pageUrl, Set<authorWikidotIds>> - 页面到作者的映射
    // - finalVotes: Map<userPageKey, latestVote> - 每个用户对每个页面的最终投票
    // - voteRelationships: Map<voterWikidotId, Map<authorWikidotId, {upvotes, downvotes}>>
    //
    // 可视化建议:
    // - 节点: 用户 (大小=总分数，颜色=活跃度)  
    // - 边: 投票关系 (粗细=投票次数，颜色=正面/负面)
    // - 布局: 力导向图或社区检测算法
    //
    const pageAuthorsMap = new Map(); // pageUrl -> Set(authorWikidotIds)
    
    // 构建页面作者映射（与calculateUserScores中的逻辑一致）
    data.pages.forEach(page => {
      if (!pageAuthorsMap.has(page.url)) {
        pageAuthorsMap.set(page.url, new Set());
      }
      
      // 添加创建者
      if (page.createdByUser) {
        const wikidotId = this.findUserWikidotIdByName(page.createdByUser);
        if (wikidotId) {
          pageAuthorsMap.get(page.url).add(wikidotId);
        }
      }
    });

    // 从attributions数据中添加所有合著者
    if (data.attributions && data.attributions.length > 0) {
      data.attributions.forEach(attribution => {
        if (attribution.userName && attribution.pageUrl) {
          const wikidotId = this.findUserWikidotIdByName(attribution.userName);
          if (wikidotId) {
            if (!pageAuthorsMap.has(attribution.pageUrl)) {
              pageAuthorsMap.set(attribution.pageUrl, new Set());
            }
            pageAuthorsMap.get(attribution.pageUrl).add(wikidotId);
          }
        }
      });
    }

    // 分析投票关系 - 只统计最终有效投票
    //
    // 时间序列处理逻辑 (重要：用于rating变化可视化):
    // 1. voteRecords包含完整的投票历史，包括投票变更
    // 2. direction值: +1=upvote, -1=downvote, 0=取消投票/中性
    // 3. 我们只保留每个用户对每个页面的最新投票(按timestamp排序)
    // 4. 这确保了社交关系的准确性，同时保留了历史数据用于时间线分析
    //
    // 首先建立每个用户对每个页面的最终投票记录
    const finalVotes = new Map(); // `${voterWikidotId}-${pageUrl}` -> latestVote
    
    data.votes.forEach(vote => {
      const key = `${vote.userWikidotId}-${vote.pageUrl}`;
      const existingVote = finalVotes.get(key);
      
      // 保留时间戳最新的投票，或者如果时间戳相同则覆盖
      if (!existingVote || new Date(vote.timestamp) >= new Date(existingVote.timestamp)) {
        finalVotes.set(key, vote);
      }
    });
    
    // 统计投票者的总投票数（基于最终有效投票）
    const voterStats = new Map(); // voterWikidotId -> {totalVotes, upvotes, downvotes}
    finalVotes.forEach(vote => {
      if (vote.direction !== 0) { // 只统计非中性投票
        const voterWikidotId = vote.userWikidotId;
        if (!voterStats.has(voterWikidotId)) {
          voterStats.set(voterWikidotId, { totalVotes: 0, upvotes: 0, downvotes: 0 });
        }
        
        const stats = voterStats.get(voterWikidotId);
        stats.totalVotes++;
        if (vote.direction > 0) {
          stats.upvotes++;
        } else {
          stats.downvotes++;
        }
      }
    });
    
    // 更新用户投票统计
    voterStats.forEach((stats, voterWikidotId) => {
      if (this.users.has(voterWikidotId)) {
        const voter = this.users.get(voterWikidotId);
        voter.totalVotesCast = stats.totalVotes;
        voter.upvotesCast = stats.upvotes;
        voter.downvotesCast = stats.downvotes;
      }
    });

    // 基于最终投票建立投票关系
    finalVotes.forEach(vote => {
      if (vote.direction === 0) return; // 跳过中性投票
      
      const voterWikidotId = vote.userWikidotId;
      const pageUrl = vote.pageUrl;
      const authors = pageAuthorsMap.get(pageUrl);
      
      if (voterWikidotId && authors && authors.size > 0) {
        // 对每个作者建立投票关系
        authors.forEach(authorWikidotId => {
          if (voterWikidotId !== authorWikidotId) { // 排除自己给自己投票
            // 构建投票关系图
            if (!this.voteRelationships.has(voterWikidotId)) {
              this.voteRelationships.set(voterWikidotId, new Map());
            }
            
            const voterRelations = this.voteRelationships.get(voterWikidotId);
            if (!voterRelations.has(authorWikidotId)) {
              voterRelations.set(authorWikidotId, { upvotes: 0, downvotes: 0 });
            }
            
            const relation = voterRelations.get(authorWikidotId);
            if (vote.direction > 0) {
              relation.upvotes++;
            } else {
              relation.downvotes++;
            }
          }
        });
      }
    });

    // 为每个用户计算top投票关系
    this.users.forEach((user, wikidotId) => {
      // 谁给我投票最多
      const receivedVotes = new Map(); // voterWikidotId -> {upvotes, downvotes}
      
      this.voteRelationships.forEach((relations, voterWikidotId) => {
        if (relations.has(wikidotId)) {
          receivedVotes.set(voterWikidotId, relations.get(wikidotId));
        }
      });

      // 最多给我upvote的用户
      user.mostUpvotedBy = Array.from(receivedVotes.entries())
        .sort((a, b) => b[1].upvotes - a[1].upvotes)
        .slice(0, 10)
        .map(([voterWikidotId, votes]) => ({
          userId: voterWikidotId,
          userName: this.users.get(voterWikidotId)?.name || 'Unknown',
          count: votes.upvotes
        }));

      // 最多给我downvote的用户
      user.mostDownvotedBy = Array.from(receivedVotes.entries())
        .sort((a, b) => b[1].downvotes - a[1].downvotes)
        .slice(0, 10)
        .map(([voterWikidotId, votes]) => ({
          userId: voterWikidotId,
          userName: this.users.get(voterWikidotId)?.name || 'Unknown',
          count: votes.downvotes
        }));

      // 我最多upvote的用户
      if (this.voteRelationships.has(wikidotId)) {
        const myRelations = this.voteRelationships.get(wikidotId);
        
        user.mostUpvotedTo = Array.from(myRelations.entries())
          .sort((a, b) => b[1].upvotes - a[1].upvotes)
          .slice(0, 10)
          .map(([authorWikidotId, votes]) => ({
            userId: authorWikidotId,
            userName: this.users.get(authorWikidotId)?.name || 'Unknown',
            count: votes.upvotes
          }));

        user.mostDownvotedTo = Array.from(myRelations.entries())
          .sort((a, b) => b[1].downvotes - a[1].downvotes)
          .slice(0, 10)
          .map(([authorWikidotId, votes]) => ({
            userId: authorWikidotId,
            userName: this.users.get(authorWikidotId)?.name || 'Unknown',
            count: votes.downvotes
          }));
      }
    });

    console.log(`   分析投票关系: ${this.voteRelationships.size} 个投票者\n`);
  }

  async identifyActiveUsers() {
    // 活跃用户定义标准：
    // 1. 至少创建了1个页面 OR 进行了10次以上投票 OR 进行了5次以上修订
    // 2. 综合活跃度评分 >= 10
    
    let activeCount = 0;
    
    this.users.forEach(user => {
      let activityScore = 0;
      
      // 创作活跃度 (权重最高)
      activityScore += user.pagesCreated * 10;
      activityScore += Math.min(user.totalRatingReceived, 100) * 0.5; // 收到的评分
      
      // 投票活跃度
      activityScore += Math.min(user.totalVotesCast, 50) * 0.2;
      
      // 编辑活跃度
      activityScore += user.revisionsCount * 2;
      
      // 影响力加成
      if (user.totalVotesReceived > 0) {
        activityScore += Math.log(user.totalVotesReceived + 1) * 2;
      }
      
      user.activityScore = Math.round(activityScore);
      
      // 活跃用户标准
      const isActive = (
        user.pagesCreated >= 1 || 
        user.totalVotesCast >= 10 || 
        user.revisionsCount >= 5
      ) && user.activityScore >= 10;
      
      user.isActive = isActive;
      if (isActive) activeCount++;
    });

    this.stats.activeUsers = activeCount;
    console.log(`   活跃用户: ${activeCount} / ${this.stats.totalUsers} (${(activeCount/this.stats.totalUsers*100).toFixed(1)}%)\n`);
  }

  async generateAnalysis() {
    // 生成综合分析报告
    //
    // 数据导出结构 (用于可视化):
    // - userProfiles: 完整用户档案，包含社交关系数据
    // - rankings: 各种排行榜，用于排名可视化  
    // - statistics: 全局统计信息，用于概览仪表板
    //
    // 时间序列数据建议:
    // 可以通过重新加载原始voteRecords并按时间分组来生成:
    // - 每日/每月的新页面创建数
    // - 每日/每月的投票活跃度
    // - 每个页面的rating历史曲线
    // - 用户活跃度时间热图
    //
    const users = Array.from(this.users.values());
    const activeUsers = users.filter(u => u.isActive);
    
    // 排行榜
    const topUsersByScore = users
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);
    
    const topCreators = users
      .filter(u => u.pagesCreated > 0)
      .sort((a, b) => b.pagesCreated - a.pagesCreated)
      .slice(0, 20);
    
    const topVoters = users
      .sort((a, b) => b.totalVotesCast - a.totalVotesCast)
      .slice(0, 20);

    // 统计信息
    const stats = {
      总用户数: this.stats.totalUsers,
      活跃用户数: this.stats.activeUsers,
      活跃用户比例: `${(this.stats.activeUsers/this.stats.totalUsers*100).toFixed(1)}%`,
      创作者数量: users.filter(u => u.pagesCreated > 0).length,
      平均用户评分: users.reduce((sum, u) => sum + u.score, 0) / users.length,
      最高评分: Math.max(...users.map(u => u.score)),
      最低评分: Math.min(...users.map(u => u.score)),
      总投票关系数: this.voteRelationships.size
    };

    return {
      metadata: {
        生成时间: new Date().toISOString(),
        数据源: 'SCPPER-CN Final Sync Data',
        版本: '1.0.0'
      },
      statistics: stats,
      rankings: {
        按评分排名: topUsersByScore.map(u => ({
          排名: u.rank,
          用户名: u.name,
          用户ID: u.wikidotId,
          评分: u.score,
          创作页面数: u.pagesCreated,
          总投票数: u.totalVotesCast,
          是否活跃: u.isActive
        })),
        顶级创作者: topCreators.map((u, i) => ({
          排名: i + 1,
          用户名: u.name,
          用户ID: u.wikidotId,
          创作页面数: u.pagesCreated,
          总评分: u.totalRatingReceived,
          平均评分: u.pagesCreated > 0 ? (u.totalRatingReceived / u.pagesCreated).toFixed(1) : 0
        })),
        顶级投票者: topVoters.map((u, i) => ({
          排名: i + 1,
          用户名: u.name,
          用户ID: u.wikidotId,
          总投票数: u.totalVotesCast,
          upvote数: u.upvotesCast,
          downvote数: u.downvotesCast,
          正面比例: u.totalVotesCast > 0 ? `${(u.upvotesCast/u.totalVotesCast*100).toFixed(1)}%` : '0%'
        }))
      },
      userProfiles: users.reduce((profiles, user) => {
        profiles[user.wikidotId] = user;
        return profiles;
      }, {})
    };
  }

  async saveAnalysis(analysis) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    // 确保分析目录存在
    const analysisDir = './user-analysis';
    if (!fs.existsSync(analysisDir)) {
      fs.mkdirSync(analysisDir, { recursive: true });
    }
    
    // 保存完整分析结果
    const fullReportPath = path.join(analysisDir, `user-analysis-${timestamp}.json`);
    fs.writeFileSync(fullReportPath, JSON.stringify(analysis, null, 2));
    
    // 保存简化的排行榜
    const rankingsPath = path.join(analysisDir, `rankings-${timestamp}.json`);
    fs.writeFileSync(rankingsPath, JSON.stringify({
      metadata: analysis.metadata,
      statistics: analysis.statistics,
      rankings: analysis.rankings
    }, null, 2));
    
    // 保存用户数据库（用于查询）
    const userDbPath = path.join(analysisDir, 'user-database.json');
    fs.writeFileSync(userDbPath, JSON.stringify(analysis.userProfiles, null, 2));
    
    console.log(`   完整报告: ${path.basename(fullReportPath)}`);
    console.log(`   排行榜: ${path.basename(rankingsPath)}`);
    console.log(`   用户数据库: user-database.json`);
  }
}

// 运行分析
async function runUserAnalysis() {
  const analyzer = new UserAnalytics();
  const analysis = await analyzer.analyzeUserData();
  
  // 显示简要统计
  console.log('\n📊 分析概览:');
  console.log(`   用户总数: ${analysis.statistics.总用户数}`);
  console.log(`   活跃用户: ${analysis.statistics.活跃用户数} (${analysis.statistics.活跃用户比例})`);
  console.log(`   创作者: ${analysis.statistics.创作者数量}`);
  console.log(`   平均评分: ${analysis.statistics.平均用户评分.toFixed(1)}`);
  
  console.log('\n🏆 评分排行榜 Top 10:');
  analysis.rankings.按评分排名.slice(0, 10).forEach(user => {
    console.log(`   ${user.排名}. ${user.用户名} - ${user.评分}分 (${user.创作页面数}页面)`);
  });
}

export { UserAnalytics };

if (import.meta.url === `file://${process.argv[1]}`) {
  runUserAnalysis().catch(console.error);
}