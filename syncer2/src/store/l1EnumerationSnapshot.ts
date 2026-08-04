/**
 * 每日 L1 四字段全站枚举快照。
 *
 * 远端载荷只含 fullname/rating/rating_votes/revisions；category 与稳定 index 都由
 * 完整轮本地派生。目标文件只会在整轮 status=ok 后以同目录 rename 替换，读取端还会
 * 复核 complete 标记、行数与内容 checksum，任何半截/损坏文件都返回 null。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

import type {
  IncrementalListPagesRun,
  L1ListPageRow,
} from '../collect/incrementalListPages.js';

export const L1_ENUMERATION_SNAPSHOT_VERSION = 1;
export const L1_ENUMERATION_SNAPSHOT_FILENAME = 'listpages-l1-enum.snapshot.json.gz';

export interface L1EnumerationSnapshotRow extends L1ListPageRow {
  category: string;
  /** 本轮确定性枚举顺序；不是 Wikidot 远端字段。 */
  index: number;
}

export interface L1EnumerationSnapshot {
  version: number;
  kind: 'l1_full_site_minimal';
  completeness: 'complete';
  updatedAt: string;
  expectedBatches: number;
  remoteTotal: number;
  rowCount: number;
  contentChecksum: string;
  rows: Record<string, L1EnumerationSnapshotRow>;
}

export interface L1SnapshotAdvanceResult {
  advanced: boolean;
  reason: 'advanced' | 'already_current_day' | 'scan_incomplete';
  snapshot: L1EnumerationSnapshot | null;
}

export function l1EnumerationSnapshotPath(stateDir: string): string {
  return path.join(stateDir, L1_ENUMERATION_SNAPSHOT_FILENAME);
}

export function createL1EnumerationSnapshot(
  scan: IncrementalListPagesRun<L1ListPageRow>,
  updatedAt: string,
): L1EnumerationSnapshot {
  if (
    scan.status !== 'ok' ||
    !scan.validation.complete ||
    scan.expectedBatches === null ||
    scan.requestedBatches !== scan.expectedBatches ||
    scan.batchesFailed !== 0
  ) {
    throw new Error(
      `拒绝从非完整 L1 轮构造枚举快照：status=${scan.status}, ` +
        `complete=${scan.validation.complete}, batches=${scan.requestedBatches}/` +
        `${scan.expectedBatches ?? '?'}, failed=${scan.batchesFailed}`,
    );
  }
  if (!Number.isFinite(Date.parse(updatedAt))) {
    throw new Error(`L1 枚举快照时点非法：${updatedAt}`);
  }
  const rows: Record<string, L1EnumerationSnapshotRow> = {};
  scan.rows.forEach((row, offset) => {
    if (rows[row.fullname] !== undefined) {
      throw new Error(`L1 枚举快照 fullname 重复：${row.fullname}`);
    }
    rows[row.fullname] = {
      ...row,
      category: categoryFromFullname(row.fullname),
      index: offset + 1,
    };
  });
  const rowCount = Object.keys(rows).length;
  if (rowCount === 0) throw new Error('L1 枚举完整轮 rows=0，拒绝当空站点');
  return {
    version: L1_ENUMERATION_SNAPSHOT_VERSION,
    kind: 'l1_full_site_minimal',
    completeness: 'complete',
    updatedAt,
    expectedBatches: scan.expectedBatches,
    remoteTotal: rowCount,
    rowCount,
    contentChecksum: checksumRows(rows),
    rows,
  };
}

