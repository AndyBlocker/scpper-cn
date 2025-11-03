import chalk from 'chalk';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'node:readline';
import { table } from 'table';
import { Prisma, PrismaClient } from '@prisma/client';
import { disconnectPrisma, getPrismaClient } from '../utils/db-connection.js';
import { Logger } from '../utils/Logger.js';
import { Pool, PoolClient } from 'pg';
import mysql from 'mysql2/promise';
import { SingleBar, Presets } from 'cli-progress';

type LegacyVoteImportOptions = {
  legacySchema?: string;
  siteWhitelist?: string[];
  maxDate?: string;
  verbose?: boolean;
  source?: 'dump' | 'mysql';
};

type PreparedOptions = ReturnType<typeof prepareOptions>;

type SummaryRow = {
  label: string;
  value: number | string;
  extra?: string | number;
};

type SummaryCollections = {
  staging: SummaryRow[];
  mapping: SummaryRow[];
  comparison: SummaryRow[];
  timestampDrift?: {
    count: number;
    minSeconds: number | null;
    maxSeconds: number | null;
    avgSeconds: number | null;
    postCutoffCount: number;
  };
  fallback?: {
    needVersion: number;
    withCandidate: number;
  };
};

type TransactionClient = Prisma.TransactionClient;

const DEFAULT_MAX_DATE = '2022-05-01';
const DEFAULT_SITE_WHITELIST = ['CN'];
const DEFAULT_LEGACY_SCHEMA = 'legacy_votes_cn';
const DEFAULT_SOURCE_MODE = 'dump';
const LEGACY_SQL_DUMP_PATH = path.join(os.homedir(), 'scpper_data', 'scpper_2025-09-27.sql');
const INSERT_BATCH_SIZE = 500;
const TARGET_TABLES = new Set(['sites', 'pages', 'votes', 'vote_history']);

export async function runLegacyVoteImport(options: LegacyVoteImportOptions): Promise<void> {
  const prepared = prepareOptions(options);
  if (!fs.existsSync(prepared.dumpPath)) {
    Logger.warn(`未找到旧数据 dump 文件：${prepared.dumpPath}，请确认路径是否正确。`);
  } else {
    Logger.info(`使用旧数据 dump：${prepared.dumpPath}`);
  }
  Logger.info(`使用旧数据 schema：${prepared.legacySchema}`);
  Logger.info(`站点白名单：${prepared.siteWhitelist.join(', ')}`);
  Logger.info(`时间上限：${prepared.maxDate}`);
  Logger.info(`装载模式：${prepared.sourceMode}`);

  const prisma = getPrismaClient();
  try {
    let schemaReady = await legacySchemaExists(prisma, prepared.legacySchema);
    let snapshot = schemaReady ? await getLegacySchemaSnapshot(prisma, prepared.legacySchema) : null;

    if (!schemaReady || (snapshot && snapshot.rowTotal === 0)) {
      Logger.warn(
        schemaReady
          ? `schema "${prepared.legacySchema}" 存在但暂无数据，准备重新装载……`
          : `未找到 schema "${prepared.legacySchema}"，准备从 ${prepared.sourceMode === 'mysql' ? 'MySQL 实例' : 'dump 文件'} 装载历史数据……`
      );
      if (prepared.sourceMode === 'mysql') {
        await loadLegacySnapshotFromMysql(prepared);
      } else {
        await loadLegacySnapshotFromDump(prepared);
      }
      schemaReady = await legacySchemaExists(prisma, prepared.legacySchema);
      if (!schemaReady) {
        throw new Error(`自动导入后仍未发现 schema "${prepared.legacySchema}"，请检查数据库连接配置。`);
      }
      snapshot = await getLegacySchemaSnapshot(prisma, prepared.legacySchema);
    } else if (snapshot) {
      Logger.info(`已检测到旧数据：sites=${snapshot.sites} pages=${snapshot.pages} vote_history=${snapshot.voteHistory} votes=${snapshot.votes}`);
    }

    if (!snapshot || snapshot.rowTotal === 0) {
      Logger.warn('旧数据仍为空，dry run 将不会产生有效统计。');
    }

    await prisma.$transaction(
      async (tx) => {
        const runner = new LegacyVoteDryRunRunner(tx, prepared);
        await runner.prepareTempTables();
        const summary = await runner.collectSummary();
        runner.printSummary(summary);
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 180_000
      }
    );
  } finally {
    await disconnectPrisma();
  }
}

export async function refreshLegacyVotes(options: LegacyVoteImportOptions = {}): Promise<void> {
  const prepared = prepareOptions(options);
  Logger.info(`准备刷新 legacy schema：${prepared.legacySchema}`);
  await dropLegacySchema(prepared.legacySchema);

  if (prepared.sourceMode === 'mysql') {
    Logger.info('从 MySQL 装载历史数据……');
    await loadLegacySnapshotFromMysql(prepared);
  } else {
    if (!fs.existsSync(prepared.dumpPath)) {
      throw new Error(`Dump 文件 ${prepared.dumpPath} 不存在，无法刷新数据。`);
    }
    Logger.info('从 dump 文件装载历史数据……');
    await loadLegacySnapshotFromDump(prepared);
  }

  const prisma = getPrismaClient();
  try {
    const snapshot = await getLegacySchemaSnapshot(prisma, prepared.legacySchema);
    Logger.info(
      `刷新完成：sites=${snapshot.sites} pages=${snapshot.pages} vote_history=${snapshot.voteHistory} votes=${snapshot.votes}`
    );
  } finally {
    await disconnectPrisma();
  }
}

