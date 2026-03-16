import { Prisma, PrismaClient } from '@prisma/client';
import mysql from 'mysql2/promise';
import { disconnectPrisma, getPrismaClient } from '../utils/db-connection.js';
import { Logger } from '../utils/Logger.js';

type LegacyVoteMigrationOptions = {
  legacySchema?: string;
  maxDate?: string;
  timezone?: string;
  apply?: boolean;
  chunkSize?: number;
  pageWids?: number[];
};

type MysqlLegacyConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
};

type LegacyPageRow = {
  pageWid: number;
  slug: string;
  title: string | null;
  existingPageId: number | null;
  slugMatchPageId: number | null;
};

type LegacyPageMeta = LegacyPageRow & {
  deleted: boolean;
  lastUpdate: Date | null;
  earliestVote: Date | null;
  latestVote: Date | null;
  voteCount: number;
};

type LegacyUserMeta = {
  wikidotId: number;
  username: string;
  displayName: string | null;
};

type DbClient = PrismaClient | Prisma.TransactionClient;

const DEFAULT_LEGACY_SCHEMA = 'legacy_votes_cn';
const DEFAULT_MAX_DATE = '2022-06-01';
const DEFAULT_TIMEZONE = '+00:00';
const INSERT_BATCH_SIZE = 1_000;

export async function runLegacyVoteMigration(options: LegacyVoteMigrationOptions = {}): Promise<void> {
  const prisma = getPrismaClient();
  const prepared = prepareOptions(options);
  Logger.info(`使用 legacy schema：${prepared.legacySchema}`);
  Logger.info(`导入时间上限：${prepared.maxDate}（含当天 00:00:00）`);
  Logger.info(`解析旧库时间使用偏移：UTC${prepared.timezoneOffset}`);
  if (prepared.pageWhitelist.length > 0) {
    Logger.info(`仅处理指定 legacy WikidotId：${prepared.pageWhitelist.join(', ')}`);
  }
  Logger.info(prepared.apply ? '⚠️ 将执行 destructive apply 流程。' : '🧪 Dry run，仅生成统计与计划。');

  const mysqlConfig = resolveMysqlConfig();
  const mysqlConnection = await connectLegacyMysql(mysqlConfig);
  Logger.info(`已连接 MySQL：${mysqlConfig.user}@${mysqlConfig.host}:${mysqlConfig.port}/${mysqlConnection.database}`);

  try {
    await withTransaction(prisma, async (tx) => {
      await ensureLegacySchema(tx, prepared.legacySchema);
      const siteInfo = await getLegacySiteInfo(tx, prepared.legacySchema);
      if (!siteInfo) {
        throw new Error(`Schema "${prepared.legacySchema}" 中未找到站点信息。`);
      }

      const legacyPages = await collectLegacyPages(tx, prepared.legacySchema, siteInfo.baseUrl, prepared.pageWhitelist);
      if (legacyPages.length === 0) {
        Logger.warn('未在 legacy 数据中找到符合筛选条件的页面。');
      }
      const voteStats = await collectLegacyVoteStats(tx, prepared.legacySchema, prepared.maxDateIso, prepared.pageWhitelist);
      const enrichedPages = await enrichPageMeta(legacyPages, voteStats, mysqlConnection.connection, prepared.timezoneOffset);

      const missingPages = enrichedPages.filter((page) => page.existingPageId == null);
      const existingPages = enrichedPages.filter((page) => page.existingPageId != null);
      const missingUserMetas = await collectMissingUsers(tx, prepared.legacySchema, prepared.maxDateIso, prepared.pageWhitelist);
      const enrichedUsers = await enrichUserMeta(missingUserMetas, mysqlConnection.connection);

      await printSummary({
        totalLegacyPages: enrichedPages.length,
        missingPageCount: missingPages.length,
        existingPageCount: existingPages.length,
        slugReuseCount: enrichedPages.filter((page) => page.slugMatchPageId != null && page.existingPageId == null).length,
        missingUserCount: enrichedUsers.length,
        totalLegacyVotes: voteStats.totalVotes,
        totalLegacyHistory: voteStats.totalHistory,
        minTimestamp: voteStats.minTimestamp,
        maxTimestamp: voteStats.maxTimestamp
      });

      if (!prepared.apply) {
        Logger.info('Dry run 模式下不执行写入操作。');
        return;
      }

      Logger.info('开始执行 apply 流程……');
      const pageIdMap = await createMissingPages(tx, missingPages, siteInfo, prepared.chunkSize);
      const combinedPages = mergePageIdMaps(existingPages, missingPages, pageIdMap);

      const legacyVersions = await createHistoricalPageVersions(tx, combinedPages, prepared.maxDateIso, prepared.chunkSize);
      await reassignLegacyRevisions(tx, legacyVersions, prepared.maxDateIso, prepared.chunkSize, prepared.pageWhitelist.length === 0);
      await upsertMissingUsers(tx, enrichedUsers, prepared.chunkSize);
      await purgePreCutoffVotes(tx, prepared.maxDateIso, Array.from(legacyVersions.keys()), prepared.chunkSize);
      await insertLegacyVotes(tx, prepared.legacySchema, prepared.maxDateIso, legacyVersions, prepared.chunkSize, prepared.pageWhitelist);

      Logger.info('apply 流程完成。');
    });
  } finally {
    await mysqlConnection.connection.end();
    await disconnectPrisma();
  }
}

