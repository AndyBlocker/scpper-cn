import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeIdPages, createSnapshotRefresh } from '../src/utils/snapshot-refresh.js';
import { deduplicatePoolByPage, type FlatPoolItem } from '../src/routes/gacha/_helpers.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('concurrent refreshes share work and reference; completion permits next refresh', async () => {
  const refresh = createSnapshotRefresh<object>();
  const gate = deferred<object>();
  let calls = 0;
  const published: object[] = [];
  const load = () => { calls++; return gate.promise; };
  const requests = Array.from({ length: 10 }, () => refresh.run(load, v => published.push(v)));
  gate.resolve({});
  const values = await Promise.all(requests);
  assert.equal(calls, 1);
  assert.ok(values.every(v => v === values[0]));
  assert.deepEqual(published, [values[0]]);
  await refresh.run(async () => { calls++; return {}; }, () => {});
  assert.equal(calls, 2);
});

test('failed refresh is cleared and can recover', async () => {
  const refresh = createSnapshotRefresh<number>();
  const failed = () => refresh.run(async () => { throw new Error('query failed'); }, () => assert.fail());
  await assert.rejects(Promise.all([failed(), failed()]), /query failed/);
  assert.equal(await refresh.run(async () => 42, () => {}), 42);
});

test('invalidation prevents old publication and old cleanup cannot clear newer work', async () => {
  const refresh = createSnapshotRefresh<number>();
  const old = deferred<number>();
  const fresh = deferred<number>();
  const published: number[] = [];
  const first = refresh.run(() => old.promise, v => published.push(v));
  refresh.invalidate();
  const second = refresh.run(() => fresh.promise, v => published.push(v));
  old.resolve(1);
  assert.equal(await first, 1);
  assert.deepEqual(published, []);
  assert.equal(refresh.run(async () => 99, () => assert.fail()), second);
  fresh.resolve(2);
  assert.equal(await second, 2);
  assert.deepEqual(published, [2]);
});

test('paged processing preserves page variants and weighting across boundaries', async () => {
  const row = (id: string, pageId: number | null, weight: number, imageUrl: string | null): FlatPoolItem => ({
    id, pageId, adjustedWeight: weight, imageUrl, title: id, rarity: 'WHITE',
    tags: ['test'], authors: [], wikidotId: null, rewardTokens: 2
  });
  const rows = [row('a', 1, 2, 'https://example.com/a.png'), row('b', null, 3, null),
    row('c', 1, 4, 'https://example.com/c.png'), row('d', 2, 0, null), row('e', null, 5, null)];
  const selected: FlatPoolItem[] = [];
  const cursors: Array<string | undefined> = [];
  await consumeIdPages(async (after, take) => {
    cursors.push(after);
    return rows.filter(r => after === undefined || r.id > after).slice(0, take);
  }, r => { if (r.adjustedWeight > 0) selected.push(r); }, 2);
  assert.deepEqual(cursors, [undefined, 'b', 'd']);
  const result = deduplicatePoolByPage(selected);
  assert.deepEqual(result, deduplicatePoolByPage(rows.filter(r => r.adjustedWeight > 0)));
  assert.deepEqual(result.map(r => r.adjustedWeight), [2, 3, 5]);
  assert.equal(result[0]!.variants.length, 2);
});

test('exactly full final page terminates on empty page and propagates query errors', async () => {
  let calls = 0;
  await consumeIdPages(async after => { calls++; return after ? [] : [{ id: 'a' }]; }, () => {}, 1);
  assert.equal(calls, 2);
  await assert.rejects(consumeIdPages(async () => { throw new Error('paging failed'); }, () => {}), /paging failed/);
});