function prepareOptions(raw: LegacyVoteImportOptions): Required<LegacyVoteImportOptions> & {
  cutoffIso: string;
  legacySchemaQuoted: string;
  dumpPath: string;
  sourceMode: 'dump' | 'mysql';
  isVerbose: boolean;
} {
  const legacySchema = (raw.legacySchema ?? DEFAULT_LEGACY_SCHEMA).trim();
  if (!legacySchema) {
    throw new Error('legacy schema 不能为空');
  }
  const siteWhitelist = normalizeSiteWhitelist(raw.siteWhitelist);
  const dateInput = raw.maxDate?.trim() || DEFAULT_MAX_DATE;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) {
    throw new Error(`时间上限 ${dateInput} 格式不合法，应为 YYYY-MM-DD`);
  }
  const cutoff = new Date(`${dateInput}T00:00:00Z`);
  if (Number.isNaN(cutoff.getTime())) {
    throw new Error(`无法解析时间上限 ${dateInput}`);
  }
  const cutoffIso = cutoff.toISOString();
  const legacySchemaQuoted = quoteIdentifier(legacySchema);
  const sourceModeRaw = (raw.source ?? DEFAULT_SOURCE_MODE).toLowerCase();
  if (sourceModeRaw !== 'dump' && sourceModeRaw !== 'mysql') {
    throw new Error(`未知的 source 模式：${raw.source ?? ''}（仅支持 dump 或 mysql）`);
  }
  const isVerbose = Boolean(raw.verbose);
  const maxLinesRaw = raw.verbose && process.env.LEGACY_DUMP_MAX_LINES ? Number(process.env.LEGACY_DUMP_MAX_LINES) : undefined;
  return {
    legacySchema,
    siteWhitelist,
    maxDate: dateInput,
    verbose: isVerbose,
    cutoffIso,
    legacySchemaQuoted,
    dumpPath: LEGACY_SQL_DUMP_PATH,
    sourceMode: sourceModeRaw,
    isVerbose,
    dumpLineLimit: maxLinesRaw && Number.isFinite(maxLinesRaw) && maxLinesRaw > 0 ? maxLinesRaw : undefined
  };
}

class LegacyVoteDryRunRunner {
  private readonly tx: TransactionClient;

  private readonly options: ReturnType<typeof prepareOptions>;

  constructor(tx: TransactionClient, options: ReturnType<typeof prepareOptions>) {
    this.tx = tx;
    this.options = options;
  }

  async prepareTempTables(): Promise<void> {
    Logger.info('开始构建临时表...');
    await this.createSiteTable();
    await this.createPageTable();
    await this.createVoteTables();
    await this.createNormalizedVotes();
    await this.enrichWithEntities();
    await this.prepareExistingVotes();
    await this.prepareComparison();
    Logger.info('临时表准备完毕，开始统计汇总。');
  }

  async collectSummary(): Promise<SummaryCollections> {
    const staging = await this.collectStagingSummary();
    const mapping = await this.collectMappingSummary();
    const comparison = await this.collectComparisonSummary();
    const timestampDrift = await this.collectTimestampStats();
    const fallback = await this.collectFallbackStats();
    return { staging, mapping, comparison, timestampDrift, fallback };
  }

  printSummary(summary: SummaryCollections): void {
    console.log(chalk.cyan('\n=== Legacy Vote Dry Run 汇总 ==='));
    console.log(chalk.yellow('\n数据抽取与去重'));
    console.log(table(summary.staging.map((row) => ([row.label, row.value, row.extra ?? '']))));

    console.log(chalk.yellow('\n实体映射情况'));
    console.log(table(summary.mapping.map((row) => ([row.label, row.value, row.extra ?? '']))));

    console.log(chalk.yellow('\n与现有 Vote 表对比'));
    console.log(table(summary.comparison.map((row) => ([row.label, row.value, row.extra ?? '']))));

    if (summary.timestampDrift && summary.timestampDrift.count > 0) {
      const drift = summary.timestampDrift;
      console.log(chalk.yellow('\n时间偏移统计（秒）'));
      console.log(table([
        ['数量', drift.count],
        ['最小偏移', drift.minSeconds ?? 'NULL'],
        ['最大偏移', drift.maxSeconds ?? 'NULL'],
        ['平均偏移', drift.avgSeconds ?? 'NULL'],
        ['>= 截止日的条目', drift.postCutoffCount]
      ]));
    }

    if (summary.fallback) {
      console.log(chalk.yellow('\n需要历史版本锚点的页面'));
      console.log(table([
        ['需定位 PageVersion 的投票', summary.fallback.needVersion],
        ['存在可用 PageVersion 兜底', summary.fallback.withCandidate]
      ]));
    }
    console.log(chalk.cyan('\nDry run 完成（未对正式表做任何修改）。'));
  }

  private async createSiteTable(): Promise<void> {
    const { legacySchemaQuoted, siteWhitelist } = this.options;
    const siteList = toSqlInList(siteWhitelist);
    const sql = `
      create temporary table tmp_legacy_sites as
      select
        "WikidotId"::bigint as site_wid,
        "ShortName" as short_name,
        "Domain" as domain,
        "Protocol" as protocol
      from ${legacySchemaQuoted}."sites"
      where upper("ShortName") in (${siteList})
    `;
    await this.tx.$executeRawUnsafe(sql);
  }

  private async createPageTable(): Promise<void> {
    const { legacySchemaQuoted } = this.options;
    const sql = `
      create temporary table tmp_legacy_pages as
      select
        p."WikidotId"::bigint as page_wid,
        p."SiteId"::bigint as site_wid,
        p."Name" as slug,
        p."Title" as title
      from ${legacySchemaQuoted}."pages" p
      join tmp_legacy_sites s on s.site_wid = p."SiteId"
    `;
    await this.tx.$executeRawUnsafe(sql);
  }

  private async createVoteTables(): Promise<void> {
    const { legacySchemaQuoted, cutoffIso } = this.options;
    const sqlHistory = `
      create temporary table tmp_legacy_vote_history as
      select
        vh."PageId"::bigint as page_wid,
        vh."UserId"::bigint as user_wid,
        vh."Value"::int as value,
        vh."DateTime"::timestamptz as timestamp,
        vh."DeltaFromPrev"::int as delta
      from ${legacySchemaQuoted}."vote_history" vh
      join tmp_legacy_pages p on p.page_wid = vh."PageId"
      where vh."DateTime" < timestamptz '${cutoffIso}'
    `;
    const sqlVotes = `
      create temporary table tmp_legacy_votes as
      select
        v."PageId"::bigint as page_wid,
        v."UserId"::bigint as user_wid,
        v."Value"::int as value,
        v."DateTime"::timestamptz as timestamp,
        v."DeltaFromPrev"::int as delta
      from ${legacySchemaQuoted}."votes" v
      join tmp_legacy_pages p on p.page_wid = v."PageId"
      where v."DateTime" < timestamptz '${cutoffIso}'
    `;
    await this.tx.$executeRawUnsafe(sqlHistory);
    await this.tx.$executeRawUnsafe(sqlVotes);
  }

