#!/usr/bin/env node

/**
 * Detect Chinese neologism candidates from stored page content.
 *
 * Method:
 * 1) Character n-gram frequency
 * 2) Minimum PMI across all split points
 * 3) Left/Right neighbor entropy
 *
 * Output is sorted by frequency (DESC) and can optionally be exported to CSV.
 */

import { Command } from 'commander';
import { Prisma } from '@prisma/client';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js';

type CounterMap = Map<string, number>;

type ContextStats = {
  left: CounterMap;
  right: CounterMap;
};

type Candidate = {
  word: string;
  freq: number;
  length: number;
  minPmi: number;
  leftEntropy: number;
  rightEntropy: number;
  neighborVariety: number;
};

type ScanStats = {
  totalPageVersions: number;
  totalHanChars: number;
  totalHanSegments: number;
};

const RE_HAN_SEGMENT = /[\p{Script=Han}]{2,}/gu;
const RE_REPEATED_CHAR = /^([\p{Script=Han}])\1+$/u;

// A small built-in set to reduce obvious function-word noise.
const BUILTIN_COMMON_WORDS = new Set([
  '我们', '你们', '他们', '它们',
  '这个', '那个', '这些', '那些', '这里', '那里',
  '一个', '一种', '一些', '很多', '有些',
  '没有', '不是', '就是', '可以', '应该',
  '因为', '所以', '但是', '然后', '如果', '或者', '并且',
  '已经', '正在', '仍然', '继续', '成为', '进行',
  '通过', '对于', '由于', '关于', '其中', '包括',
  '之前', '之后', '之间', '以上', '以下',
  '出现', '发现', '情况', '时候', '问题', '结果',
  '需要', '无法', '可能', '必须', '是否',
  '基本', '总体', '相关', '自己',
  '非常', '特别', '一般', '主要', '目前',
  '此次', '这次', '这种', '那种', '这样',
  '并不', '并非', '等等'
]);

function parseIntStrict(value: string, name: string): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return n;
}

function parseFloatStrict(value: string, name: string): number {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return n;
}

function incCounter(map: CounterMap, key: string, amount = 1): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

class BloomFilter {
  private readonly bits: Uint8Array;
  private readonly bitCount: number;
  private readonly mask: number;
  private readonly hashCount: number;

  constructor(bitCount: number, hashCount = 4) {
    if (bitCount <= 0 || (bitCount & (bitCount - 1)) !== 0) {
      throw new Error('Bloom bitCount must be power-of-two and > 0');
    }
    this.bitCount = bitCount;
    this.mask = bitCount - 1;
    this.hashCount = Math.max(1, hashCount);
    this.bits = new Uint8Array(Math.ceil(bitCount / 8));
  }

  private hash32(input: string, seed: number): number {
    let h = (2166136261 ^ seed) >>> 0;
    for (let i = 0; i < input.length; i += 1) {
      h ^= input.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    h ^= h >>> 16;
    h = Math.imul(h, 2246822507) >>> 0;
    h ^= h >>> 13;
    h = Math.imul(h, 3266489909) >>> 0;
    h ^= h >>> 16;
    return h >>> 0;
  }

  private setBit(index: number): void {
    const byteIdx = index >>> 3;
    const bitMask = 1 << (index & 7);
    this.bits[byteIdx] |= bitMask;
  }

  private getBit(index: number): boolean {
    const byteIdx = index >>> 3;
    const bitMask = 1 << (index & 7);
    return (this.bits[byteIdx] & bitMask) !== 0;
  }

  add(word: string, lenSeed: number): void {
    const h1 = this.hash32(word, 0x9e3779b9 ^ lenSeed);
    const h2Base = this.hash32(word, 0x85ebca6b ^ (lenSeed << 1));
    const h2 = (h2Base | 1) >>> 0;
    for (let i = 0; i < this.hashCount; i += 1) {
      const idx = (h1 + Math.imul(i, h2)) & this.mask;
      this.setBit(idx);
    }
  }

  has(word: string, lenSeed: number): boolean {
    const h1 = this.hash32(word, 0x9e3779b9 ^ lenSeed);
    const h2Base = this.hash32(word, 0x85ebca6b ^ (lenSeed << 1));
    const h2 = (h2Base | 1) >>> 0;
    for (let i = 0; i < this.hashCount; i += 1) {
      const idx = (h1 + Math.imul(i, h2)) & this.mask;
      if (!this.getBit(idx)) return false;
    }
    return true;
  }
}

class OccurrenceGate {
  private readonly threshold: number;
  private readonly levels: BloomFilter[];