function prepareOptions(raw: LegacyVoteMigrationOptions) {
  const legacySchema = normalizeSchemaName(raw.legacySchema ?? DEFAULT_LEGACY_SCHEMA);
  if (!legacySchema) {
    throw new Error('legacy schema 不能为空');
  }
  const maxDate = (raw.maxDate ?? DEFAULT_MAX_DATE).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(maxDate)) {
    throw new Error(`max-date "${maxDate}" 格式应为 YYYY-MM-DD`);
  }
  const timezoneOffset = normalizeTimezone(raw.timezone ?? DEFAULT_TIMEZONE);
  const maxDateIso = `${maxDate}T00:00:00Z`;
  const pageWhitelist = Array.isArray(raw.pageWids) ? raw.pageWids.filter((id) => Number.isFinite(id)) : [];
  return {
    legacySchema,
    maxDate,
    maxDateIso,
    timezoneOffset,
    apply: Boolean(raw.apply),
    chunkSize: raw.chunkSize && raw.chunkSize > 0 ? Math.min(raw.chunkSize, INSERT_BATCH_SIZE) : INSERT_BATCH_SIZE,
    pageWhitelist
  };
}

function normalizeSchemaName(input: string): string {
  const value = input.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`非法的 schema 名称：${input}`);
  }
  return value;
}

function normalizeTimezone(input: string): string {
  const trimmed = input.trim().toUpperCase();
  if (trimmed === 'UTC' || trimmed === '+00:00' || trimmed === '-00:00') return '+00:00';
  if (!/^[+-]\d{2}:\d{2}$/.test(trimmed)) {
    throw new Error(`不支持的时区偏移：${input}`);
  }
  return trimmed;
}

async function withTransaction<T>(
  prisma: PrismaClient,
  task: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction((inner) => task(inner), {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    timeout: 300_000
  });
}

async function ensureLegacySchema(prisma: DbClient, schema: string): Promise<void> {
  const rows = await prisma.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
    select exists (
      select 1
      from information_schema.tables
      where table_schema = ${schema}
        and table_name in ('pages', 'votes', 'vote_history')
    ) as "exists"
  `);
  if (!rows[0]?.exists) {
    throw new Error(`schema "${schema}" 不完整，请先运行 legacy-vote-refresh`);
  }
}

async function getLegacySiteInfo(
  prisma: DbClient,
  schema: string
): Promise<{ siteId: number; domain: string; protocol: string; baseUrl: string } | null> {
  const result = await prisma.$queryRawUnsafe<Array<{ WikidotId: number; Domain: string; Protocol: string }>>(
    `select "WikidotId", "Domain", coalesce("Protocol", 'https') as "Protocol"
       from "${schema}"."sites"
      order by "WikidotId"
      limit 1`
  );
  if (!result[0]) return null;
  const domain = result[0].Domain;
  const protocol = result[0].Protocol || 'https';
  return {
    siteId: Number(result[0].WikidotId),
    domain,
    protocol,
    baseUrl: `${protocol}://${domain}`
  };
}