export function readL1EnumerationSnapshot(file: string): L1EnumerationSnapshot | null {
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(
      gunzipSync(fs.readFileSync(file)).toString('utf8'),
    ) as unknown;
    if (!isRecord(parsed)) return null;
    if (
      parsed['version'] !== L1_ENUMERATION_SNAPSHOT_VERSION ||
      parsed['kind'] !== 'l1_full_site_minimal' ||
      parsed['completeness'] !== 'complete' ||
      typeof parsed['updatedAt'] !== 'string' ||
      !Number.isFinite(Date.parse(parsed['updatedAt'])) ||
      !positiveInteger(parsed['expectedBatches']) ||
      !positiveInteger(parsed['remoteTotal']) ||
      !positiveInteger(parsed['rowCount']) ||
      typeof parsed['contentChecksum'] !== 'string' ||
      !isRecord(parsed['rows'])
    ) {
      return null;
    }
    const rows: Record<string, L1EnumerationSnapshotRow> = {};
    for (const [fullname, value] of Object.entries(parsed['rows'])) {
      if (!isL1SnapshotRow(value) || value.fullname !== fullname) return null;
      rows[fullname] = value;
    }
    const rowCount = Object.keys(rows).length;
    if (
      parsed['rowCount'] !== rowCount ||
      parsed['remoteTotal'] !== rowCount ||
      parsed['contentChecksum'] !== checksumRows(rows)
    ) {
      return null;
    }
    return {
      version: L1_ENUMERATION_SNAPSHOT_VERSION,
      kind: 'l1_full_site_minimal',
      completeness: 'complete',
      updatedAt: parsed['updatedAt'],
      expectedBatches: parsed['expectedBatches'],
      remoteTotal: parsed['remoteTotal'],
      rowCount: parsed['rowCount'],
      contentChecksum: parsed['contentChecksum'],
      rows,
    };
  } catch {
    return null;
  }
}

/** 同目录写临时文件、fsync 后 rename；崩溃只会留下读取端完全忽略的 `.tmp.*`。 */
export function writeL1EnumerationSnapshot(
  file: string,
  snapshot: L1EnumerationSnapshot,
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8')));
    const fd = fs.openSync(tmp, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

/**
 * L1 仍按既有频率采集；这里只复用每天第一轮完整成功结果，不新增网络请求。
 * 当天后续完整轮继续做增量职责，但不反复改写 parity 基线。
 */
export function advanceDailyL1EnumerationSnapshot(
  file: string,
  scan: IncrementalListPagesRun<L1ListPageRow>,
  updatedAt: string,
): L1SnapshotAdvanceResult {
  if (scan.status !== 'ok' || !scan.validation.complete) {
    return { advanced: false, reason: 'scan_incomplete', snapshot: null };
  }
  const previous = readL1EnumerationSnapshot(file);
  if (previous !== null && shanghaiDay(previous.updatedAt) === shanghaiDay(updatedAt)) {
    return { advanced: false, reason: 'already_current_day', snapshot: previous };
  }
  const snapshot = createL1EnumerationSnapshot(scan, updatedAt);
  writeL1EnumerationSnapshot(file, snapshot);
  return { advanced: true, reason: 'advanced', snapshot };
}

function categoryFromFullname(fullname: string): string {
  const separator = fullname.indexOf(':');
  return separator < 0 ? '_default' : fullname.slice(0, separator).toLowerCase();
}

function checksumRows(rows: Record<string, L1EnumerationSnapshotRow>): string {
  const material = Object.keys(rows)
    .sort()
    .map((fullname) => {
      const row = rows[fullname]!;
      return [
        row.fullname,
        row.category,
        row.index,
        row.rating,
        row.ratingVotes,
        row.revisions,
      ].join('\u0000');
    })
    .join('\n');
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

function shanghaiDay(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`非法 L1 快照时间：${value}`);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function isL1SnapshotRow(value: unknown): value is L1EnumerationSnapshotRow {
  if (!isRecord(value)) return false;
  return (
    typeof value['fullname'] === 'string' &&
    value['fullname'] !== '' &&
    typeof value['category'] === 'string' &&
    positiveInteger(value['index']) &&
    safeInteger(value['rating']) &&
    nonNegativeInteger(value['ratingVotes']) &&
    nonNegativeInteger(value['revisions'])
  );
}

function positiveInteger(value: unknown): value is number {
  return safeInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return safeInteger(value) && value >= 0;
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
