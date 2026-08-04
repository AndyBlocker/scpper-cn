/**
 * extract-vs-crom —— 实测 v1 CROM `textContent` 与我方 `extractTextContent(html)` 的差异，
 * 并把差异翻译成"多少个 embedding chunk 的内容会变"。
 *
 * 这是 TODO #8（语义检索域归属与 embedding 重算决策）的证据来源。
 * 结论与数字见 docs/embedding-migration.md。
 *
 * ── 输入（刻意用文件，不连主库）────────────────────────────────────────────
 *
 * 三份输入都由 `experiments/extract-fetch.sh` 一键生成（`V1_DATABASE_URL=… ./extract-fetch.sh`），
 * 下面写出各自的等价手工命令，便于单独复现：
 * syncer2 全流程都**不持有主库 scpper-cn 的连接串**（并行期主库只读，见 README）。
 * 所以本脚本不查库，只吃两份离线快照：
 *
 *   1) `--v1 <file.csv>`：`id,textContent` 两列 CSV，由主库导出（在 scpper-cn 侧执行）：
 *        psql "$DATABASE_URL" -At -c "\copy (
 *          SELECT v.id, v.\"textContent\" FROM \"PageVersion\" v WHERE v.id IN (...)
 *        ) TO 'v1text.csv' WITH (FORMAT csv)"
 *
 *   2) `--html <dir>`：每页整页 HTML，文件名 `<pageVersionId>.html`，抓取方式：
 *        curl -s --compressed -x "$SYNCER2_HTTP_PROXY" \
 *             -A "$SYNCER2_USER_AGENT" -e "$SYNCER2_REFERER" \
 *             "https://scp-wiki-cn.wikidot.com/<slug>" -o html/<pv>.html
 *      （UA + Referer 两个头是实测硬契约，见 src/http/client.ts 文件头。）
 *
 *   3) `--chunks <file.tsv>`：可选。v1 实际 chunk 边界，用来验证分块模型复刻是否准确：
 *        pageVersionId \t chunkIndex \t chunkCharStart \t chunkCharEnd
 *
 * ── 差异度量 ────────────────────────────────────────────────────────────────
 * 字符级 Levenshtein 在 20k 字符上是 4×10^8 次操作/页，不可行。这里用
 * **行级 LCS + 未匹配行的字符数**：两侧都按行切，求最长公共子序列，
 * 差异字符数 = 两侧未进入 LCS 的行的字符数之和，差异率 = 该值 / (len1+len2)。
 * 行是这份数据的天然单位（CROM 输出就是逐行的），且 L≈数百，O(L²) 完全可行。
 *
 * 两个口径各算一遍：
 *   · raw       —— 行原样比。含"空白策略差异"，是切换后**实际**会看到的差异。
 *   · semantic  —— 两侧都先剥掉行内全部空白再比。只剩真正的内容增删。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  extractTextContent,
  normalizeV1ChunkerInput,
  chunkLikeV1,
  codePointLength,
  type Chunk,
} from '../src/content/extractText.js';

// ─── CLI ─────────────────────────────────────────────────────────────────────

interface Args {
  v1: string;
  html: string;
  chunks: string | null;
  out: string | null;
  emitChunks: string | null;
  verbose: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { v1: '', html: '', chunks: null, out: null, emitChunks: null, verbose: 5 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--v1' && v) { a.v1 = v; i++; }
    else if (k === '--html' && v) { a.html = v; i++; }
    else if (k === '--chunks' && v) { a.chunks = v; i++; }
    else if (k === '--out' && v) { a.out = v; i++; }
    else if (k === '--emit-chunks' && v) { a.emitChunks = v; i++; }
    else if (k === '--verbose' && v) { a.verbose = Number(v); i++; }
  }
  if (!a.v1 || !a.html) {
    throw new Error('用法: extract-vs-crom.ts --v1 v1text.csv --html htmldir [--chunks chunks.tsv] [--out report.json]');
  }
  return a;
}

// ─── 极简 CSV 读取（只需支持 postgres COPY CSV 的转义规则）────────────────────

function readCsv2(file: string): Map<string, string> {
  const s = fs.readFileSync(file, 'utf-8');
  const out = new Map<string, string>();
  let i = 0;
  const n = s.length;
  while (i < n) {
    const row: string[] = [];
    let field = '';
    let quoted = false;
    let done = false;
    while (i < n && !done) {
      const c = s[i]!;
      if (quoted) {
        if (c === '"') {
          if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"' && field === '') { quoted = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\n') { row.push(field); field = ''; i++; done = true; continue; }
      if (c === '\r') { i++; continue; }
      field += c; i++;
    }
    if (!done && (field !== '' || row.length > 0)) row.push(field);
    if (row.length >= 2 && row[0] !== '') out.set(row[0]!, row[1]!);
  }
  return out;
}

// ─── 行级 LCS 差异 ───────────────────────────────────────────────────────────

interface DiffStat {
  /** 未匹配（= 增或删）的字符数。 */
  diffChars: number;
  /** 两侧字符总数。 */
  totalChars: number;
  /** 差异率 = diffChars / totalChars。 */
  rate: number;
  /** 只在 v1 里出现的行数（内容"丢失"侧）。 */
  onlyLeftLines: number;
  /** 只在我方出现的行数（内容"新增"侧）。 */
  onlyRightLines: number;
  /** 只在 v1 里出现的字符数。 */
  onlyLeftChars: number;
  onlyRightChars: number;
}

