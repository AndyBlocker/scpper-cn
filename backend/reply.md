下面给你一套**从数据库到分析层到 BFF（Backend-for-Frontend）**的完整重构方案。目标是：**高效增量分析、更多/更稳的全站统计与“有趣事实”、高质量全文搜索（含中文）、以及为 SSR 前端提供结构化、低延迟的数据契约**。我会按以下结构给出：

1) 总体架构（数据流与职责拆分）  
2) 数据库层优化（索引、分区、物化视图、触发器、全文搜索）  
3) 增量分析框架与计算模块重构（含 SQL/伪代码/要点）  
4) “有趣统计/事实”扩展包（新指标、新榜单、新事实）  
5) 全文搜索（PostgreSQL 三套方案：pg_trgm、pg_jieba、pgvector）  
6) 面向 SSR 的 BFF 契约（REST/GraphQL 两版 + 数据契约 + 缓存策略）  
7) 代码组织与落地建议（模块化目录、并发/幂等、回填策略）  
8) 迁移计划与运维建议（上线步骤、回滚、观测）  

---

## 1) 总体架构（数据流/职责拆分）

```
GraphQL 抓取 (Phase A/B/C)
   └─→ 关系库 (PostgreSQL, Prisma)
         ├─ 基础表：Page/PageVersion/Vote/Revision/Attribution/User/...
         ├─ 计算支持：函数/索引/触发器/分区/物化视图
         └─ 分析产出：*事实表*/*物化视图*/*缓存表*/*搜索索引表*
                ├─ PageStats(UserStats/SiteStats/SeriesStats/...)
                ├─ PageDailyStats / UserDailyStats（新增）
                ├─ TrendingStats（按时段）
                ├─ InterestingFacts/TagRecords/RatingRecords/...
                ├─ SearchIndex(tsvector/embedding)（新增）
分析任务 (Analyze Pipeline)
   ├─ 增量扫描器（watermark + 变更集）
   ├─ 批计算器（set-based SQL，避免 row-by-row）
   └─ 物化视图刷新 (CONCURRENTLY)
BFF（SSR/CSR）
   ├─ REST/GraphQL 契约（稳定 ID、分页/排序/过滤）
   ├─ 边缘缓存/应用缓存（stale-while-revalidate）
   └─ 页面级聚合接口（tag 详情、用户主页、页面详情、榜单）
```

