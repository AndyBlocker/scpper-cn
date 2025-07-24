// SCP Foundation CN 时间序列可视化数据准备脚本
// 
// 这个脚本演示如何从原始数据中提取时间序列数据用于各种可视化
// 包括页面rating变化、用户活跃度时间线、社区成长趋势等

import fs from 'fs';
import path from 'path';

class TimeSeriesDataProcessor {
  constructor() {
    this.rawData = null;
  }

  async loadData() {
    // 加载原始数据（包含完整时间戳信息）
    const dataFile = './resume-sync-data/complete-data-2025-07-24T06-43-50-871Z.json';
    this.rawData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    
    console.log('📥 时间序列数据加载完成');
    console.log(`   页面: ${this.rawData.pages.length}`);
    console.log(`   投票记录: ${this.rawData.voteRecords.length}`);
    console.log(`   修订记录: ${this.rawData.revisions.length}`);
  }

  // 1. 页面rating时间线数据生成
  generatePageRatingTimeline(pageUrl) {
    console.log(`\n📈 生成页面rating时间线: ${pageUrl}`);
    
    // 获取页面的所有投票记录，按时间排序
    const pageVotes = this.rawData.voteRecords
      .filter(vote => vote.pageUrl === pageUrl)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    console.log(`   找到 ${pageVotes.length} 条投票记录`);
    
    // 计算累积rating变化
    const timelineData = [];
    let cumulativeRating = 0;
    const userCurrentVotes = new Map(); // userId -> currentVote
    
    pageVotes.forEach(vote => {
      const userId = vote.userWikidotId;
      const previousVote = userCurrentVotes.get(userId) || 0;
      
      // 更新累积rating: 减去旧投票，加上新投票
      cumulativeRating = cumulativeRating - previousVote + vote.direction;
      userCurrentVotes.set(userId, vote.direction);
      
      timelineData.push({
        timestamp: vote.timestamp,
        date: vote.timestamp.split('T')[0],
        rating: cumulativeRating,
        voter: vote.userName,
        direction: vote.direction,
        changeType: vote.direction > 0 ? 'upvote' : vote.direction < 0 ? 'downvote' : 'cancel'
      });
    });
    
    console.log(`   时间线数据点: ${timelineData.length}`);
    console.log(`   最终rating: ${cumulativeRating}`);
    
    // 可视化数据结构示例
    console.log('\n📊 可视化数据结构示例:');
    console.log('```javascript');
    console.log('const chartData = {');
    console.log('  type: "line",');
    console.log('  data: {');
    console.log('    labels: timelineData.map(d => d.date),');
    console.log('    datasets: [{');
    console.log('      label: "Page Rating",');
    console.log('      data: timelineData.map(d => d.rating),');
    console.log('      borderColor: "rgb(75, 192, 192)",');
    console.log('      tension: 0.1');
    console.log('    }]');
    console.log('  }');
    console.log('};');
    console.log('```');
    
    return timelineData;
  }

  // 2. 社区成长趋势数据生成
  generateCommunityGrowthData() {
    console.log('\n📊 生成社区成长趋势数据');
    
    // 按月统计页面创建数
    const monthlyStats = new Map();
    
    this.rawData.pages.forEach(page => {
      if (!page.createdAt) return;
      
      const date = new Date(page.createdAt);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
      
      if (!monthlyStats.has(monthKey)) {
        monthlyStats.set(monthKey, {
          month: monthKey,
          pagesCreated: 0,
          totalPages: 0,
          activeAuthors: new Set()
        });
      }
      
      const stats = monthlyStats.get(monthKey);
      stats.pagesCreated++;
      if (page.createdByUser) {
        stats.activeAuthors.add(page.createdByUser);
      }
    });
    
    // 计算累积统计
    let cumulativePages = 0;
    const growthData = Array.from(monthlyStats.values())
      .sort((a, b) => a.month.localeCompare(b.month))
      .map(stats => {
        cumulativePages += stats.pagesCreated;
        return {
          month: stats.month,
          newPages: stats.pagesCreated,
          totalPages: cumulativePages,
          activeAuthors: stats.activeAuthors.size
        };
      });
    
    console.log(`   时间跨度: ${growthData[0]?.month} 到 ${growthData[growthData.length-1]?.month}`);
    console.log(`   数据点: ${growthData.length} 个月`);
    
    return growthData;
  }

  // 3. 用户活跃度热图数据生成
  generateUserActivityHeatmap(userName, activityType = 'votes') {
    console.log(`\n🔥 生成用户活跃度热图: ${userName} (${activityType})`);
    
    let activities = [];
    
    if (activityType === 'votes') {
      activities = this.rawData.voteRecords
        .filter(vote => vote.userName === userName)
        .map(vote => vote.timestamp);
    } else if (activityType === 'revisions') {
      activities = this.rawData.revisions
        .filter(rev => rev.userName === userName)
        .map(rev => rev.timestamp);
    }
    
    console.log(`   找到 ${activities.length} 条${activityType}活动记录`);
    
    // 按小时和星期几统计
    const heatmapData = [];
    const activityMatrix = Array(7).fill().map(() => Array(24).fill(0));
    
    activities.forEach(timestamp => {
      const date = new Date(timestamp);
      const dayOfWeek = date.getDay(); // 0=Sunday, 6=Saturday
      const hour = date.getHours();
      
      activityMatrix[dayOfWeek][hour]++;
    });
    
    // 转换为热图数据格式
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    
    for (let day = 0; day < 7; day++) {
      for (let hour = 0; hour < 24; hour++) {
        heatmapData.push({
          day: dayNames[day],
          hour: hour,
          value: activityMatrix[day][hour]
        });
      }
    }
    
    console.log('\n📊 热图可视化数据结构示例:');
    console.log('```javascript');
    console.log('const heatmapConfig = {');
    console.log('  type: "heatmap",');
    console.log('  data: heatmapData,');
    console.log('  options: {');
    console.log('    x: "hour",');
    console.log('    y: "day", ');
    console.log('    value: "value",');
    console.log('    colorScale: ["#ebedf0", "#c6e48b", "#7bc96f", "#239a3b", "#196127"]');
    console.log('  }');
    console.log('};');
    console.log('```');
    
    return heatmapData;
  }

