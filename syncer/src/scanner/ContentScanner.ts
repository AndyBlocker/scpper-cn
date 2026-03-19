import { getSite } from '../client/WikidotDirectClient.js';

const WIKI_BASE = 'https://scp-wiki-cn.wikidot.com';

/**
 * 抓取完整渲染页面 HTML（和浏览器看到的一样）
 * 一次 GET 请求拿到所有 CSS、模块输出、iframe 等
 */
export async function fetchFullPageHtml(
  fullnames: string[],
  concurrency: number = 3
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (fullnames.length === 0) return result;

  console.log(`[fullpage] Fetching ${fullnames.length} full pages (concurrency: ${concurrency})...`);
  const startTime = Date.now();
  let completed = 0;
  let failed = 0;
  let index = 0;

  const workers = Array.from({ length: Math.min(concurrency, fullnames.length) }, async () => {
    while (true) {
      const i = index++;
      if (i >= fullnames.length) return;
      const fullname = fullnames[i];

      try {
        const resp = await fetch(`${WIKI_BASE}/${fullname}`);
        if (!resp.ok) {
          console.warn(`[fullpage] ${fullname}: HTTP ${resp.status}`);
          failed++;
          continue;
        }
        const html = await resp.text();
        if (html.length > 0) {
          result.set(fullname, html);
          completed++;
        } else {
          failed++;
        }
      } catch (err) {
        console.warn(`[fullpage] ${fullname}: ${err}`);
        failed++;
      }

      // 轻微延迟避免突发
      if (i % 5 === 4) {
        await new Promise(r => setTimeout(r, 100));
      }
    }
  });

  await Promise.all(workers);
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[fullpage] Done: ${completed} ok, ${failed} failed in ${elapsed}s`);
  return result;
}

export type ContentResult = {
  fullname: string;
  source: string | null;
  html: string | null;
  sourceLength: number;
  revisions: RevisionInfo[];
  files: FileInfo[];
};

export type RevisionInfo = {
  wikidotRevisionId: number;
  revNo: number;
  createdByName: string | null;
  createdByWikidotId: number | null;
  createdAt: Date | null;
  comment: string;
};

export type FileInfo = {
  fileName: string;
  fileUrl: string;
  mimeType: string;
  fileSize: number;
};

/**
 * 对指定页面获取 source + 最新版本 HTML + revision 列表 + 附件列表
 */
export async function scanPageContent(
  fullnames: string[],
  concurrency: number = 3
): Promise<Map<string, ContentResult>> {
  const site = getSite();
  const result = new Map<string, ContentResult>();

  if (fullnames.length === 0) return result;

  console.log(`[content] Fetching content for ${fullnames.length} pages (concurrency: ${concurrency})...`);
  const startTime = Date.now();

  let completed = 0;
  let failed = 0;
  let index = 0;

  const workers = Array.from({ length: Math.min(concurrency, fullnames.length) }, async () => {
    while (true) {
      const i = index++;
      if (i >= fullnames.length) return;

      const fullname = fullnames[i];
      try {
        const pageRes = await site.page.get(fullname);
        if (!pageRes.isOk() || !pageRes.value) {
          failed++;
          continue;
        }
        const page = pageRes.value;

        // 并行获取 source + revisions + files
        const [srcRes, revRes, fileRes] = await Promise.all([
          page.getSource(),
          page.getRevisions(),
          page.getFiles(),
        ]);

        const source = srcRes.isOk() ? srcRes.value.wikiText : null;
        const sourceLength = source ? source.length : 0;

        // 获取最新修订的 HTML
        let html: string | null = null;
        const revisions: RevisionInfo[] = [];

        if (revRes.isOk()) {
          for (const rev of revRes.value) {
            revisions.push({
              wikidotRevisionId: rev.id,
              revNo: rev.revNo,
              createdByName: rev.createdBy?.name ?? null,
              createdByWikidotId: rev.createdBy?.id ?? null,
              createdAt: rev.createdAt ?? null,
              comment: rev.comment ?? '',
            });
          }

          // 只获取最新版本的 HTML
          if (revRes.value.length > 0) {
            const latest = revRes.value[0]; // revisions[0] = latest
            const htmlRes = await latest.getHtml();
            if (htmlRes.isOk()) {
              html = htmlRes.value;
            }
          }
        }

        const files: FileInfo[] = [];
        if (fileRes.isOk()) {
          for (const f of fileRes.value) {
            files.push({
              fileName: f.name,
              fileUrl: f.url,
              mimeType: f.mimeType ?? '',
              fileSize: f.size ?? 0,
            });
          }
        }

        result.set(fullname, { fullname, source, html, sourceLength, revisions, files });
        completed++;
      } catch (err) {
        console.warn(`[content] Error fetching ${fullname}:`, err);
        failed++;
      }
    }
  });

  await Promise.all(workers);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[content] Done: ${completed} ok, ${failed} failed in ${elapsed}s`);
  return result;
}
