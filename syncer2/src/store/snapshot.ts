/**
 * 跨短进程的本地状态：上一轮 sitemap 快照（slug → lastmod）。
 *
 * 为什么放本地文件而不是建一张表：v2 的四 schema 由任务 A-D 定稿，**采集层无权自己加表**。
 * 而这份快照本质是"这个采集器上一次看见了什么"，是进程私有的中间态，不是事实数据——
 * 它丢了不会损坏任何事实，只会让下一轮退化成一次 bootstrap（不产出 diff、不产出任务）。
 * 这个降级方向是安全的：**丢状态 ⇒ 少报，不会误报**。
 *
 * 文件格式：gzip 过的 JSON（36k 条约 2 MB → gzip 后几百 KB）。原子写（写 .tmp 再 rename），
 * 避免进程被 SIGKILL 时留下半个文件——半个 JSON 读出来是解析失败，而解析失败在
 * absence 语义里等价于"全站都没了"，必须从物理上排除。
 */

import { gunzipSync, gzipSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../util/log.js';

const log = createLogger('snapshot');

export const SNAPSHOT_VERSION = 1;

export interface SitemapSnapshot {
  version: number;
  /** 本快照最后一次被更新的时刻（ISO UTC）。 */
  updatedAt: string;
  /** 最近一次 full 轮的时刻与枚举数；delta 轮不改这两个字段。 */
  lastFullAt: string | null;
  lastFullCount: number | null;
  /** slug → lastmod（ISO UTC 字符串；sitemap 无 lastmod 时为空串）。 */
  entries: Record<string, string>;
}

export function emptySnapshot(): SitemapSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    updatedAt: new Date(0).toISOString(),
    lastFullAt: null,
    lastFullCount: null,
    entries: {},
  };
}

export function snapshotPath(stateDir: string, name = 'sitemap-page'): string {
  return path.join(stateDir, `${name}.snapshot.json.gz`);
}

/** 读快照。不存在或损坏 → 返回 null（调用方按 bootstrap 处理，绝不当成空站点）。 */
export function readSnapshot(file: string): SitemapSnapshot | null {
  if (!fs.existsSync(file)) {
    log.info('无历史快照，本轮按 bootstrap 处理', { file });
    return null;
  }
  try {
    const raw = gunzipSync(fs.readFileSync(file)).toString('utf-8');
    const parsed = JSON.parse(raw) as SitemapSnapshot;
    if (parsed.version !== SNAPSHOT_VERSION || typeof parsed.entries !== 'object') {
      log.warn('快照版本/结构不匹配，按 bootstrap 处理', { file, version: parsed.version });
      return null;
    }
    return parsed;
  } catch (err) {
    log.warn('快照读取失败，按 bootstrap 处理（不会误报删除）', { file, error: String(err) });
    return null;
  }
}

/** 原子写快照。 */
export function writeSnapshot(file: string, snapshot: SitemapSnapshot): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf-8')));
  fs.renameSync(tmp, file);
  log.info('快照已写入', { file, entries: Object.keys(snapshot.entries).length });
}

export interface SnapshotDiff {
  /** 快照里没有的 slug。 */
  newSlugs: string[];
  /** lastmod 严格前进的 slug（附新旧值）。 */
  advanced: Array<{ slug: string; from: string; to: string }>;
  /** lastmod 后退了 —— 不正常，只记录不动作（可能是站点侧回滚或我们读到了缓存副本）。 */
  regressed: Array<{ slug: string; from: string; to: string }>;
  /** 本轮观测到但 lastmod 未变的数量。 */
  unchanged: number;
}

/**
 * 与快照比对。
 *
 * 注意这里**只做单向比对**（本轮看到的 vs 快照），不在这里推断"快照有而本轮没有 ⇒ 删除"：
 * delta 轮只抓 sitemap_page_1（最近 3.7 个月的切片），一个页面从 page_1 掉到 page_2
 * 完全正常，把它当删除就是 v1 幻影 removed 的翻版。absence 只允许在 full 轮里算，
 * 且要过完整性门控 —— 见 cli/sitemap-scan.ts。
 */
export function diffAgainstSnapshot(
  observed: ReadonlyMap<string, string>,
  snapshot: SitemapSnapshot,
): SnapshotDiff {
  const newSlugs: string[] = [];
  const advanced: SnapshotDiff['advanced'] = [];
  const regressed: SnapshotDiff['regressed'] = [];
  let unchanged = 0;

  for (const [slug, lastmod] of observed) {
    const prev = snapshot.entries[slug];
    if (prev === undefined) {
      newSlugs.push(slug);
      continue;
    }
    if (prev === lastmod) {
      unchanged++;
      continue;
    }
    // 字符串比较不可靠（时区写法可能变），一律按毫秒比。
    const prevMs = prev ? Date.parse(prev) : NaN;
    const curMs = lastmod ? Date.parse(lastmod) : NaN;
    if (Number.isFinite(prevMs) && Number.isFinite(curMs) && curMs < prevMs) {
      regressed.push({ slug, from: prev, to: lastmod });
    } else {
      advanced.push({ slug, from: prev, to: lastmod });
    }
  }

  return { newSlugs, advanced, regressed, unchanged };
}

/** delta 轮：把本轮观测**合并**进快照（不删除快照里的其它 slug）。 */
export function mergeIntoSnapshot(
  snapshot: SitemapSnapshot,
  observed: ReadonlyMap<string, string>,
  at: string,
): SitemapSnapshot {
  const entries = { ...snapshot.entries };
  for (const [slug, lastmod] of observed) entries[slug] = lastmod;
  return { ...snapshot, entries, updatedAt: at };
}

/** full 轮：本轮观测**整体替换**快照（这才是全站真值）。 */
export function replaceSnapshot(
  observed: ReadonlyMap<string, string>,
  at: string,
): SitemapSnapshot {
  const entries: Record<string, string> = {};
  for (const [slug, lastmod] of observed) entries[slug] = lastmod;
  return {
    version: SNAPSHOT_VERSION,
    updatedAt: at,
    lastFullAt: at,
    lastFullCount: observed.size,
    entries,
  };
}
