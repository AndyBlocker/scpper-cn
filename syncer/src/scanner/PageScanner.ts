import { getSite } from '../client/WikidotDirectClient.js';
import { isSuccessResponse } from '@ukwhatn/wikidot';

export type PageSnapshotEntry = {
  fullname: string;
  title: string;
  rating: number;
  votesCount: number;
  commentsCount: number;
  size: number;
  revisionsCount: number;
  parentFullname: string | null;
  createdAtTs: number | null;   // unix timestamp
  updatedAtTs: number | null;   // unix timestamp
  tags: string[];
  createdBy: string | null;
};

export type PageSnapshotMap = Map<string, PageSnapshotEntry>;

const SEPARATOR = '|||';

const MODULE_BODY = [
  '%%%%fullname%%%%',
  '%%%%title%%%%',
  '%%%%rating%%%%',
  '%%%%rating_votes%%%%',
  '%%%%comments%%%%',
  '%%%%size%%%%',
  '%%%%revisions%%%%',
  '%%%%parent_fullname%%%%',
  '%%%%created_at%%%%',
  '%%%%updated_at%%%%',
  '%%%%tags%%%%',
  '%%%%created_by%%%%',
].join(SEPARATOR);

/**
 * Tier 1 全字段扫描：ListPagesModule 批量获取全站页面元数据
 */
export async function scanAllPages(): Promise<PageSnapshotMap> {
  const site = getSite();
  const result: PageSnapshotMap = new Map();
  let pageNum = 1;
  let totalBatches: number | null = null;

  console.log('[tier1] Starting full page scan...');
  const startTime = Date.now();

  const MAX_RETRIES = 3;

  while (true) {
    if (totalBatches !== null && pageNum > totalBatches) break;

    let response: any = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const res = await site.amcRequestSingle({
        moduleName: 'list/ListPagesModule',
        category: '*',
        perPage: '250',
        order: 'created_at desc',
        p: String(pageNum),
        module_body: MODULE_BODY,
      });

      if (res.isOk() && isSuccessResponse(res.value)) {
        response = res.value;
        break;
      }

      const errMsg = res.isOk() ? `status ${res.value.status}` : String(res.error);
      if (attempt < MAX_RETRIES) {
        console.warn(`[tier1] Batch ${pageNum} attempt ${attempt}/${MAX_RETRIES} failed: ${errMsg}, retrying...`);
        await new Promise(r => setTimeout(r, 2000 * attempt));
      } else {
        // 重试耗尽：抛出错误让调用方决定处理策略
        throw new Error(`[tier1] Batch ${pageNum} failed after ${MAX_RETRIES} attempts: ${errMsg}`);
      }
    }

    if (!response) break; // 不应到达

    if (totalBatches === null) {
      totalBatches = parseTotalPages(response.body);
      if (totalBatches !== null) {
        console.log(`[tier1] Total batches: ${totalBatches}`);
      } else {
        totalBatches = 200;
        console.log(`[tier1] Pager not found, fallback: ${totalBatches}`);
      }
    }

    const entries = parsePageEntries(response.body);
    for (const entry of entries) {
      result.set(entry.fullname, entry);
    }

    if (pageNum % 20 === 0 || pageNum === 1) {
      const pct = totalBatches ? ((pageNum / totalBatches) * 100).toFixed(1) : '?';
      console.log(`[tier1] Batch ${pageNum}/${totalBatches ?? '?'} (${pct}%), pages: ${result.size}`);
    }

    pageNum++;
    const delay = 200 + Math.floor(Math.random() * 300);
    await new Promise(r => setTimeout(r, delay));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[tier1] Complete: ${result.size} pages in ${elapsed}s (${pageNum - 1} batches)`);
  return result;
}

function parseTotalPages(html: string): number | null {
  const match = html.match(/page\s+\d+\s+of\s+(\d+)/i);
  if (match) {
    const total = parseInt(match[1], 10);
    if (Number.isFinite(total) && total > 0) return total;
  }
  return null;
}

function stripPercent(s: string): string {
  if (s.startsWith('%%') && s.endsWith('%%') && s.length >= 4) {
    return s.slice(2, -2);
  }
  return s;
}

function parseDateValue(raw: string): number | null {
  // 支持两种格式：
  //   %%date|UNIX_TIMESTAMP%%  (原始未 stripPercent)
  //   date|UNIX_TIMESTAMP      (stripPercent 后)
  const match = raw.match(/(?:%%)?date\|(\d+)(?:%%)?/);
  if (match) return parseInt(match[1], 10);
  // raw number fallback
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n > 1000000000) return n;
  return null;
}

function parsePageEntries(html: string): PageSnapshotEntry[] {
  const entries: PageSnapshotEntry[] = [];

  // 提取每个 list-pages-item 中的 <p> 内容
  const itemPattern = /<div class="list-pages-item">\s*<p>(.*?)<\/p>\s*<\/div>/gs;
  let itemMatch: RegExpExecArray | null;

  while ((itemMatch = itemPattern.exec(html)) !== null) {
    const line = itemMatch[1].trim();
    const parts = line.split(SEPARATOR);
    if (parts.length !== 12) continue;

    const fullname = stripPercent(parts[0].trim());
    const title = stripPercent(parts[1].trim());
    const rating = parseInt(stripPercent(parts[2].trim()), 10);
    const votesCount = parseInt(stripPercent(parts[3].trim()), 10);
    const commentsCount = parseInt(stripPercent(parts[4].trim()), 10);
    const size = parseInt(stripPercent(parts[5].trim()), 10);
    const revisionsCount = parseInt(stripPercent(parts[6].trim()), 10);
    const parentRaw = stripPercent(parts[7].trim());
    const parentFullname = parentRaw || null;
    const createdAtTs = parseDateValue(stripPercent(parts[8].trim()));
    const updatedAtTs = parseDateValue(stripPercent(parts[9].trim()));
    const tagsRaw = stripPercent(parts[10].trim());
    const tags = tagsRaw ? tagsRaw.split(/\s+/).filter(Boolean) : [];
    const createdByRaw = stripPercent(parts[11].trim());
    const createdBy = createdByRaw || null;

    if (!fullname || isNaN(rating)) continue;

    entries.push({
      fullname,
      title,
      rating,
      votesCount: isNaN(votesCount) ? 0 : votesCount,
      commentsCount: isNaN(commentsCount) ? 0 : commentsCount,
      size: isNaN(size) ? 0 : size,
      revisionsCount: isNaN(revisionsCount) ? 0 : revisionsCount,
      parentFullname,
      createdAtTs,
      updatedAtTs,
      tags,
      createdBy,
    });
  }

  return entries;
}
