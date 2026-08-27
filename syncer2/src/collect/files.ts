/**
 * PageFilesModule 采集。
 *
 * Tier1 没有附件数量字段，只能由修订类型集合中的 FILES_CHANGED 条件触发。
 * 当前 v2 schema 没有附件事实表/apply_files 函数，本模块因此只负责严格解析与
 * `meta.page_scan(kind='files')` 证据，不臆造直写表。
 */

import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { amcRequest } from '../http/amc.js';
import type { HttpClient } from '../http/client.js';
import { decodeEntities } from '../content/extractText.js';
import { recordPageScan } from '../store/meta.js';
import { mapWithConcurrency } from '../util/concurrency.js';
import { throwIfRuntimeBudgetExceeded } from '../util/runtimeBudget.js';
import type { RevisionEntry } from './revisions.js';
import {
  assertUniqueKeys,
  diagnostics,
  failed,
  ok,
  type CollectResult,
  type PageCollectTarget,
} from './result.js';

interface PageFile {
  wikidotFileId: number;
  name: string;
  url: string;
  mimeDescription: string;
  sizeBytes: number;
}

export interface FileSnapshot {
  pageId: number;
  wikidotId: number;
  files: PageFile[];
}

function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitCells(rowHtml: string): string[] {
  const starts = [...rowHtml.matchAll(/<td\b[^>]*>/gi)];
  return starts.map((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < starts.length ? (starts[i + 1]!.index ?? rowHtml.length) : rowHtml.length;
    return rowHtml.slice(start, end).replace(/<\/td>\s*$/i, '');
  });
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + '`' + `]+))`,
    'i',
  ).exec(attrs);
  return m?.[1] ?? m?.[2] ?? m?.[3] ?? null;
}

export function parseFileSize(raw: string): number | null {
  const text = raw.trim().replace(/,/g, '');
  const m = /^(\d+(?:\.\d+)?)\s*(Bytes?|kB|KB|MB|GB)$/i.exec(text);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase();
  const multiplier =
    unit.startsWith('byte') ? 1 : unit === 'kb' ? 1_000 : unit === 'mb' ? 1_000_000 : 1_000_000_000;
  return Number.isFinite(n) ? Math.floor(n * multiplier) : null;
}

