#!/usr/bin/env node

/**
 * 文件路径: src/main.js
 * 功能概述: SCPPER-CN 数据同步和分析系统主入口文件
 * 
 * 主要功能:
 * - 统一的命令行接口，支持 sync/update/database/analyze/schema/full 等命令
 * - 命令分发和执行流程控制
 * - 参数解析和帮助信息显示
 * - 各个同步模块的协调调用
 * 
 * 使用方式:
 * - npm run main <command> [options]
 * - node src/main.js <command> [options]
 */

import { ProductionSync } from './sync/production-sync.js';
import { UpdateSyncStrategyV3 } from './sync/strategies/update-sync-strategy-v3.js';
import { FastDatabaseSync } from './sync/fast-database-sync.js';
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
    const forceReset = process.argv.includes('--force');
    console.log(`🗋 开始数据库同步${forceReset ? ' (强制重置模式)' : ''}...`);
    const databaseSync = new FastDatabaseSync({ forceReset });
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
    
  case 'update':
    console.log('🔄 开始增量更新同步...');
    const testMode = process.argv.includes('--test');
    const debugMode = process.argv.includes('--debug');
    const updateSync = new UpdateSyncStrategyV3({ testMode, debug: debugMode });
    await updateSync.runUpdateSync();
    
    if (!testMode) {
      console.log('2️⃣ 第二步: 数据库同步');
      const updateDatabaseSync = new FastDatabaseSync();
      await updateDatabaseSync.runDatabaseSync();
      console.log('✅ 增量更新完成!');
    } else {
      console.log('🧪 测试模式完成，跳过数据库同步');
    }
    break;
    
  case 'full':
    console.log('🔄 开始完整的数据同步流程...');
    console.log('1️⃣ 第一步: 生产环境数据同步');
    const fullProductionSync = new ProductionSync();
    await fullProductionSync.runProductionSync();
    
    console.log('2️⃣ 第二步: 数据库同步（强制重置模式）');
    const fullDatabaseSync = new FastDatabaseSync({ forceReset: true });
    await fullDatabaseSync.runDatabaseSync();
    
    console.log('✅ 完整流程执行完成!');
    break;
    
  default:
    console.log('使用方法:');
    console.log('  npm run main sync      - 运行生产环境数据同步');
    console.log('  npm run main database  - 运行数据库同步');
    console.log('  npm run main database -- --force - 强制重置数据库进行全量同步');
    console.log('  npm run main update    - 运行增量更新同步');
    console.log('  npm run main update -- --test - 运行增量更新测试模式（找到第一个变化页面后停止）');
    console.log('  npm run main update -- --debug - 运行增量更新调试模式（显示详细数据缺口信息）');
    console.log('  npm run main analyze <file> - 运行投票数据分析');
    console.log('  npm run main schema    - 运行Schema探索');
    console.log('  npm run main full      - 运行完整流程');
    console.log('');
    console.log('同步策略说明:');
    console.log('  full   - 完整同步：从零开始获取所有数据 (首次使用)');
    console.log('  update - 增量更新：基于现有数据检测变化并更新 (日常维护)');
    console.log('  sync   - 生产同步：获取原始数据但不入库 (调试用)');
    console.log('');
    console.log('或直接运行单个脚本:');
    console.log('  node src/sync/production-sync.js');
    console.log('  node src/main.js database');
    console.log('  node src/analyze/vote-analyzer.js <data-file>');
    console.log('  node src/sync/schema-explorer.js');
    break;
}