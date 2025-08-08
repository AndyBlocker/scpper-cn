-- 有趣统计信息扩展 Schema
-- 这些表将存储预计算的有趣统计信息，减少前端实时计算负担

-- 1. 通用里程碑记录表
CREATE TABLE "InterestingFacts" (
  "id" SERIAL PRIMARY KEY,
  "category" VARCHAR(50) NOT NULL,           -- 分类：time_milestone, tag_record, content_length, rating_record, user_activity
  "type" VARCHAR(100) NOT NULL,              -- 具体类型：first_page_of_year, highest_rated_in_tag, longest_source 等
  "title" TEXT NOT NULL,                     -- 显示标题
  "description" TEXT,                        -- 详细描述
  "value" TEXT,                              -- 统计值（可能是数字、日期、文本）
  "metadata" JSONB,                          -- 额外元数据
  "pageId" INTEGER REFERENCES "Page"("id"),  -- 相关页面ID
  "userId" INTEGER REFERENCES "User"("id"),  -- 相关用户ID
  "dateContext" DATE,                        -- 时间上下文（如某年某月）
  "tagContext" VARCHAR(100),                 -- 标签上下文
  "rank" INTEGER DEFAULT 1,                  -- 排名（支持Top N）
  "calculatedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "isActive" BOOLEAN DEFAULT true,           -- 是否仍然有效

  UNIQUE("category", "type", "dateContext", "tagContext", "rank")
);

-- 2. 时间维度里程碑表
CREATE TABLE "TimeMilestones" (
  "id" SERIAL PRIMARY KEY,
  "period" VARCHAR(20) NOT NULL,             -- year, month, quarter, day
  "periodValue" VARCHAR(20) NOT NULL,        -- 2024, 2024-01, 2024-Q1, 01-15
  "milestoneType" VARCHAR(50) NOT NULL,      -- first_page, last_page, first_high_rated
  "pageId" INTEGER NOT NULL REFERENCES "Page"("id"),
  "pageTitle" TEXT,
  "pageRating" INTEGER,
  "pageCreatedAt" TIMESTAMP,
  "calculatedAt" TIMESTAMP DEFAULT NOW(),

  UNIQUE("period", "periodValue", "milestoneType")
);

-- 3. 标签记录表
CREATE TABLE "TagRecords" (
  "id" SERIAL PRIMARY KEY,
  "tag" VARCHAR(100) NOT NULL,
  "recordType" VARCHAR(50) NOT NULL,         -- highest_rated, first_page, most_popular, most_controversial
  "pageId" INTEGER REFERENCES "Page"("id"),
  "userId" INTEGER REFERENCES "User"("id"),
  "value" NUMERIC,                           -- 评分、数量等数值
  "metadata" JSONB,                          -- 其他相关数据
  "calculatedAt" TIMESTAMP DEFAULT NOW(),

  UNIQUE("tag", "recordType")
);

-- 4. 内容分析记录表  
CREATE TABLE "ContentRecords" (
  "id" SERIAL PRIMARY KEY,
  "recordType" VARCHAR(50) NOT NULL,         -- longest_source, shortest_source, most_complex
  "pageId" INTEGER NOT NULL REFERENCES "Page"("id"),
  "pageTitle" TEXT,
  "sourceLength" INTEGER,                    -- 源代码长度
  "contentLength" INTEGER,                   -- 渲染内容长度
  "complexity" JSONB,                        -- 复杂度指标
  "calculatedAt" TIMESTAMP DEFAULT NOW(),

  UNIQUE("recordType", "pageId")
);

-- 5. 评分投票记录表
CREATE TABLE "RatingRecords" (
  "id" SERIAL PRIMARY KEY,
  "recordType" VARCHAR(50) NOT NULL,         -- highest_rated, most_votes, most_controversial, fastest_growth
  "pageId" INTEGER NOT NULL REFERENCES "Page"("id"),
  "pageTitle" TEXT,
  "rating" INTEGER,
  "voteCount" INTEGER,
  "controversy" FLOAT,
  "wilson95" FLOAT,
  "timeframe" VARCHAR(20),                   -- 24h, 7d, 30d, all_time
  "value" NUMERIC,                           -- 记录的具体数值
  "achievedAt" TIMESTAMP,                    -- 达成时间
  "calculatedAt" TIMESTAMP DEFAULT NOW(),

  UNIQUE("recordType", "timeframe", "pageId")
);

-- 6. 用户活动记录表
CREATE TABLE "UserActivityRecords" (
  "id" SERIAL PRIMARY KEY,
  "recordType" VARCHAR(50) NOT NULL,         -- first_vote, first_page, longest_streak, most_votes_single_day
  "userId" INTEGER NOT NULL REFERENCES "User"("id"),
  "userDisplayName" TEXT,
  "value" NUMERIC,                           -- 记录数值（天数、次数等）
  "achievedAt" TIMESTAMP,                    -- 达成时间
  "context" JSONB,                           -- 上下文信息
  "calculatedAt" TIMESTAMP DEFAULT NOW(),

  UNIQUE("recordType", "userId")
);

-- 7. 实时热点统计表
CREATE TABLE "TrendingStats" (
  "id" SERIAL PRIMARY KEY,
  "statType" VARCHAR(50) NOT NULL,           -- hot_tag, active_user, trending_page
  "name" TEXT NOT NULL,                      -- 标签名、用户名、页面标题
  "entityId" INTEGER,                        -- 关联实体ID
  "entityType" VARCHAR(20),                  -- tag, user, page
  "score" NUMERIC NOT NULL,                  -- 热度分数
  "period" VARCHAR(20) NOT NULL,             -- today, this_week, this_month
  "metadata" JSONB,                          -- 额外数据
  "calculatedAt" TIMESTAMP DEFAULT NOW(),

  UNIQUE("statType", "period", "entityId", "entityType")
);

-- 创建索引以提升查询性能
CREATE INDEX ON "InterestingFacts"("category", "type");
CREATE INDEX ON "InterestingFacts"("calculatedAt");
CREATE INDEX ON "InterestingFacts"("isActive");

CREATE INDEX ON "TimeMilestones"("period", "periodValue");
CREATE INDEX ON "TimeMilestones"("milestoneType");

CREATE INDEX ON "TagRecords"("tag");
CREATE INDEX ON "TagRecords"("recordType");

CREATE INDEX ON "ContentRecords"("recordType");
CREATE INDEX ON "ContentRecords"("sourceLength");

CREATE INDEX ON "RatingRecords"("recordType", "timeframe");
CREATE INDEX ON "RatingRecords"("rating" DESC);

CREATE INDEX ON "UserActivityRecords"("recordType");
CREATE INDEX ON "UserActivityRecords"("achievedAt");

CREATE INDEX ON "TrendingStats"("statType", "period");
CREATE INDEX ON "TrendingStats"("score" DESC);