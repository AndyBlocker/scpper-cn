import { getSyncerPrisma } from './db.js';
import type { ContentResult } from '../scanner/ContentScanner.js';
import { preprocessFullPageHtml } from './HtmlPreprocessor.js';
import http from 'http';

/**
 * 保存页面内容到 PageContentCache + RevisionRecord + FileRecord
 */
export async function saveContent(
  results: Map<string, ContentResult>,
  wikidotIds: Map<string, number>,
  fetchReason: string
): Promise<{ contentSaved: number; revisionsSaved: number; filesSaved: number }> {
  const prisma = getSyncerPrisma();
  let contentSaved = 0;
  let revisionsSaved = 0;
  let filesSaved = 0;

  // Per-page concurrency cap for the revision/file upsert fan-out.
  // Prisma's default connection_limit is num_cpus*2+1 on the syncer host.
  // Keep the batch size well under that so we don't thrash the pool while
  // still trading serial round-trips for parallel ones.
  const PER_PAGE_CONCURRENCY = 8;

  async function runChunked<T>(tasks: Array<() => Promise<T>>, chunkSize: number) {
    for (let i = 0; i < tasks.length; i += chunkSize) {
      await Promise.all(tasks.slice(i, i + chunkSize).map((fn) => fn()));
    }
  }

  for (const [fullname, content] of results) {
    const wikidotId = wikidotIds.get(fullname) ?? null;

    // 1. Upsert PageContentCache (must complete before dependants).
    await prisma.pageContentCache.upsert({
      where: { fullname },
      create: {
        fullname,
        wikidotId,
        source: content.source,
        html: content.html,
        sourceLength: content.sourceLength,
        fetchReason,
      },
      update: {
        wikidotId,
        source: content.source,
        html: content.html,
        sourceLength: content.sourceLength,
        fetchedAt: new Date(),
        fetchReason,
      },
    });
    contentSaved++;

    // 2+3. Revisions and files for this page are independent of each other
    // and of other rows, so fan them out concurrently. The try/catch keeps
    // the old "skip duplicates / FK errors" behaviour.
    const revTasks = content.revisions.map((rev) => async () => {
      try {
        await prisma.revisionRecord.upsert({
          where: { fullname_revNo: { fullname, revNo: rev.revNo } },
          create: {
            fullname,
            wikidotRevisionId: rev.wikidotRevisionId,
            revNo: rev.revNo,
            createdByName: rev.createdByName,
            createdByWikidotId: rev.createdByWikidotId,
            createdAt: rev.createdAt,
            comment: rev.comment,
          },
          update: {
            wikidotRevisionId: rev.wikidotRevisionId,
            createdByName: rev.createdByName,
            createdByWikidotId: rev.createdByWikidotId,
            createdAt: rev.createdAt,
            comment: rev.comment,
          },
        });
        revisionsSaved++;
      } catch {
        // skip duplicates / FK errors
      }
    });

    const fileTasks = content.files.map((file) => async () => {
      try {
        await prisma.fileRecord.upsert({
          where: { fullname_fileName: { fullname, fileName: file.fileName } },
          create: {
            fullname,
            fileName: file.fileName,
            fileUrl: file.fileUrl,
            mimeType: file.mimeType,
            fileSize: file.fileSize,
          },
          update: {
            fileUrl: file.fileUrl,
            mimeType: file.mimeType,
            fileSize: file.fileSize,
            detectedAt: new Date(),
          },
        });
        filesSaved++;
      } catch {
        // skip duplicates / FK errors
      }
    });

    await runChunked([...revTasks, ...fileTasks], PER_PAGE_CONCURRENCY);
  }

  return { contentSaved, revisionsSaved, filesSaved };
}

/**
 * 保存完整页面 HTML 到 PageContentCache.fullPageHtml
 */
export async function saveFullPageHtml(
  pages: Map<string, string>,
  wikidotIds: Map<string, number>
): Promise<number> {
  const prisma = getSyncerPrisma();
  let saved = 0;

  for (const [fullname, rawHtml] of pages) {
    const wikidotId = wikidotIds.get(fullname) ?? null;
    // 预处理：资源代理、站内链接重写、JS 清理
    const processed = preprocessFullPageHtml(rawHtml, wikidotIds);
    await prisma.pageContentCache.upsert({
      where: { fullname },
      create: {
        fullname,
        wikidotId,
        fullPageHtml: processed,
        fetchReason: 'full_page',
      },
      update: {
        wikidotId,
        fullPageHtml: processed,
        fetchedAt: new Date(),
      },
    });
    saved++;
  }

  // 预热 css-proxy 缓存：提取预处理后 HTML 中的资源 URL 并预先请求
  const allProcessed = [...pages.keys()].map(fn => {
    const wid = wikidotIds.get(fn);
    return wid ? preprocessFullPageHtml(pages.get(fn)!, wikidotIds) : '';
  }).join('');
  await warmCssProxyCache(allProcessed);

  return saved;
}

/**
 * 预热 css-proxy 缓存：从 HTML 中提取所有 /api/css-proxy?url=... 的资源 URL
 * 并预先请求，让 css-proxy 把它们缓存起来
 */
async function warmCssProxyCache(html: string): Promise<void> {
  const bffBase = process.env.BFF_BASE_URL || 'http://127.0.0.1:4396';
  const pattern = /\/api\/css-proxy\?url=([^"'\s&]+)/g;
  const urls = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(html)) !== null) {
    urls.add(m[0]);
  }

  if (urls.size === 0) return;
  console.log(`[cache-warm] Warming ${urls.size} css-proxy resources...`);

  let ok = 0;
  let fail = 0;
  const queue = [...urls];
  const CONCURRENCY = 5;
  let idx = 0;

  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    while (true) {
      const i = idx++;
      if (i >= queue.length) return;
      try {
        // 用原生 http 绕过 undici 全局代理
        await new Promise<void>((resolve) => {
          const url = `${bffBase}${queue[i]}`;
          http.get(url, { headers: { 'Sec-Fetch-Dest': 'style' } }, (res) => {
            res.resume(); // drain
            res.on('end', () => { if (res.statusCode === 200) ok++; else fail++; resolve(); });
          }).on('error', () => { fail++; resolve(); });
        });
      } catch {
        fail++;
      }
    }
  });
  await Promise.all(workers);
  console.log(`[cache-warm] Done: ${ok} ok, ${fail} failed`);
}
