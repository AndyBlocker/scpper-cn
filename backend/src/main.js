#!/usr/bin/env node

import { ProductionSync } from './sync/production-sync.js';
import { DatabaseSync } from './sync/database-sync.js';
import { VoteAnalyzer } from './analyze/vote-analyzer.js';
import { SchemaExplorer } from './sync/schema-explorer.js';

// SCPPER-CN 数据同步和分析系统主入口
console.log('🚀 SCPPER-CN 数据同步和分析系统');
console.log('='.repeat(50));

const command = process.argv[2];

switch (command) {
  case 'sync':
    console.log('📊 开始生产环境数据同步...');
    const productionSync = new ProductionSync();
    await productionSync.runProductionSync();
    break;
    
  case 'database':
    console.log('🗄️  开始数据库同步...');
    const databaseSync = new DatabaseSync();
    await databaseSync.runDatabaseSync();
    break;
    
  case 'analyze':
    const dataFile = process.argv[3];
    if (!dataFile) {
      console.log('❌ 请提供数据文件路径');
      console.log('使用方法: npm run analyze <data-file-path>');
      process.exit(1);
    }
    console.log('📈 开始投票数据分析...');
    const analyzer = new VoteAnalyzer(dataFile);
    await analyzer.loadData();
    await analyzer.generateComprehensiveReport();
    break;
    
  case 'schema':
    console.log('🔍 开始Schema探索...');
    const explorer = new SchemaExplorer();
    await explorer.exploreSchema();
    break;
    
  case 'full':
    console.log('🔄 开始完整的数据同步流程...');
    console.log('1️⃣ 第一步: 生产环境数据同步');
    const fullProductionSync = new ProductionSync();
    await fullProductionSync.runProductionSync();
    
    console.log('2️⃣ 第二步: 数据库同步');
    const fullDatabaseSync = new DatabaseSync();
    await fullDatabaseSync.runDatabaseSync();
    
    console.log('✅ 完整流程执行完成!');
    break;
    
  default:
    console.log('使用方法:');
    console.log('  npm run main sync      - 运行生产环境数据同步');
    console.log('  npm run main database  - 运行数据库同步');
    console.log('  npm run main analyze <file> - 运行投票数据分析');
    console.log('  npm run main schema    - 运行Schema探索');
    console.log('  npm run main full      - 运行完整流程');
    console.log('');
    console.log('或直接运行单个脚本:');
    console.log('  node src/sync/production-sync.js');
    console.log('  node src/sync/database-sync.js');
    console.log('  node src/analyze/vote-analyzer.js <data-file>');
    console.log('  node src/sync/schema-explorer.js');
    break;
}