  private async createNormalizedVotes(): Promise<void> {
    const sqlCombined = `
      create temporary table tmp_legacy_vote_events as
      select 'history'::text as source, h.*
      from tmp_legacy_vote_history h
      union all
      select 'final'::text as source, v.*
      from tmp_legacy_votes v
    `;
    const sqlNormalized = `
      create temporary table tmp_legacy_votes_normalized as
      with ranked as (
        select
          source,
          page_wid,
          user_wid,
          value,
          timestamp,
          delta,
          row_number() over (
            partition by page_wid, user_wid, timestamp
            order by source asc
          ) as rn
        from tmp_legacy_vote_events
      )
      select source, page_wid, user_wid, value, timestamp, delta
      from ranked
      where rn = 1
    `;
    await this.tx.$executeRawUnsafe(sqlCombined);
    await this.tx.$executeRawUnsafe(sqlNormalized);
  }

  private async enrichWithEntities(): Promise<void> {
    const sql = `
      create temporary table tmp_vote_with_entities as
      select
        n.source,
        n.page_wid,
        n.user_wid,
        n.value,
        n.timestamp,
        n.delta,
        p."id" as page_id,
        u."id" as user_id,
        pv."id" as page_version_id,
        case
          when p."id" is null then 'missing_page'
          when n.user_wid <= 0 then 'anon_vote'
          when u."id" is null then 'missing_user'
          when pv."id" is null then 'missing_page_version'
          else 'ready'
        end as mapping_status,
        case
          when pv."id" is null and p."id" is not null then (
            select min(pv_all."id") from "PageVersion" pv_all where pv_all."pageId" = p."id"
          )
          else null
        end as fallback_page_version_id
      from tmp_legacy_votes_normalized n
      left join "Page" p on p."wikidotId" = n.page_wid
      left join "User" u on u."wikidotId" = nullif(n.user_wid, 0)
      left join lateral (
        select pv_sel."id"
        from "PageVersion" pv_sel
        where pv_sel."pageId" = p."id"
          and pv_sel."validFrom" <= n.timestamp
          and (pv_sel."validTo" is null or pv_sel."validTo" > n.timestamp)
        order by pv_sel."validFrom" desc
        limit 1
      ) pv on true
    `;
    await this.tx.$executeRawUnsafe(sql);

    const sqlReady = `
      create temporary table tmp_vote_ready as
      select
        *,
        row_number() over (
          partition by page_version_id, user_id, value
          order by timestamp
        ) as event_rank
      from tmp_vote_with_entities
      where mapping_status = 'ready'
    `;
    await this.tx.$executeRawUnsafe(sqlReady);
  }

  private async prepareExistingVotes(): Promise<void> {
    const sql = `
      create temporary table tmp_existing_votes as
      select
        v."id",
        v."pageVersionId" as page_version_id,
        v."userId" as user_id,
        v."direction" as direction,
        v."timestamp" as timestamp,
        row_number() over (
          partition by v."pageVersionId", v."userId", v."direction"
          order by v."timestamp"
        ) as event_rank
      from "Vote" v
      where exists (
        select 1
        from tmp_vote_ready r
        where r.page_version_id = v."pageVersionId"
          and r.user_id = v."userId"
          and r.value = v."direction"
      )
    `;
    await this.tx.$executeRawUnsafe(sql);
  }

  private async prepareComparison(): Promise<void> {
    const { cutoffIso } = this.options;
    const sql = `
      create temporary table tmp_vote_comparison as
      select
        r.*,
        ev."id" as existing_vote_id,
        ev.timestamp as existing_timestamp,
        ev.direction as existing_direction,
        case
          when ev."id" is null then 'missing_in_db'
          when ev.direction <> r.value then 'direction_conflict'
          when ev.timestamp = r.timestamp then 'exact_match'
          else 'timestamp_mismatch'
        end as comparison_status,
        case
          when ev."id" is not null then extract(epoch from (ev.timestamp - r.timestamp))
          else null
        end as timestamp_diff_seconds,
        case
          when ev."id" is not null and ev.timestamp >= timestamptz '${cutoffIso}' then 1
          else 0
        end as is_post_cutoff_timestamp
      from tmp_vote_ready r
      left join tmp_existing_votes ev
        on ev.page_version_id = r.page_version_id
        and ev.user_id = r.user_id
        and ev.direction = r.value
        and ev.event_rank = r.event_rank
    `;
    await this.tx.$executeRawUnsafe(sql);
  }

  private async collectStagingSummary(): Promise<SummaryRow[]> {
    const rows: SummaryRow[] = [];
    const history = await this.singleCount('select count(*)::bigint as c from tmp_legacy_vote_history');
    const votes = await this.singleCount('select count(*)::bigint as c from tmp_legacy_votes');
    const combined = await this.singleCount('select count(*)::bigint as c from tmp_legacy_vote_events');
    const normalized = await this.singleCount('select count(*)::bigint as c from tmp_legacy_votes_normalized');
    const deduped = combined - normalized;

    rows.push({ label: 'vote_history 原始行', value: history });
    rows.push({ label: 'votes 原始行', value: votes });
    rows.push({ label: '合并后总行数', value: combined });
    rows.push({ label: '去重后保留', value: normalized, extra: `移除重复 ${deduped}` });
    return rows;
  }

  private async collectMappingSummary(): Promise<SummaryRow[]> {
    const sql = `
      select mapping_status, count(*)::bigint as cnt
      from tmp_vote_with_entities
      group by mapping_status
    `;
    const result = await this.tx.$queryRawUnsafe<Array<{ mapping_status: string; cnt: bigint }>>(sql);
    const map = new Map<string, number>();
    for (const row of result) {
      map.set(row.mapping_status, Number(row.cnt));
    }
    return [
      { label: '可直接映射', value: map.get('ready') ?? 0 },
      { label: '缺失 Page', value: map.get('missing_page') ?? 0 },
      { label: '缺失 User', value: map.get('missing_user') ?? 0 },
      { label: '匿名或非法用户', value: map.get('anon_vote') ?? 0 },
      { label: '缺失 PageVersion', value: map.get('missing_page_version') ?? 0 }
    ];
  }

