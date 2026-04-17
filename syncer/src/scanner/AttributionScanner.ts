/**
 * AttributionScanner — 从归属资料 wiki 页面解析作者/翻译归属数据
 *
 * 数据源：
 *   - attribution-metadata（原创归属：作者/重写/维护者/创建者）
 *   - attribution-metadata-translation（翻译归属：翻译/维护者）
 *
 * Wiki 表格格式：||title||user||type||date||
 */

import { getSite } from '../client/WikidotDirectClient.js';
import { getSyncerPrisma } from '../store/db.js';

export type AttributionEntry = {
  pageFullname: string;   // wiki 页面 fullname（如 scp-cn-001）
  userName: string;       // 用户名
  type: string;           // 原始类型（作者/重写/维护者/创建者/翻译）
  normalizedType: string; // 归一化类型（author/rewriter/maintainer/creator/translator）
  date: string | null;    // YYYY-MM-DD 或 null
  isForumOrigin: boolean; // 日期带 * 前缀表示源自论坛
  order: number;          // 同页面同类型中的排序
};

const ATTRIBUTION_PAGES = [
  'attribution-metadata',
  'attribution-metadata-translation',
];

// 大写格式，与 V1 (Crom GraphQL) 的 Attribution.type 一致
const TYPE_MAP: Record<string, string> = {
  '作者': 'AUTHOR',
  '重写': 'REWRITER',
  '重寫者': 'REWRITER',
  '重写者': 'REWRITER',
  '重寫': 'REWRITER',
  '维护者': 'MAINTAINER',
  '維護者': 'MAINTAINER',
  '创建者': 'CREATOR',
  '創建者': 'CREATOR',
  '翻译': 'TRANSLATOR',
  '翻譯': 'TRANSLATOR',
  '贡献者': 'CONTRIBUTOR',
  '貢獻者': 'CONTRIBUTOR',
};

const WIKI_BASE = 'https://scp-wiki-cn.wikidot.com';

/**
 * 从 syncer DB 的 PageContentCache 读取已缓存的页面 source。
 * 如果缓存不存在，通过 HTTP + AJAX 获取。
 */
async function fetchPageSource(pageName: string): Promise<string | null> {
  const prisma = getSyncerPrisma();
  const cached = await prisma.pageContentCache.findUnique({
    where: { fullname: pageName },
    select: { source: true },
  });
  if (cached?.source) {
    console.log(`[attribution] Using cached source for ${pageName} (${cached.source.length} bytes)`);
    return cached.source;
  }

  // fallback: HTTP GET → pageId → ViewSourceModule AJAX
  console.log(`[attribution] No cache, fetching via HTTP for ${pageName}`);
  try {
    const resp = await fetch(`${WIKI_BASE}/${pageName}`, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) return null;
    const html = await resp.text();

    const pageIdMatch = html.match(/WIKIREQUEST\.info\.pageId\s*=\s*(\d+)/);
    if (!pageIdMatch) return null;

    const site = getSite();
    const res = await site.amcRequestSingle({
      moduleName: 'viewsource/ViewSourceModule',
      page_id: pageIdMatch[1],
    });
    if (!res.isOk()) return null;
    const body = String((res.value as any).body ?? '');
    const match = body.match(/<div[^>]*class="page-source"[^>]*>([\s\S]*?)<\/div>/);
    if (!match) return null;

    const source = match[1]
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'").replace(/<br\s*\/?>/g, '\n')
      .trim();

    if (source) {
      await prisma.pageContentCache.upsert({
        where: { fullname: pageName },
        create: { fullname: pageName, source, fetchedAt: new Date(), fetchReason: 'attribution_scan' },
        update: { source, fetchedAt: new Date() },
      });
      console.log(`[attribution] Fetched and cached source for ${pageName} (${source.length} bytes)`);
    }
    return source || null;
  } catch (err) {
    console.warn(`[attribution] HTTP fetch failed for ${pageName}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * 扫描所有归属资料页面，解析为结构化数据
 */
export async function scanAttributions(): Promise<AttributionEntry[]> {
  const allEntries: AttributionEntry[] = [];

  for (const pageName of ATTRIBUTION_PAGES) {
    console.log(`[attribution] Fetching source: ${pageName}`);
    const source = await fetchPageSource(pageName);
    if (!source) {
      console.warn(`[attribution] Failed to get source: ${pageName}`);
      continue;
    }

    const entries = parseAttributionSource(source);
    allEntries.push(...entries);
    console.log(`[attribution] Parsed ${entries.length} entries from ${pageName}`);
  }

  console.log(`[attribution] Total: ${allEntries.length} attribution entries`);
  return allEntries;
}

/**
 * 解析归属资料 wiki source 中的表格行
 */
export function parseAttributionSource(source: string): AttributionEntry[] {
  const entries: AttributionEntry[] = [];
  // 每页每类型的计数器，用于生成 order
  const orderMap = new Map<string, number>();

  const lines = source.split('\n');
  for (const line of lines) {
    // 匹配 wiki 表格行：||title||user||type||date||
    // 跳过表头行（包含 ~）
    if (line.includes('||~')) continue;

    const match = line.match(/^\|\|([^|]+)\|\|([^|]+)\|\|([^|]+)\|\|([^|]*)\|\|$/);
    if (!match) continue;

    const pageFullname = match[1].trim();
    const userName = match[2].trim();
    const rawType = match[3].trim();
    const rawDate = match[4].trim();

    // 跳过空行或标题行
    if (!pageFullname || !userName || !rawType) continue;
    if (pageFullname === '标题' || pageFullname === 'title') continue;

    const normalizedType = TYPE_MAP[rawType] ?? rawType.toLowerCase();

    // 解析日期
    let date: string | null = null;
    let isForumOrigin = false;
    if (rawDate && rawDate !== ' ') {
      const cleaned = rawDate.replace(/^\*/, '');
      isForumOrigin = rawDate.startsWith('*');
      // 验证日期格式 YYYY-MM-DD
      if (/^\d{4}-\d{2}-\d{2}$/.test(cleaned)) {
        date = cleaned;
      }
    }

    // 计算 order
    const orderKey = `${pageFullname}:${normalizedType}`;
    const order = (orderMap.get(orderKey) ?? 0);
    orderMap.set(orderKey, order + 1);

    entries.push({
      pageFullname,
      userName,
      type: rawType,
      normalizedType,
      date,
      isForumOrigin,
      order,
    });
  }

  return entries;
}
