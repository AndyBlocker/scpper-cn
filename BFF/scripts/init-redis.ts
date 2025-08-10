#!/usr/bin/env tsx

/**
 * Redis初始化脚本
 * 用于设置BFF所需的Redis键结构和基础配置
 */

import Redis from 'ioredis';
import { config } from '../src/config/index.js';
import { logger } from '../src/utils/logger.js';

const redis = new (Redis as any)({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  db: config.redis.db,
});

async function initializeRedis() {
  try {
    console.log('🚀 开始初始化Redis...');
    
    // 测试连接
    await redis.ping();
    console.log('✅ Redis连接成功');

    // 设置BFF应用信息
    await redis.hset('bff:info', {
      name: 'scpper-cn-bff',
      version: '1.0.0',
      initialized_at: new Date().toISOString(),
      description: 'SCPPER-CN Backend for Frontend',
    });
    console.log('✅ 设置BFF应用信息');

    // 初始化缓存键前缀结构
    const prefixes = [
      'page:',           // 页面详情缓存
      'page_list:',      // 页面列表缓存  
      'user:',           // 用户信息缓存
      'user_stats:',     // 用户统计缓存
      'search:',         // 搜索结果缓存
      'stats:site:',     // 站点统计缓存
      'stats:series:',   // 系列统计缓存
      'stats:interesting:', // 有趣统计缓存
      'leaderboard:',    // 排行榜缓存
      'tag_cloud:',      // 标签云缓存
      'rate_limit:',     // 限流计数器
    ];

    // 记录缓存前缀
    await redis.sadd('bff:cache:prefixes', ...prefixes);
    console.log('✅ 设置缓存键前缀结构');

    // 设置默认TTL配置
    const ttlConfig = {
      HOT_DATA: '60',          // 热点数据 - 1分钟
      SEARCH_RESULTS: '300',   // 搜索结果 - 5分钟
      PAGE_DETAIL: '900',      // 页面详情 - 15分钟
      USER_PROFILE: '1800',    // 用户资料 - 30分钟
      PAGE_STATS: '3600',      // 页面统计 - 1小时
      USER_STATS: '7200',      // 用户统计 - 2小时
      SITE_STATS: '21600',     // 站点统计 - 6小时
      SERIES_STATS: '43200',   // 系列统计 - 12小时
    };

    await redis.hmset('bff:config:ttl', ttlConfig);
    console.log('✅ 设置TTL配置');

    // 设置限流配置
    const rateLimitConfig = {
      api: '100',      // 通用API - 100次/分钟
      search: '30',    // 搜索API - 30次/分钟
      heavy: '10',     // 重度操作 - 10次/分钟
      stats: '20',     // 统计API - 20次/分钟
    };

    await redis.hmset('bff:config:rate_limit', rateLimitConfig);
    console.log('✅ 设置限流配置');

    // 初始化健康检查状态
    await redis.hset('bff:health', {
      redis_status: 'healthy',
      last_check: new Date().toISOString(),
      uptime_start: new Date().toISOString(),
    });
    console.log('✅ 初始化健康检查状态');

    // 创建示例缓存数据（可选）
    const sampleCacheData = {
      'bff:sample:api_info': JSON.stringify({
        name: 'SCPPER-CN BFF API',
        version: '1.0.0',
        endpoints: ['pages', 'search', 'stats', 'users'],
        cache_enabled: true,
      }),
    };

    for (const [key, value] of Object.entries(sampleCacheData)) {
      await redis.setex(key, 3600, value); // 1小时过期
    }
    console.log('✅ 创建示例缓存数据');

    // 设置监控计数器
    await redis.set('bff:metrics:total_requests', '0');
    await redis.set('bff:metrics:cache_hits', '0');
    await redis.set('bff:metrics:cache_misses', '0');
    console.log('✅ 初始化监控计数器');

    // 显示Redis状态信息
    console.log('\n📊 Redis状态信息:');
    const info = await redis.info('memory');
    const memoryLines = info.split('\r\n').filter(line => 
      line.includes('used_memory_human') || 
      line.includes('used_memory_peak_human') ||
      line.includes('connected_clients')
    );
    memoryLines.forEach(line => console.log(`   ${line}`));

    // 显示当前所有BFF相关的键
    console.log('\n🔑 BFF相关键列表:');
    const keys = await redis.keys('bff:*');
    keys.sort().forEach(key => console.log(`   ${key}`));

    console.log('\n🎉 Redis初始化完成!');
    console.log('   BFF现在可以正常使用Redis缓存和限流功能');
    
  } catch (error) {
    console.error('❌ Redis初始化失败:', error);
    process.exit(1);
  } finally {
    await redis.disconnect();
  }
}

