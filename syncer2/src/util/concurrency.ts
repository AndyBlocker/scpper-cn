/**
 * 极小并发池。不引 p-limit —— 只有 4~10 个 sitemap 请求要并发，
 * 而且刻意保持"能一眼数清同时在飞的请求数"，这是出口礼貌的一部分。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const effective = Math.max(1, Math.min(limit, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  }

  await Promise.all(Array.from({ length: effective }, () => worker()));
  return results;
}

/** 分块，用于批量 SQL（避免单条语句参数数超过 65535）。 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size) as T[]);
  return out;
}
