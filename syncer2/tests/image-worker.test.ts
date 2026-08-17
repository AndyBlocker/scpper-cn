process.env.SYNCER2_LOG_LEVEL = 'error';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';

import { TransportError } from '../src/http/client.js';
import { evaluateImagePipelineHealth } from '../src/image/health.js';
import {
  classifyImageEgress,
  imageHostAllowed,
  processImageJob,
  storeAssetBuffer,
  verifyStoredAsset,
  type ImageWorkerOptions,
} from '../src/image/worker.js';

function failurePool(): Pool {
  const client = {
    query: async (sql: string) => {
      if (/^(?:BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: null };
      if (sql.includes('UPDATE serve.page_image')) return { rows: [], rowCount: 1 };
      if (sql.includes('UPDATE meta.image_ingest_job')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    },
    release: () => undefined,
  };
  return {
    connect: async () => client,
    query: async (sql: string) => {
      if (sql.includes('FROM serve.page_image pi')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM serve.image_asset_url_alias alias')) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected pool SQL: ${sql}`);
    },
  } as unknown as Pool;
}

const options: ImageWorkerOptions = {
  siteHost: 'scp-wiki-cn.wikidot.com',
  assetRoot: '/tmp/syncer2-image-worker-test',
  maxBytes: 20 * 1024 * 1024,
  maxAttempts: 5,
  allowedHosts: ['*.wikidot.com', '*.wdfiles.com'],
  blockedHosts: ['localhost'],
  retryBaseMs: 1_000,
  retryMaxMs: 10_000,
};

function validPngFixture(): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(1, 16);
  buffer.writeUInt32BE(1, 20);
  return buffer;
}

test('图片 egress：站内才走共享 Wikidot gate；wdfiles 外站失败不触碰其健康窗口', async () => {
  let sharedGateAttempts = 0;
  let externalAttempts = 0;
  const clients = {
    wikidot: {
      get: async () => {
        sharedGateAttempts++;
        throw new TransportError('timeout', 'https://scp-wiki-cn.wikidot.com/x.png', new Error('x'));
      },
    },
    external: {
      get: async () => {
        externalAttempts++;
        throw new TransportError('timeout', 'https://scp-wiki-cn.wdfiles.com/x.png', new Error('x'));
      },
    },
  };
  const external = await processImageJob(
    failurePool(),
    {
      id: 1, pageId: 10, normalizedUrl: 'https://scp-wiki-cn.wdfiles.com/x.png',
      displayUrl: 'https://scp-wiki-cn.wdfiles.com/x.png', attempts: 1,
    },
    clients,
    options,
  );
  assert.equal(external.egressClass, 'external');
  assert.equal(external.failureClass, 'timeout');
  assert.equal(externalAttempts, 1);
  assert.equal(sharedGateAttempts, 0, '外站失败不得计入/触发 Wikidot 自适应 gate');

  const site = await processImageJob(
    failurePool(),
    {
      id: 2, pageId: 11, normalizedUrl: 'https://scp-wiki-cn.wikidot.com/x.png',
      displayUrl: 'https://scp-wiki-cn.wikidot.com/x.png', attempts: 1,
    },
    clients,
    options,
  );
  assert.equal(site.egressClass, 'wikidot_site');
  assert.equal(sharedGateAttempts, 1, '站内图片必须经过共享 gate client');
});

test('图片 host 安全边界与 egress 分类', () => {
  assert.equal(classifyImageEgress(
    'https://scp-wiki-cn.wikidot.com/local--files/x/a.png',
    options.siteHost,
  ), 'wikidot_site');
  assert.equal(classifyImageEgress(
    'https://scp-wiki-de.wdfiles.com/local--files/x/a.png',
    options.siteHost,
  ), 'external');
  assert.equal(imageHostAllowed('https://scp-wiki-de.wdfiles.com/a.png', options.allowedHosts, []), true);
  assert.equal(imageHostAllowed('http://127.0.0.1/a.png', ['*'], []), false);
});

test('v1 alias 的 SHA 文件已在共享目录：逐字节校验后直接建引用，绝不出站', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'syncer2-image-reuse-'));
  const body = Buffer.from('already safely stored by v1');
  const hashHex = createHash('sha256').update(body).digest('hex');
  const hash = Buffer.from(hashHex, 'hex');
  const storagePath = path.join(
    hashHex.slice(0, 2), hashHex.slice(2, 4), hashHex.slice(4, 6), `${hashHex}.bin`,
  );
  await storeAssetBuffer(root, storagePath, body, hashHex);
  const client = {
    query: async (sql: string) => {
      if (/^(?:BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: null };
      if (sql.includes('UPDATE serve.page_image')) return { rows: [], rowCount: 1 };
      if (sql.includes('UPDATE meta.image_ingest_job')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected transaction SQL: ${sql}`);
    },
    release: () => undefined,
  };
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('FROM serve.page_image pi')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM serve.image_asset_url_alias alias')) {
        return { rows: [{ asset_sha: hash, storage_path: storagePath }], rowCount: 1 };
      }
      throw new Error(`unexpected pool SQL: ${sql}`);
    },
    connect: async () => client,
  } as unknown as Pool;
  let downloads = 0;
  const noDownload = { get: async () => { downloads++; throw new Error('不得下载'); } };
  const result = await processImageJob(
    pool,
    {
      id: 3, pageId: 12, normalizedUrl: 'https://scp-wiki-cn.wdfiles.com/same.png',
      displayUrl: 'https://scp-wiki-cn.wdfiles.com/same.png', attempts: 1,
    },
    { wikidot: noDownload, external: noDownload },
    { ...options, assetRoot: root },
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.bytes, 0);
  assert.equal(result.hashHex, hashHex);
  assert.equal(downloads, 0);
  await rm(root, { recursive: true, force: true });
});

test('SHA 文件不存在：下载后 temp+fsync+同目录 rename，最终路径从未暴露半截内容', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'syncer2-image-atomic-'));
  const body = Buffer.alloc(8 * 1024 * 1024, 0x5a);
  const hashHex = createHash('sha256').update(body).digest('hex');
  const relativePath = path.join(
    hashHex.slice(0, 2), hashHex.slice(2, 4), hashHex.slice(4, 6), `${hashHex}.png`,
  );
  const finalPath = path.join(root, relativePath);
  let settled = false;
  const observedLengths: number[] = [];
  const writing = storeAssetBuffer(root, relativePath, body, hashHex).finally(() => {
    settled = true;
  });
  while (!settled) {
    await readFile(finalPath).then((value) => observedLengths.push(value.length)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  await writing;
  observedLengths.push((await readFile(finalPath)).length);
  assert.ok(observedLengths.length >= 1);
  assert.ok(observedLengths.every((length) => length === body.length), 'final 名只能读到完整文件');
  assert.equal(await verifyStoredAsset(root, relativePath, hashHex), 'verified');
  assert.deepEqual(
    (await readdir(path.dirname(finalPath))).filter((name) => name.includes('.tmp-')),
    [],
  );
  await rm(root, { recursive: true, force: true });
});

test('v1 alias 指向的 SHA 路径缺失时不伪复用：实际下载并原子补齐共享目录', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'syncer2-image-download-'));
  const body = validPngFixture();
  const hashHex = createHash('sha256').update(body).digest('hex');
  const hash = Buffer.from(hashHex, 'hex');
  const storagePath = path.join(
    hashHex.slice(0, 2), hashHex.slice(2, 4), hashHex.slice(4, 6), `${hashHex}.png`,
  );
  const tx = {
    query: async (sql: string) => {
      if (/^(?:BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: null };
      if (sql.includes('INSERT INTO serve.image_asset')) return { rows: [], rowCount: 1 };
      if (sql.includes('UPDATE serve.page_image')) return { rows: [], rowCount: 1 };
      if (sql.includes('UPDATE meta.image_ingest_job')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected transaction SQL: ${sql}`);
    },
    release: () => undefined,
  };
  const pool = {
    query: async (sql: string) => {
      if (sql.includes('FROM serve.page_image pi')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM serve.image_asset_url_alias alias')) {
        return { rows: [{ asset_sha: hash, storage_path: storagePath }], rowCount: 1 };
      }
      if (sql.includes('SELECT storage_path FROM serve.image_asset')) {
        return { rows: [{ storage_path: storagePath }], rowCount: 1 };
      }
      throw new Error(`unexpected pool SQL: ${sql}`);
    },
    connect: async () => tx,
  } as unknown as Pool;
  let downloads = 0;
  const external = {
    get: async () => {
      downloads++;
      return {
        status: 200,
        headers: { 'content-type': 'image/png' },
        body,
        text: () => body.toString('utf8'),
        telemetry: {},
      } as never;
    },
  };
  const noWikidot = { get: async () => { throw new Error('不应走 wikidot'); } };
  const result = await processImageJob(
    pool,
    {
      id: 4,
      pageId: 13,
      normalizedUrl: 'https://scp-wiki-cn.wdfiles.com/missing.png',
      displayUrl: 'https://scp-wiki-cn.wdfiles.com/missing.png',
      attempts: 1,
    },
    { wikidot: noWikidot, external },
    { ...options, assetRoot: root },
  );
  assert.equal(downloads, 1);
  assert.equal(result.status, 'completed');
  assert.equal(await verifyStoredAsset(root, storagePath, hashHex), 'verified');
  assert.deepEqual(
    (await readdir(path.dirname(path.join(root, storagePath)))).filter((name) => name.includes('.tmp-')),
    [],
  );
  await rm(root, { recursive: true, force: true });
});

test('站外失败只进入 external 分链路，wikidot 成功率与 breaker 判据不受污染', () => {
  const health = evaluateImagePipelineHealth(
    {
      wikidot_site: { claimed: 10, completed: 10, retry: 0, failed: 0, healthExcluded: 0 },
      external: { claimed: 10, completed: 0, retry: 10, failed: 0, healthExcluded: 0 },
    },
    { wikidotSite: false, external: false },
  );
  assert.equal(health.wikidotSite.status, 'ok');
  assert.equal(health.wikidotSite.failureRate, 0);
  assert.equal(health.external.status, 'failed');
  assert.equal(health.external.failureRate, 1);
  assert.equal(health.unified.status, 'failed');
});
