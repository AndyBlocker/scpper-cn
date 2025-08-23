## BFF REST 路由与 SQL 映射（含 PGroonga 搜索）

本文件为前端开发提供一套可直接落地的 REST 资源与查询参数设计，并给出对应的 SQL 查询（基于 Postgres + PGroonga）。如需更详细的 SQL 与测试用例，请参考 `backend/docs/bff-rest-sql-spec.md`。

### 认证与权限
- OAuth2 + Scope 控制（GraphQL 指令 `@scope`/`@privileged` 已在 Schema 内定义）。
- 常用作用域：
  - `MANAGE_ACCOUNT`、`READ_WIKIDOT_INTEGRATION`、`READ_PATREON_INTEGRATION`、`MANAGE_READING_LISTS`、`MANAGE_DIARY_ENTRIES`。

### 约定
- 分页参数统一使用 `limit`/`offset`（整型，安全范围建议：1..100）。
- URL 规范：Wikidot 站点 URL 一律存为 `http://` 前缀。

---

### Pages（页面）

1) 列表与过滤

- REST: GET `/pages`
- 常用查询参数：`urlStartsWith`, `titleEqLower`, `categoryEq`, `tagEq(可重复)`, `ratingGte`, `ratingLte`, `createdAtGte`, `createdAtLte`, `isHidden`, `isUserPage`, `sortKey`, `sortOrder`, `limit`, `offset`
- 代表性 SQL：
```sql
SELECT 
  pv."wikidotId",
  p."currentUrl" AS url,
  pv.title,
  pv.rating,
  pv."voteCount",
  pv.category,
  pv.tags,
  pv."createdAt",
  pv."revisionCount",
  pv."commentCount",
  pv."isHidden",
  pv."isUserPage",
  pv."attributionCount"
FROM "PageVersion" pv
JOIN "Page" p ON pv."pageId" = p.id
WHERE pv."validTo" IS NULL
  AND ($1 IS NULL OR p."currentUrl" LIKE ($1 || '%'))
  AND ($2 IS NULL OR lower(pv.title) = $2)
  AND ($3 IS NULL OR pv.category = $3)
  AND ($4 IS NULL OR pv.tags @> ARRAY[$4]::text[])
  AND ($5 IS NULL OR pv.rating >= $5)
  AND ($6 IS NULL OR pv.rating <= $6)
  AND ($7 IS NULL OR pv."createdAt" >= $7::timestamptz)
  AND ($8 IS NULL OR pv."createdAt" <= $8::timestamptz)
  AND ($9 IS NULL OR pv."isHidden" = $9)
  AND ($10 IS NULL OR pv."isUserPage" = $10)
ORDER BY 
  CASE WHEN $11 = 'URL' THEN p."currentUrl" END 
    CASE WHEN $12 = 'DESC' THEN DESC END,
  CASE WHEN $11 = 'WIKIDOT_TITLE' THEN pv.title END 
    CASE WHEN $12 = 'DESC' THEN DESC END,
  CASE WHEN $11 = 'WIKIDOT_CREATED_AT' THEN pv."createdAt" END 
    CASE WHEN $12 = 'DESC' THEN DESC END,
  CASE WHEN $11 = 'WIKIDOT_RATING' THEN pv.rating END 
    CASE WHEN $12 = 'DESC' THEN DESC END
LIMIT $13 OFFSET $14;
```

2) 详情（按 URL 或 WikidotId）

- REST: GET `/pages/by-url?url=...`
```sql
SELECT pv."wikidotId", p."currentUrl" AS url, pv.*
FROM "PageVersion" pv
JOIN "Page" p ON pv."pageId" = p.id
WHERE pv."validTo" IS NULL AND p."currentUrl" = $1
LIMIT 1;
```

- REST: GET `/pages/by-id?wikidotId=...`
```sql
SELECT pv."wikidotId", p."currentUrl" AS url, pv.*
FROM "PageVersion" pv
JOIN "Page" p ON pv."pageId" = p.id
WHERE pv."validTo" IS NULL AND pv."wikidotId" = $1
LIMIT 1;
```

3) 聚合统计

- REST: GET `/aggregate/pages`
```sql
SELECT COUNT(*) AS _count
FROM "PageVersion" pv
JOIN "Page" p ON pv."pageId" = p.id
WHERE pv."validTo" IS NULL
  AND ($1 IS NULL OR p."currentUrl" LIKE ($1 || '%')) /* 可扩展与 /pages 同步的过滤条件 */
;
```