async function collectLegacyPages(
  prisma: DbClient,
  schema: string,
  baseUrl: string,
  pageWhitelist: number[]
): Promise<LegacyPageRow[]> {
  const safeBaseUrl = baseUrl.replace(/'/g, "''");
  const whereClause = pageWhitelist.length > 0 ? `where p."WikidotId" in (${pageWhitelist.join(',')})` : '';
  const rows = await prisma.$queryRawUnsafe<Array<{
    page_wid: bigint;
    slug: string;
    title: string | null;
    existing_page_id: bigint | null;
    slug_match_page_id: bigint | null;
  }>>(
    `select
        p."WikidotId" as page_wid,
        p."Name" as slug,
        p."Title" as title,
        cur."id" as existing_page_id,
        slug_map."id" as slug_match_page_id
      from "${schema}"."pages" p
      left join "Page" cur
        on cur."wikidotId" = p."WikidotId"
      left join lateral (
        select mp."id"
        from "Page" mp
        where mp."currentUrl" = '${safeBaseUrl}/' || p."Name"
        order by mp."id"
        limit 1
      ) slug_map on true
      ${whereClause}`
  );
  return rows.map((row) => ({
    pageWid: Number(row.page_wid),
    slug: row.slug,
    title: row.title,
    existingPageId: row.existing_page_id != null ? Number(row.existing_page_id) : null,
    slugMatchPageId: row.slug_match_page_id != null ? Number(row.slug_match_page_id) : null
  }));
}

async function collectLegacyVoteStats(
  prisma: DbClient,
  schema: string,
  maxDateIso: string,
  pageWhitelist: number[]
): Promise<{
  totalVotes: number;
  totalHistory: number;
  minTimestamp: Date | null;
  maxTimestamp: Date | null;
  perPage: Map<number, { earliest: Date | null; latest: Date | null; count: number }>;
}> {
  const [counts] = await prisma.$queryRawUnsafe<Array<{
    total_votes: bigint;
    total_history: bigint;
    min_ts: Date | null;
    max_ts: Date | null;
  }>>(
    `select
        (select count(*) from "${schema}"."votes" where ( "DateTime" is null or "DateTime" < '${maxDateIso}' ) ${pageWhitelistFilter('PageId', pageWhitelist)}) as total_votes,
        (select count(*) from "${schema}"."vote_history" where ( "DateTime" is null or "DateTime" < '${maxDateIso}' ) ${pageWhitelistFilter('PageId', pageWhitelist)}) as total_history,
        (select min("DateTime") from "${schema}"."votes" where ( "DateTime" is null or "DateTime" < '${maxDateIso}' ) ${pageWhitelistFilter('PageId', pageWhitelist)}) as min_ts,
        (select max("DateTime") from "${schema}"."votes" where ( "DateTime" is null or "DateTime" < '${maxDateIso}' ) ${pageWhitelistFilter('PageId', pageWhitelist)}) as max_ts`
  );

  const perPageRows = await prisma.$queryRawUnsafe<Array<{
    page_wid: bigint;
    earliest: Date | null;
    latest: Date | null;
    vote_count: bigint;
  }>>(
    `with events as (
        select v."PageId" as page_wid, v."DateTime" as ts
        from "${schema}"."votes" v
        where v."DateTime" is null or v."DateTime" < '${maxDateIso}'
          ${pageWhitelistFilter('PageId', pageWhitelist, 'v.')}
        union all
        select h."PageId" as page_wid, h."DateTime" as ts
        from "${schema}"."vote_history" h
        where h."DateTime" is null or h."DateTime" < '${maxDateIso}'
          ${pageWhitelistFilter('PageId', pageWhitelist, 'h.')}
      )
      select
        page_wid,
        min(ts) filter (where ts is not null) as earliest,
        max(ts) filter (where ts is not null) as latest,
        count(*) as vote_count
      from events
      group by page_wid`
  );

  const perPage = new Map<number, { earliest: Date | null; latest: Date | null; count: number }>();
  for (const row of perPageRows) {
    perPage.set(Number(row.page_wid), {
      earliest: row.earliest,
      latest: row.latest,
      count: Number(row.vote_count)
    });
  }

  return {
    totalVotes: Number(counts?.total_votes ?? 0n),
    totalHistory: Number(counts?.total_history ?? 0n),
    minTimestamp: counts?.min_ts ?? null,
    maxTimestamp: counts?.max_ts ?? null,
    perPage
  };
}

async function enrichPageMeta(
  base: LegacyPageRow[],
  stats: {
    perPage: Map<number, { earliest: Date | null; latest: Date | null; count: number }>;
  },
  mysql: mysql.Connection,
  timezoneOffset: string
): Promise<LegacyPageMeta[]> {
  if (base.length === 0) return [];
  const missingWids = base.filter((page) => page.existingPageId == null).map((page) => page.pageWid);
  const mysqlMeta = await fetchMysqlPageMeta(mysql, missingWids, timezoneOffset);
  const mysqlMetaMap = new Map<number, { deleted: boolean; lastUpdate: Date | null }>();
  for (const meta of mysqlMeta) {
    mysqlMetaMap.set(meta.wikidotId, {
      deleted: meta.deleted,
      lastUpdate: meta.lastUpdate
    });
  }

  return base.map((page) => {
    const stat = stats.perPage.get(page.pageWid) ?? { earliest: null, latest: null, count: 0 };
    const mysqlInfo = mysqlMetaMap.get(page.pageWid);
    return {
      ...page,
      deleted: mysqlInfo?.deleted ?? false,
      lastUpdate: mysqlInfo?.lastUpdate ?? null,
      earliestVote: stat.earliest,
      latestVote: stat.latest,
      voteCount: stat.count
    };
  });
}

async function fetchMysqlPageMeta(
  mysql: mysql.Connection,
  wids: number[],
  timezoneOffset: string
): Promise<Array<{ wikidotId: number; deleted: boolean; lastUpdate: Date | null }>> {
  if (wids.length === 0) return [];
  const chunks = chunkArray(wids, 1_000);
  const result: Array<{ wikidotId: number; deleted: boolean; lastUpdate: Date | null }> = [];
  for (const chunk of chunks) {
    const [rows] = await mysql.query(
      `SELECT WikidotId, Deleted, LastUpdate
         FROM pages
        WHERE WikidotId IN (${chunk.map(() => '?').join(',')})`,
      chunk
    ) as [Array<{ WikidotId: number; Deleted: number; LastUpdate: string | null }>, unknown];
    for (const row of rows) {
      result.push({
        wikidotId: Number(row.WikidotId),
        deleted: Number(row.Deleted ?? 0) === 1,
        lastUpdate: row.LastUpdate ? parseMysqlDate(row.LastUpdate, timezoneOffset) : null
      });
    }
  }
  return result;
}

async function collectMissingUsers(
  prisma: DbClient,
  schema: string,
  maxDateIso: string,
  pageWhitelist: number[]
): Promise<number[]> {
  const rows = await prisma.$queryRawUnsafe<Array<{ user_wid: bigint }>>(
    `with legacy_users as (
        select distinct nullif(v."UserId", 0) as user_wid
        from "${schema}"."votes" v
        where (v."DateTime" is null or v."DateTime" < '${maxDateIso}')
          ${pageWhitelistFilter('PageId', pageWhitelist, 'v.')}
        union
        select distinct nullif(h."UserId", 0) as user_wid
        from "${schema}"."vote_history" h
        where (h."DateTime" is null or h."DateTime" < '${maxDateIso}')
          ${pageWhitelistFilter('PageId', pageWhitelist, 'h.')}
      )
      select user_wid
      from legacy_users
      where user_wid is not null
        and not exists (
          select 1
          from "User" u
          where u."wikidotId" = user_wid
        )
      order by user_wid`
  );
  return rows.map((row) => Number(row.user_wid));
}

async function enrichUserMeta(ids: number[], mysql: mysql.Connection): Promise<LegacyUserMeta[]> {
  if (ids.length === 0) return [];
  const chunks = chunkArray(ids, 1_000);
  const result: LegacyUserMeta[] = [];
  for (const chunk of chunks) {
    const [rows] = await mysql.query(
      `SELECT WikidotId, WikidotName, DisplayName
         FROM users
        WHERE WikidotId IN (${chunk.map(() => '?').join(',')})`,
      chunk
    ) as [Array<{ WikidotId: number; WikidotName: string; DisplayName: string | null }>, unknown];
    for (const row of rows) {
      result.push({
        wikidotId: Number(row.WikidotId),
        username: row.WikidotName,
        displayName: row.DisplayName
      });
    }
  }
  return result;
}

async function printSummary(summary: {
  totalLegacyPages: number;
  missingPageCount: number;
  existingPageCount: number;
  slugReuseCount: number;
  missingUserCount: number;
  totalLegacyVotes: number;
  totalLegacyHistory: number;
  minTimestamp: Date | null;
  maxTimestamp: Date | null;
}): Promise<void> {
  Logger.info('=== 迁移规划概览 ===');
  Logger.info(`旧库页数：${summary.totalLegacyPages}`);
  Logger.info(`需新建 Page：${summary.missingPageCount}`);
  Logger.info(`已有 Page：${summary.existingPageCount}`);
  Logger.info(`与现有 slug 重复的历史页：${summary.slugReuseCount}`);
  Logger.info(`需补齐 User：${summary.missingUserCount}`);
  Logger.info(`legacy votes 总计：${summary.totalLegacyVotes}`);
  Logger.info(`legacy vote_history 总计：${summary.totalLegacyHistory}`);
  Logger.info(`最早投票时间：${summary.minTimestamp ?? '无数据'}`);
  Logger.info(`最晚投票时间：${summary.maxTimestamp ?? '无数据'}`);
}

async function createMissingPages(
  prisma: DbClient,
  pages: LegacyPageMeta[],
  siteInfo: { baseUrl: string },
  chunkSize: number
): Promise<Map<number, number>> {
  if (pages.length === 0) return new Map();
  Logger.info(`开始创建缺失 Page：共 ${pages.length} 条。`);
  const now = new Date();
  const idMap = new Map<number, number>();
  const chunks = chunkArray(pages, chunkSize);
  for (const chunk of chunks) {
    const data = chunk.map((page) => {
      const url = `${siteInfo.baseUrl}/${page.slug}`;
      const firstPublished = page.earliestVote ?? page.lastUpdate ?? now;
      return {
        wikidotId: page.pageWid,
        url,
        currentUrl: url,
        urlHistory: [url] as string[],
        isDeleted: page.deleted,
        firstPublishedAt: firstPublished,
        createdAt: now,
        updatedAt: now
      };
    });
    const result = await prisma.page.createMany({
      data,
      skipDuplicates: true
    });
    if (result.count !== data.length) {
      Logger.warn(`createMany 结果 ${result.count} 与数据量 ${data.length} 不一致，可能部分记录已存在。`);
    }
  }

  const inserted = await prisma.page.findMany({
    where: { wikidotId: { in: pages.map((page) => page.pageWid) } },
    select: { id: true, wikidotId: true }
  });
  for (const row of inserted) {
    idMap.set(row.wikidotId, row.id);
  }
  Logger.info('缺失 Page 创建完成。');
  return idMap;
}

function mergePageIdMaps(
  existing: LegacyPageMeta[],
  missing: LegacyPageMeta[],
  newMap: Map<number, number>
): Map<number, { pageId: number; earliest: Date | null; latest: Date | null; slug: string; title: string | null; deleted: boolean }> {
  const map = new Map<number, { pageId: number; earliest: Date | null; latest: Date | null; slug: string; title: string | null; deleted: boolean }>();
  for (const page of existing) {
    if (page.existingPageId == null) continue;
    map.set(page.pageWid, {
      pageId: page.existingPageId,
      earliest: page.earliestVote,
      latest: page.latestVote,
      slug: page.slug,
      title: page.title,
      deleted: page.deleted
    });
  }
  for (const meta of missing) {
    const mappedId = newMap.get(meta.pageWid);
    if (!mappedId) continue;
    map.set(meta.pageWid, {
      pageId: mappedId,
      earliest: meta.earliestVote ?? meta.lastUpdate ?? null,
      latest: meta.latestVote,
      slug: meta.slug,
      title: meta.title,
      deleted: meta.deleted
    });
  }
  return map;
}

async function createHistoricalPageVersions(
  prisma: DbClient,
  pageMap: Map<number, { pageId: number; earliest: Date | null; latest: Date | null; slug: string; title: string | null; deleted: boolean }>,
  cutoffIso: string,
  chunkSize: number
): Promise<Map<number, number>> {
  if (pageMap.size === 0) return new Map();
  Logger.info('准备 PageVersion...');
  const pageIds = Array.from(new Set(Array.from(pageMap.values()).map((entry) => entry.pageId)));
  const existingVersions = await prisma.pageVersion.findMany({
    where: { pageId: { in: pageIds } },
    select: { id: true, pageId: true, validFrom: true, validTo: true },
    orderBy: [{ pageId: 'asc' }, { validFrom: 'asc' }]
  });
  const versionsByPage = new Map<number, Array<{ id: number; validFrom: Date; validTo: Date | null }>>();
  for (const version of existingVersions) {
    const bucket = versionsByPage.get(version.pageId);
    if (bucket) {
      bucket.push({ id: version.id, validFrom: version.validFrom, validTo: version.validTo });
    } else {
      versionsByPage.set(version.pageId, [{ id: version.id, validFrom: version.validFrom, validTo: version.validTo }]);
    }
  }

  const toInsert: Array<{
    pageId: number;
    validFrom: Date;
    validTo: Date | null;
    title: string | null;
    isDeleted: boolean;
    createdAt: Date;
    updatedAt: Date;
  }> = [];
  const cutoff = new Date(cutoffIso);
  const toUnlockActive = new Map<number, number>();
  for (const entry of pageMap.values()) {
    const earliest = entry.earliest ?? subtractSeconds(cutoff, 1);
    const versionBucket = versionsByPage.get(entry.pageId) ?? [];
    const hasActive = versionBucket.some((version) => version.validTo == null);
    if (hasActive) {
      continue;
    }

    if (versionBucket.length > 0) {
      // 说明之前迁移创建了封闭版本但没有活跃版本；解锁最新版本作为当前快照
      const latest = versionBucket[versionBucket.length - 1];
      toUnlockActive.set(entry.pageId, latest.id);
      continue;
    }

    toInsert.push({
      pageId: entry.pageId,
      validFrom: earliest,
      validTo: null,
      title: entry.title,
      isDeleted: entry.deleted,
      createdAt: new Date(),
      updatedAt: new Date()
    });
  }

  const chunks = chunkArray(toInsert, chunkSize);
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    await prisma.pageVersion.createMany({ data: chunk });
  }

  if (toUnlockActive.size > 0) {
    const updates = chunkArray(Array.from(toUnlockActive.values()), chunkSize);
    for (const chunk of updates) {
      if (chunk.length === 0) continue;
      await prisma.pageVersion.updateMany({
        where: { id: { in: chunk } },
        data: { validTo: null, updatedAt: new Date() }
      });
    }
  }

  const versionRows = await prisma.pageVersion.findMany({
    where: { pageId: { in: pageIds } },
    select: { id: true, pageId: true, validFrom: true, validTo: true },
    orderBy: [{ pageId: 'asc' }, { validFrom: 'asc' }]
  });
  const versionMap = new Map<number, number>();
  for (const row of versionRows) {
    if (row.validTo == null) {
      versionMap.set(row.pageId, row.id);
      continue;
    }
    if (!versionMap.has(row.pageId)) {
      versionMap.set(row.pageId, row.id);
    }
  }
  Logger.info('PageVersion 准备完成。');
  return versionMap;
}

