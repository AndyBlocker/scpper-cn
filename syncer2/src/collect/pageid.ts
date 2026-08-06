/**
 * slug → wikidotId 的严格逐页入口。
 *
 * 每个 slug 物理上仍是一条 GET：
 *   /<slug>/norender/true/noredirect/true
 * 任一页失败只写该页自己的 failed 结果，不会 throw 掉整批，也不会从 Map 里消失。
 */

import type { HttpClient } from '../http/client.js';
import {
  findSharedPageIdentityCollisions,
  slugToUrl,
} from '../page/identity.js';
import { createLogger } from '../util/log.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import {
  assertUniqueKeys,
  failed,
  ok,
  type CollectResult,
} from './result.js';

export interface PageIdSnapshot {
  slug: string;
  wikidotId: number;
  url: string;
}

export function parseWikidotPageId(html: string): number | null {
  const raw = /WIKIREQUEST\.info\.pageId\s*=\s*(\d+);/.exec(html)?.[1];
  if (raw === undefined) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function pageIdUrl(baseUrl: string, slug: string): string {
  return `${slugToUrl(baseUrl, slug)}/norender/true/noredirect/true`;
}

export async function scanPageIds(
  http: HttpClient,
  baseUrl: string,
  slugs: readonly string[],
  concurrency = 4,
): Promise<Map<string, CollectResult<PageIdSnapshot>>> {
  assertUniqueKeys(slugs, (slug) => slug);
  const pairs = await mapWithConcurrency(slugs, concurrency, async (slug) => {
    const url = pageIdUrl(baseUrl, slug);
    try {
      const res = await http.get(url, 'tier2:pageid', { maxAttempts: 3 });
      const wikidotId = parseWikidotPageId(res.text());
      if (wikidotId === null) {
        return [
          slug,
          failed<PageIdSnapshot>(
            `HTTP ${res.status} 但无法匹配 WIKIREQUEST.info.pageId = <数字>;，该页独立判 failed。`,
          ),
        ] as const;
      }
      return [slug, ok({ slug, wikidotId, url })] as const;
    } catch (err) {
      return [slug, failed<PageIdSnapshot>(`pageId GET 失败：${String(err)}`)] as const;
    }
  });
  const results = new Map(pairs);
  const collisions = findSharedPageIdentityCollisions(
    pairs.flatMap(([slug, result]) =>
      result.status === 'ok' ? [{ slug, wikidotId: result.data.wikidotId }] : [],
    ),
  );
  if (collisions.length > 0) {
    createLogger('pageid').error(
      '身份冲突守卫触发：多个 slug 共享同一 pageId，冲突组全部拒绝',
      { collisions },
    );
    for (const collision of collisions) {
      for (const slug of collision.slugs) {
        results.set(
          slug,
          failed<PageIdSnapshot>(
            `身份冲突守卫：pageId=${collision.wikidotId} 同时解析自多个 slug=` +
              collision.slugs.join(',') + '；拒绝写入',
          ),
        );
      }
    }
  }
  return results;
}
