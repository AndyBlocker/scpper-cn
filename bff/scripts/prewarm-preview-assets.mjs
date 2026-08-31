#!/usr/bin/env node
/**
 * 预热页面预览用到的静态资源。
 *
 * 预览里的图片是运行时向 wikidot / wdfiles 回源取的，而那条链路对国内很不稳定
 * ——经常整段时间连不上，导致正文插图集体裂图。这个脚本趁链路通的时候把资源
 * 抓进 css-proxy 的磁盘缓存；缓存现在是 stale-while-revalidate + 容量 LRU，
 * 抓进来的内容不会因为过期被删掉。
 *
 * 资源清单直接从预览接口的输出里提取，保证跟浏览器实际会请求的完全一致
 * （包括 BFF 出口新增的内联 CSS 改写），不需要在这里复刻一份改写逻辑。
 *
 * 用法：
 *   node scripts/prewarm-preview-assets.mjs [--limit N] [--concurrency N] [--dry-run]
 *   node scripts/prewarm-preview-assets.mjs --base http://127.0.0.1:4396
 */
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import 'dotenv/config';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = Number(arg('limit', 0)) || 0;
const PAGE_CONCURRENCY = Number(arg('concurrency', 6));
const ASSET_CONCURRENCY = Number(arg('asset-concurrency', 6));
const BASE = String(arg('base', 'http://127.0.0.1:4396')).replace(/\/+$/, '');
const CACHE_DIR = process.env.CSS_PROXY_CACHE_DIR || path.resolve(process.cwd(), 'cache/css-proxy');

const SYNCER_DB_URL = process.env.SYNCER_DATABASE_URL || '';
if (!SYNCER_DB_URL) {
  console.error('SYNCER_DATABASE_URL 未配置');
  process.exit(1);
}

// 带内部密钥，避免占用面向公网的限流额度（见 bff/src/web/utils/internal-key.ts）
const INTERNAL_KEY = (process.env.BFF_INTERNAL_API_KEY || '').trim();
if (!INTERNAL_KEY) {
  console.warn('警告：BFF_INTERNAL_API_KEY 未配置，预热请求会占用公网限流额度并很快被 429');
}
const HEADERS = INTERNAL_KEY ? { 'x-internal-key': INTERNAL_KEY } : {};

/** 读完或丢弃响应体，否则 Node 的 fetch 无法回收连接，并发上限会形同虚设 */
async function drain(res) {
  try { await res.body?.cancel(); } catch { /* 已被消费或已关闭 */ }
}

const isCached = (url) =>
  fs.existsSync(path.join(CACHE_DIR, createHash('sha256').update(url).digest('hex') + '.meta'));

/** 以固定并发跑完一批任务，返回抛错的条数（不能静默吞掉：BFF 挂了要能看出来） */
async function pool(items, concurrency, worker) {
  let cursor = 0;
  let errors = 0;
  let firstError = null;
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      try {
        await worker(item);
      } catch (err) {
        errors += 1;
        firstError ??= err;
      }
    }
  });
  await Promise.all(runners);
  return { errors, firstError };
}

const client = new pg.Client({ connectionString: SYNCER_DB_URL });
await client.connect();
const { rows } = await client.query(
  `SELECT "wikidotId" FROM "PageContentCache"
   WHERE "fullPageHtml" IS NOT NULL AND "wikidotId" IS NOT NULL
   ORDER BY "wikidotId"
   ${LIMIT ? `LIMIT ${LIMIT}` : ''}`,
);
await client.end();
console.log(`待扫描页面：${rows.length}`);

/**
 * 从预览 HTML 里取出所有代理资源。
 *
 * 不能简单地用字符黑名单去截断 —— 代理链接的 ?url= 参数里可能出现 ( ) '，
 * 靠边界字符切会把 `image (1).png` 这类文件名截断。这里按承载它的语法结构来解析：
 * HTML 属性看引号，CSS 的 url() 看括号/引号。
 */
function collectProxyTargets(html, into) {
  const push = (raw) => {
    const m = /[?&]url=([^&#]+)/.exec(raw);
    if (!m) return;
    try { into.add(decodeURIComponent(m[1])); } catch { /* 跳过坏链接 */ }
  };
  // href="..." / src="..."（含单引号写法）
  for (const m of html.matchAll(/\b(?:href|src)=("([^"]*)"|'([^']*)')/gi)) {
    const value = m[2] ?? m[3] ?? '';
    if (value.includes('css-proxy')) push(value);
  }
  // CSS 的 url(...)：有引号就按引号取；无引号时允许成对的括号，
  // 因为 syncer 生成的代理链接用的是裸 encodeURIComponent，不转义 ( )，
  // 直接切到第一个 ) 会把 `image (1).png` 这类文件名截断
  for (const m of html.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^()]*(?:\([^()]*\)[^()]*)*))\s*\)/gi)) {
    const value = m[1] ?? m[2] ?? m[3] ?? '';
    if (value.includes('css-proxy')) push(value);
  }
}

