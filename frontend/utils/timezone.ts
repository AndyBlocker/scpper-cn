export const CHINA_TZ = 'Asia/Shanghai';

const isoDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: CHINA_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

const dateTimePartsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: CHINA_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
});

type DateInput = Date | string | number;

function coerceDate(input: DateInput): Date | null {
  const value = input instanceof Date ? input : new Date(input);
  return Number.isNaN(value.getTime()) ? null : value;
}

export function formatDateUtc8(input: DateInput, options?: Intl.DateTimeFormatOptions): string {
  const value = coerceDate(input);
  if (!value) return '';
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: CHINA_TZ,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(options || {})
  });
  return formatter.format(value);
}

export function formatDateTimeUtc8(input: DateInput, options?: Intl.DateTimeFormatOptions): string {
  const value = coerceDate(input);
  if (!value) return '';
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: CHINA_TZ,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    ...(options || {})
  });
  return formatter.format(value);
}

export function formatDateIsoUtc8(input: DateInput): string {
  const value = coerceDate(input);
  if (!value) return '';
  return isoDateFormatter.format(value);
}

function extractParts(input: DateInput) {
  const value = coerceDate(input);
  if (!value) return null;
  const map: Record<string, string> = {};
  dateTimePartsFormatter.formatToParts(value).forEach((part) => {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  });
  const ms = value.getMilliseconds();
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    hour: map.hour,
    minute: map.minute,
    second: map.second,
    millisecond: ms.toString().padStart(3, '0')
  };
}

export function toUtc8Date(input: DateInput): Date | null {
  const parts = extractParts(input);
  if (!parts) return null;
  return new Date(
    `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.millisecond}+08:00`
  );
}

export function startOfUtc8Day(input: DateInput = new Date()): Date | null {
  const parts = extractParts(input);
  if (!parts) return null;
  return new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00.000+08:00`);
}

export function diffUtc8CalendarDays(later: DateInput, earlier: DateInput): number | null {
  const startLater = startOfUtc8Day(later);
  const startEarlier = startOfUtc8Day(earlier);
  if (!startLater || !startEarlier) return null;
  const diff = startLater.getTime() - startEarlier.getTime();
  return Math.round(diff / 86400000);
}

export function nowUtc8(): Date {
  const current = new Date();
  const coerced = toUtc8Date(current);
  return coerced ?? current;
}