  private async collectComparisonSummary(): Promise<SummaryRow[]> {
    const sql = `
      select comparison_status, count(*)::bigint as cnt
      from tmp_vote_comparison
      group by comparison_status
    `;
    const result = await this.tx.$queryRawUnsafe<Array<{ comparison_status: string; cnt: bigint }>>(sql);
    const map = new Map<string, number>();
    for (const row of result) {
      map.set(row.comparison_status, Number(row.cnt));
    }
    return [
      { label: '已与现有记录完全匹配', value: map.get('exact_match') ?? 0 },
      { label: '仅时间戳不同', value: map.get('timestamp_mismatch') ?? 0 },
      { label: '方向冲突', value: map.get('direction_conflict') ?? 0 },
      { label: '现有库缺失', value: map.get('missing_in_db') ?? 0 }
    ];
  }

  private async collectTimestampStats(): Promise<SummaryCollections['timestampDrift']> {
    const sql = `
      select
        count(*)::bigint as cnt,
        min(timestamp_diff_seconds)::float as min_diff,
        max(timestamp_diff_seconds)::float as max_diff,
        avg(timestamp_diff_seconds)::float as avg_diff,
        sum(is_post_cutoff_timestamp)::bigint as post_cutoff
      from tmp_vote_comparison
      where comparison_status = 'timestamp_mismatch'
    `;
    const [row] = await this.tx.$queryRawUnsafe<Array<{
      cnt: bigint;
      min_diff: number | null;
      max_diff: number | null;
      avg_diff: number | null;
      post_cutoff: bigint;
    }>>(sql);
    if (!row || Number(row.cnt) === 0) {
      return undefined;
    }
    return {
      count: Number(row.cnt),
      minSeconds: row.min_diff,
      maxSeconds: row.max_diff,
      avgSeconds: row.avg_diff,
      postCutoffCount: Number(row.post_cutoff)
    };
  }

  private async collectFallbackStats(): Promise<SummaryCollections['fallback']> {
    const sqlNeed = `
      select count(*)::bigint as cnt
      from tmp_vote_with_entities
      where mapping_status = 'missing_page_version'
    `;
    const need = Number((await this.tx.$queryRawUnsafe<Array<{ cnt: bigint }>>(sqlNeed))[0]?.cnt ?? 0n);
    if (need === 0) {
      return { needVersion: 0, withCandidate: 0 };
    }
    const sqlCandidate = `
      select count(*)::bigint as cnt
      from tmp_vote_with_entities
      where mapping_status = 'missing_page_version'
        and fallback_page_version_id is not null
    `;
    const candidate = Number((await this.tx.$queryRawUnsafe<Array<{ cnt: bigint }>>(sqlCandidate))[0]?.cnt ?? 0n);
    return {
      needVersion: need,
      withCandidate: candidate
    };
  }

  private async singleCount(sql: string): Promise<number> {
    const [row] = await this.tx.$queryRawUnsafe<Array<{ c: bigint }>>(sql);
    return Number(row?.c ?? 0n);
  }
}

function quoteIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`非法的 schema 名称：${value}`);
  }
  return `"${value}"`;
}

function toSqlInList(values: string[]): string {
  return values
    .map((value) => `'${value.replace(/'/g, "''")}'`)
    .join(', ');
}

function normalizeSiteWhitelist(input?: string[]): string[] {
  const base = Array.isArray(input) && input.length > 0 ? input : DEFAULT_SITE_WHITELIST;
  const normalized = base
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.toUpperCase());
  if (normalized.length === 0) {
    throw new Error('站点白名单为空，请检查配置。');
  }
  if (normalized.some((item) => item.includes("'"))) {
    throw new Error('站点名称中不允许包含单引号');
  }
  return normalized;
}

async function legacySchemaExists(prisma: PrismaClient, schema: string): Promise<boolean> {
  const result = await prisma.$queryRaw<Array<{ exists: boolean }>>(Prisma.sql`
    select exists (
      select 1
      from information_schema.schemata
      where schema_name = ${schema}
    ) as "exists"
  `);
  return Boolean(result[0]?.exists);
}

async function getLegacySchemaSnapshot(
  prisma: PrismaClient,
  schema: string
): Promise<{ sites: number; pages: number; voteHistory: number; votes: number; rowTotal: number }> {
  try {
    const [row] = await prisma.$queryRawUnsafe<Array<{
      sites: bigint | null;
      pages: bigint | null;
      vote_history: bigint | null;
      votes: bigint | null;
    }>>(
      `select
          (select count(*) from "${schema}"."sites") as sites,
          (select count(*) from "${schema}"."pages") as pages,
          (select count(*) from "${schema}"."vote_history") as vote_history,
          (select count(*) from "${schema}"."votes") as votes`
    );
    const sites = Number(row?.sites ?? 0n);
    const pages = Number(row?.pages ?? 0n);
    const voteHistory = Number(row?.vote_history ?? 0n);
    const votes = Number(row?.votes ?? 0n);
    return {
      sites,
      pages,
      voteHistory,
      votes,
      rowTotal: sites + pages + voteHistory + votes
    };
  } catch (error) {
    Logger.warn(`读取 schema "${schema}" 数据量失败：${String(error)}`);
    return { sites: 0, pages: 0, voteHistory: 0, votes: 0, rowTotal: 0 };
  }
}

type MysqlLegacyConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
};

const MYSQL_FETCH_LIMIT = 20000;

