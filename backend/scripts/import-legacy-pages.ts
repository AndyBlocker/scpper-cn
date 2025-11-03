import { Command } from 'commander';
import mysql from 'mysql2/promise';
import { DatabaseStore } from '../src/core/store/DatabaseStore.js';
import { AttributionService } from '../src/core/store/AttributionService.js';
import { Logger } from '../src/utils/Logger.js';

type LegacyPageData = {
  title: string | null;
  source: string | null;
  altTitle: string | null;
  deleted: boolean;
  lastUpdate: string | null;
  slug: string;
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
    revisionNumber?: number | null;
    timestamp: string;
    comment?: string | null;
    user?: { wikidotId?: string; displayName?: string; username?: string };
  }>;
  votes: Array<{
    direction: number;
    timestamp: string;
    user?: { wikidotId?: string; displayName?: string; username?: string };
  }>;
};

type MysqlConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
};

const program = new Command();

program
  .option('--since <date>', '仅处理该日期之后在新库创建的页面（默认 2025-08-01，用于筛选迁移页面）')
  .option('--wikidot-id <id...>', '仅处理指定 wikidotId（可多次传入或使用逗号分隔）')
  .option('--limit <n>', '最多处理的页面数量', (value) => parseInt(value, 10))
  .option('--dry-run', '仅打印计划导入的页面，不执行写入')
  .parse(process.argv);

const options = program.opts<{
  since?: string;
  wikidotId?: (string | string[])[];
  limit?: number;
  dryRun?: boolean;
}>();

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
        WHERE table_name IN ('pages', 'votes', 'vote_history', 'users', 'revisions')
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
    Name: string;
    Title: string | null;
    Source: string | null;
    AltTitle: string | null;
    Deleted: number | null;
    LastUpdate: string | null;
    CategoryId: number | null;
  }>>(
    `SELECT __Id, Name, Title, Source, AltTitle, Deleted, LastUpdate, CategoryId
       FROM pages
      WHERE WikidotId = ?`,
    [wikidotId]
  );

  const pageRow = pageRows[0];
  if (!pageRow) return null;

  const pageInternalId = pageRow.__Id;
  const slug = pageRow.Name;
  const tags = await fetchLegacyTags(mysqlConn, pageInternalId);
  const category = await fetchLegacyCategory(mysqlConn, pageRow.CategoryId);
  const alternateTitles = deriveAlternateTitles(pageRow.AltTitle);
  const attributions = await fetchLegacyAttributions(mysqlConn, wikidotId);
  const revisions = await fetchLegacyRevisions(mysqlConn, wikidotId);
  const votes = await fetchLegacyVotes(mysqlConn, wikidotId);

  return {
    title: pageRow.Title,
    source: pageRow.Source,
    altTitle: pageRow.AltTitle,
    deleted: Number(pageRow.Deleted ?? 0) === 1,
    lastUpdate: pageRow.LastUpdate,
    slug,
    tags,
    category,
    alternateTitles,
    attributions,
    revisions,
    votes
  };
}

async function fetchLegacyTags(mysqlConn: mysql.Connection, pageInternalId: number): Promise<string[]> {
  const [rows] = await mysqlConn.query<Array<{ Tag: string | null }>>(
    `SELECT Tag
       FROM tags
      WHERE PageId = ?`,
    [pageInternalId]
  );
  return rows
    .map((row) => row.Tag?.trim())
    .filter((tag): tag is string => Boolean(tag));
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
    const wikidotUserId = row.UserLegacyId ?? row.UserId ?? undefined;
    const displayName = row.DisplayName ?? row.WikidotName ?? undefined;
    const revision: LegacyPageData['revisions'][number] = {
      wikidotId: row.WikidotId ?? row.RevisionIndex ?? null,
      revisionNumber: row.RevisionIndex ?? null,
      timestamp: row.DateTime,
      comment: row.Comments ?? null
    };
    if (wikidotUserId || displayName) {
      revision.user = {
        wikidotId: wikidotUserId ? String(wikidotUserId) : undefined,
        displayName,
        username: row.WikidotName ?? undefined
      };
    }
    return revision;
  });
}

