#!/usr/bin/env node
// Build a minimal contests JSON from pre-extracted date lines (no network).
// Input: external/contest_events.json + external/contest_date_lines.json
// Output: frontend/public/contests-cn-events.json { items: RawEvent[] }

import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const eventsListPath = path.join(root, 'external', 'contest_events.json');
const dateLinesPath = path.join(root, 'external', 'contest_date_lines.json');
const outPath = path.join(root, 'frontend', 'public', 'contests-cn-events.json');

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// Normalize a Chinese datetime string into components {y,m,d,h,mi,s}
function normalizeDateStr(s) {
  let t = String(s);
  t = t.replace(/[（(]已截止[）)]/g, '');
  t = t.replace(/[（）]/g, '');
  t = t.replace(/：/g, ':');
  t = t.replace(/\s+/g, ' ').trim();
  t = t.replace(/正午\s*12\s*时?\s*整?/g, '12:00:00');
  t = t.replace(/(\d{1,2})\s*时\s*(\d{1,2})\s*分(\s*(\d{1,2})\s*秒)?/g, (m, h, mi, _s, s2) => `${h}:${mi}${s2 ? ':' + s2 : ''}`);
  t = t.replace(/(\d{1,2})\s*时(?!\d)/g, (m, h) => `${h}:00`);
  t = t.replace(/(\d{1,2})\s*分(?!\d)/g, (m, mi) => `${mi}`);
  t = t.replace(/北京时间|GMT\+8|UTC\+8|\(GMT\+8\)|\(UTC\+8\)/gi, '').trim();
  t = t.replace(/[。．·]+$/g, '').trim();
  return t;
}

function parseZhDate(s) {
  const t = normalizeDateStr(s);
  // Try ranges like: YYYY年M月D日 HH:MM[:SS] 至 YYYY年M月D日 HH:MM[:SS]
  let m = t.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}:[0-9]{2}(?::[0-9]{2})?)?\s*至\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}:[0-9]{2}(?::[0-9]{2})?)?/);
  if (m) {
    const s1 = toIso(+m[1], +m[2], +m[3], m[4] || '00:00:00');
    const s2 = toIso(+m[5], +m[6], +m[7], m[8] || '23:59:59');
    return { start: s1, end: s2 };
  }
  // Single datetime like: YYYY年M月D日 HH:MM[:SS]
  m = t.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}:[0-9]{2}(?::[0-9]{2})?)/);
  if (m) {
    const iso = toIso(+m[1], +m[2], +m[3], m[4]);
    return { single: iso };
  }
  // Date without explicit time: YYYY年M月D日
  m = t.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (m) {
    const iso = toIso(+m[1], +m[2], +m[3], '00:00:00');
    return { single: iso };
  }
  return null;
}

function extractAllDates(s) {
  const t = normalizeDateStr(s);
  const re = /(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}:[0-9]{2}(?::[0-9]{2})?)?/g;
  const out = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    out.push(toIso(+m[1], +m[2], +m[3], m[4] || '00:00:00'));
  }
  return out;
}

function toIso(y, m, d, timeStr) {
  // Ensure two-digit fields
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  let [hh = '00', mi = '00', ss = '00'] = String(timeStr || '00:00:00').split(':');
  hh = String(hh).padStart(2, '0');
  mi = String(mi).padStart(2, '0');
  ss = String(ss).padStart(2, '0');
  // Use +08:00 explicit offset to respect Beijing time
  return `${y}-${mm}-${dd}T${hh}:${mi}:${ss}+08:00`;
}

function pickStart(lines) {
  // Priority keywords for start
  const startKeys = [
    '开始投稿日期', '投稿开始日期', '开始投稿', '投稿开始',
    '征文开始日期',
    '条目投稿期间', '投稿期间', '条目投稿日期'
  ];
  // Try explicit ranges first (投稿期间 ... 至 ...)
  for (const line of lines) {
    const norm = normalizeDateStr(line);
    if (/投稿期间|条目投稿期间/.test(norm)) {
      const p = parseZhDate(norm);
      if (p?.start) return p.start;
    }
  }
  // Then first match by key order
  for (const key of startKeys) {
    const line = lines.find(l => l.includes(key));
    if (line) {
      const p = parseZhDate(line);
      if (p?.single) return p.single;
      if (p?.start) return p.start;
    }
  }
  // Heuristic: lines like “在北京时间…发布的参赛作品”
  for (const line of lines) {
    if (line.includes('在北京时间') && (line.includes('发布') || line.includes('参赛'))) {
      const p = parseZhDate(line);
      if (p?.single) return p.single;
    }
  }
  return null;
}

function pickEnd(lines) {
  // Priority keys for voting end
  const voteEndKeys = [
    '投票截止日期', '计票截止日期', '截止投票日期', '分数截止日期',
    '投票期间', '投票截止', '投票结束'
  ];
  // Prefer explicit voting period range
  for (const line of lines) {
    const norm = normalizeDateStr(line);
    if (/投票期间/.test(norm)) {
      const p = parseZhDate(norm);
      if (p?.end) return p.end;
    }
  }
  // Collect all candidates and take the latest
  const cands = [];
  for (const key of voteEndKeys) {
    for (const line of lines) {
      if (line.includes(key)) {
        // When a line contains multiple dates, prefer the last one on that line
        const all = extractAllDates(line);
        if (all.length > 0) cands.push(all[all.length - 1]);
        const p = parseZhDate(line);
        if (p?.end) cands.push(p.end);
      }
    }
  }
  if (cands.length > 0) {
    cands.sort((a, b) => new Date(a).valueOf() - new Date(b).valueOf());
    return cands[cands.length - 1];
  }
  // Fallback to 投稿截止/征文截止 when no voting end is present
  const endKeys = ['截止投稿日期', '投稿截止日期', '征文截止日期', '截止日期'];
  for (const key of endKeys) {
    for (const line of lines) {
      if (line.includes(key)) {
        const p = parseZhDate(line);
        if (p?.single) return setIsoTime(p.single, '23:59:59');
        if (p?.end) return p.end;
      }
    }
  }
  return null;
}

function setIsoTime(iso, time) {
  // Replace time part but keep timezone offset
  const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}([+\-]\d{2}:\d{2}|Z)?$/);
  if (!m) return iso;
  const date = m[1];
  const offset = m[2] || '+08:00';
  return `${date}T${time}${offset}`;
}

function build() {
  const events = readJson(eventsListPath);
  const lines = readJson(dateLinesPath);
  const linesBySlug = new Map(lines.map(x => [x.slug, x]));

  const items = [];
  for (const ev of events) {
    const entry = linesBySlug.get(ev.slug);
    const url = ev.slug.startsWith('http') ? ev.slug : `https://scp-wiki-cn.wikidot.com/${ev.slug}`;
    const candidateLines = Array.isArray(entry?.lines) ? entry.lines : [];
    const s = pickStart(candidateLines);
    const e = pickEnd(candidateLines);
    if (!s || !e) continue; // skip incomplete ones; we’ll fetch missing later
    const id = String(ev.slug);
    items.push({
      id,
      title: String(ev.title || id),
      summary: '中文分部征文/活动',
      color: '#ef4444',
      startsAt: s,
      endsAt: e,
      detailsMd: `来源：<${url}>\n\n> 自动抽取日期（需人工复核）。`,
      __local: true
    });
  }

  const payload = { items };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  console.log(`Wrote ${items.length} events to ${path.relative(root, outPath)}`);
}

build();
