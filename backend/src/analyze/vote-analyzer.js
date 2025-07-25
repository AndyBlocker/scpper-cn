import fs from 'fs';
import path from 'path';

// SCPPER-CN 投票数据分析器 - 专门处理fuzzyVoteRecords数据
class VoteAnalyzer {
  constructor(dataFilePath) {
    this.dataFilePath = dataFilePath;
    this.data = null;
    this.analysisResults = {};
    
    // 分析缓存
    this.userVoteMap = new Map(); // userWikidotId -> 投票记录
    this.authorVoteMap = new Map(); // authorWikidotId -> 被投票记录
    this.pageVoteMap = new Map(); // pageUrl -> 投票记录
    this.userAuthorMap = new Map(); // userWikidotId -> 作者信息
  }

  async loadData() {
    console.log('📥 加载数据...');
    
    if (!fs.existsSync(this.dataFilePath)) {
      throw new Error(`数据文件不存在: ${this.dataFilePath}`);
    }
    
    const rawData = fs.readFileSync(this.dataFilePath, 'utf8');
    this.data = JSON.parse(rawData);
    
    console.log(`✅ 数据加载完成:`);
    console.log(`   页面数: ${this.data.pages?.length || 0}`);
    console.log(`   投票记录: ${this.data.voteRecords?.length || 0}`);
    console.log(`   用户数: ${this.data.users?.length || 0}`);
    console.log(`   贡献记录: ${this.data.attributions?.length || 0}`);
    
    // 构建索引以提高查询性能
    await this.buildIndexes();
  }

  async buildIndexes() {
    console.log('🔧 构建数据索引...');
    
    // 构建用户->作者映射
    this.data.pages?.forEach(page => {
      if (page.createdByWikidotId && page.createdByUser) {
        this.userAuthorMap.set(page.createdByWikidotId, {
          name: page.createdByUser,
          wikidotId: page.createdByWikidotId
        });
      }
    });

    // 构建投票记录索引
    this.data.voteRecords?.forEach(vote => {
      // 按投票者分组 - "我给谁投票"
      if (!this.userVoteMap.has(vote.voterWikidotId)) {
        this.userVoteMap.set(vote.voterWikidotId, {
          voterName: vote.voterName,
          votes: []
        });
      }
      this.userVoteMap.get(vote.voterWikidotId).votes.push(vote);

      // 按被投票作者分组 - "谁给我投票"
      if (vote.pageAuthorId) {
        if (!this.authorVoteMap.has(vote.pageAuthorId)) {
          this.authorVoteMap.set(vote.pageAuthorId, {
            authorName: vote.pageAuthor,
            receivedVotes: []
          });
        }
        this.authorVoteMap.get(vote.pageAuthorId).receivedVotes.push(vote);
      }

      // 按页面分组
      if (!this.pageVoteMap.has(vote.pageUrl)) {
        this.pageVoteMap.set(vote.pageUrl, {
          pageTitle: vote.pageTitle,
          pageAuthor: vote.pageAuthor,
          votes: []
        });
      }
      this.pageVoteMap.get(vote.pageUrl).votes.push(vote);
    });

    console.log(`✅ 索引构建完成:`);
    console.log(`   投票用户索引: ${this.userVoteMap.size}`);
    console.log(`   被投票作者索引: ${this.authorVoteMap.size}`);
    console.log(`   页面投票索引: ${this.pageVoteMap.size}`);
  }

