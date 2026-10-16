import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePageVoteMetrics as resolve, resolvePageRating } from '../utils/pageVoteMetrics.ts';

test('missing details do not become zero votes for a historical snapshot', () => {
  assert.equal(resolve({ upvotes: '0', downvotes: '0' }, null, 2204).available, false);
  assert.equal(resolve(null, null, null).available, false);
});
test('valid statistics remain available when vote details are missing or empty', () => {
  for (const distribution of [null, { upvotes: 0, downvotes: 0 }]) {
    assert.deepEqual(resolve(distribution, { hasStats: true, uv: '10', dv: '2' }, 12), { available: true, upvotes: 10, downvotes: 2 });
  }
});
test('actual details take precedence and verified zero-vote snapshots remain zero', () => {
  assert.deepEqual(resolve({ upvotes: '9', downvotes: '1' }, { hasStats: true, uv: 8, dv: 2 }, 10), { available: true, upvotes: 9, downvotes: 1 });
  assert.deepEqual(resolve({ upvotes: 0, downvotes: 0 }, null, 0), { available: true, upvotes: 0, downvotes: 0 });
});
test('invalid or uncomputed counters do not establish availability', () => {
  assert.equal(resolve({ upvotes: -1, downvotes: 1 }, { hasStats: false, uv: 10, dv: 2 }, 12).available, false);
  assert.equal(resolve({ upvotes: 'bad', downvotes: 1 }, null, 12).available, false);
});

test('missing rating and missing votes remain unknown rather than zero', () => {
  const unknown = resolve({ upvotes: 0, downvotes: 0 }, null, 2204);
  assert.equal(resolvePageRating(null, unknown), null);
  assert.equal(resolvePageRating(2024, unknown), 2024);
  assert.equal(resolvePageRating(null, resolve({ upvotes: 0, downvotes: 0 }, null, 0)), 0);
  assert.equal(resolvePageRating(null, resolve(null, { hasStats: true, uv: 8, dv: 2 }, 10)), 6);
});
