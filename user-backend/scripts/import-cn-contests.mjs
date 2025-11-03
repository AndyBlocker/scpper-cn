#!/usr/bin/env node
// Import CN Branch contests/events directly into the database (CalendarEvent).
// Prefers reading pre-built events from frontend/public/contests-cn-events.json.
// If missing, tries to build from external/contest_events.json + external/contest_date_lines.json.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const prisma = new PrismaClient();

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

function sanitizeId(slug) {
  const base = String(slug).trim().toLowerCase();
  const safe = base.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `cn-${safe}`;
}

function toItemsFromPublicJson() {
  const publicJson = path.join(repoRoot, 'frontend', 'public', 'contests-cn-events.json');
  if (!exists(publicJson)) return null;
  const data = readJson(publicJson);
  if (!data || !Array.isArray(data.items)) return null;
  return data.items.map((it) => ({
    id: sanitizeId(it.id || it.title),
    title: String(it.title || it.id),
    summary: it.summary ?? null,
    color: it.color ?? '#ef4444',
    startsAt: new Date(it.startsAt),
    endsAt: new Date(it.endsAt),
    detailsMd: (it.detailsMd ? String(it.detailsMd) : null),
    isPublished: true
  }));
}

// Minimal builder using the same heuristics used in scripts/build-cn-contests-from-lines.mjs
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
function setIsoTime(iso, time) {
  const mm = String(iso).match(/^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}([+\-]\d{2}:\d{2}|Z)?$/);
  if (!mm) return iso;
  const date = mm[1];
  const offset = mm[2] || '+08:00';
  return `${date}T${time}${offset}`;
}
function pickStart(lines) {
  const startKeys = [
    '开始投稿日期', '投稿开始日期', '开始投稿', '投稿开始',
    '征文开始日期',
    '条目投稿期间', '投稿期间', '条目投稿日期'
  ];
  for (const line of lines) {
    const norm = normalizeDateStr(line);
    if (/投稿期间|条目投稿期间/.test(norm)) {
      const p = parseZhDate(norm);
      if (p?.start) return p.start;
    }
  }
  for (const key of startKeys) {
    const line = lines.find(l => l.includes(key));
    if (line) {
      const p = parseZhDate(line);
      if (p?.single) return p.single;
      if (p?.start) return p.start;
    }
  }
  for (const line of lines) {
    if (line.includes('在北京时间') && (line.includes('发布') || line.includes('参赛'))) {
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
  for (const line of lines) {
    const norm = normalizeDateStr(line);
    if (/投票期间/.test(norm)) {
      const p = parseZhDate(norm);
      if (p?.end) return p.end;
    }
  }
  const cands = [];
  for (const key of voteEndKeys) {
    for (const line of lines) {
      if (line.includes(key)) {
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
function toItemsFromExternal() {
  const eventsList = path.join(repoRoot, 'external', 'contest_events.json');
  const linesPath = path.join(repoRoot, 'external', 'contest_date_lines.json');
  if (!exists(eventsList) || !exists(linesPath)) return null;
  const events = readJson(eventsList);
  const lines = readJson(linesPath);
  const map = new Map(lines.map(x => [x.slug, x]));
  const items = [];
  for (const ev of events) {
    const entry = map.get(ev.slug);
    const url = ev.slug.startsWith('http') ? ev.slug : `https://scp-wiki-cn.wikidot.com/${ev.slug}`;
    const candidateLines = Array.isArray(entry?.lines) ? entry.lines : [];
    const s = pickStart(candidateLines);
    const e = pickEnd(candidateLines);
    if (!s || !e) continue;
    items.push({
      id: sanitizeId(ev.slug),
      title: String(ev.title || ev.slug),
      summary: '中文分部征文/活动',
      color: '#ef4444',
      startsAt: new Date(s),
      endsAt: new Date(e),
      detailsMd: `来源：<${url}>\n\n> 自动抽取日期（需人工复核）。`,
      isPublished: true
    });
  }
  return items;
}

async function main() {
  const fromPublic = toItemsFromPublicJson();
  const items = fromPublic ?? toItemsFromExternal();
  if (!items || items.length === 0) {
    console.error('No contest items found to import.');
    process.exit(1);
  }

  let created = 0, updated = 0;
  for (const it of items) {
    const data = {
      title: it.title,
      summary: it.summary,
      color: it.color,
      startsAt: it.startsAt,
      endsAt: it.endsAt,
      detailsMd: it.detailsMd,
      isPublished: true
    };
    const existing = await prisma.calendarEvent.findUnique({ where: { id: it.id } }).catch(() => null);
    if (existing) {
      await prisma.calendarEvent.update({ where: { id: it.id }, data });
      updated++;
    } else {
      await prisma.calendarEvent.create({ data: { id: it.id, ...data } });
      created++;
    }
  }
  console.log(`Imported contests → created: ${created}, updated: ${updated}`);
}

main().finally(async () => { await prisma.$disconnect(); });