4) 站内路径匹配（跨站相同路径）

- REST: GET `/pages/matching?url=...`
```sql
WITH input AS (
  SELECT $1::text AS url
), path AS (
  SELECT regexp_replace(url, '^https?://[^/]+', '') AS p FROM input
)
SELECT pv."wikidotId", p."currentUrl" AS url, pv.title, pv.rating, pv.tags
FROM "PageVersion" pv
JOIN "Page" p ON pv."pageId" = p.id, path
WHERE pv."validTo" IS NULL AND p."currentUrl" LIKE ('http://%' || path.p)
ORDER BY pv."createdAt" DESC
LIMIT 50;
```
备注：可按需要限制站点白名单并缓存结果。

5) 随机页面

- REST: GET `/pages/random`
```sql
SELECT pv."wikidotId", p."currentUrl" AS url, pv.title, pv.rating
FROM "PageVersion" pv
JOIN "Page" p ON pv."pageId" = p.id
WHERE pv."validTo" IS NULL
ORDER BY random()
LIMIT 1;
```

6) 修订/投票/曲线（按页面）

- REST: GET `/pages/{wikidotId}/revisions?limit=&offset=`
```sql
SELECT r."wikidotId", r.timestamp, r.type, r.comment, r."userId"
FROM "Revision" r
JOIN "PageVersion" pv ON r."pageVersionId" = pv.id
WHERE pv."wikidotId" = $1
ORDER BY r.timestamp DESC
LIMIT $2 OFFSET $3;
```

- REST: GET `/pages/{wikidotId}/votes/fuzzy?limit=&offset=`
```sql
WITH pv AS (
  SELECT id FROM "PageVersion" WHERE "wikidotId" = $1 ORDER BY id DESC LIMIT 1
), dedup AS (
  SELECT v."userId", v.direction, v.timestamp::date AS day, MAX(v.timestamp) AS latest_ts
  FROM "Vote" v JOIN pv ON v."pageVersionId" = pv.id
  GROUP BY v."userId", v.direction, v.timestamp::date
)
SELECT d."userId", d.direction, d.latest_ts AS timestamp
FROM dedup d
ORDER BY d.latest_ts ASC
LIMIT $2 OFFSET $3;
```

- REST: GET `/pages/{wikidotId}/ratings/cumulative`
```sql
WITH pv AS (
  SELECT id FROM "PageVersion" WHERE "wikidotId" = $1 ORDER BY id DESC LIMIT 1
), daily AS (
  SELECT date_trunc('day', v.timestamp) AS day, SUM(v.direction) AS delta
  FROM "Vote" v JOIN pv ON v."pageVersionId" = pv.id
  GROUP BY 1
)
SELECT day::timestamptz AS date,
       SUM(delta) OVER (ORDER BY day ASC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS "cumulativeRating"
FROM daily
ORDER BY day ASC;
```

---

### Users（用户）

1) 详情与统计

- REST: GET `/users/{id}`
```sql
SELECT 
  id, 
  "wikidotId", 
  "displayName", 
  "firstActivityAt", 
  "firstActivityType",
  "firstActivityDetails",
  "lastActivityAt",
  username,
  "isGuest"
FROM "User"
WHERE id = $1;
```

- REST: GET `/users/{id}/stats`
```sql
SELECT 
  "overallRank" AS rank,
  COALESCE("totalRating", 0) AS "totalRating",
  COALESCE("overallRating", 0) AS "meanRating",
  COALESCE("pageCount", 0) AS "pageCount",
  COALESCE("scpPageCount", 0) AS "pageCountScp",
  COALESCE("storyPageCount", 0) AS "pageCountTale",
  COALESCE("goiPageCount", 0) AS "pageCountGoiFormat",
  COALESCE("artPageCount", 0) AS "pageCountArtwork",
  COALESCE("totalUp", 0) AS "totalUp",
  COALESCE("totalDown", 0) AS "totalDown",
  "favTag",
  "goiRank",
  COALESCE("goiRating", 0) AS "goiRating",
  "scpRank",
  COALESCE("scpRating", 0) AS "scpRating",
  "storyRank",
  COALESCE("storyRating", 0) AS "storyRating",
  "translationRank",
  COALESCE("translationRating", 0) AS "translationRating",
  COALESCE("translationPageCount", 0) AS "translationPageCount",
  "wanderersRank",
  COALESCE("wanderersRating", 0) AS "wanderersRating",
  COALESCE("wanderersPageCount", 0) AS "wanderersPageCount",
  "artRank",
  COALESCE("artRating", 0) AS "artRating",
  "ratingUpdatedAt"
FROM "UserStats"
WHERE "userId" = $1;
```

