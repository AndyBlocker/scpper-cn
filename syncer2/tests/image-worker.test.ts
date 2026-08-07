process.env.SYNCER2_LOG_LEVEL = 'error';

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';

import { TransportError } from '../src/http/client.js';
import {
  classifyImageEgress,
  imageHostAllowed,
  processImageJob,
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

test('相同 normalized URL 已有资产时直接复用，不重复出站', async () => {
  const hash = Buffer.alloc(32, 7);
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
      if (sql.includes('FROM serve.page_image pi')) {
        return { rows: [{ asset_sha: hash }], rowCount: 1 };
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
    options,
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.bytes, 0);
  assert.equal(result.hashHex, hash.toString('hex'));
  assert.equal(downloads, 0);
});