async function reassignLegacyRevisions(
  prisma: DbClient,
  versionMap: Map<number, number>,
  cutoffIso: string,
  chunkSize: number,
  skipRevisionMigration: boolean
): Promise<void> {
  if (versionMap.size === 0) return;
  if (skipRevisionMigration) {
    Logger.warn('检测到全量迁移，跳过 Revision 历史迁移以避免唯一键冲突。');
    return;
  }
  Logger.info('开始迁移历史 Revision 到对应 PageVersion...');
  const pairs = Array.from(versionMap.entries());
  const chunks = chunkArray(pairs, chunkSize);
  for (const chunk of chunks) {
    const pageIds = chunk.map(([pageId]) => pageId);
    const versionIds = chunk.map(([, versionId]) => versionId);
    if (pageIds.length === 0) continue;
    const sql = Prisma.sql`
      with mapping("pageId", "versionId") as (
        select *
        from unnest(${pageIds}::int[], ${versionIds}::int[])
        as m("pageId", "versionId")
      )
      , candidate as (
        select
          r."id",
          r."wikidotId",
          mapping."versionId"
        from "Revision" r
        join "PageVersion" pv on pv."id" = r."pageVersionId"
        join mapping on mapping."pageId" = pv."pageId"
        where r."timestamp" < ${cutoffIso}::timestamptz
          and pv."id" <> mapping."versionId"
      )
      , filtered as (
        select c.*
        from candidate c
        where c."wikidotId" is null
          or not exists (
            select 1
            from "Revision" existing
            where existing."pageVersionId" = c."versionId"
              and (
                (c."wikidotId" is null and existing."wikidotId" is null)
                or existing."wikidotId" = c."wikidotId"
              )
          )
      )
      update "Revision" r
      set "pageVersionId" = filtered."versionId"
      from filtered
      where r."id" = filtered."id"
    `;
    try {
      await prisma.$executeRaw(sql);
    } catch (error: any) {
      if (String(error?.message ?? '').includes('23505')) {
        Logger.warn('检测到 Revision 唯一键冲突，已跳过此次 PageRevision 迁移', { pageIds });
        continue;
      }
      throw error;
    }
  }
  Logger.info('Revision 迁移完成。');
}