2) 用户作品列表（按归属）

- REST: GET `/users/{id}/pages?type=AUTHOR|REWRITE|TRANSLATOR|SUBMITTER&limit=&offset=`
```sql
SELECT DISTINCT pv."wikidotId", p."currentUrl" AS url, pv.title, pv.rating, pv.tags
FROM "Attribution" a
JOIN "PageVersion" pv ON pv.id = a."pageVerId"
JOIN "Page" p ON p.id = pv."pageId"
WHERE pv."validTo" IS NULL
  AND a."userId" = $1
  AND ($2::text IS NULL OR a.type = $2)
ORDER BY pv."createdAt" DESC
LIMIT $3 OFFSET $4;
```

3) 搜索与排名

- REST: GET `/search/users?query=&limit=&offset=`（PGroonga）
```sql
SELECT u.id, u."wikidotId", u."displayName",
       COALESCE(us."totalRating", 0) AS "totalRating",
       COALESCE(us."pageCount", 0) AS "pageCount"
FROM "User" u
LEFT JOIN "UserStats" us ON u.id = us."userId"
WHERE u."displayName" &@~ $1
ORDER BY us."totalRating" DESC NULLS LAST
LIMIT $2 OFFSET $3;
```

- REST: GET `/users/by-rank?limit=&offset=`
```sql
SELECT u.id, u."displayName", us."overallRank" AS rank, us."overallRating"
FROM "User" u
JOIN "UserStats" us ON us."userId" = u.id
WHERE us."overallRank" IS NOT NULL
ORDER BY us."overallRank" ASC
LIMIT $1 OFFSET $2;
```

---

### Reading Lists（阅读清单）与 Diary（日记）

当前数据库 Schema 未包含阅读清单/日记相关表，暂不提供对应 SQL 端点。

---

### Accounts & Applications（账户与应用）

当前数据库 Schema 未包含账户/应用管理表，暂不提供对应 SQL 端点。

---

### Sites（站点）

若需要站点清单，可通过配置提供；数据库暂无统一 `SiteInfo` 表时不提供 SQL。

---

### Search（搜索）

已启用 PGroonga，在 `PageVersion` 与 `User` 上进行全文检索；示例 SQL 如下。

1) 页面检索
```sql
WITH base AS (
  SELECT pv.id, pv."wikidotId", pv."pageId", pv.title, p."currentUrl" AS url,
         pv.rating, pv.tags,
         COALESCE(pgroonga_snippet_html(pv."textContent", pgroonga_query_extract_keywords($1), 200),
                  LEFT(pv."textContent", 200)) AS snippet,
         pgroonga_score(tableoid, ctid) AS score,
         pv."validFrom"
  FROM "PageVersion" pv
  JOIN "Page" p ON pv."pageId" = p.id
  WHERE pv."validTo" IS NULL
    AND (pv.title &@~ $1 OR pv."textContent" &@~ $1)
    AND ($2::text[] IS NULL OR pv.tags @> $2::text[])
    AND ($3::text[] IS NULL OR NOT (pv.tags && $3::text[]))
    AND ($4::int IS NULL OR pv.rating >= $4)
    AND ($5::int IS NULL OR pv.rating <= $5)
)
SELECT * FROM base
ORDER BY 
  CASE WHEN $8 = 'rating' THEN NULL END,
  CASE WHEN $8 = 'recent' THEN NULL END,
  CASE WHEN $8 IS NULL OR $8 = 'relevance' THEN score END DESC NULLS LAST,
  CASE WHEN $8 = 'rating' THEN rating END DESC NULLS LAST,
  CASE WHEN $8 = 'recent' THEN "validFrom" END DESC
LIMIT $6 OFFSET $7;
```

2) 用户检索
```sql
SELECT u.id, u."wikidotId", u."displayName",
       COALESCE(us."totalRating", 0) AS "totalRating",
       COALESCE(us."pageCount", 0) AS "pageCount"
FROM "User" u
LEFT JOIN "UserStats" us ON u.id = us."userId"
WHERE u."displayName" &@~ $1
ORDER BY us."totalRating" DESC NULLS LAST
LIMIT $2 OFFSET $3;
```