/** 行级 LCS，返回匹配上的行下标对。空间 O(L1*L2) 用 Uint32Array，L 上限保护。 */
function lcsLines(a: readonly string[], b: readonly string[]): { ai: number; bi: number }[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return [];
  // 行内容 → 整数 id，避免在 DP 里反复比长字符串
  const ids = new Map<string, number>();
  const ida = new Int32Array(n);
  const idb = new Int32Array(m);
  for (let i = 0; i < n; i++) {
    const k = a[i]!;
    let id = ids.get(k);
    if (id === undefined) { id = ids.size; ids.set(k, id); }
    ida[i] = id;
  }
  for (let j = 0; j < m; j++) {
    const k = b[j]!;
    let id = ids.get(k);
    if (id === undefined) { id = ids.size; ids.set(k, id); }
    idb[j] = id;
  }
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const rowBase = i * w;
    const nextBase = (i + 1) * w;
    for (let j = m - 1; j >= 0; j--) {
      dp[rowBase + j] =
        ida[i] === idb[j]
          ? dp[nextBase + j + 1]! + 1
          : Math.max(dp[nextBase + j]!, dp[rowBase + j + 1]!);
    }
  }
  const pairs: { ai: number; bi: number }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ida[i] === idb[j]) { pairs.push({ ai: i, bi: j }); i++; j++; continue; }
    if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) i++;
    else j++;
  }
  return pairs;
}

const MAX_LINES = 4000; // 4000² × 4B = 64 MB，够用且不炸内存

function diffByLines(left: string, right: string): DiffStat {
  let la = left.split('\n');
  let lb = right.split('\n');
  if (la.length > MAX_LINES || lb.length > MAX_LINES) {
    // 超长页：按 2 行合并降采样后再比（差异率量级不受影响）
    const fold = (arr: string[], k: number): string[] => {
      const o: string[] = [];
      for (let i = 0; i < arr.length; i += k) o.push(arr.slice(i, i + k).join(''));
      return o;
    };
    const k = Math.ceil(Math.max(la.length, lb.length) / MAX_LINES);
    la = fold(la, k);
    lb = fold(lb, k);
  }
  const pairs = lcsLines(la, lb);
  const matchedA = new Uint8Array(la.length);
  const matchedB = new Uint8Array(lb.length);
  for (const p of pairs) { matchedA[p.ai] = 1; matchedB[p.bi] = 1; }
  let onlyLeftChars = 0;
  let onlyLeftLines = 0;
  let onlyRightChars = 0;
  let onlyRightLines = 0;
  for (let i = 0; i < la.length; i++) if (!matchedA[i]) { onlyLeftLines++; onlyLeftChars += la[i]!.length; }
  for (let j = 0; j < lb.length; j++) if (!matchedB[j]) { onlyRightLines++; onlyRightChars += lb[j]!.length; }
  const totalChars = left.length + right.length;
  const diffChars = onlyLeftChars + onlyRightChars;
  return {
    diffChars,
    totalChars,
    rate: totalChars === 0 ? 0 : diffChars / totalChars,
    onlyLeftLines,
    onlyRightLines,
    onlyLeftChars,
    onlyRightChars,
  };
}

const stripAllWs = (s: string): string => s.replace(/\s+/g, '');

// ─── 单页对比 ────────────────────────────────────────────────────────────────

