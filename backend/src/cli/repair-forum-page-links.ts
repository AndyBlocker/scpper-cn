import type { PrismaClient } from '@prisma/client';

// 单页讨论分类(scp-wiki-cn 专属)。仅对该分类的讨论帖尝试回填 pageId。
const SINGLE_PAGE_DISCUSSION_CATEGORY = 675245;

interface ResolveRow {
  thread_id: number;
  title: string;
  resolved_page_id: number | null;
  method: string;
}

/**
 * 回填论坛讨论帖与页面的关联(pageId)。
 * - 仅处理 category=675245、pageId IS NULL、未删除的讨论帖(只补空,绝不覆盖已有非空链接)。
 * - 按当前有效版本【标题 → 副标题 → URL slug】三级精确匹配,仅唯一匹配才回填;歧义/无匹配保持 NULL。
 *   与同步路径 ForumSyncProcessor.resolvePageId 的口径一致(标题优先;歧义即放弃,不降级)。
 * - 默认【dry-run】(只预览);需显式 apply=true 才写入。纯 DB 更新,不发任何提醒。
 */
export async function runRepairForumPageLinks(
  prisma: PrismaClient,
  opts: { apply?: boolean } = {}
): Promise<void> {
  const apply = Boolean(opts.apply);
  console.log(apply ? '🔧 APPLY: 回填唯一高置信匹配的 pageId' : '🔍 DRY RUN: 仅预览,不写入(加 --apply 才写)');

  // 匹配口径与 ForumSyncProcessor.resolvePageId 对齐：
  // 帖标题 btrim 后,与当前有效版本的【原始】title / alternateTitle 精确等值匹配；
  // slug 兜底用 lower(帖标题) 匹配 currentUrl 末段。唯一(count DISTINCT page_id = 1)才解析。
  const rows = await prisma.$queryRaw<ResolveRow[]>`
    WITH null_threads AS (
      SELECT id AS thread_id, btrim(title) AS title, lower(btrim(title)) AS title_lower
      FROM "ForumThread"
      WHERE "categoryId" = ${SINGLE_PAGE_DISCUSSION_CATEGORY}
        AND "pageId" IS NULL
        AND "isDeleted" = false
        AND title IS NOT NULL
    ),
    cur AS (
      SELECT
        p.id AS page_id,
        pv.title AS title,
        pv."alternateTitle" AS alt,
        lower(regexp_replace(p."currentUrl", '^.*/', '')) AS url_slug
      FROM "Page" p
      JOIN "PageVersion" pv ON pv."pageId" = p.id AND pv."validTo" IS NULL
      WHERE p."isDeleted" = false AND pv."isDeleted" = false
    ),
    title_agg AS (SELECT title,    count(DISTINCT page_id) AS c, min(page_id) AS pid FROM cur WHERE title    IS NOT NULL AND title    <> '' GROUP BY title),
    alt_agg   AS (SELECT alt,      count(DISTINCT page_id) AS c, min(page_id) AS pid FROM cur WHERE alt      IS NOT NULL AND alt      <> '' GROUP BY alt),
    slug_agg  AS (SELECT url_slug, count(DISTINCT page_id) AS c, min(page_id) AS pid FROM cur WHERE url_slug IS NOT NULL AND url_slug <> '' GROUP BY url_slug)
    SELECT
      nt.thread_id,
      nt.title,
      (CASE
        WHEN ta.c = 1 THEN ta.pid
        WHEN ta.c IS NULL AND aa.c = 1 THEN aa.pid
        WHEN ta.c IS NULL AND aa.c IS NULL AND sa.c = 1 THEN sa.pid
        ELSE NULL
      END)::int AS resolved_page_id,
      (CASE
        WHEN ta.c = 1 THEN 'title'
        WHEN ta.c IS NULL AND aa.c = 1 THEN 'alt'
        WHEN ta.c IS NULL AND aa.c IS NULL AND sa.c = 1 THEN 'slug'
        WHEN ta.c > 1 OR aa.c > 1 OR sa.c > 1 THEN 'ambiguous'
        ELSE 'no_match'
      END) AS method
    FROM null_threads nt
    LEFT JOIN title_agg ta ON ta.title    = nt.title
    LEFT JOIN alt_agg   aa ON aa.alt      = nt.title
    LEFT JOIN slug_agg  sa ON sa.url_slug = nt.title_lower
  `;

  const total = rows.length;
  const resolvable = rows.filter((r) => r.resolved_page_id != null);
  const byMethod = (m: string) => rows.filter((r) => r.method === m).length;

  console.log(`NULL 讨论帖总数: ${total}`);
  console.log(`  可唯一解析: ${resolvable.length} (title=${byMethod('title')}, alt=${byMethod('alt')}, slug=${byMethod('slug')})`);
  console.log(`  歧义(多候选,保持 NULL): ${byMethod('ambiguous')}`);
  console.log(`  无匹配(保持 NULL): ${byMethod('no_match')}`);
  console.log('样本(最多 8 条):');
  for (const r of resolvable.slice(0, 8)) {
    console.log(`  thread ${r.thread_id} "${r.title}" → page ${r.resolved_page_id} (${r.method})`);
  }

  if (!apply) {
    console.log('DRY RUN: 未写入任何数据(加 --apply 执行回填)。');
    return;
  }

  // 分块批量 UPDATE(VALUES 里都是来自上面查询的整数,无注入风险)。
  // WHERE pageId IS NULL 保证幂等且绝不覆盖已有非空链接;中途失败可安全重跑。
  let updated = 0;
  const CHUNK = 1000;
  for (let i = 0; i < resolvable.length; i += CHUNK) {
    const chunk = resolvable.slice(i, i + CHUNK);
    const values = chunk
      .map((r) => `(${Number(r.thread_id)}, ${Number(r.resolved_page_id)})`)
      .join(', ');
    const affected = await prisma.$executeRawUnsafe(
      `UPDATE "ForumThread" t
         SET "pageId" = v.page_id
         FROM (VALUES ${values}) AS v(thread_id, page_id)
        WHERE t.id = v.thread_id
          AND t."pageId" IS NULL`
    );
    updated += Number(affected);
    console.log(`  …已回填 ${updated}/${resolvable.length}`);
  }

  console.log(`✓ 完成:回填 ${updated} 个讨论帖的 pageId(歧义/无匹配保持 NULL,已有链接未动)。`);
}
