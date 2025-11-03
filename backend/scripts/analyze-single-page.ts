#!/usr/bin/env node

import { Prisma } from '@prisma/client';
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js';
import { Logger } from '../src/utils/Logger.js';
import { VotingTimeSeriesCacheJob } from '../src/jobs/VotingTimeSeriesCacheJob.js';

type CliOptions = {
  pageWid?: number;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--page-wid' || arg === '--page') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`参数 ${arg} 缺少取值`);
      }
      options.pageWid = Number.parseInt(value, 10);
      i += 1;
    }
  }
  return options;
}

async function rebuildPageStats(prisma: ReturnType<typeof getPrismaClient>, pageVersionIds: number[]): Promise<void> {
  Logger.info(`重建 PageStats：涉及 ${pageVersionIds.length} 个 PageVersion`);
  await prisma.$executeRaw`
    WITH candidates AS (
      SELECT unnest(${pageVersionIds}::int[]) AS id
    ),
    vote_stats AS (
      SELECT
        v."pageVersionId" AS id,
        COUNT(*) FILTER (WHERE v.direction = 1) AS uv,
        COUNT(*) FILTER (WHERE v.direction = -1) AS dv
      FROM "LatestVote" v
      WHERE v."pageVersionId" = ANY(${pageVersionIds}::int[])
      GROUP BY v."pageVersionId"
    )
    INSERT INTO "PageStats" ("pageVersionId", uv, dv, "wilson95", controversy, "likeRatio")
    SELECT
      c.id,
      COALESCE(vs.uv, 0) AS uv,
      COALESCE(vs.dv, 0) AS dv,
      f_wilson_lower_bound(COALESCE(vs.uv, 0)::int, COALESCE(vs.dv, 0)::int) AS "wilson95",
      f_controversy(COALESCE(vs.uv, 0)::int, COALESCE(vs.dv, 0)::int) AS controversy,
      CASE 
        WHEN COALESCE(vs.uv, 0) + COALESCE(vs.dv, 0) = 0 THEN 0
        ELSE COALESCE(vs.uv, 0)::float / (COALESCE(vs.uv, 0) + COALESCE(vs.dv, 0))
      END AS "likeRatio"
    FROM candidates c
    LEFT JOIN vote_stats vs ON c.id = vs.id
    ON CONFLICT ("pageVersionId") DO UPDATE SET
      uv = EXCLUDED.uv,
      dv = EXCLUDED.dv,
      "wilson95" = EXCLUDED."wilson95",
      controversy = EXCLUDED.controversy,
      "likeRatio" = EXCLUDED."likeRatio"
  `;
}

async function rebuildPageDailyStats(prisma: ReturnType<typeof getPrismaClient>, pageId: number, pageVersionIds: number[], minDate: Date | null, maxDate: Date | null): Promise<void> {
  Logger.info('重建 PageDailyStats...');
  await prisma.pageDailyStats.deleteMany({
    where: { pageId }
  });

  if (!minDate || !maxDate) {
    Logger.info('未检测到投票记录，跳过 PageDailyStats 重建。');
    return;
  }

  await prisma.$executeRaw`
    WITH daily_votes AS (
      SELECT 
        date(v."timestamp") AS date,
        COUNT(*) FILTER (WHERE v.direction = 1) AS votes_up,
        COUNT(*) FILTER (WHERE v.direction = -1) AS votes_down,
        COUNT(*) FILTER (WHERE v.direction <> 0) AS total_votes,
        COUNT(DISTINCT v."userId") FILTER (WHERE v."userId" IS NOT NULL) AS unique_voters
      FROM "Vote" v
      WHERE v."pageVersionId" = ANY(${pageVersionIds}::int[])
      GROUP BY date(v."timestamp")
    ),
    daily_revisions AS (
      SELECT
        date(r."timestamp") AS date,
        COUNT(*) AS revisions
      FROM "Revision" r
      WHERE r."pageVersionId" = ANY(${pageVersionIds}::int[])
      GROUP BY date(r."timestamp")
    )
    INSERT INTO "PageDailyStats" ("pageId", date, votes_up, votes_down, total_votes, unique_voters, revisions)
    SELECT
      ${pageId}::int AS "pageId",
      day.date,
      COALESCE(dv.votes_up, 0) AS votes_up,
      COALESCE(dv.votes_down, 0) AS votes_down,
      COALESCE(dv.total_votes, 0) AS total_votes,
      COALESCE(dv.unique_voters, 0) AS unique_voters,
      COALESCE(dr.revisions, 0) AS revisions
    FROM (
      SELECT DISTINCT date FROM (
        SELECT date FROM daily_votes
        UNION
        SELECT date FROM daily_revisions
      ) all_dates
    ) day
    LEFT JOIN daily_votes dv ON dv.date = day.date
    LEFT JOIN daily_revisions dr ON dr.date = day.date
    ORDER BY day.date
  `;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options.pageWid || !Number.isInteger(options.pageWid)) {
    console.error('请通过 --page-wid <WikidotId> 指定目标页面。');
    process.exit(1);
  }

  const prisma = getPrismaClient();
  try {
    const page = await prisma.page.findUnique({
      where: { wikidotId: options.pageWid },
      select: { id: true, currentUrl: true }
    });

    if (!page) {
      console.error(`未找到 WikidotId=${options.pageWid} 对应的页面。`);
      process.exit(1);
    }

    Logger.info(`处理页面：${page.id} (${page.currentUrl})`);

    const versions = await prisma.pageVersion.findMany({
      where: { pageId: page.id },
      select: { id: true, updatedAt: true },
      orderBy: { validFrom: 'asc' }
    });

    if (versions.length === 0) {
      console.warn('该页面尚未生成任何 PageVersion，终止。');
      return;
    }

    const pageVersionIds = versions.map((item) => item.id);

    await rebuildPageStats(prisma, pageVersionIds);

    const [range] = await prisma.$queryRaw<Array<{ min_date: Date | null; max_date: Date | null }>>`
      SELECT 
        MIN(v."timestamp") AS min_date,
        MAX(v."timestamp") AS max_date
      FROM "Vote" v
      WHERE v."pageVersionId" = ANY(${pageVersionIds}::int[])
    `;

    await rebuildPageDailyStats(prisma, page.id, pageVersionIds, range?.min_date ?? null, range?.max_date ?? null);

    const votingJob = new VotingTimeSeriesCacheJob(prisma);
    await votingJob.initializeSpecificCaches({ pageIds: [page.id] });

    Logger.info('单页分析计算完成 ✅');
  } finally {
    await disconnectPrisma();
  }
}

main().catch((error) => {
  console.error('分析失败：', error);
  process.exit(1);
});