  constructor(threshold: number, bloomBits: number) {
    this.threshold = threshold;
    const levelCount = Math.max(0, threshold - 1);
    this.levels = Array.from({ length: levelCount }, () => new BloomFilter(bloomBits, 4));
  }

  get initialCount(): number {
    return this.threshold;
  }

  shouldTrack(word: string, lenSeed: number): boolean {
    if (this.threshold <= 1) return true;
    if (this.levels.length === 1) {
      if (this.levels[0].has(word, lenSeed)) return true;
      this.levels[0].add(word, lenSeed);
      return false;
    }

    const last = this.levels.length - 1;
    if (this.levels[last].has(word, lenSeed)) {
      return true;
    }

    for (let i = last - 1; i >= 0; i -= 1) {
      if (this.levels[i].has(word, lenSeed)) {
        this.levels[i + 1].add(word, lenSeed);
        return false;
      }
    }

    this.levels[0].add(word, lenSeed);
    return false;
  }
}

function entropy(map: CounterMap): number {
  let total = 0;
  for (const count of map.values()) total += count;
  if (total <= 0) return 0;

  let h = 0;
  for (const count of map.values()) {
    const p = count / total;
    h -= p * Math.log2(p);
  }
  return h;
}

function isLikelyNoise(word: string): boolean {
  if (!word) return true;
  if (RE_REPEATED_CHAR.test(word)) return true;
  if (BUILTIN_COMMON_WORDS.has(word)) return true;
  return false;
}

async function loadKnownWords(filePath?: string): Promise<Set<string>> {
  const set = new Set<string>();
  if (!filePath) return set;

  const text = await fs.readFile(filePath, 'utf8');
  for (const line of text.split(/\r?\n/u)) {
    const w = line.trim();
    if (!w || w.startsWith('#')) continue;
    set.add(w);
  }
  return set;
}

async function writeCsv(outputPath: string, rows: Candidate[]): Promise<void> {
  const header = 'rank,word,freq,length,min_pmi,left_entropy,right_entropy,neighbor_variety';
  const lines = [header];
  rows.forEach((row, index) => {
    lines.push([
      String(index + 1),
      `"${row.word.replace(/"/g, '""')}"`,
      String(row.freq),
      String(row.length),
      row.minPmi.toFixed(6),
      row.leftEntropy.toFixed(6),
      row.rightEntropy.toFixed(6),
      String(row.neighborVariety)
    ].join(','));
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

type ScanPageOptions = {
  where: Prisma.PageVersionWhereInput;
  batchSize: number;
  limitPages?: number;
  progressEvery: number;
  label: string;
};

async function scanPageVersions(
  opts: ScanPageOptions,
  onText: (text: string) => void
): Promise<ScanStats> {
  const prisma = getPrismaClient();
  const stats: ScanStats = {
    totalPageVersions: 0,
    totalHanChars: 0,
    totalHanSegments: 0
  };

  let lastId = 0;
  let reachedLimit = false;

  while (true) {
    const where: Prisma.PageVersionWhereInput = {
      ...opts.where,
      id: { gt: lastId }
    };

    const rows = await prisma.pageVersion.findMany({
      where,
      orderBy: { id: 'asc' },
      take: opts.batchSize,
      select: { id: true, textContent: true }
    });

    if (rows.length === 0) break;
    lastId = rows[rows.length - 1].id;

    for (const row of rows) {
      if (opts.limitPages && stats.totalPageVersions >= opts.limitPages) {
        reachedLimit = true;
        break;
      }

      const text = row.textContent ?? '';
      stats.totalPageVersions += 1;

      const segments = text.match(RE_HAN_SEGMENT) ?? [];
      stats.totalHanSegments += segments.length;
      for (const segment of segments) {
        stats.totalHanChars += Array.from(segment).length;
        onText(segment);
      }
    }

    if (opts.progressEvery > 0 && stats.totalPageVersions > 0 && stats.totalPageVersions % opts.progressEvery === 0) {
      console.log(`[${opts.label}] scanned PageVersions: ${stats.totalPageVersions}`);
    }

    if (reachedLimit) break;
    if (rows.length < opts.batchSize) break;
  }

  return stats;
}

async function main(): Promise<void> {
  const program = new Command();
  program
    .option('--all-versions', 'Scan all PageVersion rows instead of current active versions')
    .option('--include-deleted', 'Include deleted page versions')
    .option('--limit-pages <n>', 'Limit number of PageVersion rows scanned', (v) => parseIntStrict(v, 'limit-pages'))
    .option('--batch-size <n>', 'Batch size for DB scan', (v) => parseIntStrict(v, 'batch-size'), 200)
    .option('--min-len <n>', 'Min candidate length', (v) => parseIntStrict(v, 'min-len'), 2)
    .option('--max-len <n>', 'Max candidate length', (v) => parseIntStrict(v, 'max-len'), 4)
    .option('--min-freq <n>', 'Min frequency', (v) => parseIntStrict(v, 'min-freq'), 5)
    .option('--track-from-occurrence <n>', 'Track n-grams only after this occurrence count (1=exact, >=2 memory-friendly)', (v) => parseIntStrict(v, 'track-from-occurrence'), 1)
    .option('--once-bloom-bits <n>', 'Bloom filter bits for occurrence gate (power-of-two)', (v) => parseIntStrict(v, 'once-bloom-bits'), 268435456)
    .option('--min-pmi <n>', 'Min PMI threshold', (v) => parseFloatStrict(v, 'min-pmi'), 5.0)
    .option('--min-entropy <n>', 'Min left/right entropy threshold', (v) => parseFloatStrict(v, 'min-entropy'), 1.0)
    .option('--min-neighbor-variety <n>', 'Min unique neighbor count for each side', (v) => parseIntStrict(v, 'min-neighbor-variety'), 2)
    .option('--max-pass2-candidates <n>', 'Cap candidate size for pass-2 (0 means no cap)', (v) => parseIntStrict(v, 'max-pass2-candidates'), 200000)
    .option('--known-file <path>', 'Known words file (one word per line), used for exclusion')
    .option('--progress-every <n>', 'Print progress every N scanned rows', (v) => parseIntStrict(v, 'progress-every'), 2000)
    .option('--top <n>', 'Show top N rows', (v) => parseIntStrict(v, 'top'), 200)
    .option('--out <path>', 'Write full filtered result to CSV');

  program.parse(process.argv);
  const opts = program.opts<{
    allVersions?: boolean;
    includeDeleted?: boolean;
    limitPages?: number;
    batchSize: number;
    minLen: number;
    maxLen: number;
    minFreq: number;
    trackFromOccurrence: number;
    onceBloomBits: number;
    minPmi: number;
    minEntropy: number;
    minNeighborVariety: number;
    maxPass2Candidates: number;
    knownFile?: string;
    progressEvery: number;
    top: number;
    out?: string;
  }>();

  if (opts.minLen < 2) {
    throw new Error('--min-len must be >= 2');
  }
  if (opts.maxLen < opts.minLen) {
    throw new Error('--max-len must be >= --min-len');
  }
  if (opts.batchSize <= 0) {
    throw new Error('--batch-size must be positive');
  }
  if (opts.top <= 0) {
    throw new Error('--top must be positive');
  }
  if (opts.maxPass2Candidates < 0) {
    throw new Error('--max-pass2-candidates must be >= 0');
  }
  if (opts.trackFromOccurrence < 1 || opts.trackFromOccurrence > 6) {
    throw new Error('--track-from-occurrence must be within [1, 6]');
  }
  if (opts.trackFromOccurrence >= 2) {
    const b = opts.onceBloomBits;
    if (b <= 0 || (b & (b - 1)) !== 0) {
      throw new Error('--once-bloom-bits must be power-of-two when --track-from-occurrence>=2');
    }
  }

  const knownWords = await loadKnownWords(opts.knownFile);
  const freqMap = new Map<string, number>();
  const occGate = opts.trackFromOccurrence >= 2
    ? new OccurrenceGate(opts.trackFromOccurrence, opts.onceBloomBits)
    : null;

  const baseWhere: Prisma.PageVersionWhereInput = {
    textContent: { not: null }
  };
  if (!opts.allVersions) {
    baseWhere.validTo = null;
  }
  if (!opts.includeDeleted) {
    baseWhere.isDeleted = false;
  }

  console.log('[pass-1] counting n-gram frequencies...');
  const pass1Stats = await scanPageVersions(
    {
      where: baseWhere,
      batchSize: opts.batchSize,
      limitPages: opts.limitPages,
      progressEvery: opts.progressEvery,
      label: 'pass-1'
    },
    (segment) => {
      const chars = Array.from(segment);
      const len = chars.length;
      if (len < 2) return;

      for (let i = 0; i < len; i += 1) {
        const maxN = Math.min(opts.maxLen, len - i);
        for (let n = 1; n <= maxN; n += 1) {
          const word = chars.slice(i, i + n).join('');
          if (opts.trackFromOccurrence === 1) {
            incCounter(freqMap, word);
            continue;
          }

          const current = freqMap.get(word);
          if (current !== undefined) {
            freqMap.set(word, current + 1);
            continue;
          }
          if (!occGate) continue;
          if (occGate.shouldTrack(word, n)) {
            freqMap.set(word, occGate.initialCount);
          }
        }
      }
    }
  );

  const candidateFreq = new Map<string, number>();
  for (const [word, freq] of freqMap.entries()) {
    const length = Array.from(word).length;
    if (length < opts.minLen || length > opts.maxLen) continue;
    if (freq < opts.minFreq) continue;
    if (knownWords.has(word)) continue;
    if (isLikelyNoise(word)) continue;
    candidateFreq.set(word, freq);
  }

  if (candidateFreq.size === 0) {
    console.log('No frequency-level candidates found. Try lower --min-freq or --min-pmi.');
    await disconnectPrisma();
    return;
  }

  console.log(`[pass-1.5] PMI pre-filtering ${candidateFreq.size} candidates...`);
  const pmiPassed = new Map<string, { freq: number; length: number; minPmi: number }>();
  for (const [word, freq] of candidateFreq.entries()) {
    const chars = Array.from(word);
    let minPmi = Number.POSITIVE_INFINITY;
    for (let split = 1; split < chars.length; split += 1) {
      const left = chars.slice(0, split).join('');
      const right = chars.slice(split).join('');
      const leftCount = freqMap.get(left) ?? 0;
      const rightCount = freqMap.get(right) ?? 0;
      if (leftCount <= 0 || rightCount <= 0) continue;
      const pmi = Math.log2((freq * Math.max(pass1Stats.totalHanChars, 1)) / (leftCount * rightCount));
      if (pmi < minPmi) minPmi = pmi;
    }
    if (!Number.isFinite(minPmi) || minPmi < opts.minPmi) continue;
    pmiPassed.set(word, { freq, length: chars.length, minPmi });
  }

  let pass2Pool = Array.from(pmiPassed.entries()).map(([word, meta]) => ({ word, ...meta }));
  pass2Pool.sort((a, b) => b.freq - a.freq || b.minPmi - a.minPmi || a.word.localeCompare(b.word, 'zh-Hans-CN'));
  if (opts.maxPass2Candidates > 0 && pass2Pool.length > opts.maxPass2Candidates) {
    pass2Pool = pass2Pool.slice(0, opts.maxPass2Candidates);
  }

  // Release large maps before pass-2.
  freqMap.clear();
  candidateFreq.clear();

  const pass2Meta = new Map<string, { freq: number; length: number; minPmi: number }>();
  for (const row of pass2Pool) {
    pass2Meta.set(row.word, { freq: row.freq, length: row.length, minPmi: row.minPmi });
  }
  const candidateSet = new Set(pass2Meta.keys());

  if (candidateSet.size === 0) {
    console.log('No PMI-qualified candidates after pre-filtering.');
    await disconnectPrisma();
    return;
  }

  const ctxMap = new Map<string, ContextStats>();
  console.log(`[pass-2] collecting context for ${candidateSet.size} candidates...`);

  await scanPageVersions(
    {
      where: baseWhere,
      batchSize: opts.batchSize,
      limitPages: opts.limitPages,
      progressEvery: opts.progressEvery,
      label: 'pass-2'
    },
    (segment) => {
      const chars = Array.from(segment);
      const len = chars.length;
      if (len < opts.minLen) return;

      for (let i = 0; i < len; i += 1) {
        const maxN = Math.min(opts.maxLen, len - i);
        for (let n = opts.minLen; n <= maxN; n += 1) {
          const word = chars.slice(i, i + n).join('');
          if (!candidateSet.has(word)) continue;

          let ctx = ctxMap.get(word);
          if (!ctx) {
            ctx = { left: new Map(), right: new Map() };
            ctxMap.set(word, ctx);
          }
          if (i > 0) incCounter(ctx.left, chars[i - 1]);
          if (i + n < len) incCounter(ctx.right, chars[i + n]);
        }
      }
    }
  );

  const results: Candidate[] = [];
  for (const [word, meta] of pass2Meta.entries()) {
    const ctx = ctxMap.get(word);
    if (!ctx) continue;

    const leftEntropy = entropy(ctx.left);
    const rightEntropy = entropy(ctx.right);
    if (leftEntropy < opts.minEntropy || rightEntropy < opts.minEntropy) continue;

    const leftKinds = ctx.left.size;
    const rightKinds = ctx.right.size;
    const neighborVariety = Math.min(leftKinds, rightKinds);
    if (neighborVariety < opts.minNeighborVariety) continue;

    results.push({
      word,
      freq: meta.freq,
      length: meta.length,
      minPmi: meta.minPmi,
      leftEntropy,
      rightEntropy,
      neighborVariety
    });
  }

  results.sort((a, b) =>
    b.freq - a.freq ||
    b.minPmi - a.minPmi ||
    (b.leftEntropy + b.rightEntropy) - (a.leftEntropy + a.rightEntropy) ||
    a.word.localeCompare(b.word, 'zh-Hans-CN')
  );

  const topN = Math.min(opts.top, results.length);
  const topRows = results.slice(0, topN);

  console.log('=== Neologism Candidate Detection ===');
  console.log(`PageVersions scanned: ${pass1Stats.totalPageVersions}`);
  console.log(`Han segments scanned: ${pass1Stats.totalHanSegments}`);
  console.log(`Han chars scanned: ${pass1Stats.totalHanChars}`);
  console.log(`Known dictionary size: ${knownWords.size}`);
  console.log(`PMI-passed candidate count: ${pmiPassed.size}`);
  console.log(`Pass-2 candidate count: ${candidateSet.size}`);
  console.log(`Filtered candidate count: ${results.length}`);
  console.log(`Showing top: ${topN}`);
  console.log('');

  if (topRows.length > 0) {
    console.table(topRows.map((row, index) => ({
      rank: index + 1,
      word: row.word,
      freq: row.freq,
      len: row.length,
      minPmi: Number(row.minPmi.toFixed(3)),
      leftEnt: Number(row.leftEntropy.toFixed(3)),
      rightEnt: Number(row.rightEntropy.toFixed(3)),
      nbVar: row.neighborVariety
    })));
  } else {
    console.log('No candidate matched current thresholds.');
  }

  if (opts.out) {
    await writeCsv(opts.out, results);
    console.log(`\nCSV exported: ${opts.out}`);
  }

  await disconnectPrisma();
}

main().catch(async (err) => {
  console.error('Neologism detection failed:', err);
  try {
    await disconnectPrisma();
  } catch {}
  process.exitCode = 1;
});
