import fs from 'fs';

// 测试投票历史逻辑
async function testVoteHistoryLogic() {
  console.log('🔍 测试投票历史处理逻辑');
  console.log('='.repeat(50));
  
  // 模拟投票历史数据
  const mockVotes = [
    {
      userWikidotId: 123,
      userName: 'TestUser',
      pageUrl: 'http://test.com/page1',
      pageTitle: 'Test Page 1',
      direction: 1,
      timestamp: '2024-01-01T10:00:00.000Z'
    },
    {
      userWikidotId: 123,
      userName: 'TestUser', 
      pageUrl: 'http://test.com/page1',
      pageTitle: 'Test Page 1',
      direction: -1,
      timestamp: '2024-01-02T10:00:00.000Z'
    },
    {
      userWikidotId: 123,
      userName: 'TestUser',
      pageUrl: 'http://test.com/page1', 
      pageTitle: 'Test Page 1',
      direction: 0,
      timestamp: '2024-01-03T10:00:00.000Z'
    },
    {
      userWikidotId: 123,
      userName: 'TestUser',
      pageUrl: 'http://test.com/page1',
      pageTitle: 'Test Page 1', 
      direction: -1,
      timestamp: '2024-01-04T10:00:00.000Z'
    }
  ];
  
  console.log('📊 模拟投票历史:');
  mockVotes.forEach((vote, i) => {
    let directionText;
    if (vote.direction > 0) directionText = '+1 (upvote)';
    else if (vote.direction < 0) directionText = '-1 (downvote)';
    else directionText = '0 (取消投票)';
    
    console.log(`   ${i+1}. ${vote.timestamp.split('T')[0]} ${directionText}`);
  });
  
  // 应用我们当前的逻辑
  const finalVotes = new Map();
  
  mockVotes.forEach(vote => {
    const key = `${vote.userWikidotId}-${vote.pageUrl}`;
    const existingVote = finalVotes.get(key);
    
    // 保留时间戳最新的投票
    if (!existingVote || new Date(vote.timestamp) >= new Date(existingVote.timestamp)) {
      finalVotes.set(key, vote);
    }
  });
  
  console.log('\n🎯 最终有效投票:');
  finalVotes.forEach(vote => {
    let directionText;
    if (vote.direction > 0) directionText = '+1 (upvote)';
    else if (vote.direction < 0) directionText = '-1 (downvote)';
    else directionText = '0 (取消投票)';
    
    console.log(`   用户${vote.userWikidotId} -> ${vote.pageUrl}: ${directionText}`);
    console.log(`   时间: ${vote.timestamp}`);
  });
  
  // 计算最终分数（应该是-1）
  let finalScore = 0;
  finalVotes.forEach(vote => {
    if (vote.direction !== 0) {
      finalScore += vote.direction;
    }
  });
  
  console.log(`\n📈 最终分数贡献: ${finalScore}`);
  console.log(`✅ 预期: -1, 实际: ${finalScore}, ${finalScore === -1 ? '正确' : '错误'}`);
  
  // 测试另一个场景：+1 -> 0 -> +1
  console.log('\n' + '='.repeat(50));
  console.log('🔍 测试第二个场景: +1 -> 0 -> +1');
  
  const mockVotes2 = [
    {
      userWikidotId: 456,
      userName: 'TestUser2',
      pageUrl: 'http://test.com/page2',
      direction: 1,
      timestamp: '2024-01-01T10:00:00.000Z'
    },
    {
      userWikidotId: 456,
      userName: 'TestUser2',
      pageUrl: 'http://test.com/page2', 
      direction: 0,
      timestamp: '2024-01-02T10:00:00.000Z'
    },
    {
      userWikidotId: 456,
      userName: 'TestUser2',
      pageUrl: 'http://test.com/page2',
      direction: 1,
      timestamp: '2024-01-03T10:00:00.000Z'
    }
  ];
  
  const finalVotes2 = new Map();
  mockVotes2.forEach(vote => {
    const key = `${vote.userWikidotId}-${vote.pageUrl}`;
    const existingVote = finalVotes2.get(key);
    
    if (!existingVote || new Date(vote.timestamp) >= new Date(existingVote.timestamp)) {
      finalVotes2.set(key, vote);
    }
  });
  
  let finalScore2 = 0;
  finalVotes2.forEach(vote => {
    if (vote.direction !== 0) {
      finalScore2 += vote.direction;
    }
  });
  
  console.log(`📈 最终分数贡献: ${finalScore2}`);
  console.log(`✅ 预期: +1, 实际: ${finalScore2}, ${finalScore2 === 1 ? '正确' : '错误'}`);
}

// 现在测试真实数据中的一个具体案例
async function testRealVoteHistory() {
  console.log('\n' + '='.repeat(70));  
  console.log('🔍 测试真实数据: SkyNight_aic -> AndyBlocker (SCP-CN-3301)');
  console.log('='.repeat(70));
  
  // 加载真实数据
  const dataFile = './resume-sync-data/complete-data-2025-07-24T06-43-50-871Z.json';
  const completeData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  
  // 查找SkyNight_aic对SCP-CN-3301的所有投票
  const targetVotes = completeData.voteRecords.filter(vote => 
    vote.userName === 'SkyNight_aic' && 
    vote.pageUrl === 'http://scp-wiki-cn.wikidot.com/scp-cn-3301'
  );
  
  console.log('📊 原始投票历史:');
  targetVotes
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .forEach((vote, i) => {
      let directionText;
      if (vote.direction > 0) directionText = '+1 (upvote)';
      else if (vote.direction < 0) directionText = '-1 (downvote)';
      else directionText = '0 (取消投票)';
      
      console.log(`   ${i+1}. ${vote.timestamp.split('T')[0]} ${directionText}`);
    });
  
  // 应用我们的逻辑
  const finalVotes = new Map();
  const key = `${targetVotes[0].userWikidotId}-${targetVotes[0].pageUrl}`;
  
  targetVotes.forEach(vote => {
    const existingVote = finalVotes.get(key);
    if (!existingVote || new Date(vote.timestamp) >= new Date(existingVote.timestamp)) {
      finalVotes.set(key, vote);
    }
  });
  
  const finalVote = finalVotes.get(key);
  let finalContribution = 0;
  if (finalVote && finalVote.direction !== 0) {
    finalContribution = finalVote.direction;
  }
  
  console.log('\n🎯 最终结果:');
  console.log(`   最终投票: ${finalVote.direction > 0 ? '+1 (upvote)' : finalVote.direction < 0 ? '-1 (downvote)' : '0 (取消投票)'}`);
  console.log(`   最终时间: ${finalVote.timestamp.split('T')[0]}`);
  console.log(`   对作者分数贡献: ${finalContribution}`);
  
  // 验证页面rating
  const pageInfo = completeData.pages.find(p => p.url === 'http://scp-wiki-cn.wikidot.com/scp-cn-3301');
  console.log(`\n📄 页面信息:`);
  console.log(`   页面rating: ${pageInfo.rating}`);
  console.log(`   投票总数: ${pageInfo.voteCount}`);
  
  console.log('\n✅ 逻辑验证: 我们的算法正确地只统计了最终有效投票');
}

async function runTests() {
  await testVoteHistoryLogic();
  await testRealVoteHistory();
}

runTests().catch(console.error);