async function loadLegacySnapshotFromDump(options: PreparedOptions): Promise<void> {
  if (!fs.existsSync(options.dumpPath)) {
    throw new Error(`Dump 文件 ${options.dumpPath} 不存在，无法加载历史数据。`);
  }

  const siteWhitelistSet = new Set(options.siteWhitelist.map((s) => s.toUpperCase()));
  Logger.info('第一次扫描 dump，收集目标站点 ID...');
  const whitelistSiteIds = await collectWhitelistSiteIdsFromDump(options.dumpPath, siteWhitelistSet, options.dumpLineLimit);
  Logger.info(
    `已解析站点 ID：${Array.from(whitelistSiteIds).join(', ') || '无'}`
    + `${options.dumpLineLimit ? `（最多扫描 ${options.dumpLineLimit} 条 INSERT）` : ''}`
  );
  if (whitelistSiteIds.size === 0) {
    throw new Error(`在 dump 中未找到站点 ${Array.from(siteWhitelistSet).join(', ')} 对应的 WikidotId，无法继续装载。`);
  }
  const fileStats = await fs.promises.stat(options.dumpPath);
  const totalBytes = fileStats.size;
  const progressBar = new SingleBar({
    format: 'Dump  {bar} {percentage}% | {processedMB}MB / {totalMB}MB',
    hideCursor: true
  }, Presets.shades_classic);
  const totalMB = (totalBytes / (1024 * 1024)).toFixed(1);
  progressBar.start(totalBytes, 0, { processedMB: '0.0', totalMB });
  Logger.info('开始加载站点/页面/投票数据（第二次扫描 dump）...');
  const cutoffEpoch = new Date(options.cutoffIso).getTime();

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();

  const siteIds = new Set<number>();
  const pageIds = new Set<number>();

  const siteBatch: Array<Record<string, unknown>> = [];
  const pageBatch: Array<Record<string, unknown>> = [];
  const historyBatch: Array<Record<string, unknown>> = [];
  const votesBatch: Array<Record<string, unknown>> = [];

  const counts = {
    sites: 0,
    pages: 0,
    voteHistory: 0,
    votes: 0
  };

  const flushBatch = async (table: 'sites' | 'pages' | 'vote_history' | 'votes'): Promise<void> => {
    const columnsMap: Record<typeof table, string[]> = {
      sites: ['WikidotId', 'ShortName', 'Domain', 'Protocol'],
      pages: ['__Id', 'WikidotId', 'SiteId', 'Name', 'Title'],
      vote_history: ['__Id', 'PageId', 'UserId', 'Value', 'DateTime', 'DeltaFromPrev'],
      votes: ['__Id', 'PageId', 'UserId', 'Value', 'DateTime', 'DeltaFromPrev']
    };
    const bufferMap: Record<typeof table, Array<Record<string, unknown>>> = {
      sites: siteBatch,
      pages: pageBatch,
      vote_history: historyBatch,
      votes: votesBatch
    };
    const buffer = bufferMap[table];
    if (buffer.length === 0) return;
    const rows = buffer.splice(0, buffer.length);
    await insertRowsInBatches(client, options.legacySchema, table, columnsMap[table], rows);
    if (options.isVerbose) {
      const total =
        table === 'sites' ? counts.sites :
        table === 'pages' ? counts.pages :
        table === 'vote_history' ? counts.voteHistory :
        counts.votes;
      Logger.info(`[dump] 已写入 ${table} 累计 ${total} 条。`);
    }
  };

  try {
    Logger.info('准备 Postgres staging schema...');
    await setupLegacySchema(client, options.legacySchema);
    await processDumpFile(options.dumpPath, options.dumpLineLimit, async (table, rows) => {
      if (table === 'sites') {
        for (const row of rows) {
          const wikidotId = toNumber(row[1]);
          if (!whitelistSiteIds.has(wikidotId)) continue;
          const shortNameRaw = row[4] != null ? String(row[4]) : '';

          siteIds.add(wikidotId);
          siteBatch.push({
            WikidotId: wikidotId,
            ShortName: shortNameRaw,
            Domain: row[6] != null ? String(row[6]) : '',
            Protocol: row[10] != null ? String(row[10]) : null
          });
          counts.sites += 1;
        }
        await flushBatch('sites');
      } else if (table === 'pages') {
        for (const row of rows) {
          const siteId = toNumber(row[1]);
          if (!whitelistSiteIds.has(siteId)) continue;
          const wikidotId = toNumber(row[2]);

          pageIds.add(wikidotId);
          pageBatch.push({
            __Id: toNumber(row[0]),
            WikidotId: wikidotId,
            SiteId: siteId,
            Name: row[4] != null ? String(row[4]) : '',
            Title: row[3] != null ? String(row[3]) : null
          });
          counts.pages += 1;
        }
        if (pageBatch.length >= INSERT_BATCH_SIZE) {
          await flushBatch('pages');
        }
      } else if (table === 'vote_history') {
        for (const row of rows) {
          const pageId = toNumber(row[1]);
          if (!pageIds.has(pageId)) continue;
          const timestamp = parseLegacyDateTime(row[4]);
          if (timestamp && timestamp.getTime() >= cutoffEpoch) continue;

          historyBatch.push({
            __Id: toNumber(row[0]),
            PageId: pageId,
            UserId: toNumber(row[2]),
            Value: row[3] != null ? toNumber(row[3]) : null,
            DateTime: timestamp,
            DeltaFromPrev: row[5] != null ? toNumber(row[5]) : null
          });
          counts.voteHistory += 1;
        }
        if (historyBatch.length >= INSERT_BATCH_SIZE) {
          await flushBatch('vote_history');
        }
        if (counts.voteHistory !== 0 && counts.voteHistory % 200000 === 0) {
          Logger.info(`已处理 vote_history ${counts.voteHistory} 条...`);
        }
      } else if (table === 'votes') {
        for (const row of rows) {
          const pageId = toNumber(row[1]);
          if (!pageIds.has(pageId)) continue;
          const timestamp = parseLegacyDateTime(row[4]);
          if (timestamp && timestamp.getTime() >= cutoffEpoch) continue;

          votesBatch.push({
            __Id: toNumber(row[0]),
            PageId: pageId,
            UserId: toNumber(row[2]),
            Value: row[3] != null ? toNumber(row[3]) : null,
            DateTime: timestamp,
            DeltaFromPrev: row[5] != null ? toNumber(row[5]) : null
          });
          counts.votes += 1;
        }
        if (votesBatch.length >= INSERT_BATCH_SIZE) {
          await flushBatch('votes');
        }
        if (counts.votes !== 0 && counts.votes % 500000 === 0) {
          Logger.info(`已处理 votes ${counts.votes} 条...`);
        }
      }
    }, (processedBytes) => {
      const clamped = Math.min(totalBytes, Math.max(0, processedBytes));
      progressBar.update(clamped, { processedMB: (clamped / (1024 * 1024)).toFixed(1), totalMB });
    });

    await flushBatch('sites');
    await flushBatch('pages');
    await flushBatch('vote_history');
    await flushBatch('votes');

    Logger.info(`旧数据装载完成：sites=${counts.sites}，pages=${counts.pages}，vote_history=${counts.voteHistory}，votes=${counts.votes}`);
  } finally {
    progressBar.update(totalBytes, { processedMB: totalMB, totalMB });
    progressBar.stop();
    client.release();
    await pool.end();
  }
}