关键原则：
- **增量优先**：每个分析任务只看“变更集”（votes/revisions/attributions 发生变动的 pageVersionId）。
- **集合运算**：尽量用一次 SQL 完成批量统计（`INSERT ... SELECT` / `UPDATE ... FROM` / `MERGE` 风格）。
- **预计算**：高频聚合落入**物化视图**/**缓存表**，SSR 接口直读。
- **合理索引** + **分区**：针对时序表（Vote/Revision）做月分区，日/周聚合建物化视图。
- **中文全文检索**：优先 `pg_trgm` + tsquery，支持 `pg_jieba`（可选），并附带 pgvector（可选）用于语义检索。

---

## 2) 数据库层优化

### 2.1 索引与存储层（必做）

**新索引（CONCURRENTLY 创建，避免长锁）**：
```sql
-- Vote/Revision 常用过滤
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vote_pv_ts ON "Vote" ("pageVersionId", "timestamp");
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vote_pv_dir_ts ON "Vote" ("pageVersionId", "direction", "timestamp");
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rev_pv_ts ON "Revision" ("pageVersionId", "timestamp");

-- PageVersion 热路径
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pv_valid_active ON "PageVersion" ("pageId")
  WHERE "validTo" IS NULL AND "isDeleted" = false;

-- 标签数组 GIN
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pv_tags_gin ON "PageVersion" USING GIN ("tags");

-- Attribution 参与分析
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attr_pagever_date ON "Attribution" ("pageVerId","date");
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_attr_user ON "Attribution" ("userId");

-- User 活动时间
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_first_last ON "User" ("firstActivityAt","lastActivityAt");
```

**表分区（推荐对 Vote / Revision 做月分区）：**  
> Prisma 不直接管理分区，使用 SQL migration。  
好处：大幅降低全表扫描；删除历史分区成本小；按日期聚合极快。

```sql
-- 示例：创建 Vote 按月分区
ALTER TABLE "Vote" PARTITION BY RANGE ("timestamp");

-- 动态创建每月分区
CREATE TABLE IF NOT EXISTS "Vote_2025_08" PARTITION OF "Vote"
  FOR VALUES FROM ('2025-08-01') TO ('2025-09-01');
-- 后续每月任务创建下一期分区
```

**函数库（复用统计公式）**：
```sql
-- Wilson 下界函数（参数：uv, dv）
CREATE OR REPLACE FUNCTION f_wilson_lower_bound(up int, down int)
RETURNS double precision LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN (up + down) = 0 THEN 0.0
    ELSE (
      (up::float/(up+down) + 1.96^2/(2*(up+down))
       - 1.96/(2*(up+down)) * sqrt(4*(up+down)*(up::float/(up+down))*(1-(up::float/(up+down))) + 1.96^2)
      ) / (1 + 1.96^2/(up+down))
    )
  END
$$;

-- 争议度
CREATE OR REPLACE FUNCTION f_controversy(up int, down int)
RETURNS double precision LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN (up + down) = 0 OR GREATEST(up,down)=0 THEN 0.0
    ELSE (LEAST(up,down)::float/GREATEST(up,down)::float) * ln(up+down+1)
  END
$$;
```

### 2.2 物化视图（MV）与缓存表（可混用）

**示例物化视图（带 CONCURRENTLY 刷新）**：
```sql
-- 近30天热门页面（按最近投票数 + 评分）
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_top_pages_30d AS
SELECT
  p.id AS "pageId",
  pv.title,
  COALESCE(pv.rating,0) AS rating,
  COUNT(v.id) FILTER (WHERE v.direction != 0) AS recent_votes,
  COUNT(v.id) FILTER (WHERE v.direction = 1) AS uv,
  COUNT(v.id) FILTER (WHERE v.direction = -1) AS dv,
  f_wilson_lower_bound(
    COUNT(v.id) FILTER (WHERE v.direction=1),
    COUNT(v.id) FILTER (WHERE v.direction=-1)
  ) AS wilson95
FROM "Page" p
JOIN "PageVersion" pv ON pv."pageId"=p.id AND pv."validTo" IS NULL AND pv."isDeleted"=false
LEFT JOIN "Vote" v ON v."pageVersionId"=pv.id 
  AND v."timestamp" >= (CURRENT_DATE - INTERVAL '30 days')
GROUP BY p.id, pv.title, pv.rating;

CREATE INDEX IF NOT EXISTS idx_mv_top_pages_30d_wilson ON mv_top_pages_30d (wilson95 DESC);

-- 刷新（分析任务的最后阶段触发）
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_top_pages_30d;
```

**缓存表（适合多维榜单/复杂拼装，写入快读更快）**：  
例如 `LeaderboardCache`、`TagOverviewCache`、`UserOverviewCache`，以 `(key, period, payload_jsonb, updatedAt, expiresAt)` 结构存储；BFF 直接读取，避免每次重算。

### 2.3 “页面创建时间”标准化（极大简化时间类统计）

新增列：
```sql
ALTER TABLE "Page" ADD COLUMN IF NOT EXISTS "firstPublishedAt" timestamp;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_page_first_published ON "Page" ("firstPublishedAt");
```

**回填逻辑**：以 PageVersion 的
`min(Attribution.date) / min(Revision.timestamp) / pv.validFrom / Page.createdAt` 计算一次并写入 `Page.firstPublishedAt`，后续通过触发器在 A/B/C 阶段写入新增数据时更新（仅首次为空时更新，避免抖动）。

---

## 3) 增量分析框架与模块重构

### 3.1 分析管线（Analyze）重构为“可组合任务 + 增量水位线”

**水位线表（新）**：
```sql
CREATE TABLE IF NOT EXISTS "AnalysisWatermark" (
  id serial PRIMARY KEY,
  "task" text UNIQUE NOT NULL,       -- 例如 'page_stats', 'user_stats', 'facts_tag', ...
  "lastRunAt" timestamp NOT NULL DEFAULT now(),
  "cursorTs" timestamp               -- 上次处理到的事件时间（votes/revisions/attributions）
);
```

**通用变更集获取**（一次性找出受影响的 pageVersionId）：
```sql
-- 自上次水位线之后发生变更的 pageVersion
WITH w AS (
  SELECT "cursorTs" FROM "AnalysisWatermark" WHERE task = 'page_stats'
),
changed_pv AS (
  SELECT DISTINCT v."pageVersionId" AS id, max(v."timestamp") AS changed_at
  FROM "Vote" v, w
  WHERE w."cursorTs" IS NULL OR v."timestamp" > w."cursorTs"
  GROUP BY v."pageVersionId"
  UNION
  SELECT DISTINCT r."pageVersionId" AS id, max(r."timestamp")
  FROM "Revision" r, w
  WHERE w."cursorTs" IS NULL OR r."timestamp" > w."cursorTs"
  GROUP BY r."pageVersionId"
  UNION
  SELECT DISTINCT a."pageVerId" AS id, max(a."date")
  FROM "Attribution" a, w
  WHERE a."date" IS NOT NULL AND (w."cursorTs" IS NULL OR a."date" > w."cursorTs")
  GROUP BY a."pageVerId"
)
SELECT id, max(changed_at) AS last_change
FROM changed_pv
GROUP BY id;
```

> 该结果喂给后续各任务，**仅更新这些 pageVersion**。任务结束时，将最大 `last_change` 写回水位线表的 `cursorTs`。

### 3.2 PageStats 增量计算（精简 I/O）

替代你当前“全量聚合”的写法，仅对 `changed_pv` 计算：
```sql
WITH changed AS ( ... 如上 ... ),
vote_stats AS (
  SELECT v."pageVersionId" AS id,
         COUNT(*) FILTER (WHERE v.direction=1) AS uv,
         COUNT(*) FILTER (WHERE v.direction=-1) AS dv
  FROM "Vote" v
  JOIN changed c ON c.id = v."pageVersionId"
  GROUP BY v."pageVersionId"
)
INSERT INTO "PageStats" ("pageVersionId", uv, dv, "wilson95", controversy, "likeRatio")
SELECT vs.id, vs.uv, vs.dv,
       f_wilson_lower_bound(vs.uv, vs.dv) AS wilson95,
       f_controversy(vs.uv, vs.dv) AS controversy,
       CASE WHEN vs.uv+vs.dv=0 THEN 0 ELSE vs.uv::float/(vs.uv+vs.dv) END
FROM vote_stats vs
ON CONFLICT ("pageVersionId") DO UPDATE SET
  uv = EXCLUDED.uv,
  dv = EXCLUDED.dv,
  "wilson95" = EXCLUDED."wilson95",
  controversy = EXCLUDED.controversy,
  "likeRatio" = EXCLUDED."likeRatio";
```

> 注意点：你的现有代码把 `since` 用在 `pv."updatedAt" > since`，这会漏掉仅有 vote/revision 变化的场景。上方方案基于事件表时间戳，**不会漏**。

### 3.3 UserStats/排名增量（去掉 `$executeRawUnsafe`）

- 将 `UserRatingSystem.calculateUserRatings()` 改为**参数化** `$executeRaw`，避免注入风险。  
- 同时引入两个缓存表：  
  - **UserAggregate**（按分类的累计分，用于排名输入）  
  - **LeaderboardCache**（最终排名结果缓存，含更新时间/有效期）

**UserAggregate 计算（仅变更用户）**：从 changed_pv → 找出涉及 Attribution 的 userId → 仅重算这些用户的聚合再 upsert 到 `UserStats`。  
同时为 `UserVoteInteraction`/`UserTagPreference` 引入**分片重算**：只重算“有新投票的 fromUserId”相关分片，不再全量 truncate 重建。  
> 方案：先找出近水位线后的投票用户集合 U，删除 `UserVoteInteraction` / `UserTagPreference` 表中 `fromUserId ∈ U`/`userId ∈ U` 的数据，再用一次 SQL 重新汇总 U 的增量数据并插入。避免 TB 级全表 TRUNCATE。

### 3.4 SiteStats / Daily Aggregates 精简

- **SiteStats** 留作“全站总览 + 当日新增计数”，每日 1 次更新即可。  
- 新增 `PageDailyStats` / `UserDailyStats` 两张事实表（或物化视图）：
  - `PageDailyStats(pageId, date, votes_up, votes_down, total, unique_voters, revisions)`  
  - `UserDailyStats(userId, date, votes_cast, pages_created, last_activity)`

这些事实表以**增量写入**（只写新日期或变更日期），BFF 等页面（趋势图、计数）直读事实表，不再内联复杂聚合。

### 3.5 Trending 评分改进（时间衰减）

替换简单“最近票数排序”为**时间衰减 + 质量加权**（Hotness）：
```sql
-- 近 7 天热度：票数 * 0.7^天龄 + wilson95 * 权重
WITH recent AS (
  SELECT pv.id AS pagever, p.id AS page,
         EXTRACT(EPOCH FROM (now() - date_trunc('day', v."timestamp"))) / 86400 AS age_days,
         (v.direction) AS dir
  FROM "Vote" v
  JOIN "PageVersion" pv ON v."pageVersionId"=pv.id
  JOIN "Page" p ON pv."pageId"=p.id
  WHERE v."timestamp" >= now() - INTERVAL '7 days' 
    AND pv."validTo" IS NULL AND pv."isDeleted"=false
),
agg AS (
  SELECT page,
         SUM(CASE WHEN dir>0 THEN 1 ELSE 0 END) AS uv,
         SUM(CASE WHEN dir<0 THEN 1 ELSE 0 END) AS dv,
         SUM( (CASE WHEN dir!=0 THEN 1 ELSE 0 END) * power(0.7, age_days) ) AS decayed_votes
  FROM recent GROUP BY page
)
SELECT a.page, a.decayed_votes,
       f_wilson_lower_bound(a.uv, a.dv) AS wilson95,
       a.decayed_votes + 10 * f_wilson_lower_bound(a.uv, a.dv) AS score
FROM agg a
ORDER BY score DESC
LIMIT 100;
```

---

## 4) “有趣统计/事实”扩展清单

在你已有的 `InterestingFacts/TagRecords/RatingRecords/...` 基础上，新增：

1. **作者成长曲线**：按作者 `firstPublishedAt` 对其作品评分累计，找“前 N 篇作品内增速最快/前 365 天累计最高”等。  
2. **高争议标签**：对标签下页面的 `controversy` 取均值/TopN。  
3. **首发时段分布**：按小时/星期，统计页面首发量与平均评分；找“最容易爆款的时间段”。  
4. **合作网络**（作者共现图，供前端可视化）：输出 JSON（nodes/edges）缓存到 `InterestingFacts` 的 metadata 中。  
5. **编号段“空洞”与“密集区”**：按 SCP-CN 系列编号，找连续空缺区间/爆发区间（新增事实类型）。  
6. **长尾点赞王**：低票数但 Wilson 很高的冷门页面。  
7. **编辑英雄榜**：某一时期 Revision 数最多/评论最多的用户与页面。
8. 第整万个用户、整5万voting的voting、每个标签中分数最高的页面、使用的最多最少的页面、最常出现的标签组合

所有这些**落表为事实**，并**绑定日期/标签/页面/用户上下文**，便于 SSR 页面按维度读取。

---

## 5) 全文搜索

你需要“source code/渲染内容全文搜索”。这里给三套方案（可叠加）：

### 方案 A（零外部依赖，立即可用）：`pg_trgm + GIN` + 简易 tsquery

适合中英文混排但**不进行中文分词**的情况下搜索（模糊/拼写）。  
新增表/索引：

```sql
-- SearchIndex 表（可把页面 meta + 拼接内容落地）
CREATE TABLE IF NOT EXISTS "SearchIndex" (
  "pageId" int PRIMARY KEY,
  title text,
  url text,
  tags text[],
  text_content text,          -- PageVersion.textContent (当前有效版本)
  source_content text,        -- PageVersion.source
  -- 可选：手动拼一个 summary/高亮片段
  "updatedAt" timestamp DEFAULT now()
);

-- trigram GIN 索引（标题/正文/源码）
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_search_title_trgm ON "SearchIndex" USING GIN (title gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_search_text_trgm ON "SearchIndex" USING GIN (text_content gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_search_source_trgm ON "SearchIndex" USING GIN (source_content gin_trgm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_search_tags_gin ON "SearchIndex" USING GIN (tags);
```

**增量同步**：在 Phase B/C 更新 PageVersion 时，同步 `SearchIndex` 对应行。  
**查询**：  
```sql
-- 简单关键词，多字段打分
SELECT "pageId", title, url,
  (similarity(title, :q) * 2
   + similarity(text_content, :q)
   + 0.5 * similarity(source_content, :q)) AS score
FROM "SearchIndex"
WHERE title ILIKE '%'||:q||'%' OR text_content ILIKE '%'||:q||'%' OR source_content ILIKE '%'||:q||'%'
ORDER BY score DESC
LIMIT 20 OFFSET :offset;
```

优点：零外部依赖，改造成本低。缺点：中文分词效果一般。

### 方案 B（推荐，中文体验显著提升）：`pg_jieba` + FTS

安装 `pg_jieba` 后，增加 `tsvector` 列与触发器：

```sql
ALTER TABLE "SearchIndex" ADD COLUMN IF NOT EXISTS tsv tsvector;

-- 触发器：用 jieba 切词
CREATE OR REPLACE FUNCTION searchindex_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.tsv := to_tsvector('jiebacfg', coalesce(NEW.title,'') || ' ' || coalesce(NEW.text_content,'') || ' ' || coalesce(NEW.source_content,''));
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_searchindex_tsv ON "SearchIndex";
CREATE TRIGGER trg_searchindex_tsv BEFORE INSERT OR UPDATE
ON "SearchIndex" FOR EACH ROW EXECUTE FUNCTION searchindex_tsv_update();

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_search_tsv ON "SearchIndex" USING GIN (tsv);
```

**检索**：
```sql
SELECT "pageId", title, url,
       ts_rank(tsv, plainto_tsquery('jiebacfg', :q)) AS rank
FROM "SearchIndex"
WHERE tsv @@ plainto_tsquery('jiebacfg', :q)
ORDER BY rank DESC
LIMIT 20 OFFSET :offset;
```

### 方案 C（可选，语义检索）：`pgvector` + 向量召回

- 新增 `embedding vector(768)` 列与索引；  
- 离线任务使用嵌入模型（如 bge-m3/ernie/sentence-transformers）为 title/textContent/source 生成 embedding，写入 `SearchIndex`；  
- 查询时对输入 `q` 编码，做 KNN：
```sql
-- 假设用 cosine 距离
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE "SearchIndex" ADD COLUMN IF NOT EXISTS embedding vector(768);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_search_embedding ON "SearchIndex" USING ivfflat (embedding vector_cosine_ops) WITH (lists=100);

-- 查询（:emb 为前端/BFF 侧计算好的 embedding）
SELECT "pageId", title, url
FROM "SearchIndex"
ORDER BY embedding <=> :emb
LIMIT 20;
```

> 组合策略：**先向量召回 200，再用 FTS/trgm 重排**，效果更佳。

---

## 7) 代码组织与落地建议


### 7.1 编码要点

- **避免 `$executeRawUnsafe`**：全部改成 `$executeRaw`，用模板参数。  
- **分批/分片更新**：对大表（交互/偏好）按用户分片重算，**不要 TRUNCATE 全表**。  
- **事务与锁**：物化视图刷新用 `CONCURRENTLY`；大批量更新用小事务（批 100~500）以减少锁定时间。  
- **幂等**：增量任务每次根据变更集写入 upsert，不依赖全量状态。  
- **回填任务**：提供 `generateHistoricalStats` 的改进版，按日窗口分段回填，记录进度。

---

## 8) 迁移计划与运维

**上线顺序（建议）**：
1. 先发布 DB 迁移：函数、索引、SearchIndex 表、物化视图骨架、水位线表。  
2. 发布新分析管线（不替换旧版），先跑一次**全量**回填：  
   - 计算 `Page.firstPublishedAt`  
   - 回填 SearchIndex/事实表/MV  
3. 切流量到新 BFF（读新表/视图） → 观察 QPS、延迟、慢查询（pg_stat_statements）。  
4. 开启增量调度（每 5 分钟/每小时） → 观察 CPU/I/O。  
5. 稳定后逐步移除旧分析逻辑。

**观测**：
- 打开 `pg_stat_statements`，为每个任务的 SQL 加注释（`/* task:page-stats */`），便于定位热点。  
- 为 BFF 接口埋点：命中缓存率、P95、错误码。  
- 引入 “分析运行仪表盘”：最新水位线/队列长度/刷新耗时。

---

## 关键变更清单（Prisma schema 层面）

> Prisma 对分区/MV/函数/触发器支持有限，这些**通过 SQL migration** 管理；Prisma 只管表模型。

**新增模型（建议最小化）**：
```prisma
model AnalysisWatermark {
  id        Int      @id @default(autoincrement())
  task      String   @unique
  lastRunAt DateTime @default(now())
  cursorTs  DateTime?
}