// ── 1. 收集资源清单 ──
const assets = new Set();
let scanned = 0;
let scanFailed = 0;
const scan = await pool(rows, PAGE_CONCURRENCY, async ({ wikidotId }) => {
  const res = await fetch(`${BASE}/pages/${wikidotId}/preview`, { headers: HEADERS });
  if (res.ok) collectProxyTargets(await res.text(), assets);
  else { scanFailed += 1; await drain(res); }
  if (++scanned % 500 === 0) console.log(`  已扫描 ${scanned}/${rows.length}，累计资源 ${assets.size}`);
});
if (scan.errors) {
  console.warn(`扫描阶段有 ${scan.errors} 个页面请求抛错，首个错误：${scan.firstError?.message || scan.firstError}`);
}
if (scanFailed) console.warn(`扫描阶段有 ${scanFailed} 个页面返回非 2xx`);
if (assets.size === 0) {
  console.error('没有提取到任何资源 —— 请确认 BFF 正在运行且 --base 指向正确');
  process.exit(1);
}

const all = [...assets];
console.log(`\n页面里直接引用的唯一资源 ${all.length}，其中已缓存 ${all.filter(isCached).length}`);

if (DRY_RUN) {
  console.log('--dry-run：不实际抓取（也不会展开 CSS 里的嵌套依赖）');
  process.exit(0);
}

// ── 2. 逐个走一遍 css-proxy，让服务端按自己的规则抓取并落盘 ──
//
// 用工作队列而不是固定列表：主题 CSS 里的背景图/图标/字体，其代理链接是
// css-proxy 在返回 CSS 时才生成的，压根不出现在页面 HTML 里。所以遇到 CSS
// 要把响应读出来、把里面的代理目标继续入队，否则这些资源永远预热不到。
const MAX_DEPTH = Number(arg('max-depth', 4));
const queued = new Set(all);
const queue = all.map((url) => ({ url, depth: 0 }));

let warmed = 0, hit = 0, failed = 0, done = 0, discovered = 0;
let cursor = 0;
let errors = 0;
let firstError = null;

async function worker() {
  while (cursor < queue.length) {
    const { url, depth } = queue[cursor++];
    const wasCached = isCached(url);
    try {
      const res = await fetch(`${BASE}/css-proxy?url=${encodeURIComponent(url)}`, { headers: HEADERS });
      const type = String(res.headers.get('content-type') || '');
      if (res.ok && type.includes('css') && depth < MAX_DEPTH) {
        const css = await res.text();
        const nested = new Set();
        collectProxyTargets(css, nested);
        for (const next of nested) {
          if (queued.has(next)) continue;
          queued.add(next);
          queue.push({ url: next, depth: depth + 1 });
          discovered += 1;
        }
      } else {
        await drain(res);
      }
      // 回源失败时 CSS 会以注释形式软失败，用是否真的落盘来判定成功与否
      if (res.ok && isCached(url)) { wasCached ? hit++ : warmed++; } else { failed++; }
    } catch (err) {
      errors += 1;
      failed += 1;
      firstError ??= err;
    }
    if (++done % 200 === 0) {
      console.log(`  已处理 ${done}/${queue.length}（新抓 ${warmed} / 已有 ${hit} / 失败 ${failed}，` +
                  `从 CSS 里发现 ${discovered}）`);
    }
  }
}

await Promise.all(Array.from({ length: Math.max(1, ASSET_CONCURRENCY) }, worker));

if (errors) {
  console.warn(`抓取阶段有 ${errors} 个请求抛错，首个错误：${firstError?.message || firstError}`);
}
console.log(`\n完成：处理 ${done} 个资源（其中 ${discovered} 个是从 CSS 里递归发现的）`);
console.log(`      新抓取 ${warmed}，已在缓存 ${hit}，失败 ${failed}`);
if (failed) console.log('失败多半是上游 wikidot / wdfiles 当前不可达，链路恢复后重跑即可。');
if (warmed === 0 && failed > 0) process.exit(1);