async function upsertMissingUsers(
  prisma: DbClient,
  users: LegacyUserMeta[],
  chunkSize: number
): Promise<void> {
  if (users.length === 0) return;
  Logger.info(`补齐缺失用户 ${users.length} 名…`);
  const chunks = chunkArray(users, chunkSize);
  for (const chunk of chunks) {
    await prisma.user.createMany({
      data: chunk.map((user) => ({
        wikidotId: user.wikidotId,
        username: user.username,
        displayName: user.displayName,
        isGuest: false
      })),
      skipDuplicates: true
    });
  }
  Logger.info('用户补齐完成。');
}

async function purgePreCutoffVotes(
  prisma: DbClient,
  cutoffIso: string,
  targetPageIds: number[],
  chunkSize = INSERT_BATCH_SIZE
): Promise<void> {
  Logger.info(`删除 ${cutoffIso} 之前的现有 Vote 数据及相关缓存…`);
  if (targetPageIds.length === 0) {
    await prisma.$executeRaw(Prisma.sql`delete from "Vote" where "timestamp" < ${cutoffIso}::timestamptz`);
    await prisma.$executeRaw(
      Prisma.sql`delete from "PageStats" where "pageVersionId" in (select "id" from "PageVersion" where "validFrom" < ${cutoffIso}::timestamptz)`
    );
    await prisma.$executeRaw(Prisma.sql`delete from "RatingRecords" where "createdAt" < ${cutoffIso}::timestamptz`);
    await prisma.$executeRaw(Prisma.sql`delete from "PageDailyStats" where "date" < ${cutoffIso}::date`);
    await prisma.$executeRaw(Prisma.sql`delete from "UserDailyStats" where "date" < ${cutoffIso}::date`);
    await prisma.$executeRaw(
      Prisma.sql`update "Page" set "votingTimeSeriesCache" = null, "votingCacheUpdatedAt" = null where "firstPublishedAt" < ${cutoffIso}::timestamptz`
    );
    await prisma.$executeRaw(
      Prisma.sql`update "User" set "attributionVotingTimeSeriesCache" = null, "attributionVotingCacheUpdatedAt" = null where "firstActivityAt" < ${cutoffIso}::timestamptz`
    );
    return;
  }

  const uniqueIds = Array.from(new Set(targetPageIds));
  const normalizedChunkSize = Math.max(1, Math.min(chunkSize, 30_000));
  const chunks = chunkArray(uniqueIds, normalizedChunkSize);
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    const pageIdSql = Prisma.join(chunk.map((id) => Prisma.sql`${id}`));
    await prisma.$executeRaw(
      Prisma.sql`delete from "Vote"
        where "timestamp" < ${cutoffIso}::timestamptz
          and "pageVersionId" in (
            select "id" from "PageVersion" where "pageId" in (${pageIdSql})
          )`
    );
    await prisma.$executeRaw(
      Prisma.sql`delete from "PageStats"
        where "pageVersionId" in (
          select "id" from "PageVersion" where "pageId" in (${pageIdSql})
        )`
    );
    await prisma.$executeRaw(
      Prisma.sql`delete from "RatingRecords"
        where "pageId" in (${pageIdSql})
          and "achievedAt" < ${cutoffIso}::timestamptz`
    );
    await prisma.$executeRaw(
      Prisma.sql`delete from "PageDailyStats"
        where "pageId" in (${pageIdSql})
          and "date" < ${cutoffIso}::date`
    );
    await prisma.$executeRaw(
      Prisma.sql`update "Page"
        set "votingTimeSeriesCache" = null,
            "votingCacheUpdatedAt" = null
        where "id" in (${pageIdSql})`
    );
  }
}