async function fetchLegacyVotes(mysqlConn: mysql.Connection, wikidotId: number): Promise<LegacyPageData['votes']> {
  const [rows] = await mysqlConn.query<Array<{
    Value: number;
    DateTime: string;
    UserId: number | null;
    DisplayName: string | null;
    WikidotName: string | null;
  }>>(
    `SELECT v.Value,
            v.DateTime,
            u.WikidotId AS UserLegacyId,
            u.DisplayName,
            u.WikidotName
       FROM votes v
       LEFT JOIN users u
         ON u.WikidotId = v.UserId
      WHERE v.PageId = ?`,
    [wikidotId]
  );

  return rows.map((row) => {
    const direction = Number(row.Value ?? 0);
    const wikidotUserId = row.UserLegacyId ?? row.UserId ?? undefined;
    const displayName = row.DisplayName ?? row.WikidotName ?? undefined;
    const vote: LegacyPageData['votes'][number] = {
      direction,
      timestamp: row.DateTime
    };
    if (wikidotUserId || displayName) {
      vote.user = {
        wikidotId: wikidotUserId ? String(wikidotUserId) : undefined,
        displayName,
        username: row.WikidotName ?? undefined
      };
    }
    return vote;
  });
}

async function main(): Promise<void> {
  const store = new DatabaseStore();
  const prisma = store.prisma;
  const mysqlConfig = resolveMysqlConfig();
  const mysqlConn = await connectLegacyMysql(mysqlConfig);
  const legacy = mysqlConn.connection;

  const attributionService = new AttributionService(prisma);
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

    let candidates: number[] = [];
    if (wikidotIds.length > 0) {
      candidates = wikidotIds;
    } else if (sinceDate) {
      const [rows] = await legacy.query<Array<{ WikidotId: number }>>(
        `SELECT WikidotId
           FROM pages
          WHERE LastUpdate >= ?
          ORDER BY LastUpdate ASC`,
        [sinceDate.toISOString().slice(0, 19).replace('T', ' ')]
      );
      candidates = rows.map((row) => Number(row.WikidotId));
    } else {
      Logger.warn('未指定任何筛选条件，终止操作。');
      return;
    }

    if (options.limit && Number.isFinite(options.limit) && options.limit > 0) {
      candidates = candidates.slice(0, options.limit);
    }

    if (candidates.length === 0) {
      Logger.info('未找到需要导入的页面。');
      return;
    }

    Logger.info(`待处理页面数量：${candidates.length}${options.dryRun ? '（dry-run 模式）' : ''}`);

    if (options.dryRun) {
      for (const wikidotId of candidates) {
        Logger.info(`  - wikidotId=${wikidotId}`);
      }
      return;
    }

    let imported = 0;
    let updated = 0;
    const failures: Array<{ wikidotId: number; reason: string }> = [];

    for (const wikidotId of candidates) {
      const legacyData = await fetchLegacyPageData(legacy, wikidotId);
      if (!legacyData) {
        failures.push({ wikidotId, reason: 'legacy MySQL 未找到页面数据' });
        continue;
      }

      try {
        const pageUrl = buildCanonicalUrl(legacyData.slug);
        const urlHistory = Array.from(new Set([pageUrl]));
        const aggregatedRating = legacyData.votes.reduce((sum, vote) => sum + Number(vote.direction ?? 0), 0);
        const upvotes = legacyData.votes.filter((vote) => vote.direction > 0).length;
        const downvotes = legacyData.votes.filter((vote) => vote.direction < 0).length;
        const firstRevisionTimestamp = legacyData.revisions[0]?.timestamp ?? legacyData.lastUpdate ?? new Date().toISOString();
        const firstRevisionDate = new Date(firstRevisionTimestamp);

        let page = await prisma.page.findUnique({ where: { wikidotId } });
        let versionId: number;

        if (!page) {
          page = await prisma.page.create({
            data: {
              wikidotId,
              url: pageUrl,
              currentUrl: pageUrl,
              urlHistory,
              isDeleted: legacyData.deleted,
              firstPublishedAt: firstRevisionDate,
              createdAt: new Date()
            }
          });
          const pageVersion = await prisma.pageVersion.create({
            data: {
              pageId: page.id,
              wikidotId,
              title: legacyData.title ?? legacyData.slug,
              source: legacyData.source ?? null,
              textContent: legacyData.source ?? null,
              rating: aggregatedRating,
              voteCount: legacyData.votes.length,
              revisionCount: legacyData.revisions.length,
              commentCount: null,
              tags: legacyData.tags,
              category: legacyData.category ?? null,
              isDeleted: legacyData.deleted,
              validFrom: firstRevisionDate,
              validTo: null,
              createdAt: new Date(),
              updatedAt: new Date(),
              alternateTitle: legacyData.alternateTitles[0]?.title ?? null
            }
          });
          versionId = pageVersion.id;
          imported++;
        } else {
          const pageUpdate: Record<string, unknown> = {
            isDeleted: legacyData.deleted,
            updatedAt: new Date()
          };
          if (!page.firstPublishedAt || firstRevisionDate < page.firstPublishedAt) {
            pageUpdate.firstPublishedAt = firstRevisionDate;
          }
          await prisma.page.update({
            where: { id: page.id },
            data: pageUpdate
          });

          const latestVersion = await prisma.pageVersion.findFirst({
            where: { pageId: page.id, validTo: null },
            orderBy: { validFrom: 'desc' }
          });

          let activeVersionId = latestVersion?.id;
          if (!activeVersionId) {
            const pageVersion = await prisma.pageVersion.create({
              data: {
                pageId: page.id,
                wikidotId,
                title: legacyData.title ?? legacyData.slug,
                source: legacyData.source ?? null,
                textContent: legacyData.source ?? null,
                rating: aggregatedRating,
                voteCount: legacyData.votes.length,
                revisionCount: legacyData.revisions.length,
                commentCount: null,
                tags: legacyData.tags,
                category: legacyData.category ?? null,
                isDeleted: legacyData.deleted,
                validFrom: firstRevisionDate,
                validTo: null,
                createdAt: new Date(),
                updatedAt: new Date(),
                alternateTitle: legacyData.alternateTitles[0]?.title ?? null
              }
            });
            activeVersionId = pageVersion.id;
          } else {
            const updateData: Record<string, unknown> = {
              updatedAt: new Date(),
              tags: legacyData.tags,
              category: legacyData.category ?? null
            };
            if (legacyData.source) updateData.source = legacyData.source;
            if (legacyData.title) updateData.title = legacyData.title;
            if (legacyData.alternateTitles.length > 0) {
              updateData.alternateTitle = legacyData.alternateTitles[0].title;
            }
            updateData.isDeleted = legacyData.deleted;
            await prisma.pageVersion.update({
              where: { id: activeVersionId },
              data: updateData
            });
          }
          versionId = activeVersionId!;
          updated++;
        }

        if (legacyData.attributions.length > 0) {
          await attributionService.importAttributions(versionId, legacyData.attributions);
        }

        await voteRevisionStore.importVotesAndRevisions(versionId, {
          revisions: {
            edges: legacyData.revisions.map((rev) => ({
              node: rev
            }))
          },
          votes: {
            edges: legacyData.votes.map((vote) => ({
              node: {
                direction: vote.direction,
                timestamp: vote.timestamp,
                userWikidotId: vote.user?.wikidotId,
                user: vote.user
                  ? {
                      displayName: vote.user.displayName,
                      wikidotId: vote.user.wikidotId
                    }
                  : null
              }
            }))
          }
        });

        await prisma.pageVersion.update({
          where: { id: versionId },
          data: {
            rating: aggregatedRating,
            voteCount: legacyData.votes.length,
            revisionCount: legacyData.revisions.length,
            updatedAt: new Date()
          }
        });
      } catch (err: any) {
        failures.push({ wikidotId, reason: err?.message ?? String(err) });
      }
    }

    Logger.info(`导入完成：新建 ${imported} 条，更新 ${updated} 条，失败 ${failures.length} 条。`);
    if (failures.length > 0) {
      for (const failure of failures) {
        Logger.error(`  - wikidotId=${failure.wikidotId} 失败原因：${failure.reason}`);
      }
    }
  } finally {
    await legacy.end();
    await store.disconnect();
  }
}

function buildCanonicalUrl(slug: string): string {
  if (!slug) return 'https://scp-wiki-cn.wikidot.com';
  if (/^https?:\/\//i.test(slug)) return slug;
  return `https://scp-wiki-cn.wikidot.com/${slug}`;
}

main().catch((err) => {
  Logger.error('import-legacy-pages 脚本失败', err);
  process.exit(1);
});