interface PageReport {
  pv: string;
  container: string;
  warnings: string[];
  v1Len: number;
  oursLen: number;
  v1LenNoWs: number;
  oursLenNoWs: number;
  rawRate: number;
  semRate: number;
  v1OnlyChars: number;
  oursOnlyChars: number;
  v1Chunks: number;
  oursChunks: number;
  chunkCountDelta: number;
  /** 同 index 上内容逐字符相等的 chunk 数。 */
  chunksIdentical: number;
  /** 同 index 上剥空白后相等的 chunk 数。 */
  chunksIdenticalNoWs: number;
  /** v1 的 chunk 内容能在我方 chunk 列表**任意位置**逐字符找到的数量。 */
  chunksSurvivingAnywhere: number;
  /** 与生产库实际 chunk 边界的复刻误差（缺 --chunks 时为 null）。 */
  modelEndDelta: number | null;
}

function comparePage(pv: string, v1Text: string, html: string, realChunkEnd: number | null): PageReport {
  const ex = extractTextContent(html);
  const v1Norm = normalizeV1ChunkerInput(v1Text);
  const ours = ex.text;

  const raw = diffByLines(v1Norm, ours);
  const sem = diffByLines(
    v1Norm.split('\n').map(stripAllWs).filter((l) => l !== '').join('\n'),
    ours.split('\n').map(stripAllWs).filter((l) => l !== '').join('\n'),
  );

  const cv1: Chunk[] = chunkLikeV1(v1Norm);
  const cOurs: Chunk[] = chunkLikeV1(ours);
  const oursSet = new Set(cOurs.map((c) => c.content));
  let identical = 0;
  let identicalNoWs = 0;
  let survivingAnywhere = 0;
  for (const c of cv1) {
    const mate = cOurs[c.index];
    if (mate !== undefined && mate.content === c.content) identical++;
    if (mate !== undefined && stripAllWs(mate.content) === stripAllWs(c.content)) identicalNoWs++;
    if (oursSet.has(c.content)) survivingAnywhere++;
  }

  return {
    pv,
    container: ex.container,
    warnings: ex.warnings,
    v1Len: v1Norm.length,
    oursLen: ours.length,
    v1LenNoWs: stripAllWs(v1Norm).length,
    oursLenNoWs: stripAllWs(ours).length,
    rawRate: raw.rate,
    semRate: sem.rate,
    v1OnlyChars: sem.onlyLeftChars,
    oursOnlyChars: sem.onlyRightChars,
    v1Chunks: cv1.length,
    oursChunks: cOurs.length,
    chunkCountDelta: cOurs.length - cv1.length,
    chunksIdentical: identical,
    chunksIdenticalNoWs: identicalNoWs,
    chunksSurvivingAnywhere: survivingAnywhere,
    modelEndDelta: realChunkEnd === null ? null : v1Norm.length === 0 ? null : realChunkEnd - Math.min(v1Norm.length, (cv1.length - 1) * 1300 + 1500),
  };
}

// ─── 汇总 ────────────────────────────────────────────────────────────────────

function pct(x: number): string {
  return (x * 100).toFixed(2) + '%';
}

