import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();

async function setupPGroongaSearch() {
  console.log('=== 设置 PGroonga 搜索 ===\n');

  try {
    // 1. 创建索引
    console.log('1. 创建 PGroonga 索引...');
    
    const indexCommands = [
      {
        name: 'PageVersion title 索引',
        sql: `CREATE INDEX IF NOT EXISTS idx_pageversion_title_pgroonga 
              ON "PageVersion" USING pgroonga (title)`
      },
      {
        name: 'PageVersion textContent 索引',
        sql: `CREATE INDEX IF NOT EXISTS idx_pageversion_content_pgroonga 
              ON "PageVersion" USING pgroonga ("textContent")`
      },
      {
        name: 'PageVersion 全文组合索引',
        sql: `CREATE INDEX IF NOT EXISTS idx_pageversion_fulltext_pgroonga 
              ON "PageVersion" 
              USING pgroonga ((COALESCE(title, '') || ' ' || COALESCE("textContent", '')))`
      },
      {
        name: 'PageVersion tags GIN 索引',
        sql: `CREATE INDEX IF NOT EXISTS idx_pageversion_tags_gin 
              ON "PageVersion" USING gin (tags)`
      },
      {
        name: 'PageVersion validTo 索引',
        sql: `CREATE INDEX IF NOT EXISTS idx_pageversion_validto 
              ON "PageVersion" ("validTo") 
              WHERE "validTo" IS NULL`
      },
      {
        name: 'Page currentUrl PGroonga 索引',
        sql: `CREATE INDEX IF NOT EXISTS idx_page_current_url_pgroonga 
              ON "Page" USING pgroonga ("currentUrl")`
      },
      {
        name: 'User displayName 索引(删除旧索引)',
        sql: `DROP INDEX IF EXISTS idx_user_displayname_pgroonga`
      },
      {
        name: 'User displayName 索引(创建 Bigram+NFKC)',
        sql: `CREATE INDEX IF NOT EXISTS idx_user_displayname_pgroonga
              ON "User" USING pgroonga ("displayName")
              WITH (
                tokenizer = 'TokenBigramSplitSymbolAlpha',
                normalizer = 'NormalizerNFKC100("unify_alphabet", true, "unify_symbol", true)'
              )`
      }
    ];

    for (const cmd of indexCommands) {
      try {
        await prisma.$executeRawUnsafe(cmd.sql);
        console.log(`  ✅ ${cmd.name} 创建成功`);
      } catch (e: any) {
        if (e.message.includes('already exists')) {
          console.log(`  ℹ️ ${cmd.name} 已存在`);
        } else {
          console.log(`  ❌ ${cmd.name} 创建失败: ${e.message}`);
        }
      }
    }

    // 2. 验证索引
    console.log('\n2. 验证索引创建...');
    const indexes = await prisma.$queryRaw<Array<{
      tablename: string;
      indexname: string;
    }>>`
      SELECT tablename, indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN ('PageVersion', 'Page', 'User')
        AND (
          indexname LIKE '%pgroonga%' 
          OR indexname LIKE '%tags%'
          OR indexname LIKE '%validto%'
        )
      ORDER BY tablename, indexname
    `;

    console.log(`  找到 ${indexes.length} 个索引:`);
    indexes.forEach(idx => {
      console.log(`    - ${idx.tablename}.${idx.indexname}`);
    });

    // 3. 测试搜索性能
    console.log('\n3. 测试搜索性能...');
    
    const testQueries = [
      { name: '标题搜索', query: 'SCP' },
      { name: '中文搜索', query: '异常' },
      { name: '短语搜索', query: '特殊收容' }
    ];

    for (const test of testQueries) {
      const start = Date.now();
      const result = await prisma.$queryRaw<Array<{count: bigint}>>`
        SELECT COUNT(*) as count
        FROM "PageVersion"
        WHERE "validTo" IS NULL
          AND (
            title &@~ ${test.query}
            OR "textContent" &@~ ${test.query}
          )
      `;
      const end = Date.now();
      
      console.log(`  ${test.name} "${test.query}": ${result[0].count} 结果, 耗时 ${end - start}ms`);
    }

    // 4. 示例查询
    console.log('\n4. 示例查询:');
    console.log('\n  基础搜索（标题或内容）:');
    console.log(`    SELECT * FROM "PageVersion" 
    WHERE "validTo" IS NULL 
      AND (title &@~ '搜索词' OR "textContent" &@~ '搜索词')
    LIMIT 20;`);

    console.log('\n  带标签过滤的搜索:');
    console.log(`    SELECT * FROM "PageVersion" 
    WHERE "validTo" IS NULL 
      AND (title &@~ '搜索词' OR "textContent" &@~ '搜索词')
      AND tags @> ARRAY['scp']  -- 包含特定标签
    LIMIT 20;`);

    console.log('\n  用户搜索:');
    console.log(`    SELECT u.*, us."totalRating" 
    FROM "User" u
    LEFT JOIN "UserStats" us ON u.id = us."userId"
    WHERE u."displayName" &@~ '搜索词'
    ORDER BY us."totalRating" DESC NULLS LAST
    LIMIT 20;`);

    console.log('\n✅ PGroonga 索引设置完成！');
    console.log('\n下一步：运行 migration 删除 SearchIndex 和 UserSearchIndex 表');

  } catch (error) {
    console.error('设置过程中出错:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// 运行设置
setupPGroongaSearch().catch(console.error);