  // 核心分析功能 1: "谁给我投票"
  analyzeWhoVotedMe(authorIdentifier) {
    console.log(`🔍 分析"谁给我投票": ${authorIdentifier}`);
    
    // 支持按名字或ID查找
    let authorId = null;
    if (typeof authorIdentifier === 'string' && isNaN(authorIdentifier)) {
      // 按名字查找ID
      for (const [id, info] of this.userAuthorMap) {
        if (info.name === authorIdentifier) {
          authorId = id;
          break;
        }
      }
    } else {
      authorId = authorIdentifier.toString();
    }

    if (!authorId || !this.authorVoteMap.has(authorId)) {
      console.log(`❌ 未找到作者的投票数据: ${authorIdentifier}`);
      return null;
    }

    const authorData = this.authorVoteMap.get(authorId);
    const votes = authorData.receivedVotes;

    // 统计分析
    const analysis = {
      authorName: authorData.authorName,
      authorId: authorId,
      totalVotes: votes.length,
      upVotes: votes.filter(v => v.direction > 0).length,
      downVotes: votes.filter(v => v.direction < 0).length,
      neutralVotes: votes.filter(v => v.direction === 0).length,
      
      // 按投票者分组
      voterStats: {},
      
      // 按页面分组
      pageStats: {},
      
      // 时间分析
      timeStats: {
        earliest: null,
        latest: null,
        byMonth: {}
      },
      
      // 详细投票列表
      voteDetails: votes.map(vote => ({
        voter: vote.voterName,
        voterId: vote.voterWikidotId,
        direction: vote.direction,
        page: vote.pageTitle,
        pageUrl: vote.pageUrl,
        timestamp: vote.timestamp
      }))
    };

    // 投票者统计
    votes.forEach(vote => {
      const voterId = vote.voterWikidotId;
      if (!analysis.voterStats[voterId]) {
        analysis.voterStats[voterId] = {
          name: vote.voterName,
          total: 0,
          up: 0,
          down: 0,
          neutral: 0,
          pages: []
        };
      }
      
      analysis.voterStats[voterId].total++;
      if (vote.direction > 0) analysis.voterStats[voterId].up++;
      else if (vote.direction < 0) analysis.voterStats[voterId].down++;
      else analysis.voterStats[voterId].neutral++;
      
      analysis.voterStats[voterId].pages.push({
        title: vote.pageTitle,
        direction: vote.direction,
        timestamp: vote.timestamp
      });
    });

    // 页面统计
    votes.forEach(vote => {
      if (!analysis.pageStats[vote.pageUrl]) {
        analysis.pageStats[vote.pageUrl] = {
          title: vote.pageTitle,
          total: 0,
          up: 0,
          down: 0,
          voters: []
        };
      }
      
      analysis.pageStats[vote.pageUrl].total++;
      if (vote.direction > 0) analysis.pageStats[vote.pageUrl].up++;
      else if (vote.direction < 0) analysis.pageStats[vote.pageUrl].down++;
      
      analysis.pageStats[vote.pageUrl].voters.push({
        name: vote.voterName,
        direction: vote.direction
      });
    });

    // 时间统计
    votes.forEach(vote => {
      const timestamp = new Date(vote.timestamp);
      if (!analysis.timeStats.earliest || timestamp < new Date(analysis.timeStats.earliest)) {
        analysis.timeStats.earliest = vote.timestamp;
      }
      if (!analysis.timeStats.latest || timestamp > new Date(analysis.timeStats.latest)) {
        analysis.timeStats.latest = vote.timestamp;
      }
      
      const monthKey = timestamp.toISOString().slice(0, 7); // YYYY-MM
      analysis.timeStats.byMonth[monthKey] = (analysis.timeStats.byMonth[monthKey] || 0) + 1;
    });

    return analysis;
  }

  // 核心分析功能 2: "我给谁投票"
  analyzeIVotedWhom(voterIdentifier) {
    console.log(`🔍 分析"我给谁投票": ${voterIdentifier}`);
    
    // 支持按名字或ID查找
    let voterId = null;
    if (typeof voterIdentifier === 'string' && isNaN(voterIdentifier)) {
      // 按名字查找ID
      for (const [id, data] of this.userVoteMap) {
        if (data.voterName === voterIdentifier) {
          voterId = id;
          break;
        }
      }
    } else {
      voterId = voterIdentifier.toString();
    }

    if (!voterId || !this.userVoteMap.has(voterId)) {
      console.log(`❌ 未找到用户的投票数据: ${voterIdentifier}`);
      return null;
    }

    const voterData = this.userVoteMap.get(voterId);
    const votes = voterData.votes;

    const analysis = {
      voterName: voterData.voterName,
      voterId: voterId,
      totalVotes: votes.length,
      upVotes: votes.filter(v => v.direction > 0).length,
      downVotes: votes.filter(v => v.direction < 0).length,
      neutralVotes: votes.filter(v => v.direction === 0).length,
      
      // 按作者分组
      authorStats: {},
      
      // 按页面分组  
      pageStats: {},
      
      // 投票偏好分析
      preferences: {
        averageRating: 0,
        upVoteRatio: 0,
        mostVotedAuthor: null,
        favoriteCategory: null
      },
      
      // 详细投票列表
      voteDetails: votes.map(vote => ({
        author: vote.pageAuthor,
        authorId: vote.pageAuthorId,
        direction: vote.direction,
        page: vote.pageTitle,
        pageUrl: vote.pageUrl,
        timestamp: vote.timestamp
      }))
    };

    // 作者统计
    votes.forEach(vote => {
      if (vote.pageAuthorId) {
        if (!analysis.authorStats[vote.pageAuthorId]) {
          analysis.authorStats[vote.pageAuthorId] = {
            name: vote.pageAuthor,
            total: 0,
            up: 0,
            down: 0,
            pages: []
          };
        }
        
        analysis.authorStats[vote.pageAuthorId].total++;
        if (vote.direction > 0) analysis.authorStats[vote.pageAuthorId].up++;
        else if (vote.direction < 0) analysis.authorStats[vote.pageAuthorId].down++;
        
        analysis.authorStats[vote.pageAuthorId].pages.push({
          title: vote.pageTitle,
          direction: vote.direction,
          timestamp: vote.timestamp
        });
      }
    });

    // 计算偏好指标
    analysis.preferences.upVoteRatio = analysis.upVotes / analysis.totalVotes;
    analysis.preferences.averageRating = votes.reduce((sum, v) => sum + v.direction, 0) / votes.length;
    
    // 找出最常投票的作者
    let maxVotes = 0;
    Object.entries(analysis.authorStats).forEach(([authorId, stats]) => {
      if (stats.total > maxVotes) {
        maxVotes = stats.total;
        analysis.preferences.mostVotedAuthor = {
          name: stats.name,
          id: authorId,
          votes: stats.total
        };
      }
    });

    return analysis;
  }

