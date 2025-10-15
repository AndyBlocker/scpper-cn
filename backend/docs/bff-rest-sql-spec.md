## BFF REST → SQL 规范（含 PGroonga）

目标：本规范定义 BFF 应实现的 REST 端点，以及其直接对应的 SQL 查询（基于 Postgres + PGroonga）。每个端点包含：
- 请求参数 → SQL 占位符映射
- SQL 语句（使用 `$1..$n` 参数占位）
- 返回数据结构约定（字段类型与可空性）
- 测试方案（输入、预置数据、期望输出）

注意：
- 搜索相关端点基于 PGroonga 建立在表 `"PageVersion"`、`"User"` 上的索引与运算符（`&@~`, `pgroonga_score`, `pgroonga_query_extract_keywords`, `pgroonga_snippet_html`）。
- 页面实体字段主要来自 `"PageVersion"`（当前有效版本 `validTo IS NULL`）与 `"Page"` 的关联。

---

### 1) 搜索页面（PGroonga）

- REST: GET `/search/pages`
- Query params: 
  - `query` string (必填)
  - `limit` int (默认 20, 1..100)
  - `offset` int (默认 0)
  - `tags[]` string[] (可选，包含全部)
  - `excludeTags[]` string[] (可选，排除任一)
  - `ratingMin` int (可选)
  - `ratingMax` int (可选)
  - `orderBy` enum: `relevance|rating|recent` (默认 `relevance`)

- SQL:
```sql
-- Params: $1=query, $2=tags?::text[], $3=excludeTags?::text[], $4=ratingMin?, $5=ratingMax?, $6=limit, $7=offset
WITH base AS (
  SELECT 
    pv.id,
    pv."wikidotId",
    pv."pageId",
    pv.title,
    p."currentUrl" AS url,
    pv.rating,
    pv.tags,
    COALESCE(
      pgroonga_snippet_html(pv."textContent", pgroonga_query_extract_keywords($1), 200),
      LEFT(pv."textContent", 200)
    ) AS snippet,
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

- 返回约定：
```json
{
  "results": [
    {
      "id": number,
      "wikidotId": number,
      "pageId": number,
      "title": string | null,
      "url": string,
      "rating": number | null,
      "tags": string[],
      "snippet": string,
      "score": number | null
    }
  ]
}
```

- 测试：
  - 预置：插入 2 条 `Page` + 各 1 条有效 `PageVersion(validTo IS NULL)`；分别设置 `title`, `textContent`, `tags`, `rating`。
  - 输入：`query="基金会"`, `tags=["scp"]`, `excludeTags=null`, `ratingMin=0`, `orderBy=relevance`。
  - 期望：结果包含匹配到 `title` 或 `textContent` 的页面，`snippet` 含高亮片段，`tags` 包含 `scp`，`score` 非空且排序靠前。

---

### 2) 搜索用户（PGroonga）

- REST: GET `/search/users`
- Query params: `query`(必填), `limit`(默认20), `offset`(默认0)
- SQL:
```sql
-- Params: $1=query, $2=limit, $3=offset
SELECT 
  u.id,
  u."wikidotId",
  u."displayName",
  COALESCE(us."totalRating", 0) AS "totalRating",
  COALESCE(us."pageCount", 0) AS "pageCount"
FROM "User" u
LEFT JOIN "UserStats" us ON u.id = us."userId"
WHERE u."displayName" &@~ $1
ORDER BY us."totalRating" DESC NULLS LAST
LIMIT $2 OFFSET $3;
```

- 返回约定：
```json
{
  "results": [
    { "id": number, "wikidotId": number | null, "displayName": string | null, "totalRating": number, "pageCount": number }
  ]
}
```

- 测试：
  - 预置：`User.displayName` 含中文/英文混合；`UserStats.totalRating` 各异。
  - 输入：`query="作者A"`。
  - 期望：仅返回匹配显示名用户，按 `totalRating` 降序。

---

### 3) 页面列表（过滤 + 排序）

- REST: GET `/pages`
- Query params: 
  - `urlStartsWith` string
  - `titleEqLower` string
  - `categoryEq` string
  - `tagEq` string (可重复)
  - `ratingGte`/`ratingLte` int
  - `createdAtGte`/`createdAtLte` ISO8601
  - `isHidden` boolean
  - `isUserPage` boolean
  - `sortKey` enum: `URL|LATEST_ATTRIBUTION_DATE|WIKIDOT_TITLE|WIKIDOT_CREATED_AT|WIKIDOT_RATING`
  - `sortOrder` enum: `ASC|DESC`
  - `limit`/`offset`

- SQL（示例：覆盖常用字段；若需更复杂 `_and/_or/_not` 逻辑，可在 BFF 组装动态 SQL）：
```sql
-- Params: $1=urlStartsWith?, $2=titleEqLower?, $3=categoryEq?, $4=tagEq?, $5=ratingGte?, $6=ratingLte?, $7=createdAtGte?, $8=createdAtLte?, $9=isHidden?, $10=isUserPage?, $11=sortKey, $12=sortOrder, $13=limit, $14=offset
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