model SearchIndex {
  pageId        Int      @id
  title         String?
  url           String?
  tags          String[]
  text_content  String?
  source_content String?
  updatedAt     DateTime @default(now())
  page          Page     @relation(fields: [pageId], references: [id])
}
```

> 物化视图/事实表可不入 Prisma（只读），或用 `@@map` 到视图只读 model。

---

## 你现有代码中的几个问题与对应修复

1. **PageStats 增量条件不准**  
   你把 `since` 用在 `PageVersion.updatedAt`。**应以 Vote/Revision/Attribution 的时间戳为准**（见 3.2）。  
2. **UserVoteInteraction/UserTagPreference 全量 TRUNCATE**  
   这在数据量大时不可行。改为**分片重算**（按近水位线后产生行为的用户集合）。  
3. **$executeRawUnsafe**  
   全部替换为参数化 `$executeRaw`，SQL 里占位符使用 `${}`，不要拼接。  
4. **时间里程碑统计复杂且常全表扫描**  
   引入 `Page.firstPublishedAt` 后，极简：`min(firstPublishedAt)` 即可得到年度/月份首个页面。  
5. **Phase B/C 与 DirtyQueue 耦合**  
   DirtyQueue 的判断建议**完全基于 GraphQL A 阶段的 PageMetaStaging + 稳定字段**（Vote/RevisionCount 的对齐不要影响 Dirty 标记），并在 B 后确定是否 C（你已经做了，但 Dirty 清理要幂等）。  
6. **非幂等事实生成**  
   每类事实写入前先**局部删除**（按 tag/date/type 的键），再重建，避免重复。   

搜索部分，我们需要选择使用方案B+C的混合方法，两者都支持。
