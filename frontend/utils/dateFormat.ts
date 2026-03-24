import { diffUtc8CalendarDays, nowUtc8 } from './timezone';

type DateLike = string | Date | null | undefined;

function parseDateInput(input?: DateLike): Date | null {
  if (!input) return null;
  const d = new Date(input as any);
  if (isNaN(d.getTime())) return null;
  return d;
}

function chineseNum(n: number, unit: string): string {
  if (n === 1) return `一${unit}前`;
  if (n === 2) return `两${unit}前`;
  return `${n}${unit}前`;
}

/**
 * Format a date to full GMT+8 datetime string: "2025-01-15 14:30:00 GMT+8"
 */
export function formatToGmt8Full(input?: DateLike): string {
  const d = parseDateInput(input);
  if (!d) return '—';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(d);
  const get = (type: string) => parts.find(p => p.type === type)?.value || '';
  const y = get('year');
  const M = get('month');
  const D = get('day');
  const h = get('hour');
  const m = get('minute');
  const s = get('second');
  return `${y}-${M}-${D} ${h}:${m}:${s} GMT+8`;
}

/**
 * Format a date as Chinese relative time: "刚刚", "一分钟前", "3小时前", etc.
 * Falls back to full GMT+8 format for future dates.
 */
export function formatRelativeZh(input?: DateLike, nowMs = Date.now()): string {
  const d = parseDateInput(input);
  if (!d) return '—';
  const diffMs = nowMs - d.getTime();
  if (diffMs < -60_000) return formatToGmt8Full(d);
  const diffSec = Math.max(0, Math.floor(diffMs / 1000));
  if (diffSec < 60) return '刚刚';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return chineseNum(mins, '分钟');
  const hours = Math.floor(mins / 60);
  if (hours < 24) return chineseNum(hours, '小时');
  const days = Math.floor(hours / 24);
  if (days < 30) return chineseNum(days, '天');
  const months = Math.floor(days / 30);
  if (months < 12) return chineseNum(months, '个月');
  const years = Math.floor(days / 365);
  return chineseNum(years, '年');
}

/**
 * Format a date as relative day-level time: "今天", "昨天", "5 天前", "2 个月前", etc.
 * Uses UTC+8 calendar day boundaries for diffing.
 */
export function formatRelativeTime(dateStr: string): string {
  if (!dateStr) return '';
  const diffDays = diffUtc8CalendarDays(nowUtc8(), dateStr);
  if (diffDays == null) return '';
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays < 30) return `${diffDays} 天前`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} 个月前`;
  return `${Math.floor(diffDays / 365)} 年前`;
}
