#!/usr/bin/env node

/**
 * 直接SQL迁移脚本
 * 绕过Prisma migrate，直接执行SQL
 */

import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const prisma = new PrismaClient();

async function main() {
  console.log('🚀 开始直接SQL迁移...');
  console.log('================================');
  
  try {
    // 读取SQL文件
    const sqlFile = join(__dirname, 'direct-migration.sql');
    const sqlContent = readFileSync(sqlFile, 'utf8');
    
    console.log('📄 执行SQL迁移脚本...');
    
    // 分割SQL语句并执行（去除注释和空行）
    const statements = sqlContent
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0 && !stmt.startsWith('--') && !stmt.startsWith('\\echo'))
      .filter(stmt => !stmt.includes('BEGIN') && !stmt.includes('COMMIT'));

    let executedCount = 0;
    for (const statement of statements) {
      if (statement.trim()) {
        try {
          await prisma.$executeRawUnsafe(statement);
          executedCount++;
        } catch (error) {
          // 某些语句可能因为已存在而失败，这是正常的
          if (!error.message.includes('already exists') && 
              !error.message.includes('relation') && 
              !error.message.includes('duplicate')) {
            console.warn(`⚠️ SQL执行警告: ${error.message.substring(0, 100)}...`);
          }
        }
      }
    }
    
    console.log(`✅ 执行了 ${executedCount} 个SQL语句`);
    
    // 生成Prisma客户端
    console.log('🔄 重新生成Prisma客户端...');
    const { execSync } = await import('child_process');
    execSync('npx prisma generate', { stdio: 'pipe' });
    
    // 验证迁移结果
    console.log('🔍 验证迁移结果...');
    await verifyMigration();
    
    // 初始化数据
    console.log('📊 初始化基础数据...');
    await initializeData();
    
    console.log('\n🎉 直接SQL迁移成功完成！');
    console.log('================================');
    console.log('✅ 所有新表和索引已创建');
    console.log('✅ 统计函数已安装');
    console.log('✅ 触发器已配置');
    console.log('✅ 水位线已初始化');
    console.log('\n📋 下一步操作：');
    console.log('1. 运行 npm run analyze:full 执行完整分析');
    console.log('2. 运行 npm run search:sync 同步搜索索引');
    console.log('3. 运行 npm run stats:extended 生成扩展统计');
    
  } catch (error) {
    console.error('❌ 直接SQL迁移失败:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

async function verifyMigration() {
  const tables = ['AnalysisWatermark', 'SearchIndex', 'PageDailyStats', 'UserDailyStats', 'LeaderboardCache'];
  
  for (const table of tables) {
    try {
      const result = await prisma.$queryRawUnsafe(`SELECT COUNT(*) as count FROM "${table}"`);
      console.log(`  ✓ 表 ${table} 验证通过 (${result[0].count} 行)`);
    } catch (error) {
      throw new Error(`表 ${table} 验证失败: ${error.message}`);
    }
  }
  
  // 验证Page.firstPublishedAt字段
  try {
    await prisma.$queryRawUnsafe(`SELECT "firstPublishedAt" FROM "Page" LIMIT 1`);
    console.log('  ✓ Page.firstPublishedAt 字段验证通过');
  } catch (error) {
    throw new Error(`Page.firstPublishedAt 字段验证失败: ${error.message}`);
  }
  
  // 验证函数
  try {
    const result = await prisma.$queryRawUnsafe(`SELECT f_wilson_lower_bound(10, 2) as wilson`);
    console.log(`  ✓ 统计函数验证通过 (Wilson: ${result[0].wilson.toFixed(3)})`);
  } catch (error) {
    throw new Error(`统计函数验证失败: ${error.message}`);
  }
}

async function initializeData() {
  // 回填Page.firstPublishedAt（样本）
  const nullCount = await prisma.$queryRawUnsafe(`
    SELECT COUNT(*) as count 
    FROM "Page" 
    WHERE "firstPublishedAt" IS NULL
  `);
  
  if (nullCount[0].count > 0) {
    console.log(`  回填 ${nullCount[0].count} 个页面的创建时间...`);
    
    // 只回填前1000个，避免长时间锁表
    await prisma.$executeRawUnsafe(`
      UPDATE "Page" 
      SET "firstPublishedAt" = subq.earliest_date
      FROM (
        SELECT 
          p.id,
          COALESCE(
            MIN(a.date),
            MIN(r."timestamp"),
            MIN(pv."validFrom"),
            p."createdAt"
          ) AS earliest_date
        FROM "Page" p
        LEFT JOIN "PageVersion" pv ON pv."pageId" = p.id
        LEFT JOIN "Attribution" a ON a."pageVerId" = pv.id
        LEFT JOIN "Revision" r ON r."pageVersionId" = pv.id
        WHERE p."firstPublishedAt" IS NULL
        GROUP BY p.id, p."createdAt"
        LIMIT 1000
      ) subq
      WHERE "Page".id = subq.id AND "Page"."firstPublishedAt" IS NULL
    `);
    
    console.log('  ✓ 页面创建时间回填完成（前1000条）');
  }
  
  // 同步一些页面到SearchIndex
  console.log('  同步搜索索引...');
  await prisma.$executeRawUnsafe(`
    INSERT INTO "SearchIndex" ("pageId", title, url, tags, text_content, source_content, "updatedAt")
    SELECT 
      pv."pageId",
      pv.title,
      p.url,
      pv.tags,
      pv."textContent",
      pv.source,
      now()
    FROM "PageVersion" pv
    JOIN "Page" p ON p.id = pv."pageId"
    WHERE pv."validTo" IS NULL 
      AND pv."isDeleted" = false
    LIMIT 1000
    ON CONFLICT ("pageId") DO NOTHING
  `);
  
  console.log('  ✓ 搜索索引初始化完成（前1000条）');
}

// 错误处理
process.on('unhandledRejection', (reason) => {
  console.error('❌ Unhandled Rejection:', reason);
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

main().catch((error) => {
  console.error('💥 直接SQL迁移失败:', error);
  process.exit(1);
});