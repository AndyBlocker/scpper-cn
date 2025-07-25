import { ProductionSync } from './src/sync/production-sync.js';
import fs from 'fs';
import path from 'path';

async function testCheckpointRecovery() {
  console.log('🧪 测试Checkpoint恢复功能...');
  
  const sync = new ProductionSync({ voteOnly: true });
  
  // 1. 检查是否有现有的checkpoint文件
  const checkpointDir = './production-checkpoints';
  if (!fs.existsSync(checkpointDir)) {
    console.log('❌ 没有找到checkpoint目录');
    return;
  }
  
  const files = fs.readdirSync(checkpointDir);
  const voteCheckpoints = files
    .filter(f => f.startsWith('vote-progress-checkpoint-') && f.endsWith('.json'))
    .sort()
    .reverse();
  
  if (voteCheckpoints.length === 0) {
    console.log('❌ 没有找到投票进度checkpoint文件');
    return;
  }
  
  console.log(`📋 找到 ${voteCheckpoints.length} 个checkpoint文件:`);
  voteCheckpoints.forEach((file, index) => {
    const stats = fs.statSync(path.join(checkpointDir, file));
    const size = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`   ${index + 1}. ${file} (${size} MB)`);
  });
  
  // 2. 测试加载最新的checkpoint
  console.log('\n🔄 测试加载最新checkpoint...');
  const latestFile = voteCheckpoints[0];
  const checkpointPath = path.join(checkpointDir, latestFile);
  
  try {
    const checkpointData = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    
    console.log('📊 Checkpoint内容分析:');
    console.log(`   时间戳: ${checkpointData.timestamp}`);
    console.log(`   已完成页面: ${checkpointData.completedPages?.length || 0}`);
    console.log(`   部分完成页面: ${Object.keys(checkpointData.partialPages || {}).length}`);
    console.log(`   期望总投票: ${(checkpointData.totalVotesExpected || 0).toLocaleString()}`);
    console.log(`   已收集投票: ${(checkpointData.totalVotesCollected || 0).toLocaleString()}`);
    
    // 检查是否包含实际数据
    if (checkpointData.collectedData) {
      console.log('\n✅ 发现已收集的数据:');
      console.log(`   页面数据: ${(checkpointData.collectedData.pages?.length || 0).toLocaleString()}`);
      console.log(`   投票记录: ${(checkpointData.collectedData.voteRecords?.length || 0).toLocaleString()}`);
      console.log(`   用户数据: ${(checkpointData.collectedData.users?.length || 0).toLocaleString()}`);
      console.log(`   归属记录: ${(checkpointData.collectedData.attributions?.length || 0).toLocaleString()}`);
      console.log(`   修订记录: ${(checkpointData.collectedData.revisions?.length || 0).toLocaleString()}`);
      console.log(`   备用标题: ${(checkpointData.collectedData.alternateTitles?.length || 0).toLocaleString()}`);
      
      // 验证数据完整性
      if (checkpointData.collectedData.voteRecords?.length > 0) {
        const voteRecord = checkpointData.collectedData.voteRecords[0];
        console.log('\n📝 投票记录样本:');
        console.log(`   页面: ${voteRecord.pageTitle}`);
        console.log(`   投票者: ${voteRecord.voterName} (${voteRecord.voterWikidotId})`);
        console.log(`   方向: ${voteRecord.direction}`);
        console.log(`   时间: ${voteRecord.timestamp}`);
      }
    } else {
      console.log('\n❌ Checkpoint不包含已收集的数据 - 这是旧版本的checkpoint');
    }
    
    // 3. 测试通过ProductionSync加载
    console.log('\n🔄 测试通过ProductionSync类加载checkpoint...');
    await sync.loadVoteProgressCheckpoint();
    
    console.log('\n📊 ProductionSync状态:');
    console.log(`   已完成页面: ${sync.voteProgress.completedPages.size}`);
    console.log(`   部分完成页面: ${sync.voteProgress.partialPages.size}`);
    console.log(`   期望总投票: ${sync.voteProgress.totalVotesExpected.toLocaleString()}`);
    console.log(`   数据结构中的投票: ${sync.data.voteRecords.length.toLocaleString()}`);
    console.log(`   数据结构中的页面: ${sync.data.pages.length.toLocaleString()}`);
    console.log(`   数据结构中的用户: ${sync.data.users.length.toLocaleString()}`);
    
    if (sync.data.voteRecords.length > 0) {
      console.log('\n✅ Checkpoint恢复成功！投票数据已恢复到内存中');
    } else {
      console.log('\n⚠️  Checkpoint恢复后没有投票数据 - 可能是旧格式的checkpoint');
    }
    
  } catch (error) {
    console.error(`❌ 测试失败: ${error.message}`);
  }
}

testCheckpointRecovery().catch(console.error);