// 清理函数
async function cleanupRedis() {
  try {
    console.log('🧹 开始清理Redis BFF数据...');
    
    // 清理所有BFF相关的缓存键前缀
    const prefixesToClean = [
      'bff:*',
      'route:*',     // 路由缓存（Express中间件缓存）
      'page:*',      // 页面缓存  
      'page_*',      // 页面相关缓存
      'user:*',      // 用户缓存
      'user_*',      // 用户相关缓存（user_list, user_stats等）
      'search:*',    // 搜索缓存
      'stats:*',     // 统计缓存
    ];
    
    let totalCleaned = 0;
    
    for (const pattern of prefixesToClean) {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
        console.log(`✅ 清理了 ${keys.length} 个 ${pattern} 键`);
        totalCleaned += keys.length;
      }
    }
    
    if (totalCleaned === 0) {
      console.log('✅ 没有找到需要清理的BFF数据');
    } else {
      console.log(`🎉 总共清理了 ${totalCleaned} 个缓存键`);
    }
    
  } catch (error) {
    console.error('❌ 清理Redis失败:', error);
  } finally {
    await redis.disconnect();
  }
}

// 状态检查函数  
async function checkRedisStatus() {
  try {
    console.log('🔍 检查Redis状态...');
    
    // 连接测试
    await redis.ping();
    console.log('✅ Redis连接正常');
    
    // 检查BFF相关配置
    const appInfo = await redis.hgetall('bff:info');
    if (Object.keys(appInfo).length > 0) {
      console.log('✅ BFF应用信息存在:', appInfo.name);
      console.log('   初始化时间:', appInfo.initialized_at);
    } else {
      console.log('⚠️  BFF应用信息不存在，可能需要运行初始化');
    }
    
    // 检查缓存前缀
    const prefixes = await redis.smembers('bff:cache:prefixes');
    console.log(`✅ 缓存前缀配置: ${prefixes.length} 个`);
    
    // 检查配置
    const ttlConfig = await redis.hgetall('bff:config:ttl');
    const rateLimitConfig = await redis.hgetall('bff:config:rate_limit');
    console.log(`✅ TTL配置: ${Object.keys(ttlConfig).length} 项`);
    console.log(`✅ 限流配置: ${Object.keys(rateLimitConfig).length} 项`);
    
    // 检查运行时数据
    const totalRequests = await redis.get('bff:metrics:total_requests') || '0';
    const cacheHits = await redis.get('bff:metrics:cache_hits') || '0';
    const cacheMisses = await redis.get('bff:metrics:cache_misses') || '0';
    
    console.log('\n📈 运行统计:');
    console.log(`   总请求数: ${totalRequests}`);
    console.log(`   缓存命中: ${cacheHits}`);
    console.log(`   缓存未命中: ${cacheMisses}`);
    
    const hitRate = parseInt(cacheHits) + parseInt(cacheMisses) > 0 
      ? (parseInt(cacheHits) / (parseInt(cacheHits) + parseInt(cacheMisses)) * 100).toFixed(1)
      : '0';
    console.log(`   缓存命中率: ${hitRate}%`);
    
  } catch (error) {
    console.error('❌ Redis状态检查失败:', error);
    process.exit(1);
  } finally {
    await redis.disconnect();
  }
}

// 命令行处理
const command = process.argv[2];

switch (command) {
  case 'init':
    initializeRedis();
    break;
  case 'cleanup':
    cleanupRedis();
    break;
  case 'status':
    checkRedisStatus();
    break;
  default:
    console.log('📋 Redis管理脚本');
    console.log('');
    console.log('用法:');
    console.log('  npm run redis:init     - 初始化Redis配置');
    console.log('  npm run redis:cleanup  - 清理BFF相关数据');
    console.log('  npm run redis:status   - 检查Redis状态');
    console.log('');
    console.log('示例:');
    console.log('  tsx scripts/init-redis.ts init');
    console.log('  tsx scripts/init-redis.ts status');
    break;
}