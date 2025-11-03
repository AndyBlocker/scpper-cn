#!/usr/bin/env node
// Fetch contest pages and extract key date lines for building calendar events.
// Updates external/contest_date_lines.json

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const eventsListPath = path.join(root, 'external', 'contest_events.json');
const outPath = path.join(root, 'external', 'contest_date_lines.json');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJson(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8'); }

function toUrl(slug) {
  return slug.startsWith('http') ? slug : `https://scp-wiki-cn.wikidot.com/${slug}`;
}

function extractLines(html) {
  // Very permissive text extraction
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, ' ')
    .replace(/\s+/g, ' ');
  const sentences = text.split(/(?:(?:。|！|!|？|\.|\n)\s*)/g).map(s => s.trim()).filter(Boolean);
  const keep = [];
  const keywords = [
    '开始投稿日期', '投稿开始日期', '开始投稿', '投稿开始', '开始参与',
    '征文开始日期', '征文开始',
    '投稿期间', '条目投稿期间',
    '投票期间', '投票截止日期', '计票截止日期', '截止投票日期', '分数截止日期', '投票截止', '投票结束',
    '征文截止日期', '投稿截止日期', '截止投稿日期', '截止日期'
  ];
  for (const s of sentences) {
    if (keywords.some(k => s.includes(k))) {
      keep.push(s);
    }
  }
  // Additionally, capture explicit datetime sentences
  const dtRe = /(\d{4})年\s*\d{1,2}月\s*\d{1,2}日/;
  for (const s of sentences) {
    if (dtRe.test(s) && (s.includes('北京时间') || s.includes('GMT+8') || s.includes('UTC+8'))) {
      if (!keep.includes(s)) keep.push(s);
    }
  }
  return keep;
}

async function fetchOne(slug, title) {
  const url = toUrl(slug);
  try {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const lines = extractLines(html);
    return { slug, title, url, lines };
  } catch (err) {
    return { slug, title, url, error: String(err && err.message || err) };
  }
}

async function main() {
  const events = readJson(eventsListPath);
  const prev = fs.existsSync(outPath) ? readJson(outPath) : [];
  const prevMap = new Map(prev.map(x => [x.slug, x]));

  const tasks = [];
  for (const ev of events) {
    const entry = prevMap.get(ev.slug);
    if (entry && Array.isArray(entry.lines) && entry.lines.length > 0) {
      // keep as-is
      tasks.push(Promise.resolve({ ...entry }));
    } else {
      tasks.push(fetchOne(ev.slug, ev.title));
    }
  }

  // Limit concurrency to 4
  const results = [];
  const concurrency = 4;
  let i = 0;
  async function runNext() {
    if (i >= tasks.length) return;
    const idx = i++;
    const res = await tasks[idx];
    results[idx] = res;
    await runNext();
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => runNext()));

  writeJson(outPath, results);
  const ok = results.filter(r => Array.isArray(r.lines) && r.lines.length > 0).length;
  const err = results.filter(r => r.error).length;
  console.log(`Updated ${results.length} entries; ${ok} with lines, ${err} errors.`);
}

main();