async function dropLegacySchema(schema: string): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    Logger.info(`已清空 schema "${schema}"。`);
  } finally {
    client.release();
    await pool.end();
  }
}

async function loadLegacySnapshotFromMysql(options: PreparedOptions): Promise<void> {
  const mysqlConfig = resolveMysqlConfig();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const cutoffMysql = `${options.maxDate} 00:00:00`;
  const siteWhitelistUpper = options.siteWhitelist.map((s) => s.toUpperCase());
  const { connection: mysqlConn, database } = await connectLegacyMysql(mysqlConfig);
  Logger.info(`已连接 MySQL：${mysqlConfig.user}@${mysqlConfig.host}:${mysqlConfig.port}/${database}`);

  try {
    await setupLegacySchema(client, options.legacySchema);

    const siteRows = await fetchSitesFromMysql(mysqlConn, siteWhitelistUpper);
    if (siteRows.length === 0) {
      throw new Error(`MySQL 数据库 ${database} 中未找到站点 ${siteWhitelistUpper.join(', ')} 的记录`);
    }
    await logMysqlSourceSummary(mysqlConn, siteRows, options.isVerbose);
    await insertRowsInBatches(client, options.legacySchema, 'sites', ['WikidotId', 'ShortName', 'Domain', 'Protocol'], siteRows);
    const siteIds = siteRows.map((row) => toNumber(row.WikidotId));
    Logger.info(`已同步站点 ${siteRows.length} 条。`);

    const pageCount = await fetchPagesFromMysql(mysqlConn, client, options.legacySchema, siteIds, options.isVerbose);
    Logger.info(`已同步页面 ${pageCount} 条。`);

    const historyCount = await fetchVotesFromMysql(mysqlConn, client, options.legacySchema, siteIds, cutoffMysql, 'vote_history', options.isVerbose);
    Logger.info(`已同步 vote_history ${historyCount} 条。`);

    const votesCount = await fetchVotesFromMysql(mysqlConn, client, options.legacySchema, siteIds, cutoffMysql, 'votes', options.isVerbose);
    Logger.info(`已同步 votes ${votesCount} 条。`);
  } finally {
    await mysqlConn.end();
    client.release();
    await pool.end();
  }
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
    try {
      const connection = await tryConnect(config.database);
      return { connection, database: config.database };
    } catch (error: any) {
      if (error?.code !== 'ER_BAD_DB_ERROR') {
        throw error;
      }
      Logger.warn(`指定的 MySQL 数据库 "${config.database}" 不存在，将自动探测可用数据库。`);
    }
  }

  const discovery = await tryConnect();
  try {
    const [rows] = await discovery.execute<Array<mysql.RowDataPacket>>(`
      SELECT table_schema AS db,
             COUNT(DISTINCT table_name) AS table_count
      FROM information_schema.tables
      WHERE table_name IN ('sites', 'pages', 'votes', 'vote_history')
        AND table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
      GROUP BY table_schema
      HAVING COUNT(DISTINCT table_name) >= 3
      ORDER BY table_schema
    `);
    if (rows.length === 0) {
      throw new Error('未能在 MySQL 服务器上找到包含 sites/pages/votes/vote_history 的数据库，请通过 LEGACY_MYSQL_DATABASE 指定。');
    }
    const preferred = rows.find((row) => String(row.db).toLowerCase().includes('scpper')) ?? rows[0];
    const database = String(preferred.db);
    Logger.info(`自动选择 MySQL 数据库：${database}`);
    const connection = await tryConnect(database);
    return { connection, database };
  } finally {
    await discovery.end();
  }
}

async function fetchSitesFromMysql(conn: mysql.Connection, siteWhitelist: string[]): Promise<Array<Record<string, unknown>>> {
  if (siteWhitelist.length === 0) return [];
  const placeholders = siteWhitelist.map(() => '?').join(', ');
  const sql = `
    SELECT s.WikidotId, s.ShortName, s.Domain, s.Protocol
    FROM sites s
    WHERE UPPER(s.ShortName) IN (${placeholders})
  `;
  const [rows] = await conn.execute<Array<mysql.RowDataPacket>>(sql, siteWhitelist);
  return rows.map((row) => ({
    WikidotId: toNumber(row.WikidotId),
    ShortName: String(row.ShortName ?? ''),
    Domain: String(row.Domain ?? ''),
    Protocol: row.Protocol != null ? String(row.Protocol) : null
  }));
}

async function logMysqlSourceSummary(
  conn: mysql.Connection,
  siteRows: Array<Record<string, unknown>>,
  verbose: boolean
): Promise<void> {
  const [totals] = await conn.execute<Array<mysql.RowDataPacket>>(`
    SELECT
      (SELECT COUNT(*) FROM sites) AS sites,
      (SELECT COUNT(*) FROM pages) AS pages,
      (SELECT COUNT(*) FROM vote_history) AS vote_history,
      (SELECT COUNT(*) FROM votes) AS votes
  `);
  const totalRow = totals[0] ?? {} as any;
  Logger.info(
    `[mysql] 全量数据：sites=${Number(totalRow.sites ?? 0)} pages=${Number(totalRow.pages ?? 0)} ` +
    `vote_history=${Number(totalRow.vote_history ?? 0)} votes=${Number(totalRow.votes ?? 0)}`
  );

  if (!verbose || siteRows.length === 0) return;

  const siteIds = siteRows.map((row) => toNumber(row.WikidotId));
  const placeholders = siteIds.map(() => '?').join(', ');

  const [pageCounts] = await conn.execute<Array<mysql.RowDataPacket>>(
    `SELECT SiteId, COUNT(*) AS pages FROM pages WHERE SiteId IN (${placeholders}) GROUP BY SiteId`,
    siteIds
  );

  const [voteCounts] = await conn.execute<Array<mysql.RowDataPacket>>(
    `SELECT p.SiteId AS SiteId, COUNT(*) AS votes
       FROM votes v JOIN pages p ON p.WikidotId = v.PageId
      WHERE p.SiteId IN (${placeholders})
      GROUP BY p.SiteId`,
    siteIds
  );

  const [historyCounts] = await conn.execute<Array<mysql.RowDataPacket>>(
    `SELECT p.SiteId AS SiteId, COUNT(*) AS vote_history
       FROM vote_history v JOIN pages p ON p.WikidotId = v.PageId
      WHERE p.SiteId IN (${placeholders})
      GROUP BY p.SiteId`,
    siteIds
  );

  const pageCountMap = new Map<number, number>(pageCounts.map((row) => [toNumber(row.SiteId), Number(row.pages ?? 0)]));
  const voteCountMap = new Map<number, number>(voteCounts.map((row) => [toNumber(row.SiteId), Number(row.votes ?? 0)]));
  const historyCountMap = new Map<number, number>(historyCounts.map((row) => [toNumber(row.SiteId), Number(row.vote_history ?? 0)]));

  for (const row of siteRows) {
    const siteId = toNumber(row.WikidotId);
    Logger.info(
      `[mysql] 站点 ${row.ShortName ?? siteId} (ID=${siteId}) -> pages=${pageCountMap.get(siteId) ?? 0}` +
      ` vote_history=${historyCountMap.get(siteId) ?? 0} votes=${voteCountMap.get(siteId) ?? 0}`
    );
  }
}

