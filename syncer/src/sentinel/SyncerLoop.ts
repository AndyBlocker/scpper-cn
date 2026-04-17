import { scanAllPages, type PageSnapshotMap } from '../scanner/PageScanner.js';
import { scanVoteDetails } from '../scanner/VoteDetailScanner.js';
import { fetchFullPageHtml, scanPageContent } from '../scanner/ContentScanner.js';
import { diffPages, summarizeChanges, type PageChange } from './PageDiffEngine.js';
import { diffVotes } from './VoteDiffEngine.js';
import { loadCachedVotesBatch, updateCache, writeChangeEvents } from '../store/VoteSentinelStore.js';
import {
  loadSnapshots,
  bootstrapFromMainDb,
  loadWikidotIdMap,
  saveSnapshots,
  removeDeletedSnapshots,
} from '../store/PageSnapshotStore.js';
import { saveFullPageHtml, saveContent } from '../store/ContentStore.js';
import { getSyncerPrisma } from '../store/db.js';
import { bridgeToMainDb, bridgeAttributions, bridgeAlternateTitles } from '../bridge/MainDbBridge.js';
import { triggerAnalysis } from '../bridge/AnalysisTrigger.js';
import { extractWikidotIds } from '../utils/html-extract.js';
import { scanAttributions } from '../scanner/AttributionScanner.js';
import { scanAlternateTitles } from '../scanner/AlternateTitleScanner.js';

// (attribution + alt-title sync 现在每个 cycle 都运行，不再依赖页面变更检测)

type SyncerLoopOptions = {
  intervalSeconds: number;
  runImmediately: boolean;
  tier2Concurrency: number;
};

