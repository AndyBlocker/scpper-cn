DROP VIEW IF EXISTS "LatestVote";

CREATE VIEW "LatestVote" AS
SELECT
  ranked.id,
  ranked."pageVersionId",
  ranked.timestamp,
  ranked.direction,
  ranked."userId",
  ranked."anonKey",
  ranked."actorKey"
FROM (
  SELECT
    base.id,
    base."pageVersionId",
    base.timestamp,
    base.direction,
    base."userId",
    base."anonKey",
    base."actorKey",
    ROW_NUMBER() OVER (
      PARTITION BY base."pageVersionId", base."actorKey"
      ORDER BY base.timestamp DESC, base.id DESC
    ) AS rn
  FROM (
    SELECT
      v.id,
      v."pageVersionId",
      v.timestamp,
      v.direction,
      v."userId",
      v."anonKey",
      CASE
        WHEN v."userId" IS NOT NULL THEN 'u:' || v."userId"::text
        WHEN v."anonKey" IS NOT NULL THEN 'a:' || v."anonKey"
        ELSE 'g:' || v.id::text
      END AS "actorKey"
    FROM "Vote" v
  ) AS base
) AS ranked
WHERE ranked.rn = 1;
