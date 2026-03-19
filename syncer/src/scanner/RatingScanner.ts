import { getSite } from '../client/WikidotDirectClient.js';
import { isSuccessResponse } from '@ukwhatn/wikidot';

export type RatingEntry = {
  rating: number;
  votesCount: number;
};

export type RatingMap = Map<string, RatingEntry>;

/**
 * Tier 1 扫描：使用 ListPagesModule 批量获取所有页面的 rating + votesCount
 * 每请求 250 页，约 1.5s/请求，~34000 页 ≈ 136 批 ≈ 3-4 分钟
 */
export async function scanAllRatings(): Promise<RatingMap> {
  const site = getSite();
  const result: RatingMap = new Map();
  let pageNum = 1;
  let totalBatches: number | null = null;

  console.log('[tier1] Starting rating scan...');
  const startTime = Date.now();

  while (true) {
    // 如果已知总页数且超出范围，停止
    if (totalBatches !== null && pageNum > totalBatches) break;

    const res = await site.amcRequestSingle({
      moduleName: 'list/ListPagesModule',
      category: '*',
      perPage: '250',
      order: 'created_at desc',
      p: String(pageNum),
      module_body: '%%%%fullname%%%%|%%%%rating%%%%|%%%%rating_votes%%%%',
    });

    if (!res.isOk()) {
      console.warn(`[tier1] Page ${pageNum} request failed:`, res.error);
      break;
    }

    const response = res.value;
    if (!isSuccessResponse(response)) {
      console.warn(`[tier1] Page ${pageNum} non-ok response:`, response.status);
      break;
    }

    // 从第一批响应中解析总页数
    if (totalBatches === null) {
      totalBatches = parseTotalPages(response.body);
      if (totalBatches !== null) {
        console.log(`[tier1] Total batches detected from pager: ${totalBatches}`);
      } else {
        // 兜底：假设最多 200 批 (50000 页)
        totalBatches = 200;
        console.log(`[tier1] Could not parse pager, using fallback: ${totalBatches} batches`);
      }
    }

    const entries = parseListPagesResponse(response.body);
    for (const entry of entries) {
      result.set(entry.fullname, { rating: entry.rating, votesCount: entry.votesCount });
    }

    if (pageNum % 20 === 0 || pageNum === 1) {
      const pct = totalBatches ? ((pageNum / totalBatches) * 100).toFixed(1) : '?';
      console.log(`[tier1] Batch ${pageNum}/${totalBatches ?? '?'} (${pct}%), pages so far: ${result.size}`);
    }

    pageNum++;

    // 随机延迟 200-500ms
    const delay = 200 + Math.floor(Math.random() * 300);
    await new Promise(r => setTimeout(r, delay));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[tier1] Scan complete: ${result.size} pages in ${elapsed}s (${pageNum - 1} batches)`);

  return result;
}

/**
 * 从分页器 HTML 解析总页数
 * 格式: <span class="pager-no">page 1 of 6793</span>
 */
function parseTotalPages(html: string): number | null {
  const match = html.match(/page\s+\d+\s+of\s+(\d+)/i);
  if (match) {
    const total = parseInt(match[1], 10);
    if (Number.isFinite(total) && total > 0) return total;
  }
  return null;
}

type ParsedEntry = {
  fullname: string;
  rating: number;
  votesCount: number;
};

function parseListPagesResponse(html: string): ParsedEntry[] {
  const entries: ParsedEntry[] = [];

  // 实际格式: <p>%%fullname%%|%%rating%%|%%votesCount%%</p>
  const pattern = /%%([^%]+)%%\|%%([^%]+)%%\|%%([^%]+)%%/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(html)) !== null) {
    const fullname = match[1].trim();
    const rating = parseInt(match[2].trim(), 10);
    const votesCount = parseInt(match[3].trim(), 10);

    if (!fullname || isNaN(rating) || isNaN(votesCount)) continue;

    entries.push({ fullname, rating, votesCount });
  }

  return entries;
}