  // 核心分析功能 3: 双向投票关系分析
  analyzeMutualVoting() {
    console.log('🔍 分析双向投票关系...');
    
    const mutualRelations = [];
    const processed = new Set();

    // 遍历所有用户的投票记录
    for (const [voterId, voterData] of this.userVoteMap) {
      // 检查这个投票者是否也是作者
      if (!this.userAuthorMap.has(voterId)) continue;
      
      const voterAsAuthor = this.userAuthorMap.get(voterId);
      
      // 找出给这个用户(作为作者)投票的人
      const receivedVotes = this.authorVoteMap.get(voterId)?.receivedVotes || [];
      
      // 找出这个用户投票给的作者们
      const givenVotes = voterData.votes;
      
      givenVotes.forEach(givenVote => {
        if (!givenVote.pageAuthorId) return;
        
        // 检查被投票的作者是否也给当前用户投过票
        const reciprocalVote = receivedVotes.find(received => 
          received.voterWikidotId === givenVote.pageAuthorId
        );
        
        if (reciprocalVote) {
          const relationKey = [voterId, givenVote.pageAuthorId].sort().join('-');
          if (processed.has(relationKey)) return;
          processed.add(relationKey);
          
          mutualRelations.push({
            userA: {
              id: voterId,
              name: voterAsAuthor.name
            },
            userB: {
              id: givenVote.pageAuthorId,
              name: givenVote.pageAuthor
            },
            aVotedB: {
              direction: givenVote.direction,
              page: givenVote.pageTitle,
              timestamp: givenVote.timestamp
            },
            bVotedA: {
              direction: reciprocalVote.direction,
              page: reciprocalVote.pageTitle,
              timestamp: reciprocalVote.timestamp
            },
            relationshipType: this.classifyRelationship(givenVote.direction, reciprocalVote.direction)
          });
        }
      });
    }

    console.log(`✅ 发现 ${mutualRelations.length} 对双向投票关系`);

    return {
      totalMutualRelations: mutualRelations.length,
      mutualSupport: mutualRelations.filter(r => r.relationshipType === 'mutual_support').length,
      mutualAntagonism: mutualRelations.filter(r => r.relationshipType === 'mutual_antagonism').length,
      asymmetric: mutualRelations.filter(r => r.relationshipType === 'asymmetric').length,
      relations: mutualRelations
    };
  }

  classifyRelationship(directionA, directionB) {
    if (directionA > 0 && directionB > 0) return 'mutual_support';
    if (directionA < 0 && directionB < 0) return 'mutual_antagonism';
    if ((directionA > 0 && directionB < 0) || (directionA < 0 && directionB > 0)) return 'asymmetric';
    return 'mixed';
  }