  // 4. 投票网络图数据生成
  generateVotingNetworkData(minVotes = 5) {
    console.log(`\n🕸️  生成投票网络图数据 (最小${minVotes}票)`);
    
    // 构建用户间的投票关系
    const userStats = new Map();
    const votingRelations = new Map();
    
    // 加载用户数据库以获取用户信息
    const userDbPath = './user-analysis/user-database.json';
    let userDatabase = {};
    
    if (fs.existsSync(userDbPath)) {
      userDatabase = JSON.parse(fs.readFileSync(userDbPath, 'utf8'));
    }
    
    // 分析投票关系（简化版本，仅作演示）
    this.rawData.voteRecords.forEach(vote => {
      const voterId = vote.userWikidotId;
      const voterName = vote.userName;
      
      if (!userStats.has(voterId)) {
        const userInfo = Object.values(userDatabase).find(u => u.wikidotId === voterId);
        userStats.set(voterId, {
          id: voterId,
          name: voterName,
          score: userInfo?.score || 0,
          isActive: userInfo?.isActive || false,
          totalVotes: 0
        });
      }
      
      userStats.get(voterId).totalVotes++;
    });
    
    // 生成网络图节点
    const nodes = Array.from(userStats.values())
      .filter(user => user.totalVotes >= minVotes)
      .map(user => ({
        id: user.id,
        label: user.name,
        size: Math.log(user.score + 10) * 3, // 对数缩放
        color: user.isActive ? '#ff6b6b' : '#4ecdc4',
        group: user.isActive ? 'active' : 'inactive'
      }));
    
    console.log(`   网络节点: ${nodes.length} 个用户`);
    console.log('\n📊 网络图可视化数据结构示例:');
    console.log('```javascript');
    console.log('const networkData = {');
    console.log('  nodes: nodes,');
    console.log('  edges: edges, // 需要基于投票关系计算');
    console.log('  options: {');
    console.log('    layout: { improvedLayout: true },');
    console.log('    physics: { enabled: true },');
    console.log('    nodes: { shape: "dot" },');
    console.log('    edges: { smooth: true }');
    console.log('  }');
    console.log('};');
    console.log('```');
    
    return { nodes, userStats };
  }

  // 5. 生成所有可视化数据的汇总
  async generateAllVisualizationData() {
    console.log('🎨 生成所有可视化数据');
    console.log('='.repeat(50));
    
    await this.loadData();
    
    // 1. 选择一个热门页面生成rating时间线
    const popularPage = this.rawData.pages
      .sort((a, b) => (b.voteCount || 0) - (a.voteCount || 0))[0];
    
    console.log(`\n🌟 选择热门页面: ${popularPage.title}`);
    const ratingTimeline = this.generatePageRatingTimeline(popularPage.url);
    
    // 2. 社区成长数据
    const growthData = this.generateCommunityGrowthData();
    
    // 3. 选择一个活跃用户生成热图
    const activeUser = 'MScarlet'; // 从排行榜获取
    const activityHeatmap = this.generateUserActivityHeatmap(activeUser, 'votes');
    
    // 4. 投票网络数据
    const networkData = this.generateVotingNetworkData(10);
    
    // 保存可视化数据
    const visualizationData = {
      metadata: {
        generatedAt: new Date().toISOString(),
        dataSource: 'SCPPER-CN Complete Dataset',
        version: '1.0.0'
      },
      pageRatingTimeline: {
        pageUrl: popularPage.url,
        pageTitle: popularPage.title,
        data: ratingTimeline.slice(-50) // 保留最近50个数据点
      },
      communityGrowth: growthData,
      userActivityHeatmap: {
        userName: activeUser,
        activityType: 'votes',
        data: activityHeatmap
      },
      votingNetwork: {
        nodes: networkData.nodes.slice(0, 100), // 保留前100个节点
        minVotes: 10
      }
    };
    
    // 确保目录存在
    const vizDir = './visualization-data';
    if (!fs.existsSync(vizDir)) {
      fs.mkdirSync(vizDir, { recursive: true });
    }
    
    // 保存数据
    const vizDataPath = path.join(vizDir, `visualization-data-${new Date().toISOString().split('T')[0]}.json`);
    fs.writeFileSync(vizDataPath, JSON.stringify(visualizationData, null, 2));
    
    console.log(`\n💾 可视化数据已保存: ${vizDataPath}`);
    console.log('\n📋 数据摘要:');
    console.log(`   Rating时间线: ${ratingTimeline.length} 个数据点`);
    console.log(`   成长趋势: ${growthData.length} 个月`);
    console.log(`   活跃度热图: ${activityHeatmap.length} 个时间段`);
    console.log(`   网络节点: ${networkData.nodes.length} 个用户`);
    
    return visualizationData;
  }
}

// 使用示例
if (import.meta.url === `file://${process.argv[1]}`) {
  const processor = new TimeSeriesDataProcessor();
  processor.generateAllVisualizationData().catch(console.error);
}