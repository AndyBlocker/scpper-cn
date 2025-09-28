import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function dropSearchTables() {
  console.log('=== 删除 SearchIndex 和 UserSearchIndex 表 ===\n');

  try {
    // 1. 检查表是否存在
    console.log('1. 检查表是否存在...');
    const existingTables = await prisma.$queryRaw<Array<{table_name: string}>>`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name IN ('SearchIndex', 'UserSearchIndex')
    `;

    console.log(`  找到 ${existingTables.length} 个表:`);
    existingTables.forEach(t => console.log(`    - ${t.table_name}`));

    if (existingTables.length === 0) {
      console.log('\n✅ 表已经不存在，无需删除');
      return;
    }

    // 2. 删除外键约束
    console.log('\n2. 删除外键约束...');
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE "SearchIndex" DROP CONSTRAINT IF EXISTS "SearchIndex_pageId_fkey"`);
      console.log('  ✅ SearchIndex 外键约束已删除');
    } catch (e) {
      console.log('  ℹ️ SearchIndex 外键约束不存在或已删除');
    }

    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE "UserSearchIndex" DROP CONSTRAINT IF EXISTS "UserSearchIndex_userId_fkey"`);
      console.log('  ✅ UserSearchIndex 外键约束已删除');
    } catch (e) {
      console.log('  ℹ️ UserSearchIndex 外键约束不存在或已删除');
    }

    // 3. 删除表
    console.log('\n3. 删除表...');
    
    if (existingTables.some(t => t.table_name === 'SearchIndex')) {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "SearchIndex" CASCADE`);
      console.log('  ✅ SearchIndex 表已删除');
    }

    if (existingTables.some(t => t.table_name === 'UserSearchIndex')) {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "UserSearchIndex" CASCADE`);
      console.log('  ✅ UserSearchIndex 表已删除');
    }

    // 4. 验证删除
    console.log('\n4. 验证删除...');
    const remainingTables = await prisma.$queryRaw<Array<{table_name: string}>>`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name IN ('SearchIndex', 'UserSearchIndex')
    `;

    if (remainingTables.length === 0) {
      console.log('  ✅ 所有表已成功删除');
    } else {
      console.log('  ❌ 以下表未能删除:');
      remainingTables.forEach(t => console.log(`    - ${t.table_name}`));
    }

    // 5. 显示当前的 PGroonga 索引
    console.log('\n5. 当前 PGroonga 索引:');
    const pgroongaIndexes = await prisma.$queryRaw<Array<{
      tablename: string;
      indexname: string;
    }>>`
      SELECT tablename, indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexdef LIKE '%pgroonga%'
        AND tablename IN ('PageVersion', 'User')
      ORDER BY tablename, indexname
    `;

    pgroongaIndexes.forEach(idx => {
      console.log(`  - ${idx.tablename}.${idx.indexname}`);
    });

    console.log('\n✅ 操作完成！');
    console.log('\n下一步:');
    console.log('1. 运行 npx prisma generate 更新 Prisma Client');
    console.log('2. 在代码中使用 PGroongaSearchService 替代旧的搜索服务');

  } catch (error) {
    console.error('\n❌ 操作失败:', error);
  } finally {
    await prisma.$disconnect();
  }
}

// 运行
dropSearchTables().catch(console.error);