async function fetchPagesFromMysql(
  conn: mysql.Connection,
  client: PoolClient,
  schema: string,
  siteIds: number[],
  verbose: boolean
): Promise<number> {
  let total = 0;
  for (const siteId of siteIds) {
    let lastId = 0;
    for (;;) {
      const [rows] = await conn.execute<Array<mysql.RowDataPacket>>(
        `SELECT p.__Id, p.WikidotId, p.SiteId, p.Name, p.Title
           FROM pages p
          WHERE p.SiteId = ?
            AND p.__Id > ?
          ORDER BY p.__Id
          LIMIT ${MYSQL_FETCH_LIMIT}`,
        [siteId, lastId]
      );
      if (rows.length === 0) break;
      total += rows.length;
      lastId = toNumber(rows[rows.length - 1].__Id);
      const payload = rows.map((row) => ({
        __Id: toNumber(row.__Id),
        WikidotId: toNumber(row.WikidotId),
        SiteId: toNumber(row.SiteId),
        Name: String(row.Name ?? ''),
        Title: row.Title != null ? String(row.Title) : null
      }));
      await insertRowsInBatches(client, schema, 'pages', ['__Id', 'WikidotId', 'SiteId', 'Name', 'Title'], payload);
      if (verbose) {
        Logger.info(`[mysql] 站点 ${siteId} -> 页面累计 ${total}`);
      }
    }
  }
  return total;
}

async function fetchVotesFromMysql(
  conn: mysql.Connection,
  client: PoolClient,
  schema: string,
  siteIds: number[],
  cutoff: string,
  table: 'votes' | 'vote_history',
  verbose: boolean
): Promise<number> {
  let total = 0;
  for (const siteId of siteIds) {
    let lastId = 0;
    for (;;) {
      const [rows] = await conn.execute<Array<mysql.RowDataPacket>>(
        `SELECT v.__Id, v.PageId, v.UserId, v.Value, v.DateTime, v.DeltaFromPrev
           FROM ${table} v
           JOIN pages p ON p.WikidotId = v.PageId
          WHERE p.SiteId = ?
            AND v.__Id > ?
            AND (v.DateTime IS NULL OR v.DateTime < ? )
          ORDER BY v.__Id
          LIMIT ${MYSQL_FETCH_LIMIT}`,
        [siteId, lastId, cutoff]
      );
      if (rows.length === 0) break;
      total += rows.length;
      lastId = toNumber(rows[rows.length - 1].__Id);
      const payload = rows.map((row) => ({
        __Id: toNumber(row.__Id),
        PageId: toNumber(row.PageId),
        UserId: toNumber(row.UserId),
        Value: row.Value != null ? toNumber(row.Value) : null,
        DateTime: parseLegacyDateTime(row.DateTime),
        DeltaFromPrev: row.DeltaFromPrev != null ? toNumber(row.DeltaFromPrev) : null
      }));
      await insertRowsInBatches(
        client,
        schema,
        table,
        ['__Id', 'PageId', 'UserId', 'Value', 'DateTime', 'DeltaFromPrev'],
        payload
      );
      if (verbose) {
        Logger.info(`[mysql] 站点 ${siteId} -> ${table} 累计 ${total}`);
      }
    }
  }
  return total;
}

