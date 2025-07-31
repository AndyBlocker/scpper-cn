#!/usr/bin/env node
// src/index.js
/**
 * SCPPER-CN 主程序入口
 * 运行三阶段数据同步流程
 */

import { PhaseAProcessor } from './core/processors/PhaseAProcessor.js';
import { PhaseBProcessor } from './core/processors/PhaseBProcessor.js';
import { PhaseCProcessor } from './core/processors/PhaseCProcessor.js';
import { Logger } from './utils/Logger.js';

async function main() {
  Logger.info('SCPPER-CN Data Sync System Starting...');
  
  try {
    // Phase A: 基础页面扫描
    const phaseA = new PhaseAProcessor();
    await phaseA.run();

    // Phase B: 简单页面详细数据获取  
    const phaseB = new PhaseBProcessor();
    await phaseB.run();

    // Phase C: 复杂页面处理
    const phaseC = new PhaseCProcessor({ concurrency: 2 });
    await phaseC.run();

    Logger.info('🎉 All phases completed successfully!');
    
  } catch (error) {
    // console.log(error)
    Logger.error('Sync process failed:', error);
    process.exit(1);
  }
}

// 处理未捕获的异常
process.on('uncaughtException', (error) => {
  Logger.error('Uncaught Exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  Logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// 优雅地处理 Ctrl+C
process.on('SIGINT', () => {
  Logger.info('Process interrupted by user');
  process.exit(0);
});

// 运行主程序
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
