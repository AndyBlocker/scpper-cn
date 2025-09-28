import { PrismaClient } from '@prisma/client';

type ClearOptions = {
  help?: boolean;
  force?: boolean;
  keepUsers?: boolean;
  keepPages?: boolean;
  tables?: string[];
};

async function clearDatabase(options: ClearOptions = {}): Promise<void> {
  if (options.help) {
    // Help text in Chinese to mirror compiled output
    // eslint-disable-next-line no-console
    console.log(`
数据库清空脚本 - 使用说明

用法: npm run db:clear [选项]

选项:
  --force         强制清空，无需确认
  --keep-users    保留用户数据
  --keep-pages    保留页面基础数据 (只清空投票、修订等关联数据)
  --tables <表名> 只清空指定表 (逗号分隔)
  --help          显示此帮助信息

示例:
  npm run db:clear -- --force                    # 强制清空所有数据
  npm run db:clear -- --keep-users               # 保留用户，清空其他数据
  npm run db:clear -- --tables "Vote,Revision"   # 只清空投票和修订数据
  npm run db:clear -- --keep-pages               # 只清空关联数据，保留页面

⚠️  警告: 此操作不可逆，请谨慎使用！
`);
    return;
  }

  const prisma = new PrismaClient();
  try {
    const stats = await getDataStats(prisma);
    console.log('📊 当前数据库状态:');
    console.log(`  页面: ${stats.pages.toLocaleString()}`);
    console.log(`  页面版本: ${stats.pageVersions.toLocaleString()}`);
    console.log(`  用户: ${stats.users.toLocaleString()}`);
    console.log(`  投票: ${stats.votes.toLocaleString()}`);
    console.log(`  修订: ${stats.revisions.toLocaleString()}`);
    console.log(`  归属: ${stats.attributions.toLocaleString()}`);
    console.log(`  Staging页面: ${stats.staging.toLocaleString()}`);
    console.log(`  脏页面: ${stats.dirtyPages.toLocaleString()}`);

    if (!options.force) {
      console.log('\n⚠️  警告: 即将清空数据库数据！');
      console.log('此操作不可逆，所有数据将被永久删除。');
      console.log('如需继续，请使用 --force 参数。');
      return;
    }

    console.log('\n🗑️  开始清空数据库...');

    if (options.tables && options.tables.length > 0) {
      await clearSpecificTables(prisma, options.tables);
    } else if (options.keepPages) {
      await clearRelatedData(prisma);
    } else if (options.keepUsers) {
      await clearExceptUsers(prisma);
    } else {
      await clearAllData(prisma);
    }

    console.log('✅ 数据库清空完成！');
  } catch (error) {
    console.error('❌ 清空失败:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

async function getDataStats(prisma: PrismaClient): Promise<{
  pages: number;
  pageVersions: number;
  users: number;
  votes: number;
  revisions: number;
  attributions: number;
  staging: number;
  dirtyPages: number;
}> {
  const [
    pages,
    pageVersions,
    users,
    votes,
    revisions,
    attributions,
    staging,
    dirtyPages,
  ] = await Promise.all([
    prisma.page.count(),
    prisma.pageVersion.count(),
    prisma.user.count(),
    prisma.vote.count(),
    prisma.revision.count(),
    prisma.attribution.count(),
    prisma.pageMetaStaging.count(),
    prisma.dirtyPage.count(),
  ]);
  return {
    pages,
    pageVersions,
    users,
    votes,
    revisions,
    attributions,
    staging,
    dirtyPages,
  };
}

async function clearSpecificTables(prisma: PrismaClient, tableList: string[]): Promise<void> {
  const tables = tableList.map((t) => t.trim());
  console.log(`🎯 清空指定表: ${tables.join(', ')}`);
  const tableMap: Record<string, () => Promise<unknown>> = {
    Vote: () => prisma.vote.deleteMany(),
    Revision: () => prisma.revision.deleteMany(),
    Attribution: () => prisma.attribution.deleteMany(),
    PageStats: () => prisma.pageStats.deleteMany(),
    SourceVersion: () => prisma.sourceVersion.deleteMany(),
    DirtyPage: () => prisma.dirtyPage.deleteMany(),
    PageMetaStaging: () => prisma.pageMetaStaging.deleteMany(),
    UserStats: () => prisma.userStats.deleteMany(),
    SearchIndex: () => prisma.searchIndex.deleteMany(),
    UserSearchIndex: () => prisma.userSearchIndex.deleteMany(),
  };
  for (const table of tables) {
    if (tableMap[table]) {
      console.log(`  清空 ${table}...`);
      await tableMap[table]();
      console.log(`  ✅ ${table} 已清空`);
    } else {
      console.log(`  ⚠️  未知表名: ${table}`);
    }
  }
}

async function clearRelatedData(prisma: PrismaClient): Promise<void> {
  console.log('🔗 清空关联数据，保留页面和用户...');
  const operations: Array<{ name: string; op: () => Promise<unknown> }> = [
    { name: 'Vote', op: () => prisma.vote.deleteMany() },
    { name: 'Revision', op: () => prisma.revision.deleteMany() },
    { name: 'Attribution', op: () => prisma.attribution.deleteMany() },
    { name: 'PageStats', op: () => prisma.pageStats.deleteMany() },
    { name: 'SourceVersion', op: () => prisma.sourceVersion.deleteMany() },
    { name: 'SearchIndex', op: () => prisma.searchIndex.deleteMany() },
    { name: 'UserSearchIndex', op: () => prisma.userSearchIndex.deleteMany() },
    { name: 'DirtyPage', op: () => prisma.dirtyPage.deleteMany() },
  ];
  for (const { name, op } of operations) {
    console.log(`  清空 ${name}...`);
    await op();
    console.log(`  ✅ ${name} 已清空`);
  }
}

async function clearExceptUsers(prisma: PrismaClient): Promise<void> {
  console.log('👥 保留用户数据，清空其他数据...');
  const operations: Array<{ name: string; op: () => Promise<unknown> }> = [
    { name: 'Vote', op: () => prisma.vote.deleteMany() },
    { name: 'Revision', op: () => prisma.revision.deleteMany() },
    { name: 'Attribution', op: () => prisma.attribution.deleteMany() },
    { name: 'PageStats', op: () => prisma.pageStats.deleteMany() },
    { name: 'SourceVersion', op: () => prisma.sourceVersion.deleteMany() },
    { name: 'SearchIndex', op: () => prisma.searchIndex.deleteMany() },
    { name: 'UserSearchIndex', op: () => prisma.userSearchIndex.deleteMany() },
    { name: 'UserStats', op: () => prisma.userStats.deleteMany() },
    { name: 'PageVersion', op: () => prisma.pageVersion.deleteMany() },
    { name: 'Page', op: () => prisma.page.deleteMany() },
    { name: 'PageMetaStaging', op: () => prisma.pageMetaStaging.deleteMany() },
    { name: 'DirtyPage', op: () => prisma.dirtyPage.deleteMany() },
  ];
  for (const { name, op } of operations) {
    console.log(`  清空 ${name}...`);
    await op();
    console.log(`  ✅ ${name} 已清空`);
  }
}

async function clearAllData(prisma: PrismaClient): Promise<void> {
  console.log('🧹 清空所有数据...');
  const operations: Array<{ name: string; op: () => Promise<any> }> = [
    { name: 'Vote', op: () => prisma.vote.deleteMany() },
    { name: 'Revision', op: () => prisma.revision.deleteMany() },
    { name: 'Attribution', op: () => prisma.attribution.deleteMany() },
    { name: 'PageStats', op: () => prisma.pageStats.deleteMany() },
    { name: 'SourceVersion', op: () => prisma.sourceVersion.deleteMany() },
    { name: 'SearchIndex', op: () => prisma.searchIndex.deleteMany() },
    { name: 'UserSearchIndex', op: () => prisma.userSearchIndex.deleteMany() },
    { name: 'UserStats', op: () => prisma.userStats.deleteMany() },
    { name: 'UserDailyStats', op: () => prisma.userDailyStats.deleteMany() },
    { name: 'PageDailyStats', op: () => prisma.pageDailyStats.deleteMany() },
    { name: 'UserActivityRecords', op: () => prisma.userActivityRecords.deleteMany() },
    { name: 'UserTagPreference', op: () => prisma.userTagPreference.deleteMany() },
    { name: 'UserVoteInteraction', op: () => prisma.userVoteInteraction.deleteMany() },
    { name: 'InterestingFacts', op: () => prisma.interestingFacts.deleteMany() },
    { name: 'TimeMilestones', op: () => prisma.timeMilestones.deleteMany() },
    { name: 'TagRecords', op: () => prisma.tagRecords.deleteMany() },
    { name: 'ContentRecords', op: () => prisma.contentRecords.deleteMany() },
    { name: 'RatingRecords', op: () => prisma.ratingRecords.deleteMany() },
    { name: 'TrendingStats', op: () => prisma.trendingStats.deleteMany() },
    { name: 'LeaderboardCache', op: () => prisma.leaderboardCache.deleteMany() },
    { name: 'AnalysisWatermark', op: () => prisma.analysisWatermark.deleteMany() },
    { name: 'SeriesStats', op: () => prisma.seriesStats.deleteMany() },
    { name: 'SiteStats', op: () => prisma.siteStats.deleteMany() },
    { name: 'PageVersion', op: () => prisma.pageVersion.deleteMany() },
    { name: 'Page', op: () => prisma.page.deleteMany() },
    { name: 'User', op: () => prisma.user.deleteMany() },
    { name: 'PageMetaStaging', op: () => prisma.pageMetaStaging.deleteMany() },
    { name: 'DirtyPage', op: () => prisma.dirtyPage.deleteMany() },
    { name: 'DirtyPageBackup', op: () => prisma.dirtyPageBackup.deleteMany() },
  ];
  for (const { name, op } of operations) {
    console.log(`  清空 ${name}...`);
    try {
      const result = await op();
      const count: number = (result && (result as any).count) || 0;
      console.log(`  ✅ ${name} 已清空 (${count} 条记录)`);
    } catch (error: any) {
      if (error && error.code === 'P2003') {
        console.log(`  ⚠️  ${name} 外键约束错误，跳过`);
      } else {
        console.log(`  ❌ ${name} 清空失败: ${error?.message ?? String(error)}`);
      }
    }
  }
}

function parseArgs(): ClearOptions {
  const args = process.argv.slice(2);
  const options: ClearOptions = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    switch (arg) {
      case '--force':
        options.force = true;
        break;
      case '--keep-users':
        options.keepUsers = true;
        break;
      case '--keep-pages':
        options.keepPages = true;
        break;
      case '--tables':
        if (i + 1 < args.length) {
          options.tables = args[++i].split(',');
        }
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        console.log(`未知参数: ${arg}`);
        console.log('使用 --help 查看帮助信息');
        process.exit(1);
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs();
  console.log('🗑️  SCPPER-CN 数据库清空工具');
  console.log('='.repeat(50));
  if (options.help) {
    await clearDatabase({ help: true });
    return;
  }

  if (options.tables && options.tables.length > 0) {
    console.log(`🎯 操作类型: 清空指定表 (${options.tables.join(', ')})`);
  } else if (options.keepUsers) {
    console.log('👥 操作类型: 保留用户数据');
  } else if (options.keepPages) {
    console.log('📄 操作类型: 保留页面数据');
  } else {
    console.log('🧹 操作类型: 清空所有数据');
  }

  await clearDatabase(options);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => {
      console.log('\n✅ 操作完成');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n❌ 操作失败:', error);
      process.exit(1);
    });
}


