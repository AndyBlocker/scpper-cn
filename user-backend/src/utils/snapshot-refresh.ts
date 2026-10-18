// A refresh invalidated while loading may finish for its callers, but cannot publish.
export function createSnapshotRefresh<T>() {
  let generation = 0;
  let pending: Promise<T> | undefined;
  return {
    invalidate() {
      generation++;
      pending = undefined;
    },
    run(load: () => Promise<T>, publish: (value: T) => void): Promise<T> {
      if (pending) return pending;
      const started = generation;
      const result = Promise.resolve().then(load).then((value) => {
        if (started === generation) publish(value);
        return value;
      }).finally(() => {
        if (pending === result) pending = undefined;
      });
      pending = result;
      return result;
    }
  };
}

// Keyset paging bounds each Prisma/native result buffer; consume before fetching again.
export async function consumeIdPages<T extends { id: string }>(
  fetchPage: (after: string | undefined, take: number) => Promise<T[]>,
  consume: (row: T) => void,
  pageSize = 1000
): Promise<void> {
  let after: string | undefined;
  for (;;) {
    const rows = await fetchPage(after, pageSize);
    for (const row of rows) consume(row);
    if (rows.length < pageSize) return;
    after = rows[rows.length - 1]!.id;
  }
}
