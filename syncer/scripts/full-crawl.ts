import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

import { applyHttpsFix } from '../src/utils/https-fix.js';
import { setupProxy } from '../src/utils/proxy.js';
import { bindGracefulShutdown, getMainPool, getSyncerPrisma } from '../src/store/db.js';
import { saveFullPageHtml } from '../src/store/ContentStore.js';
import { loadWikidotIdMap } from '../src/store/PageSnapshotStore.js';
import { fetchFullPageHtml } from '../src/scanner/ContentScanner.js';

applyHttpsFix();
setupProxy();
bindGracefulShutdown();

const BATCH_SIZE = 50;
const CONCURRENCY = 5;

async function main() {
  const wikidotIds = await loadWikidotIdMap();

  // 获取所有活跃页面的 fullname
  const pool = getMainPool();
  const { rows } = await pool.query<{ fullname: string }>(`
    SELECT SUBSTRING(p."currentUrl" FROM '//[^/]+/(.+)$') AS fullname
    FROM "Page" p
    WHERE p."isDeleted" = false
    ORDER BY p."wikidotId"
  `);

  const allFullnames = rows.map(r => r.fullname).filter(Boolean);

  // 跳过已缓存的页面
  const prisma = getSyncerPrisma();
  const cached: any[] = await prisma.pageContentCache.findMany({
    where: { fullPageHtml: { not: null } },
    select: { fullname: true },
  });
  const cachedSet = new Set(cached.map((r: any) => r.fullname));
  const todo = allFullnames.filter(fn => !cachedSet.has(fn));

  console.log(`[full-crawl] Total: ${allFullnames.length} | Already cached: ${cachedSet.size} | Todo: ${todo.length}`);

  let totalSaved = 0;
  let totalFailed = 0;
  const startTime = Date.now();

  for (let i = 0; i < todo.length; i += BATCH_SIZE) {
    const batch = todo.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(todo.length / BATCH_SIZE);

    try {
      const results = await fetchFullPageHtml(batch, CONCURRENCY);
      const saved = await saveFullPageHtml(results, wikidotIds);
      totalSaved += saved;
      totalFailed += batch.length - saved;

      const elapsed = (Date.now() - startTime) / 1000;
      const rate = totalSaved / (elapsed || 1);
      const remaining = (todo.length - i - batch.length) / rate;
      console.log(`[full-crawl] ${batchNum}/${totalBatches} | +${saved} | total: ${totalSaved}/${todo.length} | ${Math.round(elapsed)}s | ETA: ${Math.round(remaining / 60)}min`);
    } catch (err) {
      console.error(`[full-crawl] Batch ${batchNum} error:`, err);
      totalFailed += batch.length;
    }
  }

  const totalElapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
  console.log(`\n[full-crawl] Done: ${totalSaved} saved, ${totalFailed} failed in ${totalElapsed} min`);
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
