import { Command } from 'commander';
import mysql from 'mysql2/promise';
import { DatabaseStore } from '../src/core/store/DatabaseStore.js';
import { Logger } from '../src/utils/Logger.js';

const program = new Command();

program
  .option('--since <date>', '只处理在该日期之后创建的页面（ISO 日期，例如 2025-08-01）')
  .option('--wikidot-id <id...>', '仅处理指定 wikidotId（可多次传入或使用逗号分隔）')
  .option('--limit <n>', '最多处理的页面数量', (value) => parseInt(value, 10))
  .option('--dry-run', '仅打印待处理页面，不执行写入')
  .parse(process.argv);

const options = program.opts<{
  since?: string;
  wikidotId?: (string | string[])[];
  limit?: number;
  dryRun?: boolean;
}>();

type BackfillResult = {
  wikidotId: number;
  url: string;
  status: 'updated' | 'skipped' | 'failed';
  reason?: string;
  revisions?: number;
};

type MysqlConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
};

type LegacyRevision = {
  wikidotId: number | null;
  timestamp: string;
  comment: string | null;
  userWikidotId?: string;
  userDisplayName?: string;
  userUnixName?: string;
};

function parseWikidotIds(raw?: (string | string[])[]): number[] {
  if (!raw) return [];
  const flattened = raw.flatMap((entry) => (Array.isArray(entry) ? entry : String(entry).split(',')));
  const ids = flattened
    .map((value) => Number.parseInt(String(value).trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  return Array.from(new Set(ids));
}

function resolveMysqlConfig(): MysqlConfig {
  const portRaw = process.env.LEGACY_MYSQL_PORT ?? '3306';
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`LEGACY_MYSQL_PORT=${portRaw} 非法`);
  }
  return {
    host: process.env.LEGACY_MYSQL_HOST ?? '127.0.0.1',
    port,
    user: process.env.LEGACY_MYSQL_USER ?? 'root',
    password: process.env.LEGACY_MYSQL_PASSWORD ?? 'mysql_5CATWG',
    database: process.env.LEGACY_MYSQL_DATABASE ?? 'scpper'
  };
}

async function connectLegacyMysql(config: MysqlConfig): Promise<{ connection: mysql.Connection; database: string }> {
  const baseConfig = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    dateStrings: true
  } as const;

  const tryConnect = async (database?: string): Promise<mysql.Connection> => {
    return mysql.createConnection({ ...baseConfig, database });
  };

  if (config.database) {
    const connection = await tryConnect(config.database);
    return { connection, database: config.database };
  }

  const discovery = await tryConnect();
  try {
    const [rows] = await discovery.execute<Array<{ db: string }>>(
      `SELECT table_schema AS db
         FROM information_schema.tables
        WHERE table_name IN ('pages', 'revisions', 'users')
          AND table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
        GROUP BY table_schema
        ORDER BY table_schema`
    );
    if (rows.length === 0) {
      throw new Error('未能自动探测到包含 legacy 数据的 MySQL 数据库。');
    }
    const candidate = rows[0].db;
    const connection = await tryConnect(candidate);
    return { connection, database: candidate };
  } finally {
    await discovery.end();
  }
}

async function fetchLegacyRevisions(mysqlConn: mysql.Connection, wikidotId: number): Promise<LegacyRevision[]> {
  const [rows] = await mysqlConn.query<Array<{
    WikidotId: number | null;
    RevisionIndex: number | null;
    DateTime: string;
    Comments: string | null;
    UserId: number | null;
    DisplayName: string | null;
    WikidotName: string | null;
  }>>(
    `SELECT r.WikidotId,
            r.RevisionIndex,
            r.DateTime,
            r.Comments,
            u.WikidotId AS UserLegacyId,
            u.DisplayName,
            u.WikidotName
       FROM revisions r
       LEFT JOIN users u
         ON u.WikidotId = r.UserId
      WHERE r.PageId = ?
      ORDER BY r.DateTime ASC`,
    [wikidotId]
  );

  return rows.map((row) => ({
    wikidotId: row.WikidotId ?? row.RevisionIndex ?? null,
    timestamp: row.DateTime,
    comment: row.Comments ?? null,
    userWikidotId: row.UserLegacyId ? String(row.UserLegacyId) : undefined,
    userDisplayName: row.DisplayName ?? row.WikidotName ?? undefined,
    userUnixName: row.WikidotName ?? undefined
  }));
}

