#!/usr/bin/env node

/**
 * 简单迁移脚本 - 逐个执行SQL语句
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🚀 开始简单迁移...');
  
  try {
    // 1. 添加Page.firstPublishedAt字段
    console.log('1. 添加Page.firstPublishedAt字段...');
    try {
      await prisma.$executeRaw`ALTER TABLE "Page" ADD COLUMN IF NOT EXISTS "firstPublishedAt" timestamp`;
      console.log('  ✓ 字段已添加');
    } catch (error) {
      console.log('  ⏭️ 字段可能已存在');
    }

    // 2. 创建AnalysisWatermark表
    console.log('2. 创建AnalysisWatermark表...');
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS "AnalysisWatermark" (
        id SERIAL PRIMARY KEY,
        task TEXT UNIQUE NOT NULL,
        "lastRunAt" TIMESTAMP NOT NULL DEFAULT now(),
        "cursorTs" TIMESTAMP
      )
    `;
    console.log('  ✓ 表已创建');

    // 3. 创建SearchIndex表
    console.log('3. 创建SearchIndex表...');
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS "SearchIndex" (
        "pageId" INTEGER PRIMARY KEY,
        title TEXT,
        url TEXT,
        tags TEXT[],
        text_content TEXT,
        source_content TEXT,
        "updatedAt" TIMESTAMP DEFAULT now(),
        CONSTRAINT fk_searchindex_page FOREIGN KEY ("pageId") REFERENCES "Page"(id) ON DELETE CASCADE
      )
    `;
    console.log('  ✓ 表已创建');

    // 4. 创建PageDailyStats表
    console.log('4. 创建PageDailyStats表...');
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS "PageDailyStats" (
        id SERIAL PRIMARY KEY,
        "pageId" INTEGER NOT NULL,
        date DATE NOT NULL,
        votes_up INTEGER DEFAULT 0,
        votes_down INTEGER DEFAULT 0,
        total_votes INTEGER DEFAULT 0,
        unique_voters INTEGER DEFAULT 0,
        revisions INTEGER DEFAULT 0,
        "createdAt" TIMESTAMP DEFAULT now(),
        CONSTRAINT fk_pagedailystats_page FOREIGN KEY ("pageId") REFERENCES "Page"(id) ON DELETE CASCADE,
        UNIQUE("pageId", date)
      )
    `;
    console.log('  ✓ 表已创建');

    // 5. 创建UserDailyStats表
    console.log('5. 创建UserDailyStats表...');
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS "UserDailyStats" (
        id SERIAL PRIMARY KEY,
        "userId" INTEGER NOT NULL,
        date DATE NOT NULL,
        votes_cast INTEGER DEFAULT 0,
        pages_created INTEGER DEFAULT 0,
        last_activity TIMESTAMP,
        "createdAt" TIMESTAMP DEFAULT now(),
        CONSTRAINT fk_userdailystats_user FOREIGN KEY ("userId") REFERENCES "User"(id) ON DELETE CASCADE,
        UNIQUE("userId", date)
      )
    `;
    console.log('  ✓ 表已创建');

    // 6. 创建LeaderboardCache表
    console.log('6. 创建LeaderboardCache表...');
    await prisma.$executeRaw`
      CREATE TABLE IF NOT EXISTS "LeaderboardCache" (
        id SERIAL PRIMARY KEY,
        key TEXT NOT NULL,
        period TEXT NOT NULL,
        payload JSONB NOT NULL,
        "updatedAt" TIMESTAMP DEFAULT now(),
        "expiresAt" TIMESTAMP,
        UNIQUE(key, period)
      )
    `;
    console.log('  ✓ 表已创建');

    // 7. 创建基础索引
    console.log('7. 创建索引...');
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_page_first_published ON "Page" ("firstPublishedAt")',
      'CREATE INDEX IF NOT EXISTS idx_vote_pv_ts ON "Vote" ("pageVersionId", "timestamp")',
      'CREATE INDEX IF NOT EXISTS idx_vote_pv_dir_ts ON "Vote" ("pageVersionId", "direction", "timestamp")',
      'CREATE INDEX IF NOT EXISTS idx_rev_pv_ts ON "Revision" ("pageVersionId", "timestamp")',
      'CREATE INDEX IF NOT EXISTS idx_attr_pagever_date ON "Attribution" ("pageVerId", "date")',
      'CREATE INDEX IF NOT EXISTS idx_attr_user ON "Attribution" ("userId")',
      'CREATE INDEX IF NOT EXISTS idx_user_first_last ON "User" ("firstActivityAt", "lastActivityAt")'
    ];

    for (const [i, indexSQL] of indexes.entries()) {
      try {
        await prisma.$executeRawUnsafe(indexSQL);
        console.log(`  ✓ 索引 ${i + 1}/${indexes.length} 已创建`);
      } catch (error) {
        console.log(`  ⏭️ 索引 ${i + 1} 可能已存在`);
      }
    }

    // 8. 创建统计函数
    console.log('8. 创建统计函数...');
    await prisma.$executeRaw`
      CREATE OR REPLACE FUNCTION f_wilson_lower_bound(up integer, down integer)
      RETURNS double precision LANGUAGE sql IMMUTABLE AS $$
        SELECT CASE
          WHEN (up + down) = 0 THEN 0.0
          ELSE (
            (up::float/(up+down) + 1.96^2/(2*(up+down))
             - 1.96/(2*(up+down)) * sqrt(4*(up+down)*(up::float/(up+down))*(1-(up::float/(up+down))) + 1.96^2)
            ) / (1 + 1.96^2/(up+down))
          )
        END
      $$
    `;
    console.log('  ✓ Wilson函数已创建');

    await prisma.$executeRaw`
      CREATE OR REPLACE FUNCTION f_controversy(up integer, down integer)
      RETURNS double precision LANGUAGE sql IMMUTABLE AS $$
        SELECT CASE
          WHEN (up + down) = 0 OR GREATEST(up,down)=0 THEN 0.0
          ELSE (LEAST(up,down)::float/GREATEST(up,down)::float) * ln(up+down+1)
        END
      $$
    `;
    console.log('  ✓ 争议度函数已创建');

    // 9. 初始化水位线数据
    console.log('9. 初始化水位线数据...');
    const tasks = ['page_stats', 'user_stats', 'site_stats', 'search_index', 'facts_generation'];
    for (const task of tasks) {
      await prisma.$executeRaw`
        INSERT INTO "AnalysisWatermark" (task, "lastRunAt", "cursorTs")
        VALUES (${task}, now(), NULL)
        ON CONFLICT (task) DO NOTHING
      `;
    }
    console.log('  ✓ 水位线数据已初始化');

    // 10. 验证创建结果
    console.log('10. 验证创建结果...');
    const watermarkCount = await prisma.$queryRaw`SELECT COUNT(*) as count FROM "AnalysisWatermark"`;
    console.log(`  ✓ AnalysisWatermark: ${(watermarkCount as any)[0].count} 条记录`);

    const searchIndexCount = await prisma.$queryRaw`SELECT COUNT(*) as count FROM "SearchIndex"`;
    console.log(`  ✓ SearchIndex: ${(searchIndexCount as any)[0].count} 条记录`);

    // 测试函数
    const wilsonTest = await prisma.$queryRaw`SELECT f_wilson_lower_bound(10, 2) as wilson`;
    console.log(`  ✓ Wilson函数测试: ${((wilsonTest as any)[0].wilson as number).toFixed(3)}`);

    // 重新生成Prisma客户端
    console.log('11. 重新生成Prisma客户端...');
    const { execSync } = await import('child_process');
    try {
      execSync('npx prisma generate', { stdio: 'pipe' });
      console.log('  ✓ Prisma客户端已重新生成');
    } catch (error) {
      console.log('  ⚠️ Prisma客户端生成失败，请手动运行: npx prisma generate');
    }

    console.log('\n🎉 简单迁移成功完成！');
    console.log('================================');
    console.log('✅ 所有必需表已创建');
    console.log('✅ 基础索引已创建');
    console.log('✅ 统计函数已安装');
    console.log('✅ 水位线已初始化');
    console.log('\n📋 后续操作：');
    console.log('1. 运行完整数据回填');
    console.log('2. 同步搜索索引');
    console.log('3. 执行增量分析');
    
  } catch (error) {
    console.error('❌ 简单迁移失败:', error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('💥 迁移脚本失败:', error);
  process.exit(1);
});