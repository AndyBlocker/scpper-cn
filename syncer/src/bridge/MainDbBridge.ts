/**
 * MainDbBridge — 将 syncer v2 的数据同步到主 scpper 数据库
 *
 * 目标：让 BFF 和分析管道（CategoryIndexTickJob 等）能读到最新数据。
 *
 * 写入目标表：
 *   - PageVersion (更新 rating, voteCount, commentCount, revisionCount, tags; title/tags 变化则创建新版本)
 *   - Page (新页面 / 删除标记)
 *   - User (从投票/修订数据中 ensure)
 *   - Vote (从 VoteChangeEvent 增量写入)
 *   - Revision (从 syncer DB RevisionRecord 增量写入)
 */

import pg from 'pg';
import { getMainPool, getSyncerPrisma } from '../store/db.js';
import type { PageSnapshotEntry, PageSnapshotMap } from '../scanner/PageScanner.js';
import type { PageChange } from '../sentinel/PageDiffEngine.js';
import { extractTextFromSource } from '../utils/html-extract.js';

// ── Types ──

type PageMapping = {
  pageId: number;
  pageVersionId: number;
  wikidotId: number;
  title: string | null;
  tags: string[];
  rating: number | null;
  voteCount: number | null;
  isDeleted: boolean;
};

type BridgeResult = {
  pagesUpdated: number;
  newVersionsCreated: number;
  newPagesCreated: number;
  deletedPages: number;
  usersEnsured: number;
  votesWritten: number;
  revisionsWritten: number;
};

// ── Public API ──

/**
 * 将 syncer 检测到的变更同步到主数据库
 */
