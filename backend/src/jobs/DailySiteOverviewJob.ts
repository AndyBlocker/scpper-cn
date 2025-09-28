import { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../utils/db-connection.js';
import { Logger } from '../utils/Logger.js';

export type DailyOverviewOptions = {
  startDate?: string; // YYYY-MM-DD
  endDate?: string;   // YYYY-MM-DD
  dryRun?: boolean;
};

export class DailySiteOverviewJob {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = getPrismaClient();
  }

  private toDateOnly(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  async run(options: DailyOverviewOptions = {}): Promise<void> {
    const end = options.endDate ? new Date(options.endDate) : new Date();
    const start = options.startDate ? new Date(options.startDate) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

    // normalize to date-only boundaries (UTC)
    const dayMs = 24 * 60 * 60 * 1000;
    const startDay = new Date(this.toDateOnly(start));
    const endDay = new Date(this.toDateOnly(end));

    for (let t = startDay.getTime(); t <= endDay.getTime(); t += dayMs) {
      const dateStr = this.toDateOnly(new Date(t));
      try {
        await this.computeAndUpsert(dateStr, Boolean(options.dryRun));
      } catch (e) {
        Logger.error(`DailySiteOverviewJob: failed for ${dateStr}`, e);
        // continue other days to avoid blocking the whole range
      }
    }
  }

  private async computeAndUpsert(dateStr: string, dryRun: boolean): Promise<void> {
    // date range [date, date + 1)
    const dateStart = `${dateStr}T00:00:00.000Z`;
    const dateEnd = `${dateStr}T23:59:59.999Z`;

    // Users totals based on real event times
    const usersTotalRow = await this.prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS count
       FROM "User" u
       WHERE u."firstActivityAt" IS NOT NULL AND u."firstActivityAt" <= $1::timestamptz`,
      dateEnd
    );
    // Active users (rolling 60-day distinct based on UserDailyStats)
    const usersActiveRow = await this.prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(DISTINCT uds."userId")::bigint AS count
       FROM "UserDailyStats" uds
       WHERE uds.date BETWEEN ($1::date - INTERVAL '59 days') AND $1::date`,
      dateStr
    );

    // contributors snapshot: unique users whose earliest contribution event (revision or attribution) is <= day end
    const contributorsSnapshot = await this.prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `WITH rev_first AS (
         SELECT r."userId" as uid, MIN(r.timestamp) AS first_ts
         FROM "Revision" r
         WHERE r."userId" IS NOT NULL
         GROUP BY r."userId"
       ), attr_first AS (
         SELECT a."userId" as uid, MIN(a.date) AS first_ts
         FROM "Attribution" a
         WHERE a."userId" IS NOT NULL AND a.date IS NOT NULL
         GROUP BY a."userId"
       ), unioned AS (
         SELECT uid, first_ts FROM rev_first
         UNION ALL
         SELECT uid, first_ts FROM attr_first
       ), first_any AS (
         SELECT uid, MIN(first_ts) AS first_any_ts FROM unioned GROUP BY uid
       )
       SELECT COUNT(*)::bigint AS count FROM first_any WHERE first_any_ts <= $1::timestamptz`,
      dateEnd
    );

    // authors snapshot: users whose earliest authoring event on an '原创' page is <= day end
    const authorsSnapshot = await this.prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `WITH current_orig AS (
         SELECT pv.id AS pv_id, pv."pageId" AS pid
         FROM "PageVersion" pv
         WHERE pv."validTo" IS NULL AND pv."isDeleted" = false AND '原创' = ANY(pv.tags)
       ), page_created AS (
         SELECT pv."pageId" AS pid, MIN(r.timestamp) AS created_at
         FROM "Revision" r JOIN "PageVersion" pv ON pv.id = r."pageVersionId"
         WHERE r.type = 'PAGE_CREATED'
         GROUP BY pv."pageId"
       ), author_events AS (
         SELECT a."userId" AS uid, COALESCE(a.date, pc.created_at) AS event_at
         FROM "Attribution" a
         JOIN current_orig co ON co.pv_id = a."pageVerId"
         LEFT JOIN page_created pc ON pc.pid = co.pid
         WHERE a."userId" IS NOT NULL
       )
       SELECT COUNT(DISTINCT ae.uid)::bigint AS count FROM author_events ae WHERE ae.event_at IS NOT NULL AND ae.event_at <= $1::timestamptz`,
      dateEnd
    );

    // pages snapshot by creation time (first PAGE_CREATED revision), classify by current tags
    const pagesTotalsRow = await this.prisma.$queryRawUnsafe<{ total: bigint; originals: bigint; translations: bigint }[]>(
      `WITH first_rev AS (
         SELECT pv."pageId", MIN(r.timestamp) AS first_ts
         FROM "Revision" r
         JOIN "PageVersion" pv ON pv.id = r."pageVersionId"
         WHERE r.type = 'PAGE_CREATED'
         GROUP BY pv."pageId"
       ), created AS (
         SELECT fr."pageId" FROM first_rev fr WHERE fr.first_ts <= $1::timestamptz
       ), current AS (
         SELECT pvcur."pageId", pvcur.tags
         FROM "PageVersion" pvcur
         WHERE pvcur."validTo" IS NULL AND pvcur."isDeleted" = false
       )
       SELECT 
         (SELECT COUNT(*) FROM created)::bigint AS total,
         (SELECT COUNT(*) FROM created c JOIN current cur ON cur."pageId" = c."pageId" WHERE '原创' = ANY(cur.tags))::bigint AS originals,
         (SELECT COUNT(*) FROM created c JOIN current cur ON cur."pageId" = c."pageId" WHERE NOT ('原创' = ANY(cur.tags)))::bigint AS translations
      `,
      dateEnd
    );

    // PageDailyStats aggregates for votes/revisions
    const aggDaily = await this.prisma.$queryRawUnsafe<{ votesUp: bigint; votesDown: bigint; revisions: bigint }[]>(
      `SELECT COALESCE(SUM("votes_up"),0)::bigint AS "votesUp",
              COALESCE(SUM("votes_down"),0)::bigint AS "votesDown",
              COALESCE(SUM(revisions),0)::bigint AS revisions
       FROM "PageDailyStats"
       WHERE date = $1::date`,
      dateStr
    );

    const usersTotal = Number(usersTotalRow[0]?.count || 0);
    const usersActive = Number(usersActiveRow[0]?.count || 0);
    const pagesTotal = Number(pagesTotalsRow[0]?.total || 0);

    const row = {
      date: new Date(dateStr),
      usersTotal,
      usersActive,
      usersContributors: Number(contributorsSnapshot[0]?.count || 0),
      usersAuthors: Number(authorsSnapshot[0]?.count || 0),
      pagesTotal,
      pagesOriginals: Number(pagesTotalsRow[0]?.originals || 0),
      pagesTranslations: Number(pagesTotalsRow[0]?.translations || 0),
      votesUp: Number(aggDaily[0]?.votesUp || 0),
      votesDown: Number(aggDaily[0]?.votesDown || 0),
      revisionsTotal: Number(aggDaily[0]?.revisions || 0)
    };

    if (dryRun) {
      Logger.info(`[DryRun] SiteOverviewDaily ${dateStr}`, row);
      return;
    }

    const anyPrisma = this.prisma as any;
    if (anyPrisma.siteOverviewDaily && typeof anyPrisma.siteOverviewDaily.upsert === 'function') {
      await anyPrisma.siteOverviewDaily.upsert({
        where: { date: row.date },
        update: {
          usersTotal: row.usersTotal,
          usersActive: row.usersActive,
          usersContributors: row.usersContributors,
          usersAuthors: row.usersAuthors,
          pagesTotal: row.pagesTotal,
          pagesOriginals: row.pagesOriginals,
          pagesTranslations: row.pagesTranslations,
          votesUp: row.votesUp,
          votesDown: row.votesDown,
          revisionsTotal: row.revisionsTotal,
        },
        create: row
      });
    } else {
      // Fallback: use raw SQL UPSERT in case Prisma client hasn't been regenerated yet
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO "SiteOverviewDaily" (
            date, "usersTotal", "usersActive", "usersContributors", "usersAuthors",
            "pagesTotal", "pagesOriginals", "pagesTranslations",
            "votesUp", "votesDown", "revisionsTotal"
         ) VALUES (
            $1::date, $2::int, $3::int, $4::int, $5::int,
            $6::int, $7::int, $8::int,
            $9::int, $10::int, $11::int
         )
         ON CONFLICT (date) DO UPDATE SET
            "usersTotal" = EXCLUDED."usersTotal",
            "usersActive" = EXCLUDED."usersActive",
            "usersContributors" = EXCLUDED."usersContributors",
            "usersAuthors" = EXCLUDED."usersAuthors",
            "pagesTotal" = EXCLUDED."pagesTotal",
            "pagesOriginals" = EXCLUDED."pagesOriginals",
            "pagesTranslations" = EXCLUDED."pagesTranslations",
            "votesUp" = EXCLUDED."votesUp",
            "votesDown" = EXCLUDED."votesDown",
            "revisionsTotal" = EXCLUDED."revisionsTotal"`,
        dateStr,
        row.usersTotal,
        row.usersActive,
        row.usersContributors,
        row.usersAuthors,
        row.pagesTotal,
        row.pagesOriginals,
        row.pagesTranslations,
        row.votesUp,
        row.votesDown,
        row.revisionsTotal
      );
    }
  }
}

export async function runDailySiteOverview(options: DailyOverviewOptions = {}) {
  const job = new DailySiteOverviewJob();
  await job.run(options);
}



