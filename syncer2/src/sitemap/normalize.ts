/**
 * sitemap 条目 → slug 观测表（归一化 + 去重 + 解析健康计数）。
 *
 * ── 为什么这段逻辑从 cli/sitemap-scan.ts 里搬出来 ───────────────────────────
 * 原来它内联在 runPageScan() 中间（`skippedNoSlug++` 那一段），要测它必须先起网络
 * 再连库。而它恰好是**解析健康指标 parse_drop_rate 的唯一产地** —— R10 全局解析健康
 * 熔断的输入就是这个数。"唯一产地"却"无法单测"是不可接受的，所以提成纯函数。
 * 行为逐行保持不变（含下面那条 NaN 语义），只是变得可断言。
 *
 * ── parse_drop_rate 的语义（这里是定义处，别处不许再自己算）───────────────
 *   parse_drop_rate = 被**丢弃**的条目数 / 总条目数
 *                   = 无法从 loc 解出 slug 的条目 / 全部条目
 * 实测下它恒等于 1/N（每个 urlset 里只有一条站点根 `http://site/`，无 slug），
 * category 族 1/15 ≈ 0.067、page 族 1/10000 = 0.0001。一旦这个数跳起来，
 * 说明 loc 的格式变了（换域名 / 加了路径前缀 / 输出了相对 URL），是要人看的信号。
 *
 * **刻意不把"去重"算进 drop_rate**（原 runExistenceOnly 用的是 `1 - unique/total`，
 * 把重复 slug 也算成了丢弃）：重复是 sitemap 的正常形态（同一页在多分片里出现、
 * http/https 两种写法），把它混进丢弃率会让 R10 的基线随站点分片状况漂移，
 * 从此这个指标既不能报警也不能免报警。去重率单独出一个 dedupeRate 字段，信息不丢。
 * —— 这是本文件唯一一处偏离原实现的地方，理由如上。
 */

import type { SitemapEntry } from './parse.js';

export interface NormalizedSitemap {
  /** slug → 该 slug 观测到的最新 lastmod（ISO UTC）；无 lastmod 时为空串 ''。 */
  observed: Map<string, string>;
  /** 输入条目总数（含被丢弃的）。 */
  total: number;
  /** 无 slug 被丢弃的条目数（实测=站点根那一条）。 */
  skippedNoSlug: number;
  /** 有 slug 但无 lastmod 的条目数（thread/category 族恒等于全部）。 */
  skippedNoLastmod: number;
  /** 同一 slug 的重复出现次数（首次不算）。 */
  duplicateSlugs: number;
  /** = skippedNoSlug / total；total=0 时为 0。 */
  parseDropRate: number;
  /** = skippedNoLastmod / total；total=0 时为 0。 */
  missingLastmodRate: number;
  /** = duplicateSlugs / total；total=0 时为 0。刻意与 parseDropRate 分开，见文件头。 */
  dedupeRate: number;
}

/**
 * 归一化 + 去重。同一 slug 重复出现时取 lastmod 更**新**的那条。
 *
 * NaN 语义（保留原实现行为，别"顺手修"）：无 lastmod 的条目 lastmod 记作 ''，
 * `Date.parse('')` 是 NaN，而任何 `NaN > x` / `x > NaN` 都是 false，于是
 *   · 已有 '' + 又来一条有 lastmod 的 → 不覆盖（保留 ''）
 *   · 已有值 + 又来一条 '' 的       → 不覆盖（保留原值）
 * 即"先到者胜"。对 page 族无影响（实测除站点根外 100% 带 lastmod），
 * 对 thread/category 族全是 '' 也无影响。写在这里是为了让它是**已知的**而不是意外。
 */
export function normalizeSitemapEntries(entries: readonly SitemapEntry[]): NormalizedSitemap {
  const observed = new Map<string, string>();
  let skippedNoSlug = 0;
  let skippedNoLastmod = 0;
  let duplicateSlugs = 0;

  for (const e of entries) {
    if (!e.slug) {
      skippedNoSlug++;
      continue;
    }
    if (!e.lastmod) skippedNoLastmod++;
    const lastmod = e.lastmod ?? '';
    const prev = observed.get(e.slug);
    if (prev === undefined) {
      observed.set(e.slug, lastmod);
      continue;
    }
    duplicateSlugs++;
    if (Date.parse(lastmod) > Date.parse(prev)) observed.set(e.slug, lastmod);
  }

  const total = entries.length;
  const rate = (n: number): number => (total === 0 ? 0 : n / total);
  return {
    observed,
    total,
    skippedNoSlug,
    skippedNoLastmod,
    duplicateSlugs,
    parseDropRate: rate(skippedNoSlug),
    missingLastmodRate: rate(skippedNoLastmod),
    dedupeRate: rate(duplicateSlugs),
  };
}
