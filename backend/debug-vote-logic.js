import { ProductionSync } from './src/sync/production-sync.js';

async function debugVoteLogic() {
  console.log('🔍 调试投票逻辑问题...');
  
  const sync = new ProductionSync({ voteOnly: true });
  const problematicUrl = 'http://scp-wiki-cn.wikidot.com/20230301';
  
  try {
    // 模拟页面数据结构
    const mockPage = {
      url: problematicUrl,
      voteCount: 24,
      title: '近不可及'
    };
    
    console.log(`📋 测试页面: ${mockPage.title} (${mockPage.voteCount} 票)`);
    
    // 1. 直接调用fetchPageVotesWithResume
    console.log('\\n🔧 调用 fetchPageVotesWithResume...');
    const voteResult = await sync.fetchPageVotesWithResume(mockPage.url, mockPage.voteCount);
    
    console.log('📊 fetchPageVotesWithResume 返回结果:');
    console.log(`   votes数组长度: ${voteResult.votes?.length || 0}`);
    console.log(`   isComplete: ${voteResult.isComplete}`);
    console.log(`   nextCursor: ${voteResult.nextCursor ? '有' : '无'}`);
    console.log(`   error: ${voteResult.error || '无'}`);
    console.log(`   skipped: ${voteResult.skipped || false}`);
    
    // 2. 测试我们的验证逻辑
    console.log('\\n🧪 测试验证逻辑...');
    const votesLength = voteResult.votes?.length || 0;
    const expectedCount = mockPage.voteCount;
    const isComplete = voteResult.isComplete;
    
    console.log(`验证条件:`);
    console.log(`   voteResult.isComplete: ${isComplete}`);
    console.log(`   voteResult.votes.length: ${votesLength}`);
    console.log(`   page.voteCount: ${expectedCount}`);
    console.log(`   votes.length === page.voteCount: ${votesLength === expectedCount}`);
    console.log(`   完整条件: ${isComplete && votesLength === expectedCount}`);
    
    if (isComplete && votesLength === expectedCount) {
      console.log('✅ 验证通过 - 数据完整');
    } else {
      console.log('❌ 验证失败 - 数据不完整');
      
      if (!isComplete) {
        console.log('   原因: isComplete为false');
      }
      if (votesLength !== expectedCount) {
        console.log(`   原因: 投票数量不匹配 (获得${votesLength}, 期望${expectedCount})`);
      }
    }
    
    // 3. 检查votes数组的内容
    if (voteResult.votes && voteResult.votes.length > 0) {
      console.log('\\n📝 votes数组内容样本:');
      voteResult.votes.slice(0, 3).forEach((vote, i) => {
        console.log(`   ${i+1}. 用户ID: ${vote.userWikidotId}, 方向: ${vote.direction}, 时间: ${vote.timestamp}`);
        console.log(`      用户名: ${vote.user?.displayName || '未知'}`);
      });
    }
    
    // 4. 检查是否有重复的投票记录
    if (voteResult.votes && voteResult.votes.length > 0) {
      const userIds = voteResult.votes.map(v => v.userWikidotId);
      const uniqueUserIds = new Set(userIds);
      console.log(`\\n🔍 投票记录分析:`);
      console.log(`   总投票记录: ${voteResult.votes.length}`);
      console.log(`   唯一用户数: ${uniqueUserIds.size}`);
      if (userIds.length !== uniqueUserIds.size) {
        console.log(`   ⚠️  发现重复投票记录: ${userIds.length - uniqueUserIds.size} 个`);
      }
    }
    
  } catch (error) {
    console.error(`❌ 调试失败: ${error.message}`);
    console.error(error.stack);
  }
}

debugVoteLogic().catch(console.error);