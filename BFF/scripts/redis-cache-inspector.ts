#!/usr/bin/env tsx

import Redis from 'ioredis';
import { config } from '../src/config/index.js';

const redis = new (Redis as any)({
  host: config.redis.host,
  port: config.redis.port,
  password: config.redis.password,
  db: config.redis.db,
});

async function inspectRedisCache() {
  try {
    console.log('🔍 检查Redis中的缓存键...\n');
    
    // 获取所有键
    const allKeys = await redis.keys('*');
    console.log(`总共找到 ${allKeys.length} 个键\n`);
    
    // 按前缀分组
    const keyGroups: { [prefix: string]: string[] } = {};
    allKeys.forEach(key => {
      const prefix = key.split(':')[0] + ':';
      if (!keyGroups[prefix]) {
        keyGroups[prefix] = [];
      }
      keyGroups[prefix].push(key);
    });
    
    // 显示每个前缀的键数量
    console.log('按前缀分组的键数量:');
    Object.entries(keyGroups).forEach(([prefix, keys]) => {
      console.log(`  ${prefix} → ${keys.length} 个键`);
    });
    
    console.log('\n详细键列表:');
    
    // 显示BFF相关的键
    const bffKeys = allKeys.filter(key => key.startsWith('bff:'));
    if (bffKeys.length > 0) {
      console.log('\n🏷️  BFF配置键:');
      bffKeys.forEach(key => console.log(`  ${key}`));
    }
    
    // 显示路由缓存键
    const routeKeys = allKeys.filter(key => key.startsWith('route:'));
    if (routeKeys.length > 0) {
      console.log('\n🛣️  路由缓存键 (最多显示10个):');
      routeKeys.slice(0, 10).forEach(key => console.log(`  ${key}`));
      if (routeKeys.length > 10) {
        console.log(`  ... 还有 ${routeKeys.length - 10} 个路由缓存键`);
      }
    }
    
    // 显示其他类型的缓存键
    const otherPrefixes = ['page:', 'user:', 'search:', 'stats:', 'page_', 'user_'];
    for (const prefix of otherPrefixes) {
      const prefixKeys = allKeys.filter(key => key.startsWith(prefix));
      if (prefixKeys.length > 0) {
        console.log(`\n📄 ${prefix} 键 (${prefixKeys.length} 个):`);
        prefixKeys.slice(0, 5).forEach(key => console.log(`  ${key}`));
        if (prefixKeys.length > 5) {
          console.log(`  ... 还有 ${prefixKeys.length - 5} 个`);
        }
      }
    }
    
  } catch (error) {
    console.error('❌ 检查失败:', error);
  } finally {
    await redis.disconnect();
  }
}

async function cleanAllBffCache() {
  try {
    console.log('🧹 彻底清理所有BFF相关缓存...\n');
    
    // 清理所有可能的BFF缓存键前缀
    const prefixesToClean = [
      'bff:*',
      'route:*',     // 路由缓存
      'page:*',      // 页面缓存  
      'page_*',      // 页面相关缓存
      'user:*',      // 用户缓存
      'user_*',      // 用户相关缓存
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
    
    console.log(`\n🎉 总共清理了 ${totalCleaned} 个缓存键`);
    
    // 重新初始化BFF配置
    await redis.hset('bff:info', {
      name: 'scpper-cn-bff',
      version: '1.0.0',
      initialized_at: new Date().toISOString(),
      cache_cleared_at: new Date().toISOString(),
    });
    
    console.log('✅ 重新初始化BFF配置');
    
  } catch (error) {
    console.error('❌ 清理失败:', error);
  } finally {
    await redis.disconnect();
  }
}

// 命令行处理
const command = process.argv[2];

switch (command) {
  case 'inspect':
    inspectRedisCache();
    break;
  case 'clean-all':
    cleanAllBffCache();
    break;
  default:
    console.log('📋 Redis缓存检查工具');
    console.log('');
    console.log('用法:');
    console.log('  npx tsx scripts/redis-cache-inspector.ts inspect    - 检查所有缓存键');
    console.log('  npx tsx scripts/redis-cache-inspector.ts clean-all  - 彻底清理所有BFF缓存');
    break;
}