async function main(): Promise<void> {
  const store = new DatabaseStore();
  const prisma = store.prisma;
  const mysqlConfig = resolveMysqlConfig();
  const mysqlConn = await connectLegacyMysql(mysqlConfig);
  const legacy = mysqlConn.connection;

  const { VoteRevisionStore } = await import('../src/core/store/VoteRevisionStore.js');
  const voteRevisionStore = new VoteRevisionStore(prisma);

  try {
    const wikidotIds = parseWikidotIds(options.wikidotId);
    let sinceDate: Date | undefined;
    if (options.since) {
      const parsed = new Date(options.since);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`无法解析 --since 参数：${options.since}`);
      }
      sinceDate = parsed;
    } else if (wikidotIds.length === 0) {
      sinceDate = new Date('2025-08-01T00:00:00Z');
      Logger.info('未指定 --since 或 --wikidot-id，默认仅处理 2025-08-01 之后新增的迁移页面。');
    }

    const whereClause: any = { isDeleted: true };
    if (wikidotIds.length > 0) {
      whereClause.wikidotId = { in: wikidotIds };
    } else if (sinceDate) {
      whereClause.createdAt = { gte: sinceDate };
    }

    const pages = await prisma.page.findMany({
      where: whereClause,
      orderBy: { createdAt: 'asc' },
      take: options.limit && Number.isFinite(options.limit) ? Math.max(1, options.limit) : undefined,
      select: {
        id: true,
        wikidotId: true,
        url: true,
        currentUrl: true,
        createdAt: true,
        firstPublishedAt: true,
        versions: {
          where: { validTo: null },
          select: { id: true }
        }
      }
    });

    if (pages.length === 0) {
      Logger.info('未找到需要处理的已删除页面。');
      return;
    }

    Logger.info(`待处理页面数量：${pages.length}${options.dryRun ? '（dry-run 模式）' : ''}`);

    if (options.dryRun) {
      for (const page of pages) {
        Logger.info(`  - wikidotId=${page.wikidotId} url=${page.currentUrl || page.url}`);
      }
      return;
    }

    const results: BackfillResult[] = [];

    for (const page of pages) {
      const targetUrl = page.currentUrl || page.url;
      const currentVersion = page.versions[0] ?? null;
      if (!currentVersion) {
        results.push({
          wikidotId: page.wikidotId,
          url: targetUrl || '(unknown)',
          status: 'skipped',
          reason: '未找到活跃 PageVersion'
        });
        continue;
      }

      try {
        const versionId = currentVersion.id;
        const existingRevisionCount = await prisma.revision.count({ where: { pageVersionId: versionId } });
        if (existingRevisionCount > 0) {
          results.push({
            wikidotId: page.wikidotId,
            url: targetUrl || '(unknown)',
            status: 'skipped',
            reason: 'Revision 已存在'
          });
          continue;
        }

        const legacyRevisions = await fetchLegacyRevisions(legacy, page.wikidotId);
        if (legacyRevisions.length === 0) {
          results.push({
            wikidotId: page.wikidotId,
            url: targetUrl || '(unknown)',
            status: 'skipped',
            reason: 'legacy MySQL 未找到修订记录'
          });
          continue;
        }

        await voteRevisionStore.importVotesAndRevisions(versionId, {
          revisions: {
            edges: legacyRevisions.map((rev) => ({
              node: {
                wikidotId: rev.wikidotId ?? null,
                revisionNumber: rev.wikidotId ?? null,
                timestamp: rev.timestamp,
                comment: rev.comment,
                user: rev.userWikidotId
                  ? {
                      displayName: rev.userDisplayName ?? undefined,
                      wikidotId: rev.userWikidotId,
                      username: rev.userUnixName ?? undefined
                    }
                  : null
              }
            }))
          }
        });

        const earliest = legacyRevisions[0]?.timestamp;
        if (!page.firstPublishedAt && earliest) {
          await prisma.page.update({
            where: { id: page.id },
            data: { firstPublishedAt: new Date(earliest) }
          });
        }

        results.push({
          wikidotId: page.wikidotId,
          url: targetUrl || '(unknown)',
          status: 'updated',
          revisions: legacyRevisions.length
        });
      } catch (err: any) {
        results.push({
          wikidotId: page.wikidotId,
          url: targetUrl || '(unknown)',
          status: 'failed',
          reason: err?.message ?? String(err)
        });
      }
    }

    const updated = results.filter((r) => r.status === 'updated').length;
    const skipped = results.filter((r) => r.status === 'skipped');
    const failed = results.filter((r) => r.status === 'failed');

    Logger.info(`回填修订完成：${updated} 成功，${skipped.length} 跳过，${failed.length} 失败。`);

    if (skipped.length > 0) {
      Logger.info('跳过列表：');
      for (const item of skipped) {
        Logger.info(`  - wikidotId=${item.wikidotId} url=${item.url} 原因=${item.reason}`);
      }
    }

    if (failed.length > 0) {
      Logger.error('失败列表：');
      for (const item of failed) {
        Logger.error(`  - wikidotId=${item.wikidotId} url=${item.url} 原因=${item.reason}`);
      }
      process.exitCode = 1;
    }
  } finally {
    await legacy.end();
    await store.disconnect();
  }
}

main().catch((err) => {
  Logger.error('backfill-deleted-page-revisions 脚本失败', err);
  process.exit(1);
});
