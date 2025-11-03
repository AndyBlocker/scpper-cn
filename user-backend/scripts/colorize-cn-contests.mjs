#!/usr/bin/env node
// Assign nicer colors to CN contest CalendarEvent rows directly in DB.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

function pickColor(title) {
  const t = String(title || '').toLowerCase();
  const has = (kw) => t.includes(kw);
  // Heuristic mapping
  if (has('scp-cn-3000') || has('scp-cn-2000') || has('scp-cn-1000') || has('cn-3000') || has('cn-2000') || has('cn-1000')) return '#ef4444'; // red-500
  if (has('冬季征文') || has('冬季')) return '#3b82f6'; // blue-500
  if (has('夏季征文') || has('夏季')) return '#f97316'; // orange-500
  if (has('新秀') || has('新人')) return '#22c55e'; // green-500
  if (has('设定')) return '#a855f7'; // purple-500
  if (has('图书馆')) return '#14b8a6'; // teal-500
  if (has('万圣节')) return '#ec4899'; // pink-500
  if (has('科幻月') || has('展示活动')) return '#06b6d4'; // cyan-500
  if (has('画廊')) return '#0ea5e9'; // sky-500
  if (has('短文')) return '#eab308'; // yellow-500
  if (has('反转生死') || has('凡人终死')) return '#64748b'; // slate-500
  if (has('怪谈') || has('灵异')) return '#fb7185'; // rose-400
  return '#6366f1'; // indigo-500 default
}

async function main() {
  const events = await prisma.calendarEvent.findMany({
    where: { id: { startsWith: 'cn-' } },
    select: { id: true, title: true, color: true }
  });
  let updated = 0;
  for (const ev of events) {
    const color = pickColor(ev.title);
    if (color && color !== ev.color) {
      await prisma.calendarEvent.update({ where: { id: ev.id }, data: { color } });
      updated++;
    }
  }
  console.log(`Colorized ${updated} events.`);
}

main().finally(async () => { await prisma.$disconnect(); });