- 返回约定：数组，每项包含上述 SELECT 字段；空值允许。

- 测试：
  - 预置：插入不同 `url`, `title`, `tags`, `rating`；设置 `isHidden`/`isUserPage` 组合。
  - 输入：`urlStartsWith=http://scp-wiki-cn.wikidot.com`，`tagEq=scp`，`ratingGte=10`，`sortKey=WIKIDOT_RATING`，`sortOrder=DESC`。
  - 期望：只返回满足条件的页面，按评分降序。

---

### 4) 页面详情（按 URL 或 wikidotId）

- REST: GET `/pages/by-url`
- Params: `url`（必填）
- SQL:
```sql
-- $1=url
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
  pv."isUserPage"
FROM "PageVersion" pv
JOIN "Page" p ON pv."pageId" = p.id
WHERE pv."validTo" IS NULL AND p."currentUrl" = $1
LIMIT 1;
```

- REST: GET `/pages/by-id`
- Params: `wikidotId`（必填）
- SQL:
```sql
-- $1=wikidotId
SELECT 
  pv."wikidotId",
  p."currentUrl" AS url,
  pv.*
FROM "PageVersion" pv
JOIN "Page" p ON pv."pageId" = p.id
WHERE pv."validTo" IS NULL AND pv."wikidotId" = $1
LIMIT 1;
```

- 测试：
  - 预置：确保 URL 与 wikidotId 均可查到对应有效版本。
  - 输入：分别传 URL 与 wikidotId。
  - 期望：返回对应记录，字段完整。

---

### 5) 页面修订列表

- REST: GET `/pages/{wikidotId}/revisions`
- Params: `wikidotId`, `limit`(默认20), `offset`(默认0)
- SQL:
```sql
-- $1=wikidotId, $2=limit, $3=offset
SELECT r."wikidotId", r.timestamp, r.type, r.comment, r."userId"
FROM "Revision" r
JOIN "PageVersion" pv ON r."pageVersionId" = pv.id
WHERE pv."wikidotId" = $1
ORDER BY r.timestamp DESC
LIMIT $2 OFFSET $3;
```

- 返回约定：数组，按时间倒序。

- 测试：
  - 预置：为某 `wikidotId` 写入多条 `Revision`。
  - 期望：分页稳定、顺序正确。

---

### 6) 模糊投票记录（按日去重）

- REST: GET `/pages/{wikidotId}/votes/fuzzy`
- Params: `wikidotId`, `limit`(默认100), `offset`(默认0)
- 说明：表为 `Vote`，按 `pageVersionId` + `timestamp::date` 聚合，取同日最新记录。
- SQL：
```sql
-- $1=wikidotId, $2=limit, $3=offset
WITH pv AS (
  SELECT id FROM "PageVersion" WHERE "wikidotId" = $1 ORDER BY id DESC LIMIT 1
), dedup AS (
  SELECT 
    v."userId",
    v.direction,
    v.timestamp::date AS day,
    MAX(v.timestamp) AS latest_ts
  FROM "Vote" v
  JOIN pv ON v."pageVersionId" = pv.id
  GROUP BY v."userId", v.direction, v.timestamp::date
)
SELECT d."userId", d.direction, d.latest_ts AS timestamp
FROM dedup d
ORDER BY d.latest_ts ASC
LIMIT $2 OFFSET $3;
```

- 返回约定：数组；`userId` 可空（匿名时）。

- 测试：
  - 预置：同一用户同一天多次投票变更，只返回当天最后一次。
  - 期望：方向与时间为当天最新。

---

### 7) 累积评分曲线（实验）

