import fs from 'fs';
import path from 'path';

// 诊断用户的score和rating差异
async function diagnoseScoreVsRating(targetUserName) {
  console.log(`🔍 诊断用户 "${targetUserName}" 的score和rating差异`);
  console.log('='.repeat(60));
  
  // 加载数据
  const dataFile = './resume-sync-data/complete-data-2025-07-24T06-43-50-871Z.json';
  const completeData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  
  // 查找目标用户的所有页面
  const userPages = [];
  const pageAuthorsMap = new Map(); // pageUrl -> Set(authors)
  
  // 建立页面作者映射
  completeData.pages.forEach(page => {
    const authors = new Set();
    
    // 添加创建者
    if (page.createdByUser) {
      authors.add(page.createdByUser);
    }
    
    pageAuthorsMap.set(page.url, authors);
    
    // 如果是目标用户的页面，记录下来
    if (page.createdByUser === targetUserName) {
      userPages.push({
        url: page.url,
        title: page.title,
        rating: page.rating,
        voteCount: page.voteCount,
        createdBy: page.createdByUser
      });
    }
  });
  
  // 从attributions中添加合著者
  if (completeData.attributions) {
    completeData.attributions.forEach(attribution => {
      if (attribution.pageUrl && attribution.userName) {
        if (!pageAuthorsMap.has(attribution.pageUrl)) {
          pageAuthorsMap.set(attribution.pageUrl, new Set());
        }
        pageAuthorsMap.get(attribution.pageUrl).add(attribution.userName);
        
        // 如果是目标用户的合著页面
        if (attribution.userName === targetUserName) {
          const existingPage = userPages.find(p => p.url === attribution.pageUrl);
          if (!existingPage) {
            // 查找页面信息
            const pageInfo = completeData.pages.find(p => p.url === attribution.pageUrl);
            if (pageInfo) {
              userPages.push({
                url: pageInfo.url,
                title: pageInfo.title,
                rating: pageInfo.rating,
                voteCount: pageInfo.voteCount,
                createdBy: pageInfo.createdByUser,
                coAuthor: true
              });
            }
          }
        }
      }
    });
  }
  
  console.log(`📄 找到 ${userPages.length} 个页面:`);
  userPages.forEach((page, i) => {
    console.log(`   ${i+1}. ${page.title} - Rating: ${page.rating}, 投票数: ${page.voteCount} ${page.coAuthor ? '(合著)' : ''}`);
  });
  
  // 统计页面rating总和
  const totalRating = userPages.reduce((sum, page) => sum + (page.rating || 0), 0);
  console.log(`\n📊 页面rating总和: ${totalRating}`);
  
  // 统计实际投票
  let totalVoteScore = 0;
  let voteDetails = [];
  
  completeData.voteRecords.forEach(vote => {
    const authors = pageAuthorsMap.get(vote.pageUrl);
    if (authors && authors.has(targetUserName)) {
      totalVoteScore += vote.direction;
      voteDetails.push({
        pageUrl: vote.pageUrl,
        pageTitle: vote.pageTitle,
        direction: vote.direction,
        userName: vote.userName,
        timestamp: vote.timestamp
      });
    }
  });
  
  console.log(`🗳️  实际投票score总和: ${totalVoteScore}`);
  console.log(`🔢 投票记录总数: ${voteDetails.length}`);
  
  // 分析差异
  const difference = totalVoteScore - totalRating;
  console.log(`\n❓ 差异分析:`);
  console.log(`   Score (投票): ${totalVoteScore}`);
  console.log(`   Rating (页面): ${totalRating}`);
  console.log(`   差异: ${difference}`);
  
  if (difference !== 0) {
    console.log(`\n🔍 可能的原因:`);
    console.log(`   1. 投票时间与页面rating统计时间不一致`);
    console.log(`   2. 某些投票记录可能包含已删除页面的投票`);
    console.log(`   3. 页面rating可能经过特殊算法处理`);
    console.log(`   4. 数据同步时间点不完全一致`);
    
    // 按页面分析差异
    console.log(`\n📋 按页面详细分析:`);
    userPages.forEach(page => {
      const pageVotes = voteDetails.filter(v => v.pageUrl === page.url);
      const pageVoteScore = pageVotes.reduce((sum, v) => sum + v.direction, 0);
      const pageDifference = pageVoteScore - (page.rating || 0);
      
      console.log(`   ${page.title}:`);
      console.log(`     页面rating: ${page.rating || 0}`);
      console.log(`     投票score: ${pageVoteScore} (${pageVotes.length}票)`);
      console.log(`     差异: ${pageDifference}`);
      
      if (pageDifference !== 0) {
        console.log(`     ⚠️  这个页面存在${Math.abs(pageDifference)}分的差异`);
      }
    });
  } else {
    console.log(`✅ Score和Rating完全一致！`);
  }
  
  // 显示最近的投票活动
  console.log(`\n📅 最近的投票活动 (最新10条):`);
  voteDetails
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 10)
    .forEach(vote => {
      const direction = vote.direction > 0 ? '+1' : '-1';
      console.log(`   ${vote.timestamp.split('T')[0]} ${direction} ${vote.userName} -> ${vote.pageTitle}`);
    });
}

// 运行诊断
const targetUser = process.argv[2] || 'AndyBlocker';
diagnoseScoreVsRating(targetUser).catch(console.error);