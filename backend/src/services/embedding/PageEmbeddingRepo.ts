/**
 * DB-side helpers for reading/writing `PageEmbedding` rows.
 * Kept separate from the job code so the raw SQL for pgvector stays
 * in one place (Prisma doesn't natively support `halfvec`).
 */
import type { PrismaClient } from '@prisma/client';

/** Turn a JS number[] into the literal form pgvector accepts in text (`[1,2,3]`). */
export function toVectorLiteral(vec: number[]): string {
  const parts: string[] = new Array(vec.length);
  for (let i = 0; i < vec.length; i += 1) {
    const v = vec[i];
    // NaN/Infinity → 0 防炸。pg halfvec 会对非法浮点 reject，这里一起兜住。
    parts[i] = Number.isFinite(v) ? String(v) : '0';
  }
  return `[${parts.join(',')}]`;
}

export interface EmbeddingCandidate {
  pageVersionId: number;
  pageId: number;
  wikidotId: number | null;
  title: string | null;
  alternateTitle: string | null;
  category: string | null;
  tags: string[];
  textContent: string | null;
  isDeletedPage: boolean;
}

/**
 * 取出"需要回填"的 PageVersion 列表 —— 用的是 effective-version 选择：
 *   - Page 当前版本非 tombstone → 选 current PV
 *   - Page 当前版本是 tombstone → 选该 Page 最后一个非 deleted PV
 *
 * 然后排除已经有同模型 embedding 的记录。
 */
export async function listEmbeddingCandidates(
  prisma: PrismaClient,
  model: string,
  opts: { limit?: number; includeDeletedPages?: boolean } = {}
): Promise<EmbeddingCandidate[]> {
  const limit = opts.limit ?? 1_000_000;
  const includeDeletedPages = opts.includeDeletedPages ?? true;

  // 两段：active pages 用 current；deleted pages 用 last non-deleted（若存在）
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `
    WITH current_pv AS (
      SELECT DISTINCT ON (pv."pageId")
        pv.id AS "pageVersionId",
        pv."pageId",
        pv."isDeleted" AS "versionIsDeleted"
      FROM "PageVersion" pv
      WHERE pv."validTo" IS NULL
      ORDER BY pv."pageId", pv.id DESC
    ),
    chosen_pv AS (
      -- 非 deleted 当前版本：直接用
      SELECT c."pageVersionId", c."pageId", false AS "fromFallback"
      FROM current_pv c
      JOIN "Page" p ON p.id = c."pageId"
      WHERE c."versionIsDeleted" = false
        AND ($2::boolean OR p."isDeleted" = false)

      UNION ALL

      -- 已删除 Page：回退到最后一个非 deleted PV
      SELECT fb.id AS "pageVersionId", c."pageId", true AS "fromFallback"
      FROM current_pv c
      JOIN "Page" p ON p.id = c."pageId"
      JOIN LATERAL (
        SELECT id
          FROM "PageVersion"
         WHERE "pageId" = c."pageId" AND "isDeleted" = false
         ORDER BY "validFrom" DESC NULLS LAST, id DESC
         LIMIT 1
      ) fb ON true
      WHERE c."versionIsDeleted" = true
        AND $2::boolean
    )
    SELECT
      chosen."pageVersionId",
      pv."pageId",
      p."wikidotId",
      pv.title,
      pv."alternateTitle",
      pv.category,
      pv.tags,
      pv."textContent",
      p."isDeleted" AS "isDeletedPage"
    FROM chosen_pv chosen
    JOIN "PageVersion" pv ON pv.id = chosen."pageVersionId"
    JOIN "Page" p ON p.id = pv."pageId"
    WHERE NOT EXISTS (
      SELECT 1 FROM "PageEmbedding" pe
      WHERE pe."pageVersionId" = chosen."pageVersionId"
        AND pe.model = $1
    )
    ORDER BY chosen."pageVersionId"
    LIMIT $3
    `,
    model,
    includeDeletedPages,
    limit
  );

  return rows.map((r) => ({
    pageVersionId: Number(r.pageVersionId),
    pageId: Number(r.pageId),
    wikidotId: r.wikidotId == null ? null : Number(r.wikidotId),
    title: r.title ?? null,
    alternateTitle: r.alternateTitle ?? null,
    category: r.category ?? null,
    tags: Array.isArray(r.tags) ? r.tags : [],
    textContent: r.textContent ?? null,
    isDeletedPage: Boolean(r.isDeletedPage)
  }));
}

/**
 * 批量 upsert embedding。collisions 按 `(pageVersionId, model)` 唯一键 ON CONFLICT 更新。
 * 使用 INSERT ... VALUES ..., ...ON CONFLICT DO UPDATE 一次提交 N 行，减少 round-trip。
 */
