/**
 * AlternateTitleScanner — 从 SCP 系列页面提取 alternateTitle
 *
 * 数据源：各种系列列表页面，格式为 wiki 列表：
 *   * [[[page-name]]] - Alternate Title
 *   * [[[page-name | Display Text]]] - Alternate Title
 *
 * 系列页面：
 *   - scp-series, scp-series-2, ..., scp-series-9  (SCP-001 ~ SCP-8999)
 *   - scp-series-cn, scp-series-cn-2, ..., scp-series-cn-5  (SCP-CN-001 ~ CN-4999)
 *   - scp-international (国际 SCP)
 *   - joke-scps (搞笑 SCP)
 *   - archived-scps (归档 SCP)
 *   - scp-ex (已解明 SCP)
 *   - decommissioned-scps-arc (退役 SCP)
 */

import { getSite } from '../client/WikidotDirectClient.js';
import { getSyncerPrisma } from '../store/db.js';

export type AlternateTitleEntry = {
  fullname: string;
  alternateTitle: string;
};

// 所有已知的系列列表页面
const SERIES_PAGES = [
  // 国际 SCP 系列
  'scp-series',
  'scp-series-2',
  'scp-series-3',
  'scp-series-4',
  'scp-series-5',
  'scp-series-6',
  'scp-series-7',
  'scp-series-8',
  'scp-series-9',
  // CN SCP 系列
  'scp-series-cn',
  'scp-series-cn-2',
  'scp-series-cn-3',
  'scp-series-cn-4',
  'scp-series-cn-5',
  // 特殊系列
  'scp-international',
  'joke-scps',
  'archived-scps',
  'scp-ex',
  'decommissioned-scps-arc',
];

const WIKI_BASE = 'https://scp-wiki-cn.wikidot.com';

/**
 * 从 syncer DB 的 PageContentCache 读取已缓存的页面 source。
 * 如果没有缓存，通过 HTTP 获取渲染页面并从中提取 source。
 */
async function fetchPageSource(pageName: string): Promise<string | null> {
  // 优先从 PageContentCache 读取
  const prisma = getSyncerPrisma();
  const cached = await prisma.pageContentCache.findUnique({
    where: { fullname: pageName },
    select: { source: true },
  });
  if (cached?.source) {
    return cached.source;
  }

  // fallback: 直接 HTTP GET 拿到完整页面 → 从 pageId 通过 AJAX 获取 source
  console.log(`[alt-title] No cache for ${pageName}, fetching via HTTP...`);
  try {
    const resp = await fetch(`${WIKI_BASE}/${pageName}`, { signal: AbortSignal.timeout(30_000) });
    if (!resp.ok) return null;
    const html = await resp.text();

    // 从 HTML 中提取 pageId
    const pageIdMatch = html.match(/WIKIREQUEST\.info\.pageId\s*=\s*(\d+)/);
    if (!pageIdMatch) return null;
    const pageId = pageIdMatch[1];

    // 通过 AJAX 获取 source
    const site = getSite();
    const res = await site.amcRequestSingle({
      moduleName: 'viewsource/ViewSourceModule',
      page_id: pageId,
    });
    if (!res.isOk()) return null;
    const body = String((res.value as any).body ?? '');
    // ViewSourceModule 返回 <div class="page-source">HTML-escaped source</div>
    const match = body.match(/<div[^>]*class="page-source"[^>]*>([\s\S]*?)<\/div>/);
    if (!match) return null;

    const source = match[1]
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'").replace(/<br\s*\/?>/g, '\n')
      .trim();

    // 写入缓存供下次使用
    if (source) {
      await prisma.pageContentCache.upsert({
        where: { fullname: pageName },
        create: { fullname: pageName, source, fetchedAt: new Date(), fetchReason: 'alt_title_scan' },
        update: { source, fetchedAt: new Date() },
      });
    }

    return source || null;
  } catch (err) {
    console.warn(`[alt-title] HTTP fetch failed for ${pageName}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * 扫描所有系列页面，提取 fullname → alternateTitle 映射
 */
export async function scanAlternateTitles(): Promise<AlternateTitleEntry[]> {
  const allEntries: AlternateTitleEntry[] = [];

  for (const pageName of SERIES_PAGES) {
    try {
      const source = await fetchPageSource(pageName);
      if (!source) {
        console.warn(`[alt-title] Source empty: ${pageName}`);
        continue;
      }

      const entries = parseSeriesSource(source);
      allEntries.push(...entries);
      if (entries.length > 0) {
        console.log(`[alt-title] Parsed ${entries.length} titles from ${pageName}`);
      }
    } catch (err) {
      console.warn(`[alt-title] Error on ${pageName}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`[alt-title] Total: ${allEntries.length} alternate titles`);
  return allEntries;
}

/**
 * 解析系列页面 wiki source，提取列表项中的 alternateTitle
 *
 * 支持的格式：
 *   * [[[scp-001]]] - The Title
 *   * [[[scp-001|SCP-001]]] - The Title
 *   * [[[scp-cn-001]]] - 中文标题
 *   * [[[scp-001-ex]]] - Title [已锁]
 */
export function parseSeriesSource(source: string): AlternateTitleEntry[] {
  const entries: AlternateTitleEntry[] = [];
  const lines = source.split('\n');

  for (const line of lines) {
    // 匹配: * [[[page-name]]] - Title  或  * [[[page-name|display]]] - Title
    const match = line.match(
      /^\*\s+\[\[\[([^\]|]+?)(?:\|[^\]]*?)?\]\]\]\s+-\s+(.+)$/
    );
    if (!match) continue;

    const fullname = match[1].trim().toLowerCase();
    let alternateTitle = match[2].trim();

    // 跳过占位符（[ACCESS DENIED]、未创建等）
    if (!alternateTitle || alternateTitle === '[ACCESS DENIED]') continue;
    if (alternateTitle.startsWith('//') && alternateTitle.endsWith('//')) {
      // 斜体 = 占位符 (如 //该SCP在此页无文件// )
      continue;
    }

    // 清理常见后缀标记
    alternateTitle = alternateTitle
      .replace(/\s*\[已锁\]\s*$/, '')
      .replace(/\s*\[.*?已删除.*?\]\s*$/, '')
      .trim();

    if (!alternateTitle || !fullname) continue;

    entries.push({ fullname, alternateTitle });
  }

  return entries;
}