export function parseFilesBody(
  body: string,
  baseUrl: string,
  target: PageCollectTarget,
): CollectResult<FileSnapshot> {
  const echoedId = Number(
    /<div\b[^>]*\bid\s*=\s*["']files-page-id["'][^>]*>\s*(\d+)\s*<\/div>/i.exec(body)?.[1] ??
      NaN,
  );
  if (echoedId !== target.wikidotId) {
    return failed(
      `PageFilesModule 身份回显不一致：任务 wikidotId=${target.wikidotId}，响应=${
        Number.isFinite(echoedId) ? echoedId : 'missing'
      }。`,
    );
  }
  const rows = [...body.matchAll(/<tr\b[^>]*\bid\s*=\s*["']file-row-(\d+)["'][^>]*>([\s\S]*?)<\/tr\s*>/gi)];
  if (rows.length === 0) {
    // 真实空列表没有 table，而是这段中文提示 + 隐藏 page id。两项都要命中，
    // 防止 WAF 页面碰巧含“没有附件”字样。
    const emptyMarker = /<p\b[^>]*>\s*本页没有附件\s*<\/p>/i.test(body);
    if (emptyMarker && echoedId === target.wikidotId) {
      return ok(
        { pageId: target.pageId, wikidotId: target.wikidotId, files: [] },
        diagnostics(null, 0),
      );
    }
    return failed(
      `附件响应既没有 file-row，也不是带正确 files-page-id 的“本页没有附件”结构（回显=${String(
        Number.isFinite(echoedId) ? echoedId : 'missing',
      )}）。`,
      diagnostics(null, 0),
    );
  }

  const files: PageFile[] = [];
  const errors: string[] = [];
  for (const row of rows) {
    const id = Number(row[1]);
    const cells = splitCells(row[2] ?? '');
    const link = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(cells[0] ?? '');
    const href = link ? attr(link[1] ?? '', 'href') : null;
    const name = link ? stripHtml(link[2] ?? '') : '';
    const mimeSpan = /<span\b([^>]*)>/i.exec(cells[1] ?? '');
    const mimeDescription = decodeEntities(
      mimeSpan ? (attr(mimeSpan[1] ?? '', 'title') ?? '') : '',
    ).trim();
    const size = parseFileSize(stripHtml(cells[2] ?? ''));
    if (!Number.isSafeInteger(id) || id <= 0 || cells.length < 3 || !href || name === '' || size === null) {
      errors.push(`file-row-${row[1]} 字段不完整（td=${cells.length},href=${href ?? '-'},size=${size}）`);
      continue;
    }
    let url: string;
    try {
      url = new URL(decodeEntities(href), `${baseUrl.replace(/\/+$/, '')}/`).toString();
    } catch {
      errors.push(`file-row-${id} URL 非法：${href}`);
      continue;
    }
    files.push({ wikidotFileId: id, name, url, mimeDescription, sizeBytes: size });
  }
  if (errors.length > 0) {
    return failed(
      `附件行解析失败 ${errors.length}/${rows.length}：${errors.slice(0, 3).join('；')}`,
      diagnostics(null, files.length),
    );
  }
  const ids = new Set<number>();
  for (const file of files) {
    if (ids.has(file.wikidotFileId)) {
      return failed(`附件响应内 file id 重复：${file.wikidotFileId}`, diagnostics(null, files.length));
    }
    ids.add(file.wikidotFileId);
  }
  return ok(
    { pageId: target.pageId, wikidotId: target.wikidotId, files },
    diagnostics(null, files.length),
  );
}

export async function scanFiles(
  http: HttpClient,
  baseUrl: string,
  targets: readonly PageCollectTarget[],
  concurrency = 4,
): Promise<Map<number, CollectResult<FileSnapshot>>> {
  assertUniqueKeys(targets, (t) => t.pageId);
  const pairs = await mapWithConcurrency(targets, concurrency, async (target) => {
    try {
      const res = await amcRequest(http, baseUrl, {
        moduleName: 'files/PageFilesModule',
        params: { page_id: target.wikidotId },
        mode: 'tier2:files',
        maxAttempts: 3,
      });
      if (res.status !== 'ok') {
        return [
          target.pageId,
          failed<FileSnapshot>(`PageFilesModule status=${res.status}（message=${res.message ?? '-'}）`),
        ] as const;
      }
      if (res.body === null) {
        return [target.pageId, failed<FileSnapshot>('PageFilesModule status=ok 但 body 缺失。')] as const;
      }
      return [target.pageId, parseFilesBody(res.body, baseUrl, target)] as const;
    } catch (err) {
      throwIfRuntimeBudgetExceeded(err);
      return [
        target.pageId,
        failed<FileSnapshot>(`PageFilesModule 请求失败：${String(err)}`),
      ] as const;
    }
  });
  return new Map(pairs);
}

/** 修订类型按集合判断，不能用 `revision.type === 'FILES_CHANGED'` 的单值逻辑。 */
export function revisionNeedsFilesScan(revision: RevisionEntry): boolean {
  return revision.types.includes('FILES_CHANGED');
}

/** 仅写扫描证据；附件事实表/apply 函数尚不存在，禁止绕过 apply_* 直写。 */
export async function recordFileResult(
  pool: Pool,
  target: PageCollectTarget,
  result: CollectResult<FileSnapshot>,
  runId: number | null,
): Promise<void> {
  const hash =
    result.status === 'ok'
      ? createHash('sha256').update(JSON.stringify(result.data.files), 'utf8').digest()
      : null;
  await recordPageScan(
    pool,
    {
      runId,
      pageId: target.pageId,
      kind: 'files',
      status: result.status,
      fetchedTotal: result.diagnostics.fetchedTotal,
      resultHash: hash,
      error: result.status === 'ok' ? null : result.error,
    },
  );
}