export async function upsertEmbeddings(
  prisma: PrismaClient,
  model: string,
  dim: number,
  rows: Array<{
    pageVersionId: number;
    embedding: number[];
    sourceCharLen: number;
    sourceTruncated: boolean;
  }>
): Promise<number> {
  if (rows.length === 0) return 0;

  // 拼 VALUES 字面量：所有 halfvec 字面串 + 其他参数走 $n 位置
  // pgvector 接收 `[n1,n2,...]::halfvec(1024)` 的 cast 形式
  const placeholders: string[] = [];
  const params: any[] = [model, dim];
  let idx = 3;
  for (const r of rows) {
    placeholders.push(
      `($${idx++}, $1, $2, $${idx++}::halfvec(${dim}), $${idx++}, $${idx++})`
    );
    params.push(
      r.pageVersionId,
      toVectorLiteral(r.embedding),
      r.sourceCharLen,
      r.sourceTruncated
    );
  }

  const sql = `
    INSERT INTO "PageEmbedding" (
      "pageVersionId", "model", "dim", "embedding", "sourceCharLen", "sourceTruncated"
    )
    VALUES ${placeholders.join(',')}
    ON CONFLICT ("pageVersionId", "model") DO UPDATE SET
      "embedding" = EXCLUDED."embedding",
      "dim" = EXCLUDED."dim",
      "sourceCharLen" = EXCLUDED."sourceCharLen",
      "sourceTruncated" = EXCLUDED."sourceTruncated",
      "createdAt" = CURRENT_TIMESTAMP
  `;
  const res: any = await prisma.$executeRawUnsafe(sql, ...params);
  return Number(res) || rows.length;
}

export interface SearchHit {
  pageVersionId: number;
  pageId: number;
  wikidotId: number | null;
  title: string | null;
  alternateTitle: string | null;
  rating: number | null;
  category: string | null;
  tags: string[];
  denseScore: number;            // 1 - cosine distance
  sparseScore: number;           // pgroonga score normalized roughly to [0,1]
  finalScore: number;            // weighted combination
  isDeletedPage: boolean;
}

/**
 * Hybrid search: dense cosine（pgvector HNSW）+ sparse（pgroonga 全文）+ tag 交集加权。
 * 前 K 直接在 SQL 里融合；真实权重可以随 query 日志调。
 */
export async function hybridSearch(
  prisma: PrismaClient,
  model: string,
  queryEmbedding: number[],
  queryText: string,
  opts: {
    limit?: number;
    denseCandidates?: number;
    sparseCandidates?: number;
    denseWeight?: number;
    sparseWeight?: number;
  } = {}
): Promise<SearchHit[]> {
  const limit = opts.limit ?? 10;
  const denseN = opts.denseCandidates ?? 60;
  const sparseN = opts.sparseCandidates ?? 60;
  const wd = opts.denseWeight ?? 0.65;
  const ws = opts.sparseWeight ?? 0.35;
  const vec = toVectorLiteral(queryEmbedding);

  const rows = await prisma.$queryRawUnsafe<any[]>(
    `
    WITH dense AS (
      SELECT pe."pageVersionId",
             1 - (pe.embedding <=> $1::halfvec(${queryEmbedding.length})) AS score
      FROM "PageEmbedding" pe
      WHERE pe.model = $2
      ORDER BY pe.embedding <=> $1::halfvec(${queryEmbedding.length})
      LIMIT $3
    ),
    sparse AS (
      SELECT pv.id AS "pageVersionId",
             pgroonga_score(tableoid, ctid) AS score
      FROM "PageVersion" pv
      WHERE pv.search_text &@~ $4
        AND pv."validTo" IS NULL
      ORDER BY pgroonga_score(tableoid, ctid) DESC
      LIMIT $5
    ),
    merged AS (
      SELECT "pageVersionId" FROM dense
      UNION
      SELECT "pageVersionId" FROM sparse
    ),
    max_sparse AS (
      SELECT GREATEST(MAX(score), 1e-6) AS mx FROM sparse
    )
    SELECT
      pv.id AS "pageVersionId",
      pv."pageId",
      p."wikidotId",
      pv.title,
      pv."alternateTitle",
      pv.rating,
      pv.category,
      pv.tags,
      p."isDeleted" AS "isDeletedPage",
      COALESCE(dense.score, 0)::float AS "denseScore",
      COALESCE(sparse.score / (SELECT mx FROM max_sparse), 0)::float AS "sparseScore",
      (COALESCE(dense.score, 0) * $6 + COALESCE(sparse.score / (SELECT mx FROM max_sparse), 0) * $7)::float AS "finalScore"
    FROM merged m
    JOIN "PageVersion" pv ON pv.id = m."pageVersionId"
    JOIN "Page" p ON p.id = pv."pageId"
    LEFT JOIN dense ON dense."pageVersionId" = m."pageVersionId"
    LEFT JOIN sparse ON sparse."pageVersionId" = m."pageVersionId"
    ORDER BY "finalScore" DESC
    LIMIT $8
    `,
    vec,
    model,
    denseN,
    queryText,
    sparseN,
    wd,
    ws,
    limit
  );

  return rows.map((r: any) => ({
    pageVersionId: Number(r.pageVersionId),
    pageId: Number(r.pageId),
    wikidotId: r.wikidotId == null ? null : Number(r.wikidotId),
    title: r.title ?? null,
    alternateTitle: r.alternateTitle ?? null,
    rating: r.rating == null ? null : Number(r.rating),
    category: r.category ?? null,
    tags: Array.isArray(r.tags) ? r.tags : [],
    denseScore: Number(r.denseScore ?? 0),
    sparseScore: Number(r.sparseScore ?? 0),
    finalScore: Number(r.finalScore ?? 0),
    isDeletedPage: Boolean(r.isDeletedPage)
  }));
}
