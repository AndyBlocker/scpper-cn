import { Command } from 'commander';
import mysql from 'mysql2/promise';
import { DatabaseStore } from '../src/core/store/DatabaseStore.js';
import { AttributionService } from '../src/core/store/AttributionService.js';
import { Logger } from '../src/utils/Logger.js';

type BackfillResult = {
  wikidotId: number;
  url: string;
  status: 'updated' | 'skipped' | 'failed';
  reason?: string;
};

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

type MysqlConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
};

type LegacyPageData = {
  title: string | null;
  source: string | null;
  lastUpdate: string | null;
  tags: string[];
  category: string | null;
  alternateTitles: Array<{ title: string }>;
  attributions: Array<{
    type: string;
    order: number;
    user?: { wikidotId?: string; displayName?: string; username?: string };
    anonKey?: string;
  }>;
  revisions: Array<{
    wikidotId?: number | null;
    timestamp: string;
    comment?: string | null;
    user?: { wikidotId?: string; displayName?: string; username?: string };
  }>;
};

function parseWikidotIds(raw?: (string | string[])[]): number[] {
  if (!raw) return [];
  const flattened = raw.flatMap((entry) =>
    Array.isArray(entry) ? entry : String(entry).split(',')
  );
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
        WHERE table_name IN ('sites', 'pages', 'votes', 'vote_history', 'users')
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

async function fetchLegacyPageData(mysqlConn: mysql.Connection, wikidotId: number): Promise<LegacyPageData | null> {
  const [pageRows] = await mysqlConn.query<Array<{
    __Id: number;
    Name: string | null;
    Title: string | null;
    Source: string | null;
    AltTitle: string | null;
    LastUpdate: string | null;
    CategoryId: number | null;
  }>>(
    `SELECT __Id, Name, Title, Source, AltTitle, LastUpdate, CategoryId
       FROM pages
      WHERE WikidotId = ?`,
    [wikidotId]
  );

  const pageRow = pageRows[0];
  if (!pageRow) return null;

  const pageInternalId = pageRow.__Id;
  const tags = await fetchLegacyTags(mysqlConn, pageInternalId, pageRow.Name);
  const category = await fetchLegacyCategory(mysqlConn, pageRow.CategoryId);
  const alternateTitles = deriveAlternateTitles(pageRow.AltTitle);
  const attributions = await fetchLegacyAttributions(mysqlConn, wikidotId);
  const revisions = await fetchLegacyRevisions(mysqlConn, wikidotId);

  return {
    title: pageRow.Title,
    source: pageRow.Source,
    lastUpdate: pageRow.LastUpdate,
    tags,
    category,
    alternateTitles,
    attributions,
    revisions
  };
}

async function fetchLegacyTags(mysqlConn: mysql.Connection, pageInternalId: number, slug: string | null): Promise<string[]> {
  const normalize = (values: Array<{ Tag: string | null }>): string[] =>
    values
      .map((row) => row.Tag?.trim())
      .filter((tag): tag is string => Boolean(tag));

  const [rows] = await mysqlConn.query<Array<{ Tag: string | null }>>(
    `SELECT Tag
       FROM tags
      WHERE PageId = ?`,
    [pageInternalId]
  );

  const direct = normalize(rows);
  if (direct.length > 0) {
    return direct;
  }

  if (!slug) return [];

  const [viewRows] = await mysqlConn.query<Array<{ Tag: string | null }>>(
    `SELECT Tag
       FROM view_tags
      WHERE PageName = ?`,
    [slug]
  );

  return normalize(viewRows);
}

async function fetchLegacyCategory(mysqlConn: mysql.Connection, categoryWikidotId: number | null): Promise<string | null> {
  if (!categoryWikidotId) return null;
  const [rows] = await mysqlConn.query<Array<{ Name: string | null }>>(
    `SELECT Name
       FROM categories
      WHERE WikidotId = ?
      LIMIT 1`,
    [categoryWikidotId]
  );
  const name = rows[0]?.Name?.trim();
  return name ?? null;
}

function deriveAlternateTitles(raw: string | null): Array<{ title: string }> {
  if (!raw) return [];
  const candidates = raw
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return candidates.map((title) => ({ title }));
}

async function fetchLegacyAttributions(mysqlConn: mysql.Connection, wikidotId: number): Promise<LegacyPageData['attributions']> {
  const [rows] = await mysqlConn.query<Array<{
    RoleId: number | null;
    UserId: number | null;
    WikidotId: number | null;
    DisplayName: string | null;
    WikidotName: string | null;
  }>>(
    `SELECT a.RoleId,
            a.UserId,
            u.WikidotId,
            u.DisplayName,
            u.WikidotName
       FROM authors a
       LEFT JOIN users u
         ON u.WikidotId = a.UserId
      WHERE a.PageId = ?
      ORDER BY a.RoleId ASC, a.__Id ASC`,
    [wikidotId]
  );

  if (rows.length === 0) return [];

  const orderByType = new Map<string, number>();

  return rows.map((row) => {
    const type = mapLegacyRoleToAttribution(row.RoleId);
    const order = orderByType.get(type) ?? 0;
    orderByType.set(type, order + 1);

    const wikidotUserId = row.WikidotId ?? row.UserId ?? undefined;
    const displayName = row.DisplayName ?? row.WikidotName ?? undefined;

    const attr: LegacyPageData['attributions'][number] = {
      type,
      order
    };

    if (wikidotUserId) {
      attr.user = {
        wikidotId: String(wikidotUserId),
        displayName,
        username: row.WikidotName ?? undefined
      };
    } else if (displayName) {
      attr.anonKey = `anon:${displayName}`;
    }

    return attr;
  });
}

function mapLegacyRoleToAttribution(roleId: number | null): string {
  switch (roleId) {
    case 1:
      return 'AUTHOR';
    case 2:
      return 'REWRITE';
    case 3:
      return 'TRANSLATOR';
    case 4:
      return 'CONTRIBUTOR';
    default:
      return 'AUTHOR';
  }
}

async function fetchLegacyRevisions(mysqlConn: mysql.Connection, wikidotId: number): Promise<LegacyPageData['revisions']> {
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

  return rows.map((row) => {
    const userId = row.UserLegacyId ?? row.UserId ?? undefined;
    const displayName = row.DisplayName ?? row.WikidotName ?? undefined;
    const revision: LegacyPageData['revisions'][number] = {
      wikidotId: row.WikidotId ?? row.RevisionIndex ?? null,
      timestamp: row.DateTime,
      comment: row.Comments ?? null
    };
    if (userId) {
      revision.user = {
        wikidotId: String(userId),
        displayName,
        username: row.WikidotName ?? undefined
      };
    } else if (displayName) {
      revision.user = {
        displayName,
        username: row.WikidotName ?? undefined
      };
    }
    return revision;
  });
}

async function main(): Promise<void> {
  const store = new DatabaseStore();
  const prisma = store.prisma;
  const mysqlConfig = resolveMysqlConfig();
  const mysqlConn = await connectLegacyMysql(mysqlConfig);
  const legacy = mysqlConn.connection;

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
          select: { id: true, source: true, category: true, tags: true, title: true }
        }
      }
    });

    if (pages.length === 0) {
      Logger.info('未找到需要处理的已删除页面。');
      return;
    }

    Logger.info(`待处理已删除页面数量：${pages.length}${options.dryRun ? '（dry-run 模式）' : ''}`);

    if (options.dryRun) {
      for (const page of pages) {
        Logger.info(`  - wikidotId=${page.wikidotId} url=${page.currentUrl || page.url}`);
      }
      return;
    }

    const results: BackfillResult[] = [];
    const attributionService = new AttributionService(prisma);
    const { VoteRevisionStore } = await import('../src/core/store/VoteRevisionStore.js');
    const voteRevisionStore = new VoteRevisionStore(prisma);

    for (const page of pages) {
      const targetUrl = page.currentUrl || page.url;
      if (!targetUrl) {
        results.push({
          wikidotId: page.wikidotId,
          url: '(unknown)',
          status: 'skipped',
          reason: '缺少 URL 信息'
        });
        continue;
      }

      try {
        const currentVersion = page.versions[0] ?? null;
        if (!currentVersion) {
          results.push({
            wikidotId: page.wikidotId,
            url: targetUrl,
            status: 'skipped',
            reason: '未找到活跃 PageVersion'
          });
          continue;
        }

        const currentVersionId = currentVersion.id;
        const existingAttributionCount = await prisma.attribution.count({ where: { pageVerId: currentVersionId } });
        const existingRevisionCount = await prisma.revision.count({ where: { pageVersionId: currentVersionId } });

        const missingSource = !currentVersion.source;
        const missingCategory = !currentVersion.category;
        const missingTags = !currentVersion.tags || currentVersion.tags.length === 0;
        const missingAttributions = existingAttributionCount === 0;
        const missingRevisions = existingRevisionCount === 0;
        const missingFirstPublished = !page.firstPublishedAt;

        const legacyData = await fetchLegacyPageData(legacy, page.wikidotId);
        if (!legacyData) {
          results.push({
            wikidotId: page.wikidotId,
            url: targetUrl,
            status: 'skipped',
            reason: 'legacy MySQL 未找到对应页面'
          });
          continue;
        }

        const canProvideSource = missingSource && !!legacyData.source;
        const canProvideCategory = missingCategory && !!legacyData.category;
        const canProvideTags = missingTags && legacyData.tags.length > 0;
        const canProvideAttributions = missingAttributions && legacyData.attributions.length > 0;
        const canProvideRevisions = missingRevisions && legacyData.revisions.length > 0;

        const legacyFirstTimestamp =
          legacyData.revisions.length > 0 ? legacyData.revisions[0].timestamp : legacyData.lastUpdate;
        const canProvideFirstPublished =
          !!legacyFirstTimestamp &&
          (!page.firstPublishedAt || new Date(legacyFirstTimestamp) < page.firstPublishedAt);

        if (
          !canProvideSource &&
          !canProvideCategory &&
          !canProvideTags &&
          !canProvideAttributions &&
          !canProvideRevisions &&
          !canProvideFirstPublished &&
          (!legacyData.title || legacyData.title === currentVersion.title)
        ) {
          results.push({
            wikidotId: page.wikidotId,
            url: targetUrl,
            status: 'skipped',
            reason: 'legacy 元数据与现有数据相同'
          });
          continue;
        }

        const updateData: Record<string, unknown> = { updatedAt: new Date() };
        if (canProvideSource) updateData.source = legacyData.source;
        if (canProvideCategory) updateData.category = legacyData.category;
        if (canProvideTags) updateData.tags = legacyData.tags;
        if (legacyData.title && legacyData.title !== currentVersion.title) {
          updateData.title = legacyData.title;
        }

        if (Object.keys(updateData).length > 1) {
          await prisma.pageVersion.update({
            where: { id: currentVersionId },
            data: updateData
          });
        }

        if (canProvideAttributions) {
          await attributionService.importAttributions(currentVersionId, legacyData.attributions);
        }

        if (canProvideRevisions) {
          await voteRevisionStore.importVotesAndRevisions(currentVersionId, {
            revisions: {
              edges: legacyData.revisions.map((rev) => ({
                node: {
                  wikidotId: rev.wikidotId ?? null,
                  revisionNumber: rev.wikidotId ?? null,
                  timestamp: rev.timestamp,
                  comment: rev.comment,
                  user: rev.user
                    ? {
                        displayName: rev.user.displayName,
                        wikidotId: rev.user.wikidotId,
                        username: rev.user.username
                      }
                    : null
                }
              }))
            }
          });
        }

        if (canProvideFirstPublished && legacyFirstTimestamp) {
          await prisma.page.update({
            where: { id: page.id },
            data: { firstPublishedAt: new Date(legacyFirstTimestamp) }
          });
        }

        results.push({
          wikidotId: page.wikidotId,
          url: targetUrl,
          status: 'updated'
        });
      } catch (err: any) {
        results.push({
          wikidotId: page.wikidotId,
          url: targetUrl,
          status: 'failed',
          reason: err?.message ?? String(err)
        });
      }
    }

    const updated = results.filter((r) => r.status === 'updated').length;
    const skipped = results.filter((r) => r.status === 'skipped');
    const failed = results.filter((r) => r.status === 'failed');

    Logger.info(`补全完成：${updated} 成功，${skipped.length} 跳过，${failed.length} 失败。`);

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
  Logger.error('backfill-deleted-page-metadata 脚本失败', err);
  process.exit(1);
});
