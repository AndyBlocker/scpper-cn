import fs from 'fs';
import path from 'path';

// 诊断投票关系问题
async function diagnoseVoteRelationship(targetUserName, suspiciousVoterName) {
  console.log(`🔍 诊断投票关系: ${suspiciousVoterName} -> ${targetUserName}`);
  console.log('='.repeat(70));
  
  // 加载数据
  const dataFile = './resume-sync-data/complete-data-2025-07-24T06-43-50-871Z.json';
  const completeData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  
  // 建立页面作者映射
  const pageAuthorsMap = new Map(); // pageUrl -> Set(authors)
  const pageInfoMap = new Map(); // pageUrl -> pageInfo
  
  // 从页面数据建立映射
  completeData.pages.forEach(page => {
    const authors = new Set();
    if (page.createdByUser) {
      authors.add(page.createdByUser);
    }
    pageAuthorsMap.set(page.url, authors);
    pageInfoMap.set(page.url, {
      title: page.title,
      createdBy: page.createdByUser,
      rating: page.rating,
      voteCount: page.voteCount
    });
  });
  
  // 从attributions添加合著者
  if (completeData.attributions) {
    completeData.attributions.forEach(attribution => {
      if (attribution.pageUrl && attribution.userName) {
        if (!pageAuthorsMap.has(attribution.pageUrl)) {
          pageAuthorsMap.set(attribution.pageUrl, new Set());
        }
        pageAuthorsMap.get(attribution.pageUrl).add(attribution.userName);
      }
    });
  }
  
  // 查找目标用户的所有页面
  const targetUserPages = [];
  pageAuthorsMap.forEach((authors, pageUrl) => {
    if (authors.has(targetUserName)) {
      const pageInfo = pageInfoMap.get(pageUrl);
      if (pageInfo) {
        targetUserPages.push({
          url: pageUrl,
          title: pageInfo.title,
          createdBy: pageInfo.createdBy,
          rating: pageInfo.rating,
          voteCount: pageInfo.voteCount,
          isCoAuthor: pageInfo.createdBy !== targetUserName
        });
      }
    }
  });
  
  console.log(`📄 ${targetUserName} 的页面 (${targetUserPages.length}个):`);
  targetUserPages.forEach((page, i) => {
    console.log(`   ${i+1}. ${page.title} ${page.isCoAuthor ? '(合著)' : ''}`);
    console.log(`      Rating: ${page.rating}, 投票数: ${page.voteCount}`);
    console.log(`      URL: ${page.url}`);
  });
  
  // 查找可疑投票者对这些页面的所有投票
  const suspiciousVotes = [];
  
  completeData.voteRecords.forEach(vote => {
    // 检查是否是可疑投票者的投票
    if (vote.userName === suspiciousVoterName) {
      // 检查投票的页面是否属于目标用户
      const authors = pageAuthorsMap.get(vote.pageUrl);
      if (authors && authors.has(targetUserName)) {
        suspiciousVotes.push({
          pageUrl: vote.pageUrl,
          pageTitle: vote.pageTitle,
          direction: vote.direction,
          timestamp: vote.timestamp,
          userWikidotId: vote.userWikidotId
        });
      }
    }
  });
  
  console.log(`\n🗳️  ${suspiciousVoterName} 对 ${targetUserName} 页面的所有投票 (${suspiciousVotes.length}票):`);
  
  // 按页面分组分析
  const votesByPage = new Map();
  suspiciousVotes.forEach(vote => {
    if (!votesByPage.has(vote.pageUrl)) {
      votesByPage.set(vote.pageUrl, []);
    }
    votesByPage.get(vote.pageUrl).push(vote);
  });
  
  let totalUpvotes = 0;
  let totalDownvotes = 0;
  let problemPages = 0;
  
  votesByPage.forEach((votes, pageUrl) => {
    const pageInfo = pageInfoMap.get(pageUrl);
    console.log(`\n   📄 ${pageInfo?.title || 'Unknown Page'}:`);
    console.log(`      URL: ${pageUrl}`);
    
    // 按时间排序投票
    votes.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    const upvotes = votes.filter(v => v.direction > 0);
    const downvotes = votes.filter(v => v.direction < 0);
    
    console.log(`      投票历史 (${votes.length}票):`);
    votes.forEach((vote, i) => {
      let direction;
      if (vote.direction > 0) {
        direction = '+1 (upvote)';
      } else if (vote.direction < 0) {
        direction = '-1 (downvote)';
      } else {
        direction = '0 (取消投票/中性)';
      }
      console.log(`        ${i+1}. ${vote.timestamp.split('T')[0]} ${direction}`);
    });
    
    totalUpvotes += upvotes.length;
    totalDownvotes += downvotes.length;
    
    // 检查是否有问题
    if (upvotes.length > 0 && downvotes.length > 0) {
      problemPages++;
      console.log(`      ⚠️  问题: 同一用户对同一页面既有upvote又有downvote!`);
      console.log(`      📊 统计: ${upvotes.length} upvotes, ${downvotes.length} downvotes`);
      
      // 分析可能的原因
      if (votes.length > 1) {
        console.log(`      🔍 可能原因: 用户改变了投票 (最新投票应该是有效的)`);
        const latestVote = votes[votes.length - 1];
        const latestDirection = latestVote.direction > 0 ? 'upvote' : 'downvote';
        console.log(`      ✅ 最新投票: ${latestDirection} (${latestVote.timestamp.split('T')[0]})`);
      }
    } else if (votes.length > 1) {
      console.log(`      ℹ️  注意: 同一用户对同一页面有${votes.length}次相同投票 (可能是数据重复)`);
    }
  });
  
  console.log(`\n📊 总体统计:`);
  console.log(`   总upvote次数: ${totalUpvotes}`);
  console.log(`   总downvote次数: ${totalDownvotes}`);
  console.log(`   问题页面数: ${problemPages} (既有up又有down的页面)`);
  
  if (problemPages > 0) {
    console.log(`\n💡 建议修正方案:`);
    console.log(`   1. 对每个页面只保留最新的投票记录`);
    console.log(`   2. 或者按时间顺序，后面的投票覆盖前面的投票`);
    console.log(`   3. 检查数据源是否包含投票历史变更`);
  }
  
  // 检查用户ID一致性
  const uniqueUserIds = new Set(suspiciousVotes.map(v => v.userWikidotId));
  if (uniqueUserIds.size > 1) {
    console.log(`\n⚠️  用户ID不一致警告:`);
    console.log(`   发现 ${uniqueUserIds.size} 个不同的wikidotId:`);
    uniqueUserIds.forEach(id => {
      const votesWithThisId = suspiciousVotes.filter(v => v.userWikidotId === id);
      console.log(`   - ID ${id}: ${votesWithThisId.length} 票`);
    });
    console.log(`   这可能说明用户名相同但实际是不同用户，或者存在数据问题`);
  }
}

// 运行诊断
const targetUser = process.argv[2] || 'AndyBlocker';
const suspiciousVoter = process.argv[3] || 'SkyNight_aic';

console.log(`参数: 目标用户="${targetUser}", 可疑投票者="${suspiciousVoter}"`);
console.log(`用法: node vote-relationship-diagnostic.js <目标用户> <投票者>`);
console.log('');

diagnoseVoteRelationship(targetUser, suspiciousVoter).catch(console.error);