#!/usr/bin/env node

// 检查：于指定日期（含）之后创建的“已删除页面”中，最新 PageVersion 是否混入其他语种/分站的标签
// 用法：
//   node --import tsx/esm backend/scripts/check-cross-language-tags.ts --since 2025-10-29 [--limit N]
//   npm run check:cross-lang-tags -- --since 2025-10-29

import { Command } from 'commander';
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js';

type Row = {
  pageId: number;
  wikidotId: number;
  url: string;
  createdAt: string;
  pvId: number;
  tags: string[];
};

const LANG_CODE_TAGS = new Set([
  // 主要 SCP 分站两字母或常用代号
  'en','jp','ko','ru','pl','es','fr','de','it','pt','cs','sk','uk','vi','th','tr','id','ro','hu','nl','he','ar','zh','int'
]);

// 明显的非中文拉丁词（各分站常见标签样式）
const SUSPICIOUS_LATIN_WORDS = new Set([
  'übersetzt', // de
  'ansteckend', 'biologische-gefahr', 'gebäude', 'ort', 'sicher', // de (示例)
  'relato', 'formato', // es/pt
  'modèle', // fr
  'szablon', // pl
  'doplněk', 'korekce', // cs
  'truyện', // vi
  'component', 'template' // 模板多语复用场景：该两词若与非中文同现可辅助标注
]);

// 字符集检测（unicode 范围）
const RE_CYRILLIC = /[\u0400-\u052F]/u; // 西里尔
const RE_HIRAGANA = /[\u3040-\u309F]/u; // 日文平假名
const RE_KATAKANA = /[\u30A0-\u30FF]/u; // 日文片假名
const RE_HANGUL   = /[\u1100-\u11FF\uAC00-\uD7AF]/u; // 韩文

function normalize(tag: string): string {
  return String(tag ?? '').trim().toLowerCase();
}

function isForeignTag(tag: string): boolean {
  const t = normalize(tag);
  if (!t) return false;

  // 语言代码标签（如 jp / es 等）
  if (LANG_CODE_TAGS.has(t)) return true;

  // 非中文常见拉丁词
  if (SUSPICIOUS_LATIN_WORDS.has(t)) return true;

  // 西里尔、日文、韩文字符
  if (RE_CYRILLIC.test(t)) return true;
  if (RE_HIRAGANA.test(t)) return true;
  if (RE_KATAKANA.test(t)) return true;
  if (RE_HANGUL.test(t)) return true;

  return false;
}

const program = new Command();
program
  .option('--since <date>', '仅检查该日期（含）之后创建的页面（ISO 日期）')
  .option('--limit <n>', '最多检查的页面数量', (v) => parseInt(String(v), 10))
  .option('--top <n>', '展示最常见的“外语标签”数目', (v) => parseInt(String(v), 10), 25);

async function main(): Promise<void> {
  program.parse(process.argv);
  const opts = program.opts<{ since?: string; limit?: number; top?: number }>();

  const sinceStr = opts.since ?? '2025-10-29';
  const since = new Date(sinceStr);
  if (Number.isNaN(since.getTime())) {
    console.error(`无法解析 --since：${sinceStr}`);
    process.exit(1);
  }

  const prisma = getPrismaClient();
  console.log(`🔎 检查：创建时间 >= ${since.toISOString().slice(0,10)} 的“已删除页面”，是否混入其他分站/语种标签`);

  const pages = await prisma.page.findMany({
    where: { isDeleted: true, createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' },
    take: opts.limit && Number.isFinite(opts.limit) ? Math.max(1, opts.limit) : undefined,
    select: {
      id: true,
      wikidotId: true,
      url: true,
      currentUrl: true,
      createdAt: true,
      versions: {
        where: { validTo: null },
        orderBy: { validFrom: 'desc' },
        take: 1,
        select: { id: true, tags: true }
      }
    }
  });

  let checked = 0;
  let pagesWithForeign = 0;
  const foreignTagFreq = new Map<string, number>();
  const samples: Array<Row & { foreign: string[] }> = [];

  for (const p of pages) {
    checked += 1;
    const pv = p.versions[0];
    if (!pv) continue;
    const tags = (pv.tags ?? []).map((x) => String(x));
    const foreign = tags.filter((t) => isForeignTag(t));
    if (foreign.length > 0) {
      pagesWithForeign += 1;
      for (const ft of foreign) {
        const k = normalize(ft);
        foreignTagFreq.set(k, (foreignTagFreq.get(k) || 0) + 1);
      }
      if (samples.length < 50) {
        samples.push({
          pageId: p.id,
          wikidotId: p.wikidotId,
          url: p.currentUrl || p.url,
          createdAt: p.createdAt.toISOString(),
          pvId: pv.id,
          tags,
          foreign
        });
      }
    }
  }

  console.log(`🧮 已检查页面：${checked}；混入“外语/分站标签”的页面：${pagesWithForeign}`);

  const top = Math.max(1, Math.min(Number(opts.top) || 25, 100));
  const topList = Array.from(foreignTagFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, top)
    .map(([tag, count]) => ({ tag, count }));

  if (topList.length) {
    console.log(`\n最常见“外语标签” Top${top}:`);
    console.table(topList);
  }

  if (samples.length) {
    console.log('\n示例页面（最多 50 条）：');
    console.table(
      samples.map((s) => ({
        wikidotId: s.wikidotId,
        pageId: s.pageId,
        pvId: s.pvId,
        createdAt: s.createdAt.slice(0,19),
        foreign: s.foreign.join('|'),
        url: s.url
      }))
    );
    // 追加紧凑预览，避免控制台宽表格被截断
    const compact = samples.slice(0, 12).map((s) => {
      const items = s.foreign.slice(0, 8);
      const more = s.foreign.length > items.length ? ` (+${s.foreign.length - items.length})` : '';
      return `  - wikidotId=${s.wikidotId} url=${s.url} foreign=[${items.join(', ')}]${more}`;
    });
    console.log('\n紧凑示例（前 12 条）：');
    for (const line of compact) console.log(line);
  }

  await disconnectPrisma();
}

main().catch((err) => {
  console.error('检查失败：', err);
  process.exitCode = 1;
}).finally(async () => {
  try { await disconnectPrisma(); } catch {}
});
