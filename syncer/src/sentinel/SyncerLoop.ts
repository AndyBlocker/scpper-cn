import { scanAllPages, type PageSnapshotMap } from '../scanner/PageScanner.js';
import { scanVoteDetails } from '../scanner/VoteDetailScanner.js';
import { fetchFullPageHtml } from '../scanner/ContentScanner.js';
import { diffPages, summarizeChanges, type PageChange } from './PageDiffEngine.js';
import { diffVotes } from './VoteDiffEngine.js';
import { loadCachedVotesBatch, updateCache, writeChangeEvents } from '../store/VoteSentinelStore.js';
import {
  loadSnapshots,
  bootstrapFromMainDb,
  loadWikidotIdMap,
  saveSnapshots,
} from '../store/PageSnapshotStore.js';
import { saveFullPageHtml } from '../store/ContentStore.js';
import { getSyncerPrisma } from '../store/db.js';

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
        const voteChangedPages = changes.filter(c => c.categories.has('votes_changed'));
        const contentChangedPages = changes.filter(c => c.categories.has('content_changed') || c.categories.has('new_page'));
        const allChangedFullnames = changes.filter(c => c.curr).map(c => c.fullname);

        // ── 4. Vote Tier 2 ──
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

        // ── 5. 全页面 HTML 抓取（预处理后存储）──
        let fullPageSaved = 0;
        if (contentChangedPages.length > 0) {
          const contentFullnames = contentChangedPages.map(c => c.fullname);
          const fullPages = await fetchFullPageHtml(contentFullnames, options.tier2Concurrency);
          fullPageSaved = await saveFullPageHtml(fullPages, wikidotIds);
          console.log(`[syncer] Full pages saved: ${fullPageSaved}`);
        }

        // ── 6. 保存变化页面的 PageSnapshot ──
        const entriesToSave = allChangedFullnames
          .map(fn => currentMap.get(fn))
          .filter((e): e is NonNullable<typeof e> => !!e);
        await saveSnapshots(entriesToSave, wikidotIds);

        // ── 7. 更新 SyncerState ──
        await updateState('syncer-main', {
          pagesScanned: currentMap.size,
          pagesChanged: changes.length,
          eventsWritten: totalVoteEvents + fullPageSaved,
        });
      }

      // ── 8. 更新基准 ──
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
