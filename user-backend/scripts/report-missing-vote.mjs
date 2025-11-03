#!/usr/bin/env node
// Report CN events that lack explicit voting deadline in their source lines,
// and show the latest datetime found per event.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const linesPath = path.join(repoRoot, 'external', 'contest_date_lines.json');

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

function extractUrlFromDetailsMd(md) {
  if (!md) return null;
  const m = String(md).match(/<([^>]+)>/);
  return m ? m[1] : null;
}
function toSlugKeys(url) {
  if (!url) return [];
  try {
    const u = new URL(url);
    if (u.hostname.includes('scp-wiki-cn.wikidot.com') && u.pathname) {
      const slug = u.pathname.replace(/^\//, '').replace(/\/$/, '');
      return [slug, url, url.replace('https://', 'http://')];
    }
  } catch {
    // If not a URL, return both as-is
    return [url];
  }
  return [url];
}

function hasVoteKeyword(lines) {
  const keys = ['投票截止', '计票截止', '截止投票', '分数截止', '投票期间', '投票结束'];
  return Array.isArray(lines) && lines.some((l) => keys.some((k) => String(l).includes(k)));
}

function latestDateInLines(lines) {
  const cands = [];
  for (const l of (lines || [])) {
    const p = parseZhDate(l);
    if (p?.end) cands.push(p.end);
    if (p?.single) cands.push(p.single);
  }
  if (cands.length === 0) return null;
  cands.sort((a, b) => new Date(a).valueOf() - new Date(b).valueOf());
  return cands[cands.length - 1];
}

async function main() {
  const lines = readJson(linesPath);
  const map = new Map(lines.map(x => [x.slug, x]));
  const events = await prisma.calendarEvent.findMany({
    where: { id: { startsWith: 'cn-' } },
    orderBy: { startsAt: 'asc' }
  });
  const rows = [];
  for (const ev of events) {
    const url = extractUrlFromDetailsMd(ev.detailsMd);
    const keys = toSlugKeys(url);
    let entry = null;
    for (const k of keys) {
      entry = map.get(k);
      if (entry) break;
    }
    if (!entry) continue;
    const vote = hasVoteKeyword(entry.lines);
    if (!vote) {
      const latest = latestDateInLines(entry.lines) || ev.endsAt?.toISOString?.() || null;
      rows.push({ title: ev.title, endsAt: ev.endsAt, latest });
    }
  }
  // Print concise report
  console.log('缺乏“投票截止”关键字的活动与其包含的最晚时间:');
  for (const r of rows) {
    const endStr = r.endsAt ? new Date(r.endsAt).toISOString() : '-';
    console.log(`- ${r.title} | latest: ${r.latest || '-'} | endsAt: ${endStr}`);
  }
}

main().finally(async () => { await prisma.$disconnect(); });