- REST: GET `/pages/{wikidotId}/ratings/cumulative`
- Params: `wikidotId`
- 说明：基于 `Vote` 时间序列累积求和（up=+1, down=-1, novote=0），可按天分箱。
- SQL（示例：按日累计）：
```sql
-- $1=wikidotId
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

- 返回约定：
```json
[ { "date": string(ISO8601), "cumulativeRating": number } ]
```

- 测试：
  - 预置：多天的投票增减。
  - 期望：累积曲线单调按增量累计。

---

### 8) 用户统计（概览）

- REST: GET `/users/{userId}/stats`
- SQL：
```sql
-- $1=userId
SELECT 
  us."overallRank" AS rank,
  COALESCE(us."totalRating", 0) AS "totalRating",
  COALESCE(us."overallRating", 0) AS "meanRating",
  COALESCE(us."pageCount", 0) AS "pageCount",
  COALESCE(us."scpPageCount", 0) AS "pageCountScp",
  COALESCE(us."storyPageCount", 0) AS "pageCountTale",
  COALESCE(us."goiPageCount", 0) AS "pageCountGoiFormat",
  COALESCE(us."artPageCount", 0) AS "pageCountArtwork",
  COALESCE(us."totalUp", 0) AS "totalUp",
  COALESCE(us."totalDown", 0) AS "totalDown",
  us."favTag",
  us."goiRank",
  COALESCE(us."goiRating", 0) AS "goiRating",
  us."scpRank",
  COALESCE(us."scpRating", 0) AS "scpRating",
  us."storyRank",
  COALESCE(us."storyRating", 0) AS "storyRating",
  us."translationRank",
  COALESCE(us."translationRating", 0) AS "translationRating",
  COALESCE(us."translationPageCount", 0) AS "translationPageCount",
  us."wanderersRank",
  COALESCE(us."wanderersRating", 0) AS "wanderersRating",
  COALESCE(us."wanderersPageCount", 0) AS "wanderersPageCount",
  us."artRank",
  COALESCE(us."artRating", 0) AS "artRating",
  us."ratingUpdatedAt"
FROM "UserStats" us
WHERE us."userId" = $1;
```

- 测试：
  - 预置：填充 `UserStats` 不同维度字段。
  - 期望：字段缺失时按 COALESCE 规则为 0。

---

### 9) 相似页面（向量近邻，若已具向量）

- REST: GET `/search/pages/similar`
- Params: `wikidotId` 或 `pageId`，`limit`(默认10)
- 前置：若未维护向量，可暂不启用；如果有平均向量保存在 `PageVersion` 或相关表，则按下列相似度实现。
- SQL（示例，假设向量保存在 `PageVersion.embedding` 列；如无则跳过本端点）：
```sql
-- $1=wikidotId, $2=limit
WITH src AS (
  SELECT embedding FROM "PageVersion" WHERE "wikidotId" = $1 AND "validTo" IS NULL AND embedding IS NOT NULL LIMIT 1
)
SELECT pv."pageId", pv.title, p."currentUrl" AS url, pv.tags,
       1 - (pv.embedding <=> (SELECT embedding FROM src)) AS score
FROM "PageVersion" pv
JOIN "Page" p ON p.id = pv."pageId"
WHERE pv.embedding IS NOT NULL AND pv."validTo" IS NULL AND pv."wikidotId" <> $1
ORDER BY pv.embedding <=> (SELECT embedding FROM src)
LIMIT $2;
```

- 测试：
  - 预置：插入 1 个源页面 + 多个相似/不相似页面向量。
  - 期望：按相似度排序返回前 N 条。

---

### 10) 站点列表

- REST: GET `/sites`
- 说明：若无专门表，可返回静态配置；若有表（例如站点元信息），可：
```sql
SELECT type, "displayName", url, language, "recentlyCreatedUrl" FROM "SiteInfo";
```
（若数据库暂无该表，请以配置文件驱动，不在此强制 SQL）

---

## 通用测试约定
- 所有 SQL 使用参数化（`$1..$n`），BFF 层负责进行类型与范围校验（如 limit 范围、枚举值合法性）。
- 时间字段返回 ISO8601 字符串；数组字段返回 JSON 数组。
- 对分页接口统一支持 `limit`/`offset`；如需游标，可在 BFF 侧补充 `nextOffset` 计算。

---

## 附录：统计扩展端点（只读）

### A1) InterestingFacts 列表
- REST: GET `/stats/interesting-facts?category=&type=&pageId=&userId=&date=&tag=&limit=&offset=`
- SQL 与返回：见 `bff-rest-mapping.md` 对应章节；字段直出。

### A2) TimeMilestones 列表
- REST: GET `/stats/milestones?period=&periodValue=&milestoneType=&pageId=&limit=&offset=`
- SQL 与返回：见 `bff-rest-mapping.md`。

### A3) TagRecords 列表
- REST: GET `/stats/tag-records?tag=&recordType=&pageId=&userId=&limit=&offset=`
- SQL 与返回：见 `bff-rest-mapping.md`。

### A4) ContentRecords 列表
- REST: GET `/stats/content-records?recordType=&pageId=&limit=&offset=`
- SQL 与返回：见 `bff-rest-mapping.md`。

### A5) RatingRecords 列表
- REST: GET `/stats/rating-records?recordType=&timeframe=&pageId=&limit=&offset=`
- SQL 与返回：见 `bff-rest-mapping.md`。

### A6) UserActivityRecords 列表
- REST: GET `/stats/user-activity?recordType=&userId=&limit=&offset=`
- SQL 与返回：见 `bff-rest-mapping.md`。
- 响应字段：`{ items: UserActivityRecord[], total: number, limit: number, offset: number }`