（向量混合检索依赖 SearchIndex/SearchChunk 如存在时再启用，详见 `bff-rest-sql-spec.md` 可选章节。）

---

### 设计建议
- BFF 中对输入参数进行白名单与范围校验；所有 SQL 使用参数化占位符 `$1..$n`。
- 对高成本查询（如 `matchingPages`、大分页）做缓存与限流。
- 若未来补充阅读清单/日记/账户表，再补充相应 REST→SQL 条目。

---

### Stats（扩展只读数据集）

- REST: GET `/stats/interesting-facts?category=&type=&pageId=&userId=&date=&tag=&limit=&offset=`
```sql
SELECT id, category, type, title, description, value, metadata, "pageId", "userId", "dateContext" AS date, "tagContext" AS tag, rank, "calculatedAt", "isActive"
FROM "InterestingFacts"
WHERE ($1::text IS NULL OR category = $1::text)
  AND ($2::text IS NULL OR type = $2::text)
  AND ($3::int IS NULL OR "pageId" = $3::int)
  AND ($4::int IS NULL OR "userId" = $4::int)
  AND ($5::date IS NULL OR "dateContext" = $5::date)
  AND ($6::text IS NULL OR "tagContext" = $6::text)
ORDER BY rank ASC, "calculatedAt" DESC
LIMIT $7 OFFSET $8;
```

- REST: GET `/stats/milestones?period=&periodValue=&milestoneType=&pageId=&limit=&offset=`
```sql
SELECT id, period, "periodValue", "milestoneType", "pageId", "pageTitle", "pageRating", "pageCreatedAt", "calculatedAt"
FROM "TimeMilestones"
WHERE ($1::text IS NULL OR period = $1::text)
  AND ($2::text IS NULL OR "periodValue" = $2::text)
  AND ($3::text IS NULL OR "milestoneType" = $3::text)
  AND ($4::int IS NULL OR "pageId" = $4::int)
ORDER BY "calculatedAt" DESC
LIMIT $5 OFFSET $6;
```

- REST: GET `/stats/tag-records?tag=&recordType=&pageId=&userId=&limit=&offset=`
```sql
SELECT id, tag, "recordType", "pageId", "userId", value, metadata, "calculatedAt"
FROM "TagRecords"
WHERE ($1::text IS NULL OR tag = $1::text)
  AND ($2::text IS NULL OR "recordType" = $2::text)
  AND ($3::int IS NULL OR "pageId" = $3::int)
  AND ($4::int IS NULL OR "userId" = $4::int)
ORDER BY "calculatedAt" DESC
LIMIT $5 OFFSET $6;
```

- REST: GET `/stats/content-records?recordType=&pageId=&limit=&offset=`
```sql
SELECT id, "recordType", "pageId", "pageTitle", "sourceLength", "contentLength", complexity, "calculatedAt"
FROM "ContentRecords"
WHERE ($1::text IS NULL OR "recordType" = $1::text)
  AND ($2::int IS NULL OR "pageId" = $2::int)
ORDER BY "calculatedAt" DESC
LIMIT $3 OFFSET $4;
```

- REST: GET `/stats/rating-records?recordType=&timeframe=&pageId=&limit=&offset=`
```sql
SELECT id, "recordType", timeframe, "pageId", "pageTitle", rating, "voteCount", controversy, wilson95, value, "achievedAt", "calculatedAt"
FROM "RatingRecords"
WHERE ($1::text IS NULL OR "recordType" = $1::text)
  AND ($2::text IS NULL OR timeframe = $2::text)
  AND ($3::int IS NULL OR "pageId" = $3::int)
ORDER BY COALESCE("achievedAt", "calculatedAt") DESC
LIMIT $4 OFFSET $5;
```

- REST: GET `/stats/user-activity?recordType=&userId=&limit=&offset=`
```sql
SELECT id, "recordType", "userId", "userDisplayName", value, context, "achievedAt", "calculatedAt"
FROM "UserActivityRecords"
WHERE ($1::text IS NULL OR "recordType" = $1::text)
  AND ($2::int IS NULL OR "userId" = $2::int)
ORDER BY COALESCE("achievedAt", "calculatedAt") DESC
LIMIT $3 OFFSET $4;
```


