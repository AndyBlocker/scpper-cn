import type { PrismaClient } from '@prisma/client';

/**
 * 修复"线程回复计数与真实帖数不一致"(#116)：ForumThread.postCount 是远端声明值/历史水位，
 * 部分线程与本地实际未删帖子数不符（偏高/偏低，含抓帖失败遗留）。本 CLI 把这些线程的
 * postCount 校正为本地真实未删帖子数。
 *
 * 安全性：postCount 仅用于【展示】；同步的增量跳过判定用的是 postCountAtSync（水位），
 * 见 ForumSyncProcessor 的 `localThread.postCountAtSync === remoteThread.postCount`。
 * 故本校正【不触碰 postCountAtSync】，不影响同步行为。
 * 默认 dry-run（只统计/列样本，不写库）；需 --apply 才落库；幂等（只改不一致的行）。
 */
export async function runRepairForumPostCounts(
  prisma: PrismaClient,
  opts: { apply?: boolean } = {}
): Promise<void> {
  const apply = Boolean(opts.apply);
  console.log(apply ? '🔧 APPLY: 校正线程 postCount 为真实未删帖子数' : '🔍 DRY RUN: 仅统计不一致线程(加 --apply 落库)');

  const mismatched = await prisma.$queryRaw<Array<{ id: number; declared: number; real: number }>>`
    SELECT t.id, t."postCount" AS declared,
           (SELECT COUNT(*)::int FROM "ForumPost" p WHERE p."threadId" = t.id AND p."isDeleted" = false) AS real
    FROM "ForumThread" t
    WHERE t."isDeleted" = false
      AND t."postCount" <> (SELECT COUNT(*)::int FROM "ForumPost" p WHERE p."threadId" = t.id AND p."isDeleted" = false)
    ORDER BY t.id
  `;

  console.log(`不一致线程数: ${mismatched.length}`);
  if (mismatched.length === 0) {
    console.log('无不一致，无需处理。');
    return;
  }
  const higher = mismatched.filter((r) => Number(r.declared) > Number(r.real)).length;
  const lower = mismatched.filter((r) => Number(r.declared) < Number(r.real)).length;
  console.log(`  其中 declared>real: ${higher}，declared<real: ${lower}`);
  console.log(
    '样本(最多 10):',
    mismatched.slice(0, 10).map((r) => `#${r.id}(${r.declared}→${r.real})`).join(', ')
  );

  if (!apply) {
    console.log('DRY RUN: 未写库(加 --apply 执行校正)。');
    return;
  }

  // 一次性按真实未删帖子数校正(只改不一致行,不触碰 postCountAtSync)。
  const affected = await prisma.$executeRaw`
    UPDATE "ForumThread" t
    SET "postCount" = sub.real
    FROM (
      SELECT t2.id,
             (SELECT COUNT(*)::int FROM "ForumPost" p WHERE p."threadId" = t2.id AND p."isDeleted" = false) AS real
      FROM "ForumThread" t2
      WHERE t2."isDeleted" = false
    ) sub
    WHERE t.id = sub.id AND t."postCount" <> sub.real
  `;
  console.log(`✓ 完成：校正 ${affected} 个线程的 postCount。`);
}