function quantiles(xs: number[], qs: number[]): number[] {
  const s = [...xs].sort((a, b) => a - b);
  return qs.map((q) => {
    if (s.length === 0) return NaN;
    const i = Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))));
    return s[i]!;
  });
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const v1Map = readCsv2(args.v1);

  const realEnds = new Map<string, number>();
  if (args.chunks !== null) {
    for (const line of fs.readFileSync(args.chunks, 'utf-8').split('\n')) {
      if (line.trim() === '') continue;
      const [pv, , , ce] = line.split('\t');
      if (!pv || !ce) continue;
      const v = Number(ce);
      realEnds.set(pv, Math.max(realEnds.get(pv) ?? 0, v));
    }
  }

  const files = fs.readdirSync(args.html).filter((f) => f.endsWith('.html'));
  const reports: PageReport[] = [];
  for (const f of files) {
    const pv = path.basename(f, '.html');
    const v1 = v1Map.get(pv);
    if (v1 === undefined) { console.error(`跳过 ${pv}：v1 CSV 里没有该 pageVersionId`); continue; }
    const html = fs.readFileSync(path.join(args.html, f), 'utf-8');
    reports.push(comparePage(pv, v1, html, realEnds.get(pv) ?? null));
  }

  reports.sort((a, b) => b.semRate - a.semRate);

  const n = reports.length;
  const rawRates = reports.map((r) => r.rawRate);
  const semRates = reports.map((r) => r.semRate);
  const totV1Chunks = reports.reduce((s, r) => s + r.v1Chunks, 0);
  const totOursChunks = reports.reduce((s, r) => s + r.oursChunks, 0);
  const totIdentical = reports.reduce((s, r) => s + r.chunksIdentical, 0);
  const totIdenticalNoWs = reports.reduce((s, r) => s + r.chunksIdenticalNoWs, 0);
  const totSurviving = reports.reduce((s, r) => s + r.chunksSurvivingAnywhere, 0);
  const countChanged = reports.filter((r) => r.chunkCountDelta !== 0).length;
  const anyIdentical = reports.filter((r) => r.chunksIdentical > 0).length;
  const fullyIdentical = reports.filter((r) => r.chunksIdentical === r.v1Chunks && r.v1Chunks === r.oursChunks).length;
  const semZero = reports.filter((r) => r.semRate === 0).length;

  const qs = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 1];
  const qLabels = ['min', 'p10', 'p25', 'p50', 'p75', 'p90', 'p95', 'max'];

  const line = (s = ''): void => { process.stdout.write(s + '\n'); };

  line('='.repeat(78));
  line(`样本页数: ${n}`);
  line('='.repeat(78));
  line();
  line('【1】字符级差异率分布（行级 LCS，diffChars/(len_v1+len_ours)）');
  line('  raw（含空白策略差异，= 切换后实际观察到的差异）:');
  line('    ' + qLabels.map((l, i) => `${l}=${pct(quantiles(rawRates, qs)[i]!)}`).join('  '));
  line('  semantic（两侧剥掉全部空白后，只剩真内容增删）:');
  line('    ' + qLabels.map((l, i) => `${l}=${pct(quantiles(semRates, qs)[i]!)}`).join('  '));
  line(`  semantic 差异率 = 0 的页: ${semZero}/${n} (${pct(semZero / n)})`);
  const semBuckets: [string, (r: PageReport) => boolean][] = [
    ['= 0', (r) => r.semRate === 0],
    ['0–1%', (r) => r.semRate > 0 && r.semRate <= 0.01],
    ['1–5%', (r) => r.semRate > 0.01 && r.semRate <= 0.05],
    ['5–10%', (r) => r.semRate > 0.05 && r.semRate <= 0.1],
    ['10–30%', (r) => r.semRate > 0.1 && r.semRate <= 0.3],
    ['>30%', (r) => r.semRate > 0.3],
  ];
  line('  semantic 分桶:');
  for (const [label, f] of semBuckets) {
    const c = reports.filter(f).length;
    line(`    ${label.padEnd(8)} ${String(c).padStart(4)} 页  ${pct(c / n)}`);
  }
  line();
  line('【2】正文体量变化（剥空白后的字符数，我方 / v1）');
  const ratios = reports.filter((r) => r.v1LenNoWs > 0).map((r) => r.oursLenNoWs / r.v1LenNoWs);
  line('    ' + qLabels.map((l, i) => `${l}=${quantiles(ratios, qs)[i]!.toFixed(3)}`).join('  '));
  const sumV1 = reports.reduce((s, r) => s + r.v1LenNoWs, 0);
  const sumOurs = reports.reduce((s, r) => s + r.oursLenNoWs, 0);
  line(`    合计: v1 ${sumV1} 字 → 我方 ${sumOurs} 字（${((sumOurs / sumV1 - 1) * 100).toFixed(1)}%）`);
  line(`    含空白合计: v1 ${reports.reduce((s, r) => s + r.v1Len, 0)} → 我方 ${reports.reduce((s, r) => s + r.oursLen, 0)}`);
  line();
  line('【3】分块边界变化');
  line(`    v1 chunk 总数 ${totV1Chunks} → 我方 ${totOursChunks}（${totOursChunks - totV1Chunks >= 0 ? '+' : ''}${totOursChunks - totV1Chunks}）`);
  line(`    chunk 数发生变化的页: ${countChanged}/${n} (${pct(countChanged / n)})`);
  line(`    同 index 内容逐字符相等的 chunk: ${totIdentical}/${totV1Chunks} (${pct(totIdentical / totV1Chunks)})`);
  line(`    同 index 剥空白后相等的 chunk:   ${totIdenticalNoWs}/${totV1Chunks} (${pct(totIdenticalNoWs / totV1Chunks)})`);
  line(`    v1 chunk 内容在我方任意位置存活: ${totSurviving}/${totV1Chunks} (${pct(totSurviving / totV1Chunks)})`);
  line(`    ⇒ 内容会变的 chunk: ${totV1Chunks - totIdentical}/${totV1Chunks} (${pct(1 - totIdentical / totV1Chunks)})`);
  line(`    至少有 1 个 chunk 完全不变的页: ${anyIdentical}/${n};全页 chunk 全不变: ${fullyIdentical}/${n}`);
  line();
  if (realEnds.size > 0) {
    const withModel = reports.filter((r) => r.modelEndDelta !== null);
    const exact = withModel.filter((r) => r.modelEndDelta === 0).length;
    line('【4】v1 分块器模型复刻精度（对生产库真实 chunkCharEnd）');
    line(`    完全吻合: ${exact}/${withModel.length} (${pct(exact / Math.max(1, withModel.length))})`);
    const deltas = withModel.map((r) => Math.abs(r.modelEndDelta!)).filter((d) => d > 0);
    if (deltas.length > 0) {
      line(`    不吻合页的 |Δ| 中位数 ${quantiles(deltas, [0.5])[0]} 字符, 最大 ${Math.max(...deltas)}`);
      line('    （偏差方向双向 ⇒ 是 2026-04 生成 embedding 之后 textContent 又漂移了，不是模型错）');
    }
    line();
  }
  line('【5】提取健康度');
  const noContainer = reports.filter((r) => r.container !== 'page-content');
  line(`    未定位到 #page-content 的页: ${noContainer.length}`);
  const warned = reports.filter((r) => r.warnings.length > 0);
  line(`    带 warning 的页: ${warned.length}`);
  const warnCount = new Map<string, number>();
  for (const r of warned) for (const w of r.warnings) warnCount.set(w, (warnCount.get(w) ?? 0) + 1);
  for (const [w, c] of [...warnCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    line(`      ${c}×  ${w}`);
  }
  line();
  line(`【6】semantic 差异率最高的 ${args.verbose} 页（人工复核用）`);
  for (const r of reports.slice(0, args.verbose)) {
    line(`    pv=${r.pv.padEnd(8)} sem=${pct(r.semRate).padStart(7)} raw=${pct(r.rawRate).padStart(7)} ` +
      `v1无空白=${r.v1LenNoWs} 我方=${r.oursLenNoWs} v1独有字符=${r.v1OnlyChars} 我方独有=${r.oursOnlyChars} ` +
      `chunk ${r.v1Chunks}→${r.oursChunks}`);
  }
  line();
  line(`【7】v1 独有内容最多的 ${args.verbose} 页（= 我方可能漏抓）`);
  for (const r of [...reports].sort((a, b) => b.v1OnlyChars - a.v1OnlyChars).slice(0, args.verbose)) {
    line(`    pv=${r.pv.padEnd(8)} v1独有=${r.v1OnlyChars} 字  我方独有=${r.oursOnlyChars} 字  sem=${pct(r.semRate)}`);
  }

  // ── --emit-chunks:把我方抽取结果切块后导出成 serve.text_chunk 的 COPY 输入 ────
  // 目的不是"生成生产数据",而是拿**真实语料**去撞 0008 的约束(尤其 tc_content_len:
  // JS 的 slice 按 UTF-16 码元切,Postgres 的 length() 按码点数 —— 语料里只要有
  // 一个代理对(emoji / 生僻 CJK 扩展字),两边就会不等。这条只能用真数据测出来)。
  if (args.emitChunks !== null) {
    const lines: string[] = [];
    const esc = (s: string): string =>
      s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
    let emitted = 0;
    for (const f of files) {
      const pv = path.basename(f, '.html');
      const html = fs.readFileSync(path.join(args.html, f), 'utf-8');
      const ex = extractTextContent(html);
      if (ex.text === '') continue;
      const sha = createHash('sha256').update(ex.text, 'utf-8').digest('hex');
      const cs = chunkLikeV1(ex.text);
      for (const c of cs) {
        lines.push(
          [
            sha,   // 纯 hex,由载入侧 decode(...,'hex');刻意不写 COPY TEXT 的 \\x 前缀(那层转义极易搞错)
            'v2-fixed-1500-1300',
            String(c.index),
            String(cs.length),
            String(c.charStart),
            String(c.charEnd),
            esc(c.content),
            String(codePointLength(ex.text)),   // 码点数,与 Postgres length() 同口径
            pv,
          ].join('\t'),
        );
        emitted++;
      }
    }
    fs.writeFileSync(args.emitChunks, lines.join('\n') + '\n');
    line();
    line(`已导出 ${emitted} 条 chunk 到 ${args.emitChunks}（列序:text_sha_hex chunker chunk_index chunk_total char_start char_end content text_len page_ref）`);
  }

  if (args.out !== null) {
    fs.writeFileSync(args.out, JSON.stringify({ generatedAt: new Date().toISOString(), n, reports }, null, 2));
    line();
    line(`逐页明细已写入 ${args.out}`);
  }
}

main();
