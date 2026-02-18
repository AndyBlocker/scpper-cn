-- gacha-v0.2-review-metrics.sql
-- Repro queries for Section 17 in docs/gacha-v0.2-design.md
-- Run against scpper-cn database (PostgreSQL).

-- ============================================================
-- Q1) Category page counts (live/all)
-- ============================================================
WITH latest_all AS (
  SELECT pv."pageId" AS page_id, pv.tags, pv."isDeleted"
  FROM "PageVersion" pv
  WHERE pv."validTo" IS NULL
),
x AS (
  SELECT 'OVERALL'::text AS category,
         COUNT(*) FILTER (WHERE NOT "isDeleted") AS page_count_live,
         COUNT(*) AS page_count_all
  FROM latest_all
  UNION ALL
  SELECT 'TRANSLATION',
         COUNT(*) FILTER (WHERE NOT "isDeleted" AND NOT ('原创' = ANY(tags))),
         COUNT(*) FILTER (WHERE NOT ('原创' = ANY(tags)))
  FROM latest_all
  UNION ALL
  SELECT 'SCP',
         COUNT(*) FILTER (WHERE NOT "isDeleted" AND '原创' = ANY(tags) AND 'scp' = ANY(tags)),
         COUNT(*) FILTER (WHERE '原创' = ANY(tags) AND 'scp' = ANY(tags))
  FROM latest_all
  UNION ALL
  SELECT 'TALE',
         COUNT(*) FILTER (WHERE NOT "isDeleted" AND '原创' = ANY(tags) AND '故事' = ANY(tags)),
         COUNT(*) FILTER (WHERE '原创' = ANY(tags) AND '故事' = ANY(tags))
  FROM latest_all
  UNION ALL
  SELECT 'GOI',
         COUNT(*) FILTER (WHERE NOT "isDeleted" AND '原创' = ANY(tags) AND 'goi格式' = ANY(tags)),
         COUNT(*) FILTER (WHERE '原创' = ANY(tags) AND 'goi格式' = ANY(tags))
  FROM latest_all
  UNION ALL
  SELECT 'WANDERERS',
         COUNT(*) FILTER (WHERE NOT "isDeleted" AND '原创' = ANY(tags) AND 'wanderers' = ANY(tags)),
         COUNT(*) FILTER (WHERE '原创' = ANY(tags) AND 'wanderers' = ANY(tags))
  FROM latest_all
)
SELECT *
FROM x
ORDER BY category;

-- ============================================================
-- Q2) 2022 vote outlier days (local robust z-score)
-- Rule: date in [2022-04-01, 2022-07-31] and rz_local >= 4
-- ============================================================
WITH daily AS (
  SELECT date::date AS day, SUM(total_votes)::numeric AS votes
  FROM "PageDailyStats"
  GROUP BY 1
),
scored AS (
  SELECT
    d1.day,
    d1.votes,
    CASE
      WHEN mad.mad_lv > 0 THEN 0.6745 * (LN(1 + d1.votes) - med.med_lv) / mad.mad_lv
      ELSE NULL
    END AS rz_local,
    CASE
      WHEN mad.mad_lv > 0 THEN GREATEST(EXP(med.med_lv + (4.0 / 0.6745) * mad.mad_lv) - 1, 0)
      ELSE d1.votes
    END AS cap_votes
  FROM daily d1
  CROSS JOIN LATERAL (
    SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY LN(1 + d3.votes)) AS med_lv
    FROM daily d3
    WHERE d3.day BETWEEN d1.day - INTERVAL '30 day' AND d1.day + INTERVAL '30 day'
      AND d3.day <> d1.day
  ) med
  CROSS JOIN LATERAL (
    SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(LN(1 + d2.votes) - med.med_lv)) AS mad_lv
    FROM daily d2
    WHERE d2.day BETWEEN d1.day - INTERVAL '30 day' AND d1.day + INTERVAL '30 day'
      AND d2.day <> d1.day
  ) mad
),
adj AS (
  SELECT
    day,
    votes::bigint AS votes_raw,
    ROUND(cap_votes)::bigint AS votes_cap,
    ROUND(
      CASE
        WHEN day BETWEEN DATE '2022-04-01' AND DATE '2022-07-31' AND rz_local >= 4
          THEN LEAST(votes, cap_votes)
        ELSE votes
      END
    )::bigint AS votes_adj,
    ROUND(rz_local::numeric, 2) AS rz_local
  FROM scored
)
SELECT
  day,
  votes_raw,
  votes_cap,
  votes_adj,
  ROUND((votes_adj::numeric / NULLIF(votes_raw, 0)), 4) AS scale,
  rz_local
FROM adj
WHERE votes_adj < votes_raw
ORDER BY day;

-- ============================================================
-- Q3) Yearly impact (targeted 2022 window only)
-- ============================================================
WITH daily AS (
  SELECT date::date AS day, SUM(total_votes)::numeric AS votes
  FROM "PageDailyStats"
  GROUP BY 1
),
scored AS (
  SELECT
    d1.day,
    d1.votes,
    CASE
      WHEN mad.mad_lv > 0 THEN 0.6745 * (LN(1 + d1.votes) - med.med_lv) / mad.mad_lv
      ELSE NULL
    END AS rz_local,
    CASE
      WHEN mad.mad_lv > 0 THEN GREATEST(EXP(med.med_lv + (4.0 / 0.6745) * mad.mad_lv) - 1, 0)
      ELSE d1.votes
    END AS cap_votes
  FROM daily d1
  CROSS JOIN LATERAL (
    SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY LN(1 + d3.votes)) AS med_lv
    FROM daily d3
    WHERE d3.day BETWEEN d1.day - INTERVAL '30 day' AND d1.day + INTERVAL '30 day'
      AND d3.day <> d1.day
  ) med
  CROSS JOIN LATERAL (
    SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ABS(LN(1 + d2.votes) - med.med_lv)) AS mad_lv
    FROM daily d2
    WHERE d2.day BETWEEN d1.day - INTERVAL '30 day' AND d1.day + INTERVAL '30 day'
      AND d2.day <> d1.day
  ) mad
),
adj AS (
  SELECT
    day,
    votes AS raw_votes,
    CASE
      WHEN day BETWEEN DATE '2022-04-01' AND DATE '2022-07-31' AND rz_local >= 4
        THEN LEAST(votes, cap_votes)
      ELSE votes
    END AS adj_votes
  FROM scored
)
SELECT
  EXTRACT(YEAR FROM day)::int AS year,
  COUNT(*) FILTER (WHERE adj_votes < raw_votes) AS capped_days,
  ROUND(SUM(raw_votes))::bigint AS raw_sum,
  ROUND(SUM(adj_votes))::bigint AS adj_sum,
  ROUND((100 * (SUM(raw_votes) - SUM(adj_votes)) / NULLIF(SUM(raw_votes), 0))::numeric, 2) AS reduced_pct
FROM adj
WHERE day >= DATE '2017-01-01'
GROUP BY 1
ORDER BY 1;