export async function bridgeToMainDb(
  changes: PageChange[],
  currentMap: PageSnapshotMap,
  wikidotIds: Map<string, number>,
): Promise<BridgeResult> {
  if (changes.length === 0) {
    return { pagesUpdated: 0, newVersionsCreated: 0, newPagesCreated: 0, deletedPages: 0, usersEnsured: 0, votesWritten: 0, revisionsWritten: 0 };
  }

  const pool = getMainPool();
  const t0 = Date.now();
  console.log(`[bridge] Starting main DB bridge for ${changes.length} changes...`);

  // 1. 加载 fullname → (pageId, pageVersionId) 映射
  const pageMap = await loadPageMapping(pool);
  console.log(`[bridge] Loaded ${pageMap.size} page mappings from main DB`);

  const result: BridgeResult = {
    pagesUpdated: 0,
    newVersionsCreated: 0,
    newPagesCreated: 0,
    deletedPages: 0,
    usersEnsured: 0,
    votesWritten: 0,
    revisionsWritten: 0,
  };

  // 2. 预加载内容变化页面的 source（用于 textContent 提取）
  const contentChangedFullnames = changes
    .filter(c => c.categories.has('content_changed') || c.categories.has('new_page'))
    .filter(c => c.curr)
    .map(c => c.fullname);

  const sourceMap = new Map<string, string>();
  if (contentChangedFullnames.length > 0) {
    const syncerPrisma = getSyncerPrisma();
    const contentRows: Array<{ fullname: string; source: string | null }> =
      await syncerPrisma.pageContentCache.findMany({
        where: { fullname: { in: contentChangedFullnames } },
        select: { fullname: true, source: true },
      });
    for (const r of contentRows) {
      if (r.source) sourceMap.set(r.fullname, r.source);
    }
  }

  // 3. 分类变更
  const statsUpdates: Array<{ fullname: string; snap: PageSnapshotEntry; mapping: PageMapping }> = [];
  const versionUpdates: Array<{ fullname: string; snap: PageSnapshotEntry; mapping: PageMapping }> = [];
  const newPages: Array<{ fullname: string; snap: PageSnapshotEntry }> = [];
  const deletedFullnames: string[] = [];

  // 构建 wikidotId → 新 fullname 的映射，用于检测 URL 变更（删除+新建 → 同一 wikidotId）
  const newPageWikidotIds = new Map<number, string>();
  for (const change of changes) {
    if (change.categories.has('new_page') && change.curr) {
      const wid = wikidotIds.get(change.fullname);
      if (wid) newPageWikidotIds.set(wid, change.fullname);
    }
  }

  for (const change of changes) {
    const snap = change.curr;
    const mapping = pageMap.get(change.fullname);

    if (change.categories.has('deleted_page')) {
      if (mapping) {
        // 检查是否是 URL 变更：同一 wikidotId 在新页面中出现
        if (newPageWikidotIds.has(mapping.wikidotId)) {
          // URL 变更，不标记删除 — createNewPage 会处理 URL 更新
          continue;
        }
        deletedFullnames.push(change.fullname);
      }
      continue;
    }

    if (!snap) continue;

    if (!mapping) {
      // 新页面：主库中不存在（含已删除页面中也找不到的）
      if (change.categories.has('new_page')) {
        newPages.push({ fullname: change.fullname, snap });
      }
      continue;
    }

    // 僵尸页面检测：主库标记为已删除，但 V2 扫描到了（说明实际存在）
    if (mapping.isDeleted) {
      console.log(`[bridge] Zombie page detected: ${change.fullname} (was deleted, now alive)`);
      // 当作 newPage 处理 — createNewPage 中有按 wikidotId 恢复的逻辑
      newPages.push({ fullname: change.fullname, snap });
      continue;
    }

    // 判断是否需要创建新版本（title 或 tags 变化）
    const needNewVersion =
      (change.categories.has('metadata_changed') && (
        mapping.title !== snap.title ||
        !arraysEqual(mapping.tags, snap.tags)
      ));

    if (needNewVersion) {
      versionUpdates.push({ fullname: change.fullname, snap, mapping });
    } else {
      statsUpdates.push({ fullname: change.fullname, snap, mapping });
    }
  }

  // 4. 批量更新 PageVersion（仅统计字段）
  if (statsUpdates.length > 0) {
    result.pagesUpdated = await batchUpdatePageVersionStats(pool, statsUpdates);
  }

  // 4b. 更新有内容变化的页面的 source + textContent
  if (sourceMap.size > 0) {
    let contentUpdated = 0;
    for (const [fullname, source] of sourceMap) {
      const mapping = pageMap.get(fullname);
      if (!mapping) continue;
      const textContent = extractTextFromSource(source);
      try {
        await pool.query(`
          UPDATE "PageVersion"
          SET source = $2, "textContent" = $3, search_text = $3, "updatedAt" = NOW()
          WHERE id = $1
        `, [mapping.pageVersionId, source, textContent]);
        contentUpdated++;
      } catch { /* non-critical */ }
    }
    if (contentUpdated > 0) {
      console.log(`[bridge] Content updated: ${contentUpdated} pages (source + textContent)`);
    }
  }

  // 4. 创建新 PageVersion（title/tags 变化）
  for (const { snap, mapping } of versionUpdates) {
    try {
      await createNewPageVersion(pool, mapping, snap);
      result.newVersionsCreated++;
    } catch (err) {
      console.warn(`[bridge] Failed to create version for ${snap.fullname}:`, err);
    }
  }

  // 5. 创建新页面
  for (const { fullname, snap } of newPages) {
    const wikidotId = wikidotIds.get(fullname);
    if (!wikidotId) {
      // 无 wikidotId 无法创建 Page（主库 wikidotId 是 unique 必填）
      continue;
    }
    try {
      const pageId = await createNewPage(pool, fullname, wikidotId, snap);
      if (pageId) {
        result.newPagesCreated++;
        // 更新映射缓存供后续步骤使用
        // (不需要——vote/revision 写入在下面会重新查映射)
      }
    } catch (err) {
      console.warn(`[bridge] Failed to create page ${fullname}:`, err);
    }
  }

  // 6. 标记删除的页面
  if (deletedFullnames.length > 0) {
    result.deletedPages = await markPagesDeleted(pool, deletedFullnames, pageMap);
  }

  // 7. Ensure Users + 写入 Vote 和 Revision
  //    需要从 syncer DB 读取 VoteChangeEvent 和 RevisionRecord
  const voteChangedFullnames = changes
    .filter(c => (c.categories.has('votes_changed') || c.categories.has('new_page')) && c.curr)
    .map(c => c.fullname);

  const revisionFullnames = changes
    .filter(c => (c.categories.has('content_changed') || c.categories.has('new_page')) && c.curr)
    .map(c => c.fullname);

  // 重新加载映射（包含新创建的页面和新版本的 pageVersionId）
  const needFreshMap = newPages.length > 0 || versionUpdates.length > 0;
  const freshPageMap = needFreshMap
    ? await loadPageMapping(pool)
    : pageMap;

  if (voteChangedFullnames.length > 0) {
    const { usersEnsured, votesWritten } = await bridgeVotes(pool, voteChangedFullnames, freshPageMap);
    result.usersEnsured += usersEnsured;
    result.votesWritten = votesWritten;
  }

  if (revisionFullnames.length > 0) {
    const { usersEnsured, revisionsWritten } = await bridgeRevisions(pool, revisionFullnames, freshPageMap);
    result.usersEnsured += usersEnsured;
    result.revisionsWritten = revisionsWritten;
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(
    `[bridge] Done in ${elapsed}s:`,
    `pages=${result.pagesUpdated}`,
    `newVer=${result.newVersionsCreated}`,
    `newPage=${result.newPagesCreated}`,
    `deleted=${result.deletedPages}`,
    `users=${result.usersEnsured}`,
    `votes=${result.votesWritten}`,
    `revisions=${result.revisionsWritten}`,
  );

  return result;
}

// ── Internal: Page Mapping ──

async function loadPageMapping(pool: pg.Pool): Promise<Map<string, PageMapping>> {
  // 同时加载已删除和未删除的页面，以便检测僵尸页面（被错误标记删除但实际存在的）
  const { rows } = await pool.query<{
    fullname: string;
    page_id: string;
    page_version_id: string;
    wikidot_id: string;
    title: string | null;
    tags: string[] | null;
    rating: string | null;
    vote_count: string | null;
    is_deleted: boolean;
  }>(`
    SELECT
      SUBSTRING(p."currentUrl" FROM '//[^/]+/(.+)$') AS fullname,
      p.id::text AS page_id,
      pv.id::text AS page_version_id,
      p."wikidotId"::text AS wikidot_id,
      pv.title,
      pv.tags,
      pv.rating::text,
      pv."voteCount"::text AS vote_count,
      p."isDeleted" AS is_deleted
    FROM "Page" p
    JOIN "PageVersion" pv ON pv."pageId" = p.id AND pv."validTo" IS NULL
  `);

  const map = new Map<string, PageMapping>();
  for (const r of rows) {
    if (!r.fullname) continue;
    map.set(r.fullname, {
      pageId: parseInt(r.page_id, 10),
      pageVersionId: parseInt(r.page_version_id, 10),
      wikidotId: parseInt(r.wikidot_id, 10),
      title: r.title,
      tags: r.tags ?? [],
      rating: r.rating != null ? parseInt(r.rating, 10) : null,
      voteCount: r.vote_count != null ? parseInt(r.vote_count, 10) : null,
      isDeleted: r.is_deleted,
    });
  }
  return map;
}

// ── Internal: PageVersion Stats Update ──

async function batchUpdatePageVersionStats(
  pool: pg.Pool,
  updates: Array<{ fullname: string; snap: PageSnapshotEntry; mapping: PageMapping }>
): Promise<number> {
  // 使用 unnest 批量更新
  const ids: number[] = [];
  const ratings: number[] = [];
  const voteCounts: number[] = [];
  const commentCounts: number[] = [];
  const revisionCounts: number[] = [];

  for (const { snap, mapping } of updates) {
    ids.push(mapping.pageVersionId);
    ratings.push(snap.rating);
    voteCounts.push(snap.votesCount);
    commentCounts.push(snap.commentsCount);
    revisionCounts.push(snap.revisionsCount);
  }

  const result = await pool.query(`
    UPDATE "PageVersion" pv
    SET
      rating = u.rating,
      "voteCount" = u.vote_count,
      "commentCount" = u.comment_count,
      "revisionCount" = u.revision_count,
      "updatedAt" = NOW()
    FROM (
      SELECT
        unnest($1::int[]) AS id,
        unnest($2::int[]) AS rating,
        unnest($3::int[]) AS vote_count,
        unnest($4::int[]) AS comment_count,
        unnest($5::int[]) AS revision_count
    ) u
    WHERE pv.id = u.id
  `, [ids, ratings, voteCounts, commentCounts, revisionCounts]);

  return result.rowCount ?? 0;
}

// ── Internal: New PageVersion ──

async function createNewPageVersion(
  pool: pg.Pool,
  mapping: PageMapping,
  snap: PageSnapshotEntry,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 关闭旧版本
    await client.query(`
      UPDATE "PageVersion" SET "validTo" = NOW(), "updatedAt" = NOW()
      WHERE id = $1
    `, [mapping.pageVersionId]);

    // 获取旧版本的内容字段（保持不变的字段）
    const { rows: [old] } = await client.query(`
      SELECT source, "textContent", category, "alternateTitle", "attributionCount",
             search_text, "isDeleted"
      FROM "PageVersion" WHERE id = $1
    `, [mapping.pageVersionId]);

    // 创建新版本
    const { rows: [newVer] } = await client.query(`
      INSERT INTO "PageVersion" (
        "pageId", "wikidotId", title, rating, "voteCount", "revisionCount",
        "commentCount", tags, category, source, "textContent", search_text,
        "alternateTitle", "attributionCount", "isDeleted",
        "validFrom", "validTo", "createdAt", "updatedAt"
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12,
        $13, $14, $15,
        NOW(), NULL, NOW(), NOW()
      )
      RETURNING id
    `, [
      mapping.pageId,
      mapping.wikidotId,
      snap.title,
      snap.rating,
      snap.votesCount,
      snap.revisionsCount,
      snap.commentsCount,
      snap.tags,
      wikidotCategory(snap.fullname),
      old?.source ?? null,
      old?.textContent ?? null,
      old?.search_text ?? null,
      old?.alternateTitle ?? null,
      old?.attributionCount ?? null,
      false,  // isDeleted 始终为 false（新版本不应继承删除状态）
    ]);

    const newPvId = newVer.id;

    // 迁移关联记录到新版本（与 V1 Phase B 行为一致）
    // Vote、Revision、Attribution 等通过 pageVersionId 关联
    await client.query(
      `UPDATE "Vote" SET "pageVersionId" = $1 WHERE "pageVersionId" = $2`,
      [newPvId, mapping.pageVersionId]
    );
    await client.query(
      `UPDATE "Revision" SET "pageVersionId" = $1 WHERE "pageVersionId" = $2`,
      [newPvId, mapping.pageVersionId]
    );
    await client.query(
      `UPDATE "Attribution" SET "pageVerId" = $1 WHERE "pageVerId" = $2`,
      [newPvId, mapping.pageVersionId]
    );
    // PageStats: 旧版本的删除（新版本会由 page_stats 任务重新计算）
    await client.query(
      `DELETE FROM "PageStats" WHERE "pageVersionId" = $1`,
      [mapping.pageVersionId]
    );
    await client.query(
      `UPDATE "SourceVersion" SET "pageVersionId" = $1 WHERE "pageVersionId" = $2`,
      [newPvId, mapping.pageVersionId]
    );
    await client.query(
      `UPDATE "PageReference" SET "pageVersionId" = $1 WHERE "pageVersionId" = $2`,
      [newPvId, mapping.pageVersionId]
    );
    await client.query(
      `UPDATE "PageVersionImage" SET "pageVersionId" = $1 WHERE "pageVersionId" = $2`,
      [newPvId, mapping.pageVersionId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Internal: New Page ──

async function createNewPage(
  pool: pg.Pool,
  fullname: string,
  wikidotId: number,
  snap: PageSnapshotEntry,
): Promise<number | null> {
  const url = `http://scp-wiki-cn.wikidot.com/${fullname}`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 检查 wikidotId 是否已存在
    const { rows: existing } = await client.query(
      `SELECT id, "currentUrl" FROM "Page" WHERE "wikidotId" = $1 LIMIT 1`, [wikidotId]
    );
    if (existing.length > 0) {
      // wikidotId 已存在 → 可能是 URL 变更或僵尸页面恢复
      const pageId = existing[0].id;
      const oldUrl = existing[0].currentUrl;
      // 总是确保 isDeleted=false（处理僵尸页面恢复）
      await client.query(`
        UPDATE "Page"
        SET "currentUrl" = $2,
            "urlHistory" = CASE WHEN $2 != "currentUrl"
              THEN array_append("urlHistory", $2) ELSE "urlHistory" END,
            "isDeleted" = false,
            "updatedAt" = NOW()
        WHERE id = $1
      `, [pageId, url]);
      if (oldUrl !== url) {
        console.log(`[bridge] URL change: ${oldUrl} → ${url} (wikidotId=${wikidotId})`);
      }
      // 更新 PageVersion 统计 + category + 确保 isDeleted=false
      const category = wikidotCategory(fullname);
      await client.query(`
        UPDATE "PageVersion"
        SET rating = $2, "voteCount" = $3, "commentCount" = $4,
            "revisionCount" = $5, tags = $6, title = $7,
            category = $8, "isDeleted" = false, "updatedAt" = NOW()
        WHERE "pageId" = $1 AND "validTo" IS NULL
      `, [pageId, snap.rating, snap.votesCount, snap.commentsCount,
          snap.revisionsCount, snap.tags, snap.title, category]);
      await client.query('COMMIT');
      return pageId;
    }

    const firstPublished = snap.createdAtTs
      ? new Date(snap.createdAtTs * 1000)
      : new Date();

    const { rows: [page] } = await client.query(`
      INSERT INTO "Page" ("wikidotId", url, "currentUrl", "isDeleted", "firstPublishedAt", "createdAt", "updatedAt")
      VALUES ($1, $2, $2, false, $3, NOW(), NOW())
      RETURNING id
    `, [wikidotId, url, firstPublished]);

    const pageId = page.id;

    const category = wikidotCategory(fullname);

    const { rows: [newPv] } = await client.query(`
      INSERT INTO "PageVersion" (
        "pageId", "wikidotId", title, rating, "voteCount", "revisionCount",
        "commentCount", tags, category, "isDeleted",
        "validFrom", "validTo", "createdAt", "updatedAt"
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, false,
        NOW(), NULL, NOW(), NOW()
      )
      RETURNING id
    `, [
      pageId,
      wikidotId,
      snap.title,
      snap.rating,
      snap.votesCount,
      snap.revisionsCount,
      snap.commentsCount,
      snap.tags,
      category,
    ]);

    // 为新页面创建 SUBMITTER Attribution（从 createdBy 查找用户）
    if (snap.createdBy && newPv?.id) {
      try {
        const { rows: [creator] } = await client.query(
          `SELECT id FROM "User" WHERE "displayName" = $1 LIMIT 1`,
          [snap.createdBy]
        );
        if (creator) {
          await client.query(`
            INSERT INTO "Attribution" ("pageVerId", type, "order", "userId")
            VALUES ($1, 'SUBMITTER', 0, $2)
            ON CONFLICT ("pageVerId", type, "order", "userId") DO NOTHING
          `, [newPv.id, creator.id]);
        }
      } catch { /* non-critical */ }
    }

    await client.query('COMMIT');
    return pageId;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Internal: Mark Deleted ──

async function markPagesDeleted(
  pool: pg.Pool,
  fullnames: string[],
  pageMap: Map<string, PageMapping>,
): Promise<number> {
  let count = 0;
  for (const fullname of fullnames) {
    const mapping = pageMap.get(fullname);
    if (!mapping) continue;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 标记 Page 为已删除
      await client.query(`UPDATE "Page" SET "isDeleted" = true, "updatedAt" = NOW() WHERE id = $1`, [mapping.pageId]);

      // 关闭当前 PageVersion
      await client.query(`
        UPDATE "PageVersion" SET "validTo" = NOW(), "updatedAt" = NOW()
        WHERE id = $1
      `, [mapping.pageVersionId]);

      // 创建删除标记版本
      await client.query(`
        INSERT INTO "PageVersion" (
          "pageId", "wikidotId", title, rating, "voteCount", "revisionCount",
          "commentCount", tags, "isDeleted", "validFrom", "validTo", "createdAt", "updatedAt"
        )
        SELECT
          "pageId", "wikidotId", title, rating, "voteCount", "revisionCount",
          "commentCount", tags, true, NOW(), NULL, NOW(), NOW()
        FROM "PageVersion" WHERE id = $1
      `, [mapping.pageVersionId]);

      await client.query('COMMIT');
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      console.warn(`[bridge] Failed to mark deleted: ${fullname}`, err);
    } finally {
      client.release();
    }
  }
  return count;
}

// ── Internal: Bridge Votes ──

/**
 * 从 VoteChangeEvent（增量事件）写入新投票到主库
 * 只处理 'added' 事件 — 这些是自 V2 监控以来新增的投票
 */
async function bridgeVotes(
  pool: pg.Pool,
  fullnames: string[],
  pageMap: Map<string, PageMapping>,
): Promise<{ usersEnsured: number; votesWritten: number }> {
  const syncerPrisma = getSyncerPrisma();
  let usersEnsured = 0;
  let votesWritten = 0;

  // 从 VoteChangeEvent 读取 'added' 和 'changed' 事件（增量）
  const voteEvents: Array<{
    fullname: string;
    userId: number | null;
    userName: string | null;
    changeType: string;
    oldDirection: number | null;
    newDirection: number | null;
    detectedAt: Date;
  }> = await syncerPrisma.voteChangeEvent.findMany({
    where: {
      fullname: { in: fullnames },
      changeType: { in: ['added', 'changed'] },
      userId: { not: null },
    },
    orderBy: { detectedAt: 'desc' },
  });

  if (voteEvents.length === 0) return { usersEnsured: 0, votesWritten: 0 };

  // 按 fullname+userId 去重（只保留最新事件）
  const dedupKey = (fn: string, uid: number) => `${fn}:${uid}`;
  const seen = new Set<string>();
  const uniqueEvents = voteEvents.filter(e => {
    if (e.userId == null) return false;
    const key = dedupKey(e.fullname, e.userId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 收集用户
  const userPairs = new Map<number, string | null>();
  for (const e of uniqueEvents) {
    if (e.userId != null) userPairs.set(e.userId, e.userName ?? null);
  }

  if (userPairs.size > 0) {
    usersEnsured = await ensureUsers(pool, userPairs);
  }

  const userIdMap = await loadUserIdMap(pool, [...userPairs.keys()]);

  // 按页面分组写入
  const eventsByPage = new Map<string, typeof uniqueEvents>();
  for (const e of uniqueEvents) {
    const list = eventsByPage.get(e.fullname) ?? [];
    list.push(e);
    eventsByPage.set(e.fullname, list);
  }

  for (const [fullname, events] of eventsByPage) {
    const mapping = pageMap.get(fullname);
    if (!mapping) continue;

    // 加载该 PAGE 上所有版本已有的投票用户集合（跨版本去重，避免新旧版本重复）
    const { rows: existingVoteRows } = await pool.query<{ user_id: string }>(
      `SELECT DISTINCT v."userId"::text AS user_id
       FROM "Vote" v
       JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
       WHERE pv."pageId" = (SELECT "pageId" FROM "PageVersion" WHERE id = $1)
         AND v."userId" IS NOT NULL`,
      [mapping.pageVersionId]
    );
    const existingUserIds = new Set(existingVoteRows.map(r => r.user_id));

    for (const e of events) {
      if (e.userId == null || e.newDirection == null) continue;
      const mainUserId = userIdMap.get(e.userId) ?? null;
      if (!mainUserId) continue;

      try {
        if (e.changeType === 'added') {
          // 主库已有该用户的投票 → 跳过（V1 的记录有原始时间戳，更准确）
          if (existingUserIds.has(String(mainUserId))) continue;

          const r = await pool.query(`
            INSERT INTO "Vote" ("pageVersionId", "userId", direction, timestamp)
            VALUES ($1, $2, $3, ($4::date)::timestamp)
            ON CONFLICT ("pageVersionId", "userId", timestamp) DO NOTHING
          `, [mapping.pageVersionId, mainUserId, e.newDirection, toVoteDateString(e.detectedAt)]);
          if ((r.rowCount ?? 0) > 0) {
            votesWritten++;
            existingUserIds.add(String(mainUserId));
          }
        } else if (e.changeType === 'changed') {
          // 方向变更 → 更新该用户最新的投票记录
          if (existingUserIds.has(String(mainUserId))) {
            const r = await pool.query(`
              UPDATE "Vote" SET direction = $3
              WHERE id = (
                SELECT id FROM "Vote"
                WHERE "pageVersionId" = $1 AND "userId" = $2
                ORDER BY timestamp DESC LIMIT 1
              ) AND direction != $3
            `, [mapping.pageVersionId, mainUserId, e.newDirection]);
            votesWritten += r.rowCount ?? 0;
          } else {
            // 无现有记录 → INSERT
            const r = await pool.query(`
              INSERT INTO "Vote" ("pageVersionId", "userId", direction, timestamp)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT ("pageVersionId", "userId", timestamp) DO NOTHING
            `, [mapping.pageVersionId, mainUserId, e.newDirection, toVoteDateString(e.detectedAt)]);
            if ((r.rowCount ?? 0) > 0) {
              votesWritten++;
              existingUserIds.add(String(mainUserId));
            }
          }
        }
      } catch (err) {
        // skip individual failures
      }
    }
  }

  return { usersEnsured, votesWritten };
}

// ── Internal: Bridge Revisions ──

async function bridgeRevisions(
  pool: pg.Pool,
  fullnames: string[],
  pageMap: Map<string, PageMapping>,
): Promise<{ usersEnsured: number; revisionsWritten: number }> {
  const syncerPrisma = getSyncerPrisma();
  let usersEnsured = 0;
  let revisionsWritten = 0;

  // 从 syncer DB 读取这些页面的修订记录
  const revRecords: Array<{
    fullname: string;
    wikidotRevisionId: number | null;
    revNo: number;
    createdByName: string | null;
    createdByWikidotId: number | null;
    createdAt: Date | null;
    comment: string | null;
    type: string | null;
  }> = await syncerPrisma.revisionRecord.findMany({
    where: { fullname: { in: fullnames } },
    orderBy: { revNo: 'asc' },
  });

  if (revRecords.length === 0) return { usersEnsured: 0, revisionsWritten: 0 };

  // 收集用户
  const userPairs = new Map<number, string | null>();
  for (const r of revRecords) {
    if (r.createdByWikidotId != null) {
      userPairs.set(r.createdByWikidotId, r.createdByName ?? null);
    }
  }

  if (userPairs.size > 0) {
    usersEnsured = await ensureUsers(pool, userPairs);
  }

  const userIdMap = await loadUserIdMap(pool, [...userPairs.keys()]);

  // 按页面分组写入
  for (const fullname of fullnames) {
    const mapping = pageMap.get(fullname);
    if (!mapping) continue;

    const pageRevs = revRecords.filter(r => r.fullname === fullname);
    if (pageRevs.length === 0) continue;

    for (const rev of pageRevs) {
      if (!rev.wikidotRevisionId || !rev.createdAt) continue;

      const mainUserId = rev.createdByWikidotId != null
        ? (userIdMap.get(rev.createdByWikidotId) ?? null)
        : null;

      try {
        const r = await pool.query(`
          INSERT INTO "Revision" ("pageVersionId", "wikidotId", timestamp, type, comment, "userId")
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT ("pageVersionId", "wikidotId") DO NOTHING
        `, [
          mapping.pageVersionId,
          rev.wikidotRevisionId,
          rev.createdAt,
          rev.type ?? 'SOURCE_CHANGED',
          rev.comment ?? '',
          mainUserId,
        ]);
        revisionsWritten += r.rowCount ?? 0;
      } catch {
        // skip duplicates
      }
    }
  }

  return { usersEnsured, revisionsWritten };
}

// ── Internal: User Management ──

async function ensureUsers(
  pool: pg.Pool,
  userPairs: Map<number, string | null>,
): Promise<number> {
  if (userPairs.size === 0) return 0;

  const wikidotIds: number[] = [];
  const displayNames: (string | null)[] = [];

  for (const [wid, name] of userPairs) {
    wikidotIds.push(wid);
    displayNames.push(name);
  }

  // 批量 upsert，使用 COALESCE 保留已有的更丰富数据
  const result = await pool.query(`
    INSERT INTO "User" ("wikidotId", "displayName")
    SELECT
      unnest($1::int[]),
      unnest($2::text[])
    ON CONFLICT ("wikidotId") DO UPDATE SET
      "displayName" = COALESCE(
        CASE WHEN "User"."displayName" IS NOT NULL
              AND "User"."displayName" != ''
              AND "User"."displayName" NOT LIKE 'Wikidot User %'
             THEN "User"."displayName"
             ELSE NULL
        END,
        EXCLUDED."displayName",
        "User"."displayName"
      )
  `, [wikidotIds, displayNames]);

  return result.rowCount ?? 0;
}

async function loadUserIdMap(
  pool: pg.Pool,
  wikidotIds: number[],
): Promise<Map<number, number>> {
  if (wikidotIds.length === 0) return new Map();

  const { rows } = await pool.query<{ wikidot_id: string; id: string }>(`
    SELECT "wikidotId"::text AS wikidot_id, id::text
    FROM "User"
    WHERE "wikidotId" = ANY($1::int[])
  `, [wikidotIds]);

  const map = new Map<number, number>();
  for (const r of rows) {
    map.set(parseInt(r.wikidot_id, 10), parseInt(r.id, 10));
  }
  return map;
}

// ── Helpers ──

/**
 * 将 Date 转为 YYYY-MM-DD 字符串（Asia/Shanghai 时区的日期）
 * 用于 Vote.timestamp — V1 存储为 midnight UTC (`YYYY-MM-DD 00:00:00`)
 * 直接传字符串给 SQL，避免 JS Date 的时区转换问题
 */
function toVoteDateString(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ── Public: AlternateTitle Bridge ──

import type { AlternateTitleEntry } from '../scanner/AlternateTitleScanner.js';

/**
 * 将 alternateTitle 数据写入主库 PageVersion.alternateTitle
 */
export async function bridgeAlternateTitles(
  entries: AlternateTitleEntry[],
): Promise<{ updated: number; skipped: number }> {
  if (entries.length === 0) return { updated: 0, skipped: 0 };

  const pool = getMainPool();
  const t0 = Date.now();
  console.log(`[bridge-alt] Writing ${entries.length} alternate titles...`);

  const pageMap = await loadPageMapping(pool);
  let updated = 0;
  let skipped = 0;

  // 批量更新：收集所有有映射的条目
  const pvIds: number[] = [];
  const titles: string[] = [];

  for (const entry of entries) {
    const mapping = pageMap.get(entry.fullname);
    if (!mapping) { skipped++; continue; }
    pvIds.push(mapping.pageVersionId);
    titles.push(entry.alternateTitle);
  }

  if (pvIds.length > 0) {
    const result = await pool.query(`
      UPDATE "PageVersion" pv
      SET "alternateTitle" = u.alt_title, "updatedAt" = NOW()
      FROM (
        SELECT unnest($1::int[]) AS id, unnest($2::text[]) AS alt_title
      ) u
      WHERE pv.id = u.id AND (pv."alternateTitle" IS NULL OR pv."alternateTitle" != u.alt_title)
    `, [pvIds, titles]);
    updated = result.rowCount ?? 0;
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[bridge-alt] Done in ${elapsed}s: updated=${updated} skipped=${skipped}`);
  return { updated, skipped };
}

// ── Public: Attribution Bridge ──

import type { AttributionEntry } from '../scanner/AttributionScanner.js';

/**
 * 将归属数据写入主库 Attribution 表
 * 独立于主 bridge 流程，因为归属数据变化不频繁
 */
export async function bridgeAttributions(
  entries: AttributionEntry[],
): Promise<{ written: number; skipped: number }> {
  if (entries.length === 0) return { written: 0, skipped: 0 };

  const pool = getMainPool();
  const t0 = Date.now();
  console.log(`[bridge-attr] Writing ${entries.length} attribution entries...`);

  // 加载 fullname → pageVersionId 映射
  const pageMap = await loadPageMapping(pool);
  console.log(`[bridge-attr] pageMap size: ${pageMap.size}, sample: ${[...pageMap.keys()].slice(0, 3).join(', ')}`);

  // 加载 userName → userId 映射（通过 displayName 查找）
  const userNames = [...new Set(entries.map(e => e.userName))];
  const userNameMap = await loadUserByDisplayName(pool, userNames);
  console.log(`[bridge-attr] userNameMap size: ${userNameMap.size}, unique users: ${userNames.length}`);

  let written = 0;
  let skipped = 0;

  for (const entry of entries) {
    const mapping = pageMap.get(entry.pageFullname);
    if (!mapping) { skipped++; continue; }

    const userId = userNameMap.get(entry.userName) ?? null;
    const anonKey = userId == null ? entry.userName : null;
    const date = entry.date ? new Date(entry.date) : null;

    try {
      if (userId != null) {
        await pool.query(`
          INSERT INTO "Attribution" ("pageVerId", type, "order", date, "userId")
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT ("pageVerId", type, "order", "userId") DO UPDATE SET
            date = COALESCE(EXCLUDED.date, "Attribution".date)
        `, [mapping.pageVersionId, entry.normalizedType, entry.order, date, userId]);
      } else {
        await pool.query(`
          INSERT INTO "Attribution" ("pageVerId", type, "order", date, "anonKey")
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT ("pageVerId", type, "order", "anonKey") DO UPDATE SET
            date = COALESCE(EXCLUDED.date, "Attribution".date)
        `, [mapping.pageVersionId, entry.normalizedType, entry.order, date, anonKey]);
      }
      written++;
    } catch (err) {
      if (skipped < 3) {
        console.warn(`[bridge-attr] SQL error for ${entry.pageFullname}:`, err instanceof Error ? err.message : err);
      }
      skipped++;
    }
  }

  // 更新受影响的 PageVersion.attributionCount
  const affectedPages = new Map<number, number>();
  for (const entry of entries) {
    const mapping = pageMap.get(entry.pageFullname);
    if (!mapping) continue;
    affectedPages.set(mapping.pageVersionId, (affectedPages.get(mapping.pageVersionId) ?? 0) + 1);
  }

  for (const [pvId, count] of affectedPages) {
    try {
      await pool.query(`
        UPDATE "PageVersion" SET "attributionCount" = $2, "updatedAt" = NOW()
        WHERE id = $1
      `, [pvId, count]);
    } catch { /* non-critical */ }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[bridge-attr] Done in ${elapsed}s: written=${written} skipped=${skipped}`);
  return { written, skipped };
}

async function loadUserByDisplayName(
  pool: pg.Pool,
  names: string[],
): Promise<Map<string, number>> {
  if (names.length === 0) return new Map();

  // 优先选有 wikidotId 的用户（避免匹配到幽灵用户）
  const { rows } = await pool.query<{ display_name: string; id: string }>(`
    SELECT DISTINCT ON ("displayName") "displayName" AS display_name, id::text
    FROM "User"
    WHERE "displayName" = ANY($1::text[])
    ORDER BY "displayName", ("wikidotId" IS NOT NULL) DESC, id ASC
  `, [names]);

  const map = new Map<string, number>();
  for (const r of rows) {
    if (r.display_name) {
      map.set(r.display_name, parseInt(r.id, 10));
    }
  }
  return map;
}

/**
 * 从 fullname 提取 wikidot 页面分类（与 V1 CROM 的 category 字段对齐）
 *
 * wikidot 页面分类由 URL 中 ':' 前的前缀决定：
 *   theme:al-slop → 'theme'
 *   fragment:scp-6821-1 → 'fragment'
 *   wanderers:the-exile → 'wanderers'
 *   scp-cn-001 → '_default'
 *
 * 注意：内容分类（SCP/Tale/GOI 等）由分析管道在 SQL 中从 tags 动态计算，
 *       不存储在 category 字段中。
 */
function wikidotCategory(fullname: string): string {
  const colonIdx = fullname.indexOf(':');
  if (colonIdx > 0) return fullname.substring(0, colonIdx);
  return '_default';
}
