import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Isolate the bridge from DB bootstrap (which loads Prisma and environment files).
// Execute the actual bridge implementation with an injected pool; no DB is opened.
const source = await readFile(new URL('../src/bridge/MainDbBridge.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  transformers: {
    before: [() => node => ts.factory.updateSourceFile(
      node,
      node.statements.filter(statement => !ts.isImportDeclaration(statement)),
    )],
  },
});
const bridge = await import(`data:text/javascript;base64,${Buffer.from(`
  let pool;
  function getMainPool() { return pool; }
  export function setPool(value) { pool = value; }
  ${outputText}
  export { loadPageMapping };
`).toString('base64')}`);

function mapping(overrides = {}) {
  return {
    fullname: 'scp-cn-3000', page_id: '20', page_version_id: '200',
    wikidot_id: '1452014507', title: 'SCP-CN-3000', tags: [],
    rating: '2278', vote_count: '2400', is_deleted: false,
    ...overrides,
  };
}

test('URL reuse keeps first deterministic live mapping rather than deleted predecessor', async () => {
  let query;
  const pool = { query: async (sql, params) => {
    query = { sql, params };
    return { rows: [mapping(), mapping({ page_id: '10', page_version_id: '100', wikidot_id: '1451202340', is_deleted: true })] };
  } };
  const result = await bridge.loadPageMapping(pool);
  assert.equal(result.get('scp-cn-3000').wikidotId, 1452014507);
  assert.match(query.sql, /ORDER BY fullname, \(p\."isDeleted" OR pv\."isDeleted"\) ASC/);
  assert.match(query.sql, /pv\."validFrom" DESC, pv\.id DESC, p\.id DESC/);
  assert.deepEqual(query.params, [true]);
});

test('main bridge retains deleted-only mappings for restoration by Wikidot identity', async () => {
  const result = await bridge.loadPageMapping({ query: async () => ({ rows: [mapping({ is_deleted: true })] }) });
  assert.equal(result.get('scp-cn-3000').isDeleted, true);
});

test('alternate title maps to live version and checks deletion again at mutation time', async () => {
  const queries = [];
  bridge.setPool({ query: async (sql, params) => {
    queries.push({ sql, params });
    if (queries.length === 1) return { rows: [mapping()] };
    return { rowCount: 1 };
  } });
  const result = await bridge.bridgeAlternateTitles([{ fullname: 'scp-cn-3000', alternateTitle: '众节点永垂不朽' }]);
  assert.deepEqual(result, { updated: 1, skipped: 0 });
  assert.deepEqual(queries[0].params, [false]);
  assert.match(queries[0].sql, /p\."isDeleted" = false AND pv\."isDeleted" = false/);
  assert.deepEqual(queries[1].params, [[200], ['众节点永垂不朽']]);
  assert.match(queries[1].sql, /pv\."validTo" IS NULL AND pv\."isDeleted" = false/);
  assert.match(queries[1].sql, /p\."isDeleted" = false/);
});

test('alternate title skips deleted targets even if a stale mapping is supplied', async () => {
  let queries = 0;
  bridge.setPool({ query: async () => {
    queries++;
    return { rows: [mapping({ is_deleted: true })] };
  } });
  assert.deepEqual(await bridge.bridgeAlternateTitles([{ fullname: 'scp-cn-3000', alternateTitle: 'new' }]), { updated: 0, skipped: 1 });
  assert.equal(queries, 1);
});

test('attribution bridge excludes deleted versions and guards all metadata mutations', async () => {
  const queries = [];
  bridge.setPool({ query: async (sql, params) => {
    queries.push({ sql, params });
    if (queries.length === 1) return { rows: [mapping()] };
    if (sql.includes('FROM "User"')) return { rows: [] };
    return { rowCount: 1 };
  } });
  const result = await bridge.bridgeAttributions([{ pageFullname: 'scp-cn-3000', userName: 'author', normalizedType: 'AUTHOR', order: 0, date: null }]);
  assert.deepEqual(result, { written: 1, skipped: 0 });
  assert.deepEqual(queries[0].params, [false]);
  for (const { sql } of queries.slice(2)) {
    assert.match(sql, /pv\."validTo" IS NULL/);
    assert.match(sql, /pv\."isDeleted" = false/);
    assert.match(sql, /p\."isDeleted" = false/);
  }
});

test('attribution bridge skips deleted mappings without inserting or recounting', async () => {
  const queries = [];
  bridge.setPool({ query: async (sql, params) => {
    queries.push({ sql, params });
    return { rows: queries.length === 1 ? [mapping({ is_deleted: true })] : [] };
  } });
  const result = await bridge.bridgeAttributions([{ pageFullname: 'scp-cn-3000', userName: 'author', normalizedType: 'AUTHOR', order: 0, date: null }]);
  assert.deepEqual(result, { written: 0, skipped: 1 });
  assert.equal(queries.length, 2);
});

test('attribution guard rejecting a concurrent deletion reports a skipped write', async () => {
  let queryCount = 0;
  bridge.setPool({ query: async () => {
    queryCount++;
    if (queryCount === 1) return { rows: [mapping()] };
    if (queryCount === 2) return { rows: [] };
    return { rowCount: 0 };
  } });
  const result = await bridge.bridgeAttributions([{ pageFullname: 'scp-cn-3000', userName: 'author', normalizedType: 'AUTHOR', order: 0, date: null }]);
  assert.deepEqual(result, { written: 0, skipped: 1 });
});
