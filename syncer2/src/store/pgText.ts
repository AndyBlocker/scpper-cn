/**
 * PostgreSQL 文本边界。
 *
 * PostgreSQL 的 text/jsonb 不能表示 U+0000；未配对 UTF-16 代理项也不是合法 Unicode。
 * 站点、HTTP 错误、旧库备注等自由文本在绑定参数前统一经过这里，避免“记录失败时再次
 * 失败”。替换使用 U+FFFD，既可打印、可搜索，也不会与业务文本里的普通空格混淆。
 */

import { createLogger } from '../util/log.js';

const log = createLogger('pg-text');
const REPLACEMENT = '\ufffd';

export const PAGE_SCAN_ERROR_MAX_UTF8_BYTES = 16 * 1024;

export interface PgTextSanitization {
  nulCodeUnits: number;
  loneSurrogates: number;
  truncated: boolean;
  originalUtf8Bytes: number;
  storedUtf8Bytes: number;
}

export interface SanitizedPgText {
  value: string;
  sanitation: PgTextSanitization;
}

export interface PgValueSanitization {
  stringsVisited: number;
  stringsChanged: number;
  nulCodeUnits: number;
  loneSurrogates: number;
}

export interface SanitizedPgValue<T> {
  value: T;
  sanitation: PgValueSanitization;
}

export interface PgTextSanitizationCounters extends PgValueSanitization {
  truncatedStrings: number;
}

const counters: PgTextSanitizationCounters = {
  stringsVisited: 0,
  stringsChanged: 0,
  nulCodeUnits: 0,
  loneSurrogates: 0,
  truncatedStrings: 0,
};

export function pgTextSanitizationCounters(): PgTextSanitizationCounters {
  return { ...counters };
}

/**
 * 清除 PG 不可表示的码元，并可按 UTF-8 字节安全截断（绝不切开一个 code point）。
 */
export function sanitizePgText(
  input: string,
  options: { maxUtf8Bytes?: number; context?: string; trace?: boolean } = {},
): SanitizedPgText {
  let nulCodeUnits = 0;
  let loneSurrogates = 0;
  let normalized = '';

  for (let index = 0; index < input.length; index++) {
    const unit = input.charCodeAt(index);
    if (unit === 0) {
      normalized += REPLACEMENT;
      nulCodeUnits++;
      continue;
    }
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = input.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        normalized += input[index]! + input[index + 1]!;
        index++;
      } else {
        normalized += REPLACEMENT;
        loneSurrogates++;
      }
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) {
      normalized += REPLACEMENT;
      loneSurrogates++;
      continue;
    }
    normalized += input[index]!;
  }

  const originalUtf8Bytes = Buffer.byteLength(input, 'utf8');
  const maxUtf8Bytes =
    options.maxUtf8Bytes === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, Math.floor(options.maxUtf8Bytes));
  const limited = truncateUtf8(normalized, maxUtf8Bytes);
  const sanitation: PgTextSanitization = {
    nulCodeUnits,
    loneSurrogates,
    truncated: limited.truncated,
    originalUtf8Bytes,
    storedUtf8Bytes: Buffer.byteLength(limited.value, 'utf8'),
  };

  counters.stringsVisited++;
  if (textWasSanitized(sanitation)) {
    counters.stringsChanged++;
    counters.nulCodeUnits += nulCodeUnits;
    counters.loneSurrogates += loneSurrogates;
    if (limited.truncated) counters.truncatedStrings++;
    if (options.trace !== false) {
      log.warn('PG 文本已清洗', {
        context: options.context ?? 'unspecified',
        ...sanitation,
      });
    }
  }
  return { value: limited.value, sanitation };
}

/**
 * 深度清洗 JSON/数组参数。Buffer 等非 plain object 保持原样；不会修改调用方对象。
 */