  // 生成综合分析报告
  async generateComprehensiveReport(outputDir = './analysis-results') {
    console.log('📊 生成综合分析报告...');
    
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    // 1. 投票网络总体统计
    const networkStats = this.analyzeVotingNetwork();
    
    // 2. 最活跃的投票者和被投票者
    const topVoters = this.getTopVoters(20);
    const topAuthors = this.getTopAuthors(20);
    
    // 3. 双向关系分析
    const mutualVoting = this.analyzeMutualVoting();
    
    // 4. 投票模式分析
    const patterns = this.analyzeVotingPatterns();

    const report = {
      metadata: {
        generatedAt: new Date().toISOString(),
        dataSource: this.dataFilePath,
        totalPages: this.data.pages?.length || 0,
        totalVotes: this.data.voteRecords?.length || 0,
        totalUsers: this.data.users?.length || 0
      },
      networkStats,
      topVoters,
      topAuthors,
      mutualVoting,
      patterns
    };

    // 保存详细报告
    const reportFile = path.join(outputDir, `comprehensive-vote-analysis-${timestamp}.json`);
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));

    // 生成markdown总结
    const summaryFile = path.join(outputDir, `vote-analysis-summary-${timestamp}.md`);
    const markdownSummary = this.generateMarkdownSummary(report);
    fs.writeFileSync(summaryFile, markdownSummary);

    console.log(`✅ 分析报告已生成:`);
    console.log(`   详细报告: ${reportFile}`);
    console.log(`   总结报告: ${summaryFile}`);

    return report;
  }

  analyzeVotingNetwork() {
    const stats = {
      totalVoters: this.userVoteMap.size,
      totalAuthors: this.authorVoteMap.size,
      totalVoteRelations: this.data.voteRecords?.length || 0,
      averageVotesPerVoter: 0,
      averageVotesPerAuthor: 0,
      upVoteRatio: 0,
      downVoteRatio: 0
    };

    if (stats.totalVoters > 0) {
      stats.averageVotesPerVoter = stats.totalVoteRelations / stats.totalVoters;
    }
    
    if (stats.totalAuthors > 0) {
      stats.averageVotesPerAuthor = stats.totalVoteRelations / stats.totalAuthors;
    }

    const upVotes = this.data.voteRecords?.filter(v => v.direction > 0).length || 0;
    const downVotes = this.data.voteRecords?.filter(v => v.direction < 0).length || 0;
    
    stats.upVoteRatio = upVotes / stats.totalVoteRelations;
    stats.downVoteRatio = downVotes / stats.totalVoteRelations;

    return stats;
  }

  getTopVoters(limit = 20) {
    return Array.from(this.userVoteMap.entries())
      .map(([id, data]) => ({
        id,
        name: data.voterName,
        totalVotes: data.votes.length,
        upVotes: data.votes.filter(v => v.direction > 0).length,
        downVotes: data.votes.filter(v => v.direction < 0).length,
        upVoteRatio: data.votes.filter(v => v.direction > 0).length / data.votes.length
      }))
      .sort((a, b) => b.totalVotes - a.totalVotes)
      .slice(0, limit);
  }

  getTopAuthors(limit = 20) {
    return Array.from(this.authorVoteMap.entries())
      .map(([id, data]) => ({
        id,
        name: data.authorName,
        totalVotesReceived: data.receivedVotes.length,
        upVotesReceived: data.receivedVotes.filter(v => v.direction > 0).length,
        downVotesReceived: data.receivedVotes.filter(v => v.direction < 0).length,
        netRating: data.receivedVotes.reduce((sum, v) => sum + v.direction, 0)
      }))
      .sort((a, b) => b.totalVotesReceived - a.totalVotesReceived)
      .slice(0, limit);
  }

  analyzeVotingPatterns() {
    // 分析投票时间模式、投票分布等
    const patterns = {
      timeDistribution: {},
      categoryPreferences: {},
      votingConsistency: {}
    };

    // 时间分布分析
    this.data.voteRecords?.forEach(vote => {
      const hour = new Date(vote.timestamp).getHours();
      patterns.timeDistribution[hour] = (patterns.timeDistribution[hour] || 0) + 1;
    });

    return patterns;
  }

  generateMarkdownSummary(report) {
    return `# 投票网络分析报告

## 数据概况
- **总页面数**: ${report.metadata.totalPages.toLocaleString()}
- **总投票数**: ${report.metadata.totalVotes.toLocaleString()}  
- **投票用户数**: ${report.networkStats.totalVoters}
- **被投票作者数**: ${report.networkStats.totalAuthors}
- **双向关系数**: ${report.mutualVoting.totalMutualRelations}

## 网络统计
- **平均投票/用户**: ${report.networkStats.averageVotesPerVoter.toFixed(1)}
- **平均被投票/作者**: ${report.networkStats.averageVotesPerAuthor.toFixed(1)}
- **好评率**: ${(report.networkStats.upVoteRatio * 100).toFixed(1)}%
- **差评率**: ${(report.networkStats.downVoteRatio * 100).toFixed(1)}%

## 最活跃投票者 (前10)
${report.topVoters.slice(0, 10).map((voter, i) => 
  `${i+1}. **${voter.name}**: ${voter.totalVotes}票 (${(voter.upVoteRatio*100).toFixed(1)}%好评)`
).join('\n')}

## 最受关注作者 (前10)  
${report.topAuthors.slice(0, 10).map((author, i) => 
  `${i+1}. **${author.name}**: ${author.totalVotesReceived}票 (净评分: ${author.netRating})`
).join('\n')}

## 双向投票关系
- **相互支持**: ${report.mutualVoting.mutualSupport}对
- **相互对立**: ${report.mutualVoting.mutualAntagonism}对  
- **不对称关系**: ${report.mutualVoting.asymmetric}对

---
*生成时间: ${report.metadata.generatedAt}*
`;
  }

  // 导出功能函数，供外部脚本调用
  async exportAnalysisFunctions() {
    return {
      whoVotedMe: (identifier) => this.analyzeWhoVotedMe(identifier),
      iVotedWhom: (identifier) => this.analyzeIVotedWhom(identifier),
      mutualVoting: () => this.analyzeMutualVoting(),
      topVoters: (limit) => this.getTopVoters(limit),
      topAuthors: (limit) => this.getTopAuthors(limit),
      networkStats: () => this.analyzeVotingNetwork()
    };
  }
}

