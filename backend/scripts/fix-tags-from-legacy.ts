#!/usr/bin/env node

// 基于 legacy MySQL（CN 分站）修正 Postgres 中“已删除页面（since 指定日期后创建）”的最新 PageVersion.tags
// 用法：
//   node --import tsx/esm backend/scripts/fix-tags-from-legacy.ts --since 2025-10-29 --dry-run
//   npm run fix:tags-from-legacy -- --since 2025-10-29 --dry-run

import { Command } from 'commander';
import mysql from 'mysql2/promise';
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js';
import { Logger } from '../src/utils/Logger.js';

type Options = {
  since?: string;
  limit?: number;
  wikidotId?: (string | string[])[];
  dryRun?: boolean;
};

type MysqlConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
};

const SITE_NAME_CN = 'scp-wiki-cn';
const SITE_SHORT_CN = 'cn';

const program = new Command();
program
  .option('--since <date>', '仅处理该日期（含）之后创建的页面（默认 2025-10-29）')
  .option('--wikidot-id <id...>', '仅处理指定 wikidotId（可多次传入或使用逗号分隔）')
  .option('--limit <n>', '最多处理的页面数量', (v) => parseInt(String(v), 10))
  .option('--dry-run', '仅显示计划更改，不执行写入');

function parseWikidotIds(raw?: (string | string[])[]): number[] {
  if (!raw) return [];
  const flattened = raw.flatMap((entry) => (Array.isArray(entry) ? entry : String(entry).split(',')));
  const ids = flattened
    .map((v) => Number.parseInt(String(v).trim(), 10))
    .filter((v) => Number.isFinite(v) && v > 0);
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

async function connectLegacyMysql(config: MysqlConfig): Promise<mysql.Connection> {
  return mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    dateStrings: true
  });
}

async function fetchCnTagsForPage(mysqlConn: mysql.Connection, wikidotId: number): Promise<string[] | null> {
  // 优先使用 view_tags（按 SiteName 精准过滤到 CN）
  const [rows] = await mysqlConn.query<Array<{ Tag: string | null }>>(
    `SELECT Tag FROM view_tags WHERE SiteName = ? AND PageId = ?`,
    [SITE_NAME_CN, wikidotId]
  );
  const tags = rows
    .map((r) => (r.Tag ?? '').trim())
    .filter((t) => t.length > 0);
  if (tags.length > 0) return tags;

  // 兜底：join tags → pages → sites（使用 ShortName='cn'）
  const [fallback] = await mysqlConn.query<Array<{ Tag: string | null }>>(
    `SELECT t.Tag
       FROM tags t
       JOIN pages p ON p.WikidotId = t.PageId
       JOIN sites s ON s.WikidotId = p.SiteId
      WHERE p.WikidotId = ? AND s.ShortName = ?`,
    [wikidotId, SITE_SHORT_CN]
  );
  const fallbackTags = fallback
    .map((r) => (r.Tag ?? '').trim())
    .filter((t) => t.length > 0);
  return fallbackTags.length > 0 ? fallbackTags : [];
}

function dedupePreserveOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const v of values) {
    const key = v.trim();
    if (!key) continue;
    const norm = key.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    result.push(key);
  }
  return result;
}

async function main() {
  program.parse(process.argv);
  const opts = program.opts<Options>();

  const sinceStr = opts.since ?? '2025-10-29';
  const since = new Date(sinceStr);
  if (Number.isNaN(since.getTime())) {
    throw new Error(`无法解析 --since：${sinceStr}`);
  }

  const wikidotIdsFilter = parseWikidotIds(opts.wikidotId);

  const prisma = getPrismaClient();
  const mysqlConn = await connectLegacyMysql(resolveMysqlConfig());

  try {
    const pages = await prisma.page.findMany({
      where: {
        isDeleted: true,
        createdAt: { gte: since },
        ...(wikidotIdsFilter.length > 0 ? { wikidotId: { in: wikidotIdsFilter } } : {})
      },
      orderBy: { createdAt: 'asc' },
      take: opts.limit && Number.isFinite(opts.limit) ? Math.max(1, opts.limit) : undefined,
      select: {
        id: true,
        wikidotId: true,
        currentUrl: true,
        createdAt: true,
        versions: {
          where: { validTo: null },
          orderBy: { validFrom: 'desc' },
          take: 1,
          select: { id: true, tags: true }
        }
      }
    });

    if (pages.length === 0) {
      Logger.info('未找到需要处理的已删除页面。');
      return;
    }

    Logger.info(`目标页面：${pages.length}（since=${since.toISOString().slice(0, 10)}）${opts.dryRun ? ' [dry-run]' : ''}`);

    const summary = {
      checked: 0,
      updated: 0,
      unchanged: 0,
      notFoundInLegacy: 0,
      legacyEmpty: 0
    };

    for (const page of pages) {
      summary.checked += 1;
      const pv = page.versions[0] ?? null;
      if (!pv) {
        Logger.warn(`缺少活跃 PageVersion，跳过 wikidotId=${page.wikidotId}`);
        continue;
      }

      // 检查 legacy 是否存在该 wikidotId（限定 CN）
      const [existRows] = await mysqlConn.query<Array<{ cnt: number }>>(
        `SELECT COUNT(*) AS cnt
           FROM pages p
           JOIN sites s ON s.WikidotId = p.SiteId
          WHERE p.WikidotId = ? AND s.ShortName = ?
          LIMIT 1`,
        [page.wikidotId, SITE_SHORT_CN]
      );
      const existsInCn = Number(existRows[0]?.cnt ?? 0) > 0;
      if (!existsInCn) {
        summary.notFoundInLegacy += 1;
        continue;
      }

      const legacyTagsRaw = await fetchCnTagsForPage(mysqlConn, page.wikidotId);
      if (!legacyTagsRaw || legacyTagsRaw.length === 0) {
        summary.legacyEmpty += 1;
      }

      const legacyTags = dedupePreserveOrder(legacyTagsRaw ?? []);
      const current = Array.isArray(pv.tags) ? pv.tags : [];

      const same = (() => {
        if (current.length !== legacyTags.length) return false;
        for (let i = 0; i < current.length; i++) {
          if ((current[i] ?? '').trim() !== (legacyTags[i] ?? '').trim()) return false;
        }
        return true;
      })();

      if (same) {
        summary.unchanged += 1;
        continue;
      }

      if (opts.dryRun) {
        Logger.info(`DRY-RUN 替换 wikidotId=${page.wikidotId} url=${page.currentUrl} tags ${current.length} -> ${legacyTags.length}`);
      } else {
        await prisma.pageVersion.update({
          where: { id: pv.id },
          data: { tags: legacyTags, updatedAt: new Date() }
        });
        summary.updated += 1;
        Logger.info(`✅ 已替换 tags wikidotId=${page.wikidotId} url=${page.currentUrl}（${current.length} -> ${legacyTags.length}）`);
      }
    }

    console.log('\n修复汇总：');
    console.table([
      { label: '已检查', value: summary.checked },
      { label: '已更新', value: summary.updated },
      { label: '未变更', value: summary.unchanged },
      { label: 'Legacy 未命中 CN', value: summary.notFoundInLegacy },
      { label: 'Legacy 无标签', value: summary.legacyEmpty }
    ]);
  } finally {
    try { await mysqlConn.end(); } catch {}
    await disconnectPrisma();
  }
}

main().catch((err) => {
  Logger.error('fix-tags-from-legacy 脚本失败', err);
  process.exit(1);
});