function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export async function runSyncerLoop(options: SyncerLoopOptions): Promise<void> {
  const intervalMs = Math.max(60, Math.floor(options.intervalSeconds)) * 1000;

  let running = false;
  let stopping = false;
  let timer: NodeJS.Timeout | null = null;
  let resolveStop: (() => void) | null = null;

  const stopPromise = new Promise<void>(r => { resolveStop = r; });
  const finish = () => { if (resolveStop) { const r = resolveStop; resolveStop = null; r(); } };

  // 持久状态
  let lastSnapshotMap: PageSnapshotMap | null = null;
  let wikidotIds: Map<string, number> = new Map();

  const scheduleNext = () => {
    if (stopping) return;
    const next = new Date(Date.now() + intervalMs);
    console.log(`[syncer] Next cycle at ${next.toISOString()}`);
    timer = setTimeout(() => void runOneCycle('scheduled'), intervalMs);
  };

  const handleStop = (sig: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    if (timer) { clearTimeout(timer); timer = null; }
    console.log(`[syncer] Received ${sig}, waiting for cycle...`);
    if (!running) finish();
  };

  const runOneCycle = async (reason: 'startup' | 'scheduled') => {
    if (running) { scheduleNext(); return; }
    running = true;
    const t0 = Date.now();
    console.log(`\n[syncer] ══════════════════════════════════════`);
    console.log(`[syncer] Cycle (${reason}) at ${new Date(t0).toISOString()}`);

    try {
      // ── 1. 加载基准 ──
      let isBaselineCycle = false;
      if (!lastSnapshotMap) {
        lastSnapshotMap = await loadSnapshots();
        if (lastSnapshotMap.size === 0) {
          // 首次启动：从主库引导，标记为基线周期
          lastSnapshotMap = await bootstrapFromMainDb();
          isBaselineCycle = true;
        }
        wikidotIds = await loadWikidotIdMap();
      }

      // ── 2. Tier 1 全字段扫描 ──
      const currentMap = await scanAllPages();

      // ── 基线周期：仅保存快照作为基准，不做 Tier 2 ──
      if (isBaselineCycle) {
        console.log(`[syncer] Baseline cycle — saving ${currentMap.size} snapshots, skipping Tier 2`);
        const allEntries = [...currentMap.values()];
        await saveSnapshots(allEntries, wikidotIds);
        await updateState('syncer-main', { pagesScanned: currentMap.size, pagesChanged: 0, eventsWritten: 0 });
        lastSnapshotMap = currentMap;
        return; // finally 块会处理 scheduleNext
      }

      // ── 3. Diff ──
      const changes = diffPages(lastSnapshotMap, currentMap);
      const summary = summarizeChanges(changes);
      console.log(`[syncer] Changes: ${changes.length} total —`, JSON.stringify(summary));

      if (changes.length > 0) {
        // 新页面也需要投票扫描（可能已有投票但 syncer 从未见过）
        const voteChangedPages = changes.filter(c => c.categories.has('votes_changed') || c.categories.has('new_page'));
        const contentChangedPages = changes.filter(c => c.categories.has('content_changed') || c.categories.has('new_page'));
        const allChangedFullnames = changes.filter(c => c.curr).map(c => c.fullname);

        // ── 4. Vote Tier 2 ──
        // 内部 scanVoteDetails 有断路器：连续 5 次失败自动中止。
        let totalVoteEvents = 0;
        if (voteChangedPages.length > 0) {
          const voteFullnames = voteChangedPages.map(c => c.fullname);
          const voteDetails = await scanVoteDetails(voteFullnames, options.tier2Concurrency);
          const cachedVotes = await loadCachedVotesBatch(voteFullnames);

          for (const fullname of voteFullnames) {
            const cached = cachedVotes.get(fullname) || [];
            const current = voteDetails.get(fullname) || [];
            const events = diffVotes(fullname, cached, current);
            if (events.length > 0) {
              totalVoteEvents += await writeChangeEvents(events);
            }
            if (current.length > 0) {
              await updateCache(fullname, current);
            }
          }
          console.log(`[syncer] Vote events written: ${totalVoteEvents}`);
        }

        // ── 5. 内容扫描（source + revisions + files）──
        let contentScanResult = { contentSaved: 0, revisionsSaved: 0, filesSaved: 0 };
        if (contentChangedPages.length > 0) {
          const contentFullnames = contentChangedPages.map(c => c.fullname);
          try {
            const contentResults = await scanPageContent(contentFullnames, options.tier2Concurrency);
            contentScanResult = await saveContent(contentResults, wikidotIds, 'content_changed');
            console.log(`[syncer] Content scan: ${contentScanResult.contentSaved} pages, ${contentScanResult.revisionsSaved} revisions, ${contentScanResult.filesSaved} files`);
          } catch (err) {
            console.warn(`[syncer] Content scan failed (non-fatal):`, err instanceof Error ? err.message : err);
          }
        }

        // ── 6. 全页面 HTML 抓取 + wikidotId 提取 ──
        // 新页面也需要抓取 HTML（即使没有 content_changed），用于提取 wikidotId
        const newPageFullnames = changes
          .filter(c => c.categories.has('new_page') && c.curr)
          .map(c => c.fullname);
        const htmlTargetFullnames = [
          ...new Set([
            ...contentChangedPages.map(c => c.fullname),
            ...newPageFullnames,
          ])
        ];

        let fullPageSaved = 0;
        if (htmlTargetFullnames.length > 0) {
          const contentFullnames = htmlTargetFullnames;
          const fullPages = await fetchFullPageHtml(contentFullnames, options.tier2Concurrency);

          // 从原始 HTML 中提取 wikidotId（在预处理之前）
          const extractedIds = extractWikidotIds(fullPages);
          let newIdCount = 0;
          for (const [fn, wid] of extractedIds) {
            if (!wikidotIds.has(fn)) {
              wikidotIds.set(fn, wid);
              newIdCount++;
              // 同步更新 syncer DB 的 PageSnapshot.wikidotId
              try {
                await getSyncerPrisma().pageSnapshot.update({
                  where: { fullname: fn },
                  data: { wikidotId: wid },
                });
              } catch { /* 可能尚未写入 snapshot */ }
            }
          }
          if (newIdCount > 0) {
            console.log(`[syncer] Extracted ${newIdCount} new wikidotIds from HTML`);
          }

          fullPageSaved = await saveFullPageHtml(fullPages, wikidotIds);
          console.log(`[syncer] Full pages saved: ${fullPageSaved}`);
        }

        // ── 7. Bridge → 主数据库 ──
        try {
          const bridgeResult = await bridgeToMainDb(changes, currentMap, wikidotIds);
          console.log(`[syncer] Bridge: pv=${bridgeResult.pagesUpdated} newVer=${bridgeResult.newVersionsCreated} newPage=${bridgeResult.newPagesCreated} deleted=${bridgeResult.deletedPages} users=${bridgeResult.usersEnsured} votes=${bridgeResult.votesWritten} revisions=${bridgeResult.revisionsWritten}`);
        } catch (err) {
          console.error(`[syncer] Bridge failed (non-fatal):`, err instanceof Error ? err.message : err);
        }

        // ── 8. 保存 PageSnapshot + 清理删除快照 ──
        const entriesToSave = allChangedFullnames
          .map(fn => currentMap.get(fn))
          .filter((e): e is NonNullable<typeof e> => !!e);
        await saveSnapshots(entriesToSave, wikidotIds);

        // 清理已删除页面的快照（避免重启后幻象 deleted_page）
        const deletedFns = changes
          .filter(c => c.categories.has('deleted_page'))
          .map(c => c.fullname);
        if (deletedFns.length > 0) {
          const removed = await removeDeletedSnapshots(deletedFns);
          if (removed > 0) console.log(`[syncer] Removed ${removed} deleted snapshots`);
        }

        // ── 9. 每个 cycle 执行 attribution + alternateTitle sync ──
        // CROM 的 attribution 也来自 first revision + attribution-metadata，
        // 所以每个 cycle 都需要同步以保持一致。
        try {
          console.log(`[syncer] Running attribution sync...`);
          const attrEntries = await scanAttributions();
          const attrResult = await bridgeAttributions(attrEntries);
          console.log(`[syncer] Attribution sync: written=${attrResult.written} skipped=${attrResult.skipped}`);
        } catch (err) {
          console.error(`[syncer] Attribution sync failed (non-fatal):`, err instanceof Error ? err.message : err);
        }

        try {
          console.log(`[syncer] Running alternate title sync...`);
          const altEntries = await scanAlternateTitles();
          const altResult = await bridgeAlternateTitles(altEntries);
          console.log(`[syncer] Alt title sync: updated=${altResult.updated} skipped=${altResult.skipped}`);
        } catch (err) {
          console.error(`[syncer] Alt title sync failed (non-fatal):`, err instanceof Error ? err.message : err);
        }

        // ── 10. 触发分析管道 ──
        try {
          await triggerAnalysis();
        } catch (err) {
          console.error(`[syncer] Analysis trigger failed (non-fatal):`, err instanceof Error ? err.message : err);
        }

        // ── 11. 更新 SyncerState ──
        await updateState('syncer-main', {
          pagesScanned: currentMap.size,
          pagesChanged: changes.length,
          eventsWritten: totalVoteEvents + fullPageSaved + contentScanResult.revisionsSaved,
        });
      }

      // ── 12. 更新内存基准 ──
      lastSnapshotMap = currentMap;

    } catch (err) {
      const msg = err instanceof Error ? err.stack || err.message : String(err);
      console.error(`[syncer] Cycle failed: ${msg}`);
      await updateState('syncer-main', { errorMessage: msg });
    } finally {
      console.log(`[syncer] Cycle finished in ${formatDuration(Date.now() - t0)}`);
      console.log(`[syncer] ══════════════════════════════════════\n`);
      running = false;
      if (stopping) finish(); else scheduleNext();
    }
  };

  process.on('SIGINT', handleStop);
  process.on('SIGTERM', handleStop);

  console.log(`[syncer] Loop started. interval=${Math.round(intervalMs / 1000)}s`);
  if (options.runImmediately) {
    void runOneCycle('startup');
  } else {
    scheduleNext();
  }

  await stopPromise;
}

async function updateState(
  task: string,
  data: { pagesScanned?: number; pagesChanged?: number; eventsWritten?: number; errorMessage?: string }
): Promise<void> {
  const prisma = getSyncerPrisma();
  const now = new Date();
  try {
    await prisma.syncerState.upsert({
      where: { task },
      create: {
        task,
        lastRunAt: now,
        lastSuccessAt: data.errorMessage ? undefined : now,
        pagesScanned: data.pagesScanned ?? 0,
        pagesChanged: data.pagesChanged ?? 0,
        eventsWritten: data.eventsWritten ?? 0,
        errorMessage: data.errorMessage ?? null,
      },
      update: {
        lastRunAt: now,
        ...(data.errorMessage ? {} : { lastSuccessAt: now }),
        pagesScanned: data.pagesScanned,
        pagesChanged: data.pagesChanged,
        eventsWritten: data.eventsWritten,
        errorMessage: data.errorMessage ?? null,
      },
    });
  } catch {
    // non-critical
  }
}
