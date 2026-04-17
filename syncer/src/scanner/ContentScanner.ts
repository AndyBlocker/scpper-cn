import { getSite } from '../client/WikidotDirectClient.js';
import { isSuccessResponse } from '@ukwhatn/wikidot';

const WIKI_BASE = 'https://scp-wiki-cn.wikidot.com';

// flags title → V1 兼容的 revision type 映射
const FLAG_TYPE_MAP: Record<string, string> = {
  'source code edited': 'SOURCE_CHANGED',
  'page content was changed': 'SOURCE_CHANGED',
  'tags changed': 'TAGS_CHANGED',
  'title changed': 'TITLE_CHANGED',
  'page title changed': 'TITLE_CHANGED',
  'new page': 'PAGE_CREATED',
  'page created': 'PAGE_CREATED',
  'files changed': 'FILES_CHANGED',
  'file added': 'FILES_CHANGED',
  'file deleted': 'FILES_CHANGED',
  'file renamed': 'FILES_CHANGED',
  'page renamed': 'TITLE_CHANGED',
  'meta data changed': 'SOURCE_CHANGED',
  'page moved': 'TITLE_CHANGED',
};

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
  type: string;  // SOURCE_CHANGED, TAGS_CHANGED, TITLE_CHANGED, PAGE_CREATED, FILES_CHANGED, unknown
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

        // 获取 source
        const srcRes = await page.getSource();
        const source = srcRes.isOk() ? srcRes.value.wikiText : null;
        const sourceLength = source ? source.length : 0;

        // 获取 files
        const fileRes = await page.getFiles();
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

        // 获取 revisions（直接请求 AJAX，提取完整 flags）
        let html: string | null = null;
        const revisions: RevisionInfo[] = [];

        // page.id 可能从库的 page.get() 中获取到（如果库内部做了 ID 获取）
        // 如果没有，尝试从 getRevisions 触发（库内部会获取 ID）
        const revRes = await page.getRevisions();
        if (revRes.isOk() && page.id != null) {
          // 有 pageId → 用我们自己的解析获取带 flags 的修订
          const rawRevisions = await fetchRevisionsWithFlags(page.id);
          if (rawRevisions.length > 0) {
            revisions.push(...rawRevisions);
          } else {
            // fallback: 用库的数据（不含 flags）
            for (const rev of revRes.value) {
              revisions.push({
                wikidotRevisionId: rev.id,
                revNo: rev.revNo,
                createdByName: rev.createdBy?.name ?? null,
                createdByWikidotId: rev.createdBy?.id ?? null,
                createdAt: rev.createdAt ?? null,
                comment: rev.comment ?? '',
                type: rev.revNo === 0 ? 'PAGE_CREATED' : 'SOURCE_CHANGED',
              });
            }
          }

          // 获取最新版本 HTML
          if (revRes.value.length > 0) {
            const htmlRes = await revRes.value[0].getHtml();
            if (htmlRes.isOk()) html = htmlRes.value;
          }
        } else if (revRes.isOk()) {
          // 无 pageId，只能用库的数据
          for (const rev of revRes.value) {
            revisions.push({
              wikidotRevisionId: rev.id,
              revNo: rev.revNo,
              createdByName: rev.createdBy?.name ?? null,
              createdByWikidotId: rev.createdBy?.id ?? null,
              createdAt: rev.createdAt ?? null,
              comment: rev.comment ?? '',
              type: rev.revNo === 0 ? 'PAGE_CREATED' : 'SOURCE_CHANGED',
            });
          }
          if (revRes.value.length > 0) {
            const htmlRes = await revRes.value[0].getHtml();
            if (htmlRes.isOk()) html = htmlRes.value;
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

/**
 * 直接请求 PageRevisionListModule AJAX 接口，从 HTML 中解析包含 flags 的完整修订数据
 *
 * Wikidot 修订表格结构（7 列）:
 *   td[0]: revNo        例 "5."
 *   td[1]: flags        例 <span class="spantip" title="source code edited">S</span>
 *   td[2]: actions      例 checkbox + links
 *   td[3]: ???          空或额外信息
 *   td[4]: createdBy    例 <span class="printuser">username</span>
 *   td[5]: createdAt    例 <span class="odate">...</span>
 *   td[6]: comment      纯文本
 */
async function fetchRevisionsWithFlags(pageId: number): Promise<RevisionInfo[]> {
  const site = getSite();
  const revisions: RevisionInfo[] = [];

  try {
    const res = await site.amcRequestSingle({
      moduleName: 'history/PageRevisionListModule',
      page_id: String(pageId),
      perpage: '99999999',
      options: JSON.stringify({ all: true }),
    });

    if (!res.isOk()) return revisions;
    const response = res.value;
    if (!isSuccessResponse(response)) return revisions;

    const body = String(response.body ?? '');

    // 解析 revision rows
    const rowPattern = /<tr\s+id="revision-row-(\d+)">([\s\S]*?)<\/tr>/g;
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowPattern.exec(body)) !== null) {
      const revId = parseInt(rowMatch[1], 10);
      if (isNaN(revId)) continue;

      const rowHtml = rowMatch[2];
      const tds = [...rowHtml.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
      if (tds.length < 7) continue;

      // td[0]: revNo
      const revNoMatch = tds[0].match(/(\d+)/);
      const revNo = revNoMatch ? parseInt(revNoMatch[1], 10) : 0;

      // td[1]: flags — 从 <span class="spantip" title="..."> 提取
      const flagMatches = [...tds[1].matchAll(/class="spantip"[^>]*title="([^"]+)"/g)];
      const flags = flagMatches.map(m => m[1].toLowerCase().trim());
      const type = resolveRevisionType(revNo, flags);

      // td[4]: createdBy
      const userIdMatch = tds[4].match(/userInfo\((\d+)\)/);
      const userNameMatch = tds[4].match(/<a[^>]*>([^<]+)<\/a>/);
      const createdByWikidotId = userIdMatch ? parseInt(userIdMatch[1], 10) : null;
      const createdByName = userNameMatch ? userNameMatch[1].trim() : null;

      // td[5]: createdAt — 从 odate 的 unix timestamp 提取
      const odateMatch = tds[5].match(/class="odate[^"]*"[^>]*>(\d+)<\/span>|odate[^>]*>.*?(\d{10,})/);
      // 备选：从 time_* class 提取
      const timeClassMatch = tds[5].match(/class="time_(\d+)"/);
      let createdAt: Date | null = null;
      if (timeClassMatch) {
        createdAt = new Date(parseInt(timeClassMatch[1], 10) * 1000);
      } else if (odateMatch) {
        const ts = parseInt(odateMatch[1] || odateMatch[2], 10);
        if (ts > 1000000000) createdAt = new Date(ts * 1000);
      }

      // td[6]: comment
      const comment = tds[6].replace(/<[^>]+>/g, '').trim();

      revisions.push({
        wikidotRevisionId: revId,
        revNo,
        createdByName,
        createdByWikidotId,
        createdAt,
        comment,
        type,
      });
    }
  } catch (err) {
    console.warn(`[content] fetchRevisionsWithFlags(${pageId}) failed:`, err instanceof Error ? err.message : err);
  }

  return revisions;
}

/**
 * 从 Wikidot flags 解析为 V1 兼容的 revision type
 */
function resolveRevisionType(revNo: number, flags: string[]): string {
  if (revNo === 0) return 'PAGE_CREATED';

  for (const flag of flags) {
    const mapped = FLAG_TYPE_MAP[flag];
    if (mapped) return mapped;
  }

  // 无 flags 或未知 flags → 检查是否有多个 flag
  if (flags.length > 0) {
    // 尝试部分匹配
    for (const flag of flags) {
      if (flag.includes('source')) return 'SOURCE_CHANGED';
      if (flag.includes('tag')) return 'TAGS_CHANGED';
      if (flag.includes('title') || flag.includes('rename')) return 'TITLE_CHANGED';
      if (flag.includes('file')) return 'FILES_CHANGED';
      if (flag.includes('new') || flag.includes('creat')) return 'PAGE_CREATED';
    }
  }

  return 'SOURCE_CHANGED'; // 默认
}