async function insertLegacyVotes(
  prisma: DbClient,
  schema: string,
  cutoffIso: string,
  versionMap: Map<number, number>,
  chunkSize: number,
  pageWhitelist: number[]
): Promise<void> {
  Logger.info('开始写入 legacy votes…');
  const pageToVersion = new Map<number, number>(versionMap);

  const voteRows = await prisma.$queryRawUnsafe<Array<{
    page_wid: bigint;
    user_wid: bigint | null;
    value: number;
    timestamp: Date;
  }>>(
    `select
        v."PageId" as page_wid,
        nullif(v."UserId", 0) as user_wid,
        v."Value" as value,
        v."DateTime" as timestamp
      from "${schema}"."votes" v
      where v."DateTime" is null or v."DateTime" < '${cutoffIso}'
        ${pageWhitelistFilter('PageId', pageWhitelist, 'v.')}
      order by v."DateTime", v."PageId", v."UserId"`
  );

  if (voteRows.length === 0) {
    Logger.info('无 legacy votes 需要导入。');
    return;
  }

  const pageIdLookup = await prisma.page.findMany({
    where: { wikidotId: { in: Array.from(new Set(voteRows.map((row) => Number(row.page_wid)))) } },
    select: { id: true, wikidotId: true }
  });
  const widToPageId = new Map<number, number>();
  for (const row of pageIdLookup) {
    widToPageId.set(row.wikidotId, row.id);
  }

  const rawUserIds = Array.from(new Set(voteRows.map((row) => (row.user_wid != null ? Number(row.user_wid) : -1))));
  const userIds = rawUserIds.filter((id) => id > 0);
  const userLookup = await prisma.user.findMany({
    where: { wikidotId: { in: userIds } },
    select: { id: true, wikidotId: true }
  });
  const widToUserId = new Map<number, number>();
  for (const row of userLookup) {
    if (row.wikidotId == null) continue;
    widToUserId.set(row.wikidotId, row.id);
  }

  const votesToInsert: Array<{ pageVersionId: number; userId: number | null; timestamp: Date; direction: number }> = [];
  for (const row of voteRows) {
    const pageId = widToPageId.get(Number(row.page_wid));
    if (!pageId) continue;
    const pageVersionId = pageToVersion.get(pageId);
    if (!pageVersionId) continue;
    const userId = row.user_wid != null ? widToUserId.get(Number(row.user_wid)) ?? null : null;
    votesToInsert.push({
      pageVersionId,
      userId,
      timestamp: row.timestamp,
      direction: row.value
    });
  }

  const chunks = chunkArray(votesToInsert, chunkSize);
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    await prisma.vote.createMany({
      data: chunk
    });
  }
  Logger.info('legacy votes 导入完成。');
}

function pageWhitelistFilter(column: string, wids: number[], aliasPrefix = ''): string {
  if (!wids || wids.length === 0) return '';
  const prefix = aliasPrefix ?? '';
  const qualified = `${prefix}"${column}"`;
  return ` AND ${qualified} IN (${wids.join(',')})`;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function subtractSeconds(date: Date, seconds: number): Date {
  const copy = new Date(date);
  copy.setSeconds(copy.getSeconds() - seconds);
  return copy;
}

function parseMysqlDate(value: string, offset: string): Date {
  const normalized = value.replace(' ', 'T');
  const suffix = /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : '+00:00';
  return new Date(`${normalized}${suffix}`);
}


function resolveMysqlConfig(): MysqlLegacyConfig {
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

async function connectLegacyMysql(config: MysqlLegacyConfig): Promise<{ connection: mysql.Connection; database: string }> {
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
    const [rows] = await discovery.execute(
      `SELECT table_schema AS db
         FROM information_schema.tables
        WHERE table_name IN ('sites', 'pages', 'votes', 'vote_history', 'users')
          AND table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
        GROUP BY table_schema
        ORDER BY table_schema`
    ) as [Array<{ db: string }>, unknown];
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