// 命令行使用示例
async function runAnalysis() {
  if (process.argv.length < 3) {
    console.log('使用方法: node apiv2-vote-analyzer.js <data-file-path> [analysis-type] [identifier]');
    console.log('');
    console.log('分析类型:');
    console.log('  who-voted-me <author-name-or-id>  - 分析谁给指定作者投票');
    console.log('  i-voted-whom <voter-name-or-id>   - 分析指定用户给谁投票');
    console.log('  mutual-voting                     - 分析双向投票关系');
    console.log('  comprehensive                     - 生成综合分析报告');
    return;
  }

  const dataFile = process.argv[2];
  const analysisType = process.argv[3] || 'comprehensive';
  const identifier = process.argv[4];

  try {
    const analyzer = new VoteAnalyzer(dataFile);
    await analyzer.loadData();

    switch (analysisType) {
      case 'who-voted-me':
        if (!identifier) {
          console.log('❌ 请提供作者名字或ID');
          return;
        }
        const whoVotedResult = analyzer.analyzeWhoVotedMe(identifier);
        if (whoVotedResult) {
          console.log('\n📊 "谁给我投票"分析结果:');
          console.log(`作者: ${whoVotedResult.authorName}`);
          console.log(`总投票: ${whoVotedResult.totalVotes} (+${whoVotedResult.upVotes}/-${whoVotedResult.downVotes})`);
          console.log(`主要投票者:`);
          Object.values(whoVotedResult.voterStats)
            .sort((a, b) => b.total - a.total)
            .slice(0, 10)
            .forEach((voter, i) => {
              console.log(`  ${i+1}. ${voter.name}: ${voter.total}票 (+${voter.up}/-${voter.down})`);
            });
        }
        break;

      case 'i-voted-whom':
        if (!identifier) {
          console.log('❌ 请提供用户名字或ID');
          return;
        }
        const iVotedResult = analyzer.analyzeIVotedWhom(identifier);
        if (iVotedResult) {
          console.log('\n📊 "我给谁投票"分析结果:');
          console.log(`投票者: ${iVotedResult.voterName}`);
          console.log(`总投票: ${iVotedResult.totalVotes} (+${iVotedResult.upVotes}/-${iVotedResult.downVotes})`);
          console.log(`主要投票对象:`);
          Object.values(iVotedResult.authorStats)
            .sort((a, b) => b.total - a.total)
            .slice(0, 10)
            .forEach((author, i) => {
              console.log(`  ${i+1}. ${author.name}: ${author.total}票 (+${author.up}/-${author.down})`);
            });
        }
        break;

      case 'mutual-voting':
        const mutualResult = analyzer.analyzeMutualVoting();
        console.log('\n📊 双向投票关系分析:');
        console.log(`总关系数: ${mutualResult.totalMutualRelations}`);
        console.log(`相互支持: ${mutualResult.mutualSupport}`);
        console.log(`相互对立: ${mutualResult.mutualAntagonism}`);
        console.log(`不对称关系: ${mutualResult.asymmetric}`);
        break;

      case 'comprehensive':
      default:
        await analyzer.generateComprehensiveReport();
        break;
    }

  } catch (error) {
    console.error('❌ 分析过程发生错误:', error.message);
  }
}

export { VoteAnalyzer };

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  runAnalysis().catch(console.error);
}