async function processDumpFile(
  filePath: string,
  lineLimit: number | undefined,
  handler: (table: string, rows: any[][]) => Promise<void>,
  progress?: (processedBytes: number) => void
): Promise<void> {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  let processedBytes = 0;
  if (progress) {
    stream.on('data', (chunk: string) => {
      processedBytes += Buffer.byteLength(chunk, 'utf8');
      progress(processedBytes);
    });
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  let currentStatement = '';
  let collecting = false;
  let statementCount = 0;

  for await (const rawLine of rl) {
    const line = rawLine.trimStart();
    if (!collecting) {
      if (line.startsWith('INSERT INTO `')) {
        currentStatement = line;
        collecting = true;
        if (line.trimEnd().endsWith(';')) {
          await handleInsertStatement(currentStatement, handler);
          statementCount += 1;
          if (lineLimit && statementCount >= lineLimit) break;
          currentStatement = '';
          collecting = false;
        }
      }
    } else {
      currentStatement += '\n' + line;
      if (line.trimEnd().endsWith(';')) {
        await handleInsertStatement(currentStatement, handler);
          statementCount += 1;
          if (lineLimit && statementCount >= lineLimit) break;
        currentStatement = '';
        collecting = false;
      }
    }
  }
  rl.close();
  if (progress) {
    progress(processedBytes);
  }
}

async function collectWhitelistSiteIdsFromDump(
  filePath: string,
  siteWhitelist: Set<string>,
  lineLimit: number | undefined
): Promise<Set<number>> {
  const ids = new Set<number>();
  await processDumpFile(
    filePath,
    lineLimit,
    async (table, rows) => {
      if (table !== 'sites') return;
      for (const row of rows) {
        const wikidotId = toNumber(row[1]);
        const shortNameRaw = row[4] != null ? String(row[4]) : '';
        if (!siteWhitelist.has(shortNameRaw.toUpperCase())) continue;
        ids.add(wikidotId);
      }
    }
  );
  return ids;
}

async function handleInsertStatement(
  statement: string,
  handler: (table: string, rows: any[][]) => Promise<void>
): Promise<void> {
  const parsed = parseInsertStatement(statement);
  if (!parsed) return;
  await handler(parsed.table, parsed.rows);
}

function parseInsertStatement(statement: string): { table: string; rows: any[][] } | null {
  const match = statement.match(/^INSERT INTO `([^`]+)` VALUES\s*(.+);$/s);
  if (!match) return null;
  const table = match[1];
  if (!TARGET_TABLES.has(table)) return null;
  const valuesSegment = match[2].trim();
  if (!valuesSegment) return null;
  const rows = parseInsertValues(valuesSegment);
  return { table, rows };
}

function parseInsertValues(segment: string): any[][] {
  const rows: any[][] = [];
  const length = segment.length;
  let index = 0;

  const evaluate = (stringValue: string | null, token: string): any => evaluateToken(stringValue, token);

  while (index < length) {
    while (index < length && segment[index] !== '(') index += 1;
    if (index >= length) break;
    index += 1; // skip '('
    const row: any[] = [];
    let currentToken = '';
    let currentString: string | null = null;
    let inString = false;
    let escape = false;

    for (; index < length; index += 1) {
      const char = segment[index];
      if (inString) {
        if (escape) {
          currentString += interpretEscapedChar(char);
          escape = false;
        } else if (char === '\\') {
          escape = true;
        } else if (char === "'") {
          inString = false;
        } else {
          currentString += char;
        }
        continue;
      }

      if (char === "'") {
        inString = true;
        currentString = '';
      } else if (char === ',') {
        row.push(evaluate(currentString, currentToken));
        currentString = null;
        currentToken = '';
      } else if (char === ')') {
        row.push(evaluate(currentString, currentToken));
        currentString = null;
        currentToken = '';
        rows.push(row);
        index += 1;
        while (index < length && segment[index] !== '(') {
          if (segment[index] === ';') return rows;
          index += 1;
        }
        index -= 1;
        break;
      } else {
        currentToken += char;
      }
    }
  }

  return rows;
}

function evaluateToken(stringValue: string | null, token: string): any {
  if (stringValue !== null) {
    return stringValue;
  }
  const trimmed = token.trim();
  if (!trimmed || trimmed.toUpperCase() === 'NULL') return null;
  if (/^-?\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    return Number.isSafeInteger(num) ? num : Number.parseFloat(trimmed);
  }
  if (/^-?\d+\.\d+$/.test(trimmed)) {
    return Number(trimmed);
  }
  return trimmed;
}

function interpretEscapedChar(char: string): string {
  switch (char) {
    case '0': return '\0';
    case 'b': return '\b';
    case 'n': return '\n';
    case 'r': return '\r';
    case 't': return '\t';
    case 'Z': return '\u001A';
    case '"': return '"';
    case "'": return "'";
    case '\\': return '\\';
    default: return char;
  }
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function parseLegacyDateTime(input: unknown): Date | null {
  if (input == null) return null;
  const text = typeof input === 'string' ? input : String(input);
  if (!text || text === '0000-00-00 00:00:00') return null;
  const normalized = text.replace(' ', 'T');
  const date = new Date(`${normalized}Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

async function setupLegacySchema(client: PoolClient, schema: string): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await client.query(`DROP TABLE IF EXISTS "${schema}"."votes"`);
  await client.query(`DROP TABLE IF EXISTS "${schema}"."vote_history"`);
  await client.query(`DROP TABLE IF EXISTS "${schema}"."pages"`);
  await client.query(`DROP TABLE IF EXISTS "${schema}"."sites"`);

  await client.query(`
    CREATE TABLE "${schema}"."sites" (
      "WikidotId" bigint NOT NULL,
      "ShortName" text NOT NULL,
      "Domain" text NOT NULL,
      "Protocol" text
    )
  `);

  await client.query(`
    CREATE TABLE "${schema}"."pages" (
      "__Id" bigint,
      "WikidotId" bigint NOT NULL,
      "SiteId" bigint NOT NULL,
      "Name" text NOT NULL,
      "Title" text
    )
  `);
  await client.query(`CREATE INDEX ON "${schema}"."pages" ("SiteId")`);
  await client.query(`CREATE INDEX ON "${schema}"."pages" ("WikidotId")`);

  await client.query(`
    CREATE TABLE "${schema}"."vote_history" (
      "__Id" bigint,
      "PageId" bigint NOT NULL,
      "UserId" bigint NOT NULL,
      "Value" smallint,
      "DateTime" timestamptz,
      "DeltaFromPrev" smallint
    )
  `);
  await client.query(`CREATE INDEX ON "${schema}"."vote_history" ("PageId")`);
  await client.query(`CREATE INDEX ON "${schema}"."vote_history" ("DateTime")`);

  await client.query(`
    CREATE TABLE "${schema}"."votes" (
      "__Id" bigint,
      "PageId" bigint NOT NULL,
      "UserId" bigint NOT NULL,
      "Value" smallint,
      "DateTime" timestamptz,
      "DeltaFromPrev" smallint
    )
  `);
  await client.query(`CREATE INDEX ON "${schema}"."votes" ("PageId")`);
  await client.query(`CREATE INDEX ON "${schema}"."votes" ("DateTime")`);
}

async function insertRowsInBatches(
  client: PoolClient,
  schema: string,
  table: string,
  columns: string[],
  rows: Array<Record<string, unknown>>
): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + INSERT_BATCH_SIZE);
    await insertRows(client, schema, table, columns, batch);
  }
}

async function insertRows(
  client: PoolClient,
  schema: string,
  table: string,
  columns: string[],
  rows: Array<Record<string, unknown>>
): Promise<void> {
  if (rows.length === 0) return;
  const columnList = columns.map((col) => `"${col}"`).join(', ');
  const values: string[] = [];
  const params: unknown[] = [];
  let index = 1;
  for (const row of rows) {
    const placeholders: string[] = [];
    for (const column of columns) {
      placeholders.push(`$${index++}`);
      params.push(row[column]);
    }
    values.push(`(${placeholders.join(', ')})`);
  }
  const sql = `INSERT INTO "${schema}"."${table}" (${columnList}) VALUES ${values.join(', ')}`;
  await client.query(sql, params);
}