export function sanitizePgValue<T>(
  input: T,
  options: { context?: string; trace?: boolean } = {},
): SanitizedPgValue<T> {
  const aggregate: PgValueSanitization = {
    stringsVisited: 0,
    stringsChanged: 0,
    nulCodeUnits: 0,
    loneSurrogates: 0,
  };
  const seen = new WeakMap<object, unknown>();

  function visit(value: unknown): unknown {
    if (typeof value === 'string') {
      const sanitized = sanitizePgText(value, { trace: false });
      aggregate.stringsVisited++;
      if (textWasSanitized(sanitized.sanitation)) {
        aggregate.stringsChanged++;
        aggregate.nulCodeUnits += sanitized.sanitation.nulCodeUnits;
        aggregate.loneSurrogates += sanitized.sanitation.loneSurrogates;
      }
      return sanitized.value;
    }
    if (value === null || typeof value !== 'object') return value;
    if (Buffer.isBuffer(value) || value instanceof Date) return value;
    const cached = seen.get(value);
    if (cached !== undefined) return cached;
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      seen.set(value, out);
      for (const item of value) out.push(visit(item));
      return out;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value;
    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const [key, item] of Object.entries(value)) {
      const cleanKey = sanitizePgText(key, { trace: false });
      aggregate.stringsVisited++;
      if (textWasSanitized(cleanKey.sanitation)) {
        aggregate.stringsChanged++;
        aggregate.nulCodeUnits += cleanKey.sanitation.nulCodeUnits;
        aggregate.loneSurrogates += cleanKey.sanitation.loneSurrogates;
      }
      let storedKey = cleanKey.value;
      let collision = 1;
      while (Object.hasOwn(out, storedKey)) {
        storedKey = `${cleanKey.value}__syncer2_collision_${collision++}`;
      }
      out[storedKey] = visit(item);
    }
    return out;
  }

  const value = visit(input) as T;
  if (aggregate.stringsChanged > 0 && options.trace !== false) {
    log.warn('PG 结构化文本已清洗', {
      context: options.context ?? 'unspecified',
      ...aggregate,
    });
  }
  return { value, sanitation: aggregate };
}

/** JSONB 参数必须在 JSON.stringify 之前清洗，不能等转义成 "\\u0000" 后再处理。 */
export function toPgJson(value: unknown, context: string): string {
  return JSON.stringify(sanitizePgValue(value, { context }).value);
}

/**
 * page_scan.error 是不可失败的证据通道：清洗、限长，并把动作本身追加为可查询标记。
 */
export function sanitizePageScanError(
  input: string | null | undefined,
  context = 'meta.record_page_scan',
): string | null {
  if (input === null || input === undefined) return null;
  const first = sanitizePgText(input, { context, trace: false });
  const needsMarker =
    first.sanitation.nulCodeUnits > 0 ||
    first.sanitation.loneSurrogates > 0 ||
    Buffer.byteLength(first.value, 'utf8') > PAGE_SCAN_ERROR_MAX_UTF8_BYTES;
  if (!needsMarker) return first.value;

  const willTruncate =
    Buffer.byteLength(first.value, 'utf8') > PAGE_SCAN_ERROR_MAX_UTF8_BYTES;
  const marker =
    `\n[syncer2:text_sanitized nul=${first.sanitation.nulCodeUnits}` +
    ` lone_surrogate=${first.sanitation.loneSurrogates}` +
    ` truncated=${willTruncate ? 1 : 0}]`;
  const bodyLimit = Math.max(
    0,
    PAGE_SCAN_ERROR_MAX_UTF8_BYTES - Buffer.byteLength(marker, 'utf8'),
  );
  const body = truncateUtf8(first.value, bodyLimit);
  const output = `${body.value}${marker}`;
  log.warn('page_scan.error 已清洗', {
    context,
    nulCodeUnits: first.sanitation.nulCodeUnits,
    loneSurrogates: first.sanitation.loneSurrogates,
    truncated: body.truncated,
    originalUtf8Bytes: first.sanitation.originalUtf8Bytes,
    storedUtf8Bytes: Buffer.byteLength(output, 'utf8'),
  });
  return output;
}

export function textWasSanitized(value: PgTextSanitization): boolean {
  return value.nulCodeUnits > 0 || value.loneSurrogates > 0 || value.truncated;
}

function truncateUtf8(input: string, maxUtf8Bytes: number): {
  value: string;
  truncated: boolean;
} {
  if (!Number.isFinite(maxUtf8Bytes) || Buffer.byteLength(input, 'utf8') <= maxUtf8Bytes) {
    return { value: input, truncated: false };
  }
  let bytes = 0;
  let value = '';
  for (const character of input) {
    const width = Buffer.byteLength(character, 'utf8');
    if (bytes + width > maxUtf8Bytes) break;
    value += character;
    bytes += width;
  }
  return { value, truncated: true };
}
