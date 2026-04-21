-- Chunk-level embeddings: one PageVersion -> N rows.
--
-- 为长文（p95 约 15K char，hub 类到 85K char）提供尾部可搜能力：之前的 doc-level
-- 方案把 > 8000 char 的内容直接 slice 掉，dense 索引里有 ~16% 页面的尾段是空白。
-- 改成按 ~1500 char 滚动窗口 + 200 char overlap 切段，每段独立 embedding；
-- 搜索时以 `GROUP BY pageVersionId MAX(score)` 聚合到 PV。
--
-- 改动会作废之前写入的少量样本（~800 行 doc-level embedding 不再兼容新 unique key），
-- 这里在 ALTER 前主动清一下。因为 (pageVersionId, model) -> (pageVersionId, model,
-- chunkIndex) 的键语义变了，不能无损迁移。

DELETE FROM "PageEmbedding";

ALTER TABLE "PageEmbedding"
  ADD COLUMN "chunkIndex" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "chunkTotal" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "chunkCharStart" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "chunkCharEnd" INTEGER NOT NULL DEFAULT 0;

-- 旧 unique key 作废：允许一个 PV 在同模型下有多行（每 chunk 一行）
-- 注意：原先是 CREATE UNIQUE INDEX（不是 table constraint），所以用 DROP INDEX。
DROP INDEX IF EXISTS "PageEmbedding_pageVersionId_model_key";

-- 新 unique index：一个 PV 在同一模型下，每个 chunkIndex 唯一
CREATE UNIQUE INDEX "PageEmbedding_pageVersionId_model_chunkIndex_key"
  ON "PageEmbedding" ("pageVersionId", "model", "chunkIndex");
