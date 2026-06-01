import type { PrismaClient } from '@prisma/client';
import { ForumSyncProcessor } from '../core/processors/ForumSyncProcessor.js';

/**
 * 修复"卡住线程"(#113)：历史抓帖失败但水位 postCountAtSync 已推进到 postCount，
 * 导致增量同步永久跳过、显示有帖实际 0 帖。本 CLI 定向网络重抓这些线程的帖子。
 * - 复用 ForumSyncProcessor.resyncThreads：连接 → getPosts → upsertPost → 推进水位。
 * - 【不触发任何论坛提醒】(不喂 newPostIds 给 ForumInteractionAlertJob)。
 * - 默认 dry-run(只列出,不联网)；需显式 apply=true 才网络重抓。
 * - 自动检测口径刻意收窄为"本地 0 帖"(审计确认的 63 个卡住线程签名)，避免把"有已删帖
 *   的健康线程"误判为卡住而反复重抓；失败线程的 id 会逐条打印，可用 threadIds 精确重试。
 */
export async function runRepairForumStuckThreads(
  prisma: PrismaClient,
  opts: { apply?: boolean; threadIds?: number[] } = {}
): Promise<void> {
  const apply = Boolean(opts.apply);
  console.log(apply ? '🔧 APPLY: 网络重抓卡住线程并落库' : '🔍 DRY RUN: 仅列出卡住线程,不重抓(加 --apply 执行)');

  let ids: number[];
  if (opts.threadIds && opts.threadIds.length > 0) {
    ids = Array.from(new Set(opts.threadIds)).sort((a, b) => a - b);
    console.log(`显式指定 thread id(绕过自动检测): ${ids.length}`);
  } else {
    const rows = await prisma.$queryRaw<Array<{ id: number }>>`
      SELECT t.id
      FROM "ForumThread" t
      WHERE t."postCount" > 0
        AND t."isDeleted" = false
        AND t."postCountAtSync" = t."postCount"
        AND NOT EXISTS (
          SELECT 1 FROM "ForumPost" p WHERE p."threadId" = t.id AND p."isDeleted" = false
        )
      ORDER BY t.id
    `;
    ids = rows.map((r) => Number(r.id));
    console.log(`卡住线程(postCount>0 但本地 0 帖且会被增量跳过): ${ids.length}`);
  }
  if (ids.length === 0) {
    console.log('无卡住线程,无需处理。');
    return;
  }
  console.log('样本 id(最多 20):', ids.slice(0, 20).join(', '));

  if (!apply) {
    console.log('DRY RUN: 未重抓(加 --apply 执行网络重抓)。');
    return;
  }

  const processor = new ForumSyncProcessor({ dryRun: false });
  const summary = await processor.resyncThreads(ids);
  console.log(
    `✓ 完成:重抓 ${summary.succeeded}/${summary.threads} 线程,落库 ${summary.postsUpserted} 帖,失败 ${summary.failed}。`
  );
}
