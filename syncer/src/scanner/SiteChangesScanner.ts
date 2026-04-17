/**
 * SiteChangesScanner — 通过 SiteChangesListModule 获取最近变更
 * 比全量 Tier 1 扫描快 100 倍（~0.5s vs ~7min）
 */

import { getSite } from '../client/WikidotDirectClient.js';
import { isSuccessResponse } from '@ukwhatn/wikidot';

export type SiteChangeEntry = {
  fullname: string;
  title: string;
  revisionNo: number;
  changedBy: string | null;
  changedAt: Date | null;
  flags: string[];
  comment: string;
};

/**
 * 获取最近的站点变更（1-2 次 AJAX 请求）
 */
export async function scanRecentChanges(pages: number = 2): Promise<SiteChangeEntry[]> {
  const site = getSite();
  const allChanges: SiteChangeEntry[] = [];

  for (let p = 1; p <= pages; p++) {
    const res = await site.amcRequestSingle({
      moduleName: 'changes/SiteChangesListModule',
      perpage: '100',
      page: String(p),
    });

    if (!res.isOk()) break;
    const response = res.value;
    if (!isSuccessResponse(response)) break;

    const body = String(response.body ?? '');
    const entries = parseSiteChanges(body);
    allChanges.push(...entries);

    if (entries.length < 100) break; // 没有更多页
  }

  return allChanges;
}

/**
 * 解析 SiteChangesListModule HTML
 */
function parseSiteChanges(html: string): SiteChangeEntry[] {
  const entries: SiteChangeEntry[] = [];

  // 每个变更项在 <div class="changes-list-item"> 中
  const itemPattern = /<div class="changes-list-item">\s*<table>([\s\S]*?)<\/table>/g;
  let itemMatch: RegExpExecArray | null;

  while ((itemMatch = itemPattern.exec(html)) !== null) {
    const tableHtml = itemMatch[1];

    // 提取页面链接和标题
    const linkMatch = tableHtml.match(/<td class="title">\s*<a href="\/([^"]+)">([\s\S]*?)<\/a>/);
    if (!linkMatch) continue;
    const fullname = linkMatch[1].trim();
    const title = linkMatch[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

    // 提取 flags
    const flags: string[] = [];
    const flagPattern = /class="spantip"[^>]*title="([^"]+)"/g;
    let flagMatch: RegExpExecArray | null;
    while ((flagMatch = flagPattern.exec(tableHtml)) !== null) {
      flags.push(flagMatch[1].trim());
    }

    // 提取修订号
    const revMatch = tableHtml.match(/class="revision-no"[^>]*>(\d+)/);
    const revisionNo = revMatch ? parseInt(revMatch[1], 10) : 0;

    // 提取用户
    const userMatch = tableHtml.match(/class="printuser[^"]*"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/);
    const changedBy = userMatch ? userMatch[1].trim() : null;

    // 提取时间 (odate)
    const timeMatch = tableHtml.match(/class="time_(\d+)"/);
    const changedAt = timeMatch ? new Date(parseInt(timeMatch[1], 10) * 1000) : null;

    // 提取评论
    const commentMatch = tableHtml.match(/class="comments"[^>]*>([\s\S]*?)<\/span>/);
    const comment = commentMatch ? commentMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    entries.push({ fullname, title, revisionNo, changedBy, changedAt, flags, comment });
  }

  return entries;
}

/**
 * 从变更列表中提取有投票变化的页面（rating 相关的编辑不在 changes 中，
 * 但 flags 包含内容/标签变化的页面很可能也有新投票）
 * 实际上 SiteChanges 只包含编辑变更，不包含投票事件。
 * 但我们可以用它来检测新页面和内容变化，配合 RatingScanner 的增量检测。
 */
export function getChangedFullnames(changes: SiteChangeEntry[]): Set<string> {
  return new Set(changes.map(c => c.fullname));
}
