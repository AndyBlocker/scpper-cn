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

  private async upsertRange(startDate: string, endDate: string, dryRun = false): Promise<void> {
    const sql = `
WITH params AS (
  SELECT $1::date AS start, $2::date AS finish
),
days AS (
  SELECT gs::date AS day
  FROM generate_series((SELECT start FROM params), (SELECT finish FROM params), '1 day') gs
),

/******** 当前有效 PageVersion（做页面归类用） ********/
current_pv AS (
  SELECT pv."pageId", pv.tags
  FROM "PageVersion" pv
  WHERE pv."validTo" IS NULL AND pv."isDeleted" = false
),

/******** 有效归属（剔除混入的 SUBMITTER） ********/
effective_attributions AS (
  SELECT a.*
  FROM (
    SELECT 
      a.*,
      BOOL_OR(a.type <> 'SUBMITTER') OVER (PARTITION BY a."pageVerId") AS has_non_submitter
    FROM "Attribution" a
  ) a
  WHERE NOT (a.has_non_submitter AND a.type = 'SUBMITTER')
),

/******** usersTotal：按 firstActivityAt 的累积 ********/
new_users AS (
  SELECT date_trunc('day', u."firstActivityAt")::date AS day, COUNT(*)::bigint AS cnt
  FROM "User" u
  WHERE u."firstActivityAt" IS NOT NULL
  GROUP BY 1
),
users_total AS (
  SELECT d.day,
         COALESCE(SUM(nu.cnt) OVER (ORDER BY d.day
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 0)::bigint AS users_total
  FROM days d
  LEFT JOIN new_users nu ON nu.day = d.day
),

/******** usersContributors：首次贡献日 -> 累积 ********/
rev_first AS (
  SELECT r."userId" AS uid, MIN(r."timestamp") AS first_ts
  FROM "Revision" r
  WHERE r."userId" IS NOT NULL
  GROUP BY r."userId"
),
attr_first AS (
  SELECT a."userId" AS uid, MIN(a."date") AS first_ts
  FROM effective_attributions a
  WHERE a."userId" IS NOT NULL AND a."date" IS NOT NULL
  GROUP BY a."userId"
),
first_contrib AS (
  SELECT uid, MIN(first_ts) AS first_ts
  FROM (
    SELECT * FROM rev_first
    UNION ALL
    SELECT * FROM attr_first
  ) s
  GROUP BY uid
),
contributors_new AS (
  SELECT date_trunc('day', first_ts)::date AS day, COUNT(*)::bigint AS cnt
  FROM first_contrib
  GROUP BY 1
),
contributors_total AS (
  SELECT d.day,
         COALESCE(SUM(cn.cnt) OVER (ORDER BY d.day
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 0)::bigint AS total_contributors
  FROM days d
  LEFT JOIN contributors_new cn ON cn.day = d.day
),

/******** usersAuthors：在“当前为原创”的页面上的首次作者事件 -> 累积 ********/
page_created AS (
  SELECT pv."pageId" AS pid, MIN(r."timestamp") AS created_at
  FROM "Revision" r
  JOIN "PageVersion" pv ON pv.id = r."pageVersionId"
  WHERE r.type = 'PAGE_CREATED'
  GROUP BY pv."pageId"
),
attr_with_page AS (
  SELECT a."userId" AS uid, a."date" AS at_date, pv."pageId" AS pid
  FROM effective_attributions a
  JOIN "PageVersion" pv ON pv.id = a."pageVerId"
  WHERE a."userId" IS NOT NULL
),
author_events AS (
  SELECT awp.uid,
         COALESCE(awp.at_date, pc.created_at) AS event_at
  FROM attr_with_page awp
  JOIN current_pv cp ON cp."pageId" = awp.pid
  LEFT JOIN page_created pc ON pc.pid = awp.pid
  WHERE '原创' = ANY(cp.tags)
),
authors_first AS (
  SELECT uid, MIN(event_at) AS first_ts
  FROM author_events
  WHERE event_at IS NOT NULL
  GROUP BY uid
),
authors_new AS (
  SELECT date_trunc('day', first_ts)::date AS day, COUNT(*)::bigint AS cnt
  FROM authors_first
  GROUP BY 1
),
authors_total AS (
  SELECT d.day,
         COALESCE(SUM(an.cnt) OVER (ORDER BY d.day
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 0)::bigint AS total_authors
  FROM days d
  LEFT JOIN authors_new an ON an.day = d.day
),

/******** 页面累计（用当前 tags 归类） ********/
first_rev AS (
  SELECT pv."pageId", MIN(r."timestamp") AS first_ts
  FROM "Revision" r
  JOIN "PageVersion" pv ON pv.id = r."pageVersionId"
  WHERE r.type = 'PAGE_CREATED'
  GROUP BY pv."pageId"
),
pages_new AS (
  SELECT date_trunc('day', fr.first_ts)::date AS day,
         COUNT(*)::bigint AS total,
         COUNT(*) FILTER (WHERE '原创' = ANY(cp.tags))::bigint AS originals,
         COUNT(*) FILTER (WHERE NOT ('原创' = ANY(cp.tags)))::bigint AS translations
  FROM first_rev fr
  JOIN current_pv cp ON cp."pageId" = fr."pageId"
  GROUP BY 1
),
pages_total AS (
  SELECT d.day,
         COALESCE(SUM(pn.total)       OVER (ORDER BY d.day
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 0)::bigint AS total_pages,
         COALESCE(SUM(pn.originals)   OVER (ORDER BY d.day
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 0)::bigint AS originals,
         COALESCE(SUM(pn.translations)OVER (ORDER BY d.day
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 0)::bigint AS translations
  FROM days d
  LEFT JOIN pages_new pn ON pn.day = d.day
),

/******** votes/revisions：直接用 PageDailyStats 的当日聚合 ********/
votes_daily AS (
  SELECT pds.date AS day,
         SUM(pds.votes_up)::bigint   AS votes_up,
         SUM(pds.votes_down)::bigint AS votes_down,
         SUM(pds.revisions)::bigint  AS revisions
  FROM "PageDailyStats" pds
  WHERE pds.date BETWEEN (SELECT start FROM params) AND (SELECT finish FROM params)
  GROUP BY pds.date
),

/******** usersActive：60 天窗口去重（区间合并 + 前缀和） ********/
ud AS (
  SELECT DISTINCT uds."userId", uds.date::date AS day
  FROM "UserDailyStats" uds
  WHERE uds.date BETWEEN ((SELECT start FROM params) - INTERVAL '59 days') AND (SELECT finish FROM params)
),
ud_sorted AS (
  SELECT u."userId", u.day,
         LAG(u.day) OVER (PARTITION BY u."userId" ORDER BY u.day) AS prev_day
  FROM ud u
),
ud_grp AS (
  SELECT "userId", day,
         CASE WHEN prev_day IS NULL OR day > prev_day + INTERVAL '59 days' THEN 1 ELSE 0 END AS is_new
  FROM ud_sorted
),
ud_grp_id AS (
  SELECT "userId", day,
         SUM(is_new) OVER (PARTITION BY "userId" ORDER BY day) AS grp
  FROM ud_grp
),
intervals AS (
  SELECT "userId",
         MIN(day) AS s,
         (MAX(day) + INTERVAL '59 days')::date AS e
  FROM ud_grp_id
  GROUP BY "userId", grp
),
intervals_clip AS (
  SELECT GREATEST(s, (SELECT start FROM params)) AS s,
         LEAST(e,    (SELECT finish FROM params)) AS e
  FROM intervals
  WHERE e >= (SELECT start FROM params) AND s <= (SELECT finish FROM params)
),
events_raw AS (
  SELECT s AS day, 1 AS delta FROM intervals_clip
  UNION ALL
  SELECT (e + INTERVAL '1 day')::date AS day, -1 AS delta
  FROM intervals_clip
  WHERE e < (SELECT finish FROM params)
),
events AS (
  SELECT day, SUM(delta) AS delta
  FROM events_raw
  GROUP BY 1
),
users_active AS (
  SELECT d.day,
         SUM(COALESCE(ev.delta,0)) OVER (ORDER BY d.day
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)::bigint AS users_active
  FROM days d
  LEFT JOIN events ev ON ev.day = d.day
),

/******** 汇总 ********/
final AS (
  SELECT d.day AS date,
         ut.users_total             AS "usersTotal",
         ua.users_active            AS "usersActive",
         ct.total_contributors      AS "usersContributors",
         at.total_authors           AS "usersAuthors",
         pt.total_pages             AS "pagesTotal",
         pt.originals               AS "pagesOriginals",
         pt.translations            AS "pagesTranslations",
         COALESCE(vd.votes_up,0)    AS "votesUp",
         COALESCE(vd.votes_down,0)  AS "votesDown",
         COALESCE(vd.revisions,0)   AS "revisionsTotal"
  FROM days d
  LEFT JOIN users_total     ut ON ut.day = d.day
  LEFT JOIN users_active    ua ON ua.day = d.day
  LEFT JOIN contributors_total ct ON ct.day = d.day
  LEFT JOIN authors_total   at ON at.day = d.day
  LEFT JOIN pages_total     pt ON pt.day = d.day
  LEFT JOIN votes_daily     vd ON vd.day = d.day
)
${dryRun ? `
SELECT * FROM final ORDER BY date;`
: `
INSERT INTO "SiteOverviewDaily" (
  date, "usersTotal", "usersActive", "usersContributors", "usersAuthors",
  "pagesTotal", "pagesOriginals", "pagesTranslations",
  "votesUp", "votesDown", "revisionsTotal"
)
SELECT
  date, "usersTotal", "usersActive", "usersContributors", "usersAuthors",
  "pagesTotal", "pagesOriginals", "pagesTranslations",
  "votesUp", "votesDown", "revisionsTotal"
FROM final
ON CONFLICT (date) DO UPDATE SET
  "usersTotal"        = EXCLUDED."usersTotal",
  "usersActive"       = EXCLUDED."usersActive",
  "usersContributors" = EXCLUDED."usersContributors",
  "usersAuthors"      = EXCLUDED."usersAuthors",
  "pagesTotal"        = EXCLUDED."pagesTotal",
  "pagesOriginals"    = EXCLUDED."pagesOriginals",
  "pagesTranslations" = EXCLUDED."pagesTranslations",
  "votesUp"           = EXCLUDED."votesUp",
  "votesDown"         = EXCLUDED."votesDown",
  "revisionsTotal"    = EXCLUDED."revisionsTotal";`
}
  `;

    if (dryRun) {
      const rows = await this.prisma.$queryRawUnsafe<any[]>(sql, startDate, endDate);
      Logger.info(`[DryRun] SiteOverviewDaily ${startDate}..${endDate} rows=${rows.length}`);
      if (rows.length) {
        Logger.info(rows.slice(0, Math.min(5, rows.length)));
      }
    } else {
      await this.prisma.$executeRawUnsafe(sql, startDate, endDate);
    }
  }

  async run(options: DailyOverviewOptions = {}): Promise<void> {
    const end = options.endDate ? new Date(options.endDate) : new Date();
    const start = options.startDate ? new Date(options.startDate) : new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

    await this.upsertRange(this.toDateOnly(start), this.toDateOnly(end), Boolean(options.dryRun));
  }
}

export async function runDailySiteOverview(options: DailyOverviewOptions = {}) {
  const job = new DailySiteOverviewJob();
  await job.run(options);
}
