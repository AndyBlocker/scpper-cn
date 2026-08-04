/**
 * Tier2 采集结果的统一形状。
 *
 * 最重要的语义不是泛型，而是 `failed` 必须作为一等结果留在 Map 里：
 * 调用方不能通过“键不存在”或 `?? []` 猜测扫描是否成功。`partial` 仍携带已解析
 * 数据，便于留证与排障，但调用方不得据此写事实/投影。
 */

export interface CollectDiagnostics {
  claimedTotal: number | null;
  fetchedTotal: number | null;
  warnings: string[];
}

export type CollectResult<T> =
  | {
      status: 'ok';
      data: T;
      diagnostics: CollectDiagnostics;
    }
  | {
      status: 'partial';
      data: T;
      error: string;
      diagnostics: CollectDiagnostics;
    }
  | {
      status: 'failed';
      error: string;
      diagnostics: CollectDiagnostics;
    };

export interface PageCollectTarget {
  /** v2 内部 `ingest.page.id`，也是结果 Map 的键。 */
  pageId: number;
  /** wikidot 原始 pageId；每次定向抓取携带，落库时必须回显给 apply_*。 */
  wikidotId: number;
  /** 需要整页 GET 时必填。 */
  slug?: string;
}

export function diagnostics(
  claimedTotal: number | null = null,
  fetchedTotal: number | null = null,
  warnings: string[] = [],
): CollectDiagnostics {
  return { claimedTotal, fetchedTotal, warnings };
}

export function ok<T>(data: T, d: CollectDiagnostics = diagnostics()): CollectResult<T> {
  return { status: 'ok', data, diagnostics: d };
}

export function partial<T>(
  data: T,
  error: string,
  d: CollectDiagnostics = diagnostics(),
): CollectResult<T> {
  return { status: 'partial', data, error, diagnostics: d };
}

export function failed<T>(
  error: string,
  d: CollectDiagnostics = diagnostics(),
): CollectResult<T> {
  return { status: 'failed', error, diagnostics: d };
}

/** 防止重复键在 Map 构造时静默覆盖，造成“某页从结果里消失”。 */
export function assertUniqueKeys<T, K>(items: readonly T[], keyOf: (item: T) => K): void {
  const seen = new Set<K>();
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) {
      throw new Error(`采集目标键重复：${String(key)}。拒绝静默覆盖 Map 结果。`);
    }
    seen.add(key);
  }
}
