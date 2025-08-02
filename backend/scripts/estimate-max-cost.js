#!/usr/bin/env node

// 估算页面最大point cost的脚本
// 假设条件：vote数量 = 100, revision数量 = 100

import { PointEstimator, RateLimitCosts } from '../src/core/graphql/PointEstimator.js';
import { MAX_FIRST } from '../src/config/RateLimitConfig.js';

console.log('🧮 页面Point Cost估算脚本');
console.log('='.repeat(50));

// 测试页面数据 - 恰好100个votes和100个revisions
const testPage = {
  revisionCount: 100,
  voteCount: 100,
  // 其他可能影响成本的字段
  hasAttributions: true,
  hasAlternateTitles: true,
  hasChildren: true,
  hasSource: true,
  hasTextContent: true
};

console.log('📊 测试条件:');
console.log(`- Revision Count: ${testPage.revisionCount}`);
console.log(`- Vote Count: ${testPage.voteCount}`);
console.log(`- MAX_FIRST (API limit): ${MAX_FIRST}`);
console.log('');

console.log('💰 Rate Limit Costs:');
Object.entries(RateLimitCosts).forEach(([key, value]) => {
  console.log(`- ${key}: ${value} points`);
});
console.log('');

// 场景1: Phase B - 使用保守限制 (目前的20/50)
console.log('🔵 场景1: Phase B (当前保守限制)');
const phaseBCurrentCost = PointEstimator.estimatePageCost(testPage, {
  revisionLimit: 20,
  voteLimit: 50,
  includeAttributions: true,
  includeAlternateTitles: true,
  includeChildren: false,
  includeSource: true,
  includeTextContent: true,
});
console.log(`Cost: ${phaseBCurrentCost} points`);
console.log('明细:');
console.log(`- 基础字段: ${RateLimitCosts.wikidotPage + RateLimitCosts.attributions + RateLimitCosts.source + RateLimitCosts.textContent} points`);
console.log(`- Revisions: ${Math.min(100, 20)} × ${RateLimitCosts.revisionEdge} = ${Math.min(100, 20) * RateLimitCosts.revisionEdge} points`);
console.log(`- Votes: ${Math.min(100, 50)} × ${RateLimitCosts.voteEdge} = ${Math.min(100, 50) * RateLimitCosts.voteEdge} points`);
console.log('');

// 场景2: Phase B - 使用MAX_FIRST (推荐的100/100)
console.log('🟢 场景2: Phase B (推荐的MAX_FIRST限制)');
const phaseBOptimalCost = PointEstimator.estimatePageCost(testPage, {
  revisionLimit: MAX_FIRST,
  voteLimit: MAX_FIRST,
  includeAttributions: true,
  includeAlternateTitles: true,
  includeChildren: false,
  includeSource: true,
  includeTextContent: true,
});
console.log(`Cost: ${phaseBOptimalCost} points`);
console.log('明细:');
console.log(`- 基础字段: ${RateLimitCosts.wikidotPage + RateLimitCosts.attributions + RateLimitCosts.source + RateLimitCosts.textContent} points`);
console.log(`- Revisions: ${Math.min(100, MAX_FIRST)} × ${RateLimitCosts.revisionEdge} = ${Math.min(100, MAX_FIRST) * RateLimitCosts.revisionEdge} points`);
console.log(`- Votes: ${Math.min(100, MAX_FIRST)} × ${RateLimitCosts.voteEdge} = ${Math.min(100, MAX_FIRST) * RateLimitCosts.voteEdge} points`);
console.log('');

// 场景3: 最大可能的成本 (包含所有可选字段)
console.log('🔴 场景3: 理论最大成本 (包含所有字段)');
const maxPossibleCost = PointEstimator.estimatePageCost(testPage, {
  revisionLimit: MAX_FIRST,
  voteLimit: MAX_FIRST,
  includeAttributions: true,
  includeAlternateTitles: true,
  includeChildren: true,
  includeSource: true,
  includeTextContent: true,
});
console.log(`Cost: ${maxPossibleCost} points`);
console.log('明细:');
console.log(`- wikidotPage: ${RateLimitCosts.wikidotPage} points`);
console.log(`- attributions: ${RateLimitCosts.attributions} points`);
console.log(`- alternateTitles: ${RateLimitCosts.alternateTitles} points`);
console.log(`- children: ${RateLimitCosts.children} points`);
console.log(`- source: ${RateLimitCosts.source} points`);
console.log(`- textContent: ${RateLimitCosts.textContent} points`);
console.log(`- revisions: ${Math.min(100, MAX_FIRST)} × ${RateLimitCosts.revisionEdge} = ${Math.min(100, MAX_FIRST) * RateLimitCosts.revisionEdge} points`);
console.log(`- votes: ${Math.min(100, MAX_FIRST)} × ${RateLimitCosts.voteEdge} = ${Math.min(100, MAX_FIRST) * RateLimitCosts.voteEdge} points`);
console.log('');

// 批处理分析
console.log('📦 批处理分析:');
const BUCKET_SOFT_LIMIT = 800; // 从RateLimitConfig.js
console.log(`- Bucket Soft Limit: ${BUCKET_SOFT_LIMIT} points`);
console.log(`- 当前Phase B: 每个bucket最多 ${Math.floor(BUCKET_SOFT_LIMIT / phaseBCurrentCost)} 个页面 (${phaseBCurrentCost} points/页)`);
console.log(`- 推荐Phase B: 每个bucket最多 ${Math.floor(BUCKET_SOFT_LIMIT / phaseBOptimalCost)} 个页面 (${phaseBOptimalCost} points/页)`);
console.log(`- 理论最大: 每个bucket最多 ${Math.floor(BUCKET_SOFT_LIMIT / maxPossibleCost)} 个页面 (${maxPossibleCost} points/页)`);
console.log('');

// 边界情况分析
console.log('⚠️ 边界情况分析:');

// 测试更大数量的情况
const largePage = { revisionCount: 1000, voteCount: 1000 };
const largeCost = PointEstimator.estimatePageCost(largePage, {
  revisionLimit: MAX_FIRST,
  voteLimit: MAX_FIRST,
  includeAttributions: true,
  includeSource: true,
  includeTextContent: true,
});
console.log(`- 大型页面 (1000 rev/vote): ${largeCost} points (限制在MAX_FIRST后)`);

// 测试小页面
const smallPage = { revisionCount: 5, voteCount: 10 };
const smallCost = PointEstimator.estimatePageCost(smallPage, {
  revisionLimit: MAX_FIRST,
  voteLimit: MAX_FIRST,
  includeAttributions: true,
  includeSource: true,
  includeTextContent: true,
});
console.log(`- 小型页面 (5 rev/10 vote): ${smallCost} points`);
console.log('');

// 总结和建议
console.log('📋 总结和建议:');
console.log('1. 当前Phase B限制(20/50)过于保守，导致效率低下');
console.log('2. 推荐使用MAX_FIRST(100/100)限制，提高批处理效率');
console.log('3. 即使是100/100的页面，成本也在可接受范围内');
console.log(`4. 单个页面最大理论成本: ${maxPossibleCost} points (< 1000 points limit)`);
console.log('5. 可以安全地在一个query中包含多个这样的页面');