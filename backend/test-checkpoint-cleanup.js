import { ProductionSync } from './src/sync/production-sync.js';
import fs from 'fs';
import path from 'path';

async function testCheckpointCleanup() {
  console.log('🧪 测试Checkpoint清理功能...');
  
  const sync = new ProductionSync();
  
  // 1. 检查当前页面checkpoint文件
  console.log('\n📁 当前页面checkpoint文件:');
  const dataDir = './production-data';
  if (fs.existsSync(dataDir)) {
    const files = fs.readdirSync(dataDir);
    const pageCheckpoints = files
      .filter(f => f.startsWith('production-data-pages-checkpoint-') && f.endsWith('.json'))
      .map(f => {
        const match = f.match(/pages-checkpoint-(\d+)-/);
        const pageCount = match ? parseInt(match[1]) : 0;
        const stats = fs.statSync(path.join(dataDir, f));
        const size = (stats.size / 1024 / 1024).toFixed(2);
        return { filename: f, pageCount, size };
      })
      .sort((a, b) => a.pageCount - b.pageCount);
    
    if (pageCheckpoints.length > 0) {
      pageCheckpoints.forEach((file, index) => {
        console.log(`   ${index + 1}. ${file.filename} - ${file.pageCount}页 (${file.size} MB)`);
      });
      console.log(`   总计: ${pageCheckpoints.length} 个页面checkpoint文件`);
    } else {
      console.log('   没有找到页面checkpoint文件');
    }
  }
  
  // 2. 检查当前投票checkpoint文件
  console.log('\n📁 当前投票checkpoint文件:');
  const checkpointDir = './production-checkpoints';
  if (fs.existsSync(checkpointDir)) {
    const files = fs.readdirSync(checkpointDir);
    const voteCheckpoints = files
      .filter(f => f.startsWith('vote-progress-checkpoint-') && f.endsWith('.json'))
      .map(f => {
        const stats = fs.statSync(path.join(checkpointDir, f));
        const size = (stats.size / 1024 / 1024).toFixed(2);
        const mtime = stats.mtime.toISOString().replace('T', ' ').substring(0, 19);
        return { filename: f, size, mtime };
      })
      .sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    
    if (voteCheckpoints.length > 0) {
      voteCheckpoints.forEach((file, index) => {
        console.log(`   ${index + 1}. ${file.filename} - ${file.size} MB (${file.mtime})`);
      });
      console.log(`   总计: ${voteCheckpoints.length} 个投票checkpoint文件`);
    } else {
      console.log('   没有找到投票checkpoint文件');
    }
  }
  
  // 3. 测试页面checkpoint清理（如果有足够的文件）
  if (fs.existsSync(dataDir)) {
    const files = fs.readdirSync(dataDir);
    const pageCheckpoints = files.filter(f => f.startsWith('production-data-pages-checkpoint-') && f.endsWith('.json'));
    
    if (pageCheckpoints.length > 2) {
      console.log('\n🧹 测试页面checkpoint清理...');
      // 模拟保存一个新的checkpoint来触发清理
      const maxPages = Math.max(...pageCheckpoints.map(f => {
        const match = f.match(/pages-checkpoint-(\d+)-/);
        return match ? parseInt(match[1]) : 0;
      }));
      
      console.log(`   当前最大页面数: ${maxPages}`);
      console.log(`   模拟清理逻辑（不实际删除文件）...`);
      
      sync.cleanupOldPageCheckpoints(maxPages + 1000); // 模拟更大的页面数
    }
  }
  
  // 4. 测试投票checkpoint清理（如果有足够的文件）
  if (fs.existsSync(checkpointDir)) {
    const files = fs.readdirSync(checkpointDir);
    const voteCheckpoints = files.filter(f => f.startsWith('vote-progress-checkpoint-') && f.endsWith('.json'));
    
    if (voteCheckpoints.length > 3) {
      console.log('\n🧹 测试投票checkpoint清理...');
      console.log(`   当前有 ${voteCheckpoints.length} 个投票checkpoint文件`);
      console.log(`   应该保留最新的3个，删除其余 ${voteCheckpoints.length - 3} 个`);
      console.log(`   模拟清理逻辑（不实际删除文件）...`);
      
      sync.cleanupOldVoteCheckpoints();
    }
  }
  
  console.log('\n✅ Checkpoint清理测试完成');
}

testCheckpointCleanup().catch(console.error);