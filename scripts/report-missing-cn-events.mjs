#!/usr/bin/env node
// Report contests that were NOT buildable due to missing start/end time
// using the same heuristics as build-cn-contests-from-lines.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd());
const eventsListPath = path.join(root, 'external', 'contest_events.json');
const dateLinesPath = path.join(root, 'external', 'contest_date_lines.json');

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

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
function toIso(y, m, d, timeStr) {
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  let [hh = '00', mi = '00', ss = '00'] = String(timeStr || '00:00:00').split(':');
  hh = String(hh).padStart(2, '0');
  mi = String(mi).padStart(2, '0');
  ss = String(ss).padStart(2, '0');
  return `${y}-${mm}-${dd}T${hh}:${mi}:${ss}+08:00`;
}
function parseZhDate(s) {
  const t = normalizeDateStr(s);
  let m = t.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}:[0-9]{2}(?::[0-9]{2})?)?\s*至\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}:[0-9]{2}(?::[0-9]{2})?)?/);
  if (m) {
    const s1 = toIso(+m[1], +m[2], +m[3], m[4] || '00:00:00');
    const s2 = toIso(+m[5], +m[6], +m[7], m[8] || '23:59:59');
    return { start: s1, end: s2 };
  }
  m = t.match(/(\d{4})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}:[0-9]{2}(?::[0-9]{2})?)/);
  if (m) return { single: toIso(+m[1], +m[2], +m[3], m[4]) };
  m = t.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (m) return { single: toIso(+m[1], +m[2], +m[3], '00:00:00') };
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
function pickStart(lines) {
  const startKeys = [
    '开始投稿日期', '投稿开始日期', '开始投稿', '投稿开始',
    '征文开始日期',
    '条目投稿期间', '投稿期间', '条目投稿日期'
  ];
  for (const line of (lines || [])) {
    const norm = normalizeDateStr(line);
    if (/投稿期间|条目投稿期间/.test(norm)) {
      const p = parseZhDate(norm);
      if (p?.start) return p.start;
    }
  }
  for (const key of startKeys) {
    const line = (lines || []).find(l => String(l).includes(key));
    if (line) {
      const p = parseZhDate(line);
      if (p?.single) return p.single;
      if (p?.start) return p.start;
    }
  }
  for (const line of (lines || [])) {
    if (String(line).includes('在北京时间') && (String(line).includes('发布') || String(line).includes('参赛'))) {
      const p = parseZhDate(line);
      if (p?.single) return p.single;
    }
  }
  return null;
}
function pickEnd(lines) {
  const voteEndKeys = [
    '投票截止日期', '计票截止日期', '截止投票日期', '分数截止日期',
    '投票期间', '投票截止', '投票结束'
  ];
  for (const line of (lines || [])) {
    const norm = normalizeDateStr(line);
    if (/投票期间/.test(norm)) {
      const p = parseZhDate(norm);
      if (p?.end) return p.end;
    }
  }
  const cands = [];
  for (const key of voteEndKeys) {
    for (const line of (lines || [])) {
      if (String(line).includes(key)) {
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
  const endKeys = ['截止投稿日期', '投稿截止日期', '征文截止日期', '截止日期'];
  for (const key of endKeys) {
    for (const line of (lines || [])) {
      if (String(line).includes(key)) {
        const p = parseZhDate(line);
        if (p?.end) return p.end;
        if (p?.single) {
          const iso = p.single;
          const m = String(iso).match(/^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}([+\-]\d{2}:\d{2}|Z)?$/);
          if (m) return `${m[1]}T23:59:59${m[2] || '+08:00'}`;
          return iso;
        }
      }
    }
  }
  return null;
}
function latestDateInLines(lines) {
  const cands = [];
  for (const l of (lines || [])) {
    const p = parseZhDate(l);
    if (p?.end) cands.push(p.end);
    if (p?.single) cands.push(p.single);
    const all = extractAllDates(l);
    cands.push(...all);
  }
  if (cands.length === 0) return null;
  cands.sort((a, b) => new Date(a).valueOf() - new Date(b).valueOf());
  return cands[cands.length - 1];
}

function main() {
  const events = readJson(eventsListPath);
  const linesArr = readJson(dateLinesPath);
  const linesMap = new Map(linesArr.map(x => [x.slug, x]));
  const missing = [];
  for (const ev of events) {
    const entry = linesMap.get(ev.slug);
    const hasLines = entry && Array.isArray(entry.lines) && entry.lines.length > 0;
    const s = hasLines ? pickStart(entry.lines) : null;
    const e = hasLines ? pickEnd(entry.lines) : null;
    if (!hasLines || !s || !e) {
      missing.push({
        slug: ev.slug,
        title: ev.title,
        hasLines,
        missingStart: !s,
        missingEnd: !e,
        latest: hasLines ? (latestDateInLines(entry.lines) || null) : null,
        error: entry?.error || null
      });
    }
  }
  console.log(`Total contests: ${events.length}`);
  console.log(`Cannot build (missing time): ${missing.length}`);
  for (const m of missing) {
    const url = m.slug.startsWith('http') ? m.slug : `https://scp-wiki-cn.wikidot.com/${m.slug}`;
    const reason = m.hasLines
      ? [m.missingStart ? '缺少开始' : null, m.missingEnd ? '缺少投票截止' : null].filter(Boolean).join('+') || '未知'
      : (m.error ? `抓取失败: ${m.error}` : '未抽取到日期行');
    console.log(`- ${m.title} | ${url}`);
    console.log(`  原因: ${reason}`);
    console.log(`  该页出现的最晚时间: ${m.latest ?? '-'}`);
  }
}

main();

