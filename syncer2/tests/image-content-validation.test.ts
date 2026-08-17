process.env.SYNCER2_LOG_LEVEL = 'error';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';

import { sniffImageContent } from '../src/image/contentValidation.js';
import {
  isWikimediaFileDescriptionUrl,
  resolveWikimediaOgImageUrl,
} from '../src/image/descriptionPage.js';
import {
  processImageJob,
  verifyStoredAsset,
  type ImageWorkerOptions,
} from '../src/image/worker.js';

const options: ImageWorkerOptions = {
  siteHost: 'scp-wiki-cn.wikidot.com',
  assetRoot: '/tmp/syncer2-image-content-test',
  maxBytes: 20 * 1024 * 1024,
  maxAttempts: 5,
  allowedHosts: ['*'],
  blockedHosts: [],
  retryBaseMs: 1_000,
  retryMaxMs: 10_000,
};

test('magic bytes 覆盖生产图片格式，不依赖响应头或扩展名', () => {
  assert.equal(sniffImageContent(validPng())?.mime, 'image/png');
  assert.equal(sniffImageContent(validJpeg())?.mime, 'image/jpeg');
  assert.equal(sniffImageContent(validGif())?.mime, 'image/gif');
  assert.equal(sniffImageContent(validWebp())?.mime, 'image/webp');
  assert.equal(sniffImageContent(validAvif())?.mime, 'image/avif');
  assert.equal(sniffImageContent(validBmp())?.mime, 'image/bmp');
  assert.equal(sniffImageContent(validIco())?.mime, 'image/x-icon');
  assert.equal(sniffImageContent(validTiff())?.mime, 'image/tiff');
  assert.equal(
    sniffImageContent(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))?.mime,
    'image/svg+xml',
  );
  assert.equal(sniffImageContent(Buffer.from('<svg onload="alert(1)"></svg>')), null);
});

test('webp 即使声明 application/octet-stream 仍按字节识别并以 SHA 路径入库', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'syncer2-webp-octet-'));
  const body = validWebp();
  const database = successPool();
  const external = responseClient([
    { body, contentType: 'application/octet-stream' },
  ]);
  const result = await processImageJob(
    database.pool,
    {
      id: 101,
      pageId: 201,
      normalizedUrl: 'https://scp-wiki.wdfiles.com/local--files/x/sample.webp',
      displayUrl: 'https://scp-wiki.wdfiles.com/local--files/x/sample.webp',
      attempts: 1,
    },
    { wikidot: external, external },
    { ...options, assetRoot: root },
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.failureClass, null);
  assert.equal(database.assetParams[1], 'image/webp');
  const storagePath = String(database.assetParams[5]);
  assert.match(storagePath, /^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.webp$/);
  assert.equal(
    await verifyStoredAsset(root, storagePath, createHash('sha256').update(body).digest('hex')),
    'verified',
  );
  await rm(root, { recursive: true, force: true });
});

test('非图片内容伪装成 .webp 且声明 image/webp 仍终态拒绝，不写资产', async () => {
  const result = await processImageJob(
    failurePool(),
    {
      id: 102,
      pageId: 202,
      normalizedUrl: 'https://example.com/not-an-image.webp',
      displayUrl: 'https://example.com/not-an-image.webp',
      attempts: 1,
    },
    {
      wikidot: responseClient([{ body: Buffer.from('<html>not an image</html>'), contentType: 'image/webp' }]),
      external: responseClient([{ body: Buffer.from('<html>not an image</html>'), contentType: 'image/webp' }]),
    },
    options,
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.failureClass, 'invalid_image_content');
  assert.equal(result.hashHex, null);
});

test('Wikimedia File 描述页只接受 upload.wikimedia.org og:image，并二跳入库', async () => {
  const pageUrl = 'https://commons.wikimedia.org/wiki/File:Example.webp';
  const imageUrl = 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Example.webp';
  const html = `<html><head><meta property="og:image" content="${imageUrl}"></head></html>`;
  assert.equal(isWikimediaFileDescriptionUrl(pageUrl), true);
  assert.equal(resolveWikimediaOgImageUrl(pageUrl, html), imageUrl);
  assert.equal(
    resolveWikimediaOgImageUrl(
      pageUrl,
      '<meta property="og:image" content="http://127.0.0.1/private">',
    ),
    null,
  );

  const root = await mkdtemp(path.join(os.tmpdir(), 'syncer2-wikimedia-og-'));
  const database = successPool();
  const external = responseClient([
    { body: Buffer.from(html), contentType: 'text/html; charset=utf-8' },
    { body: validWebp(), contentType: 'application/octet-stream' },
  ]);
  const result = await processImageJob(
    database.pool,
    {
      id: 103,
      pageId: 203,
      normalizedUrl: pageUrl.toLowerCase(),
      displayUrl: pageUrl,
      attempts: 1,
    },
    { wikidot: external, external },
    { ...options, assetRoot: root },
  );
  assert.equal(result.status, 'completed');
  assert.deepEqual(external.urls, [pageUrl, imageUrl]);
  assert.equal(database.assetParams[6], imageUrl);
  assert.equal(database.assetParams[7], 'upload.wikimedia.org');
  assert.match(String(database.referenceMetadata), /"content_detected_by":"magic_bytes"/);
  assert.match(String(database.referenceMetadata), /"description_page_url"/);
  await rm(root, { recursive: true, force: true });
});

test('已识别描述页缺少安全 og:image 时进入明确终态', async () => {
  const pageUrl = 'https://en.wikipedia.org/wiki/File:Missing.png';
  const result = await processImageJob(
    failurePool(),
    {
      id: 104,
      pageId: 204,
      normalizedUrl: pageUrl.toLowerCase(),
      displayUrl: pageUrl,
      attempts: 1,
    },
    {
      wikidot: responseClient([{ body: Buffer.from('<div>description only</div>'), contentType: 'text/html' }]),
      external: responseClient([{ body: Buffer.from('<div>description only</div>'), contentType: 'text/html' }]),
    },
    options,
  );
  assert.equal(result.status, 'failed');
  assert.equal(result.failureClass, 'description_page_unresolved');
});

function successPool(): {
  pool: Pool;
  assetParams: unknown[];
  referenceMetadata: unknown;
} {
  const captured = { assetParams: [] as unknown[], referenceMetadata: null as unknown };
  const tx = {
    query: async (sql: string, params?: unknown[]) => {
      if (/^(?:BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: null };
      if (sql.includes('INSERT INTO serve.image_asset')) {
        captured.assetParams = params ?? [];
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE serve.page_image')) {
        captured.referenceMetadata = params?.[3] ?? null;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE meta.image_ingest_job')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected transaction SQL: ${sql}`);
    },
    release: () => undefined,
  };
  const pool = {
    connect: async () => tx,
    query: async (sql: string) => {
      if (sql.includes('FROM serve.page_image pi')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM serve.image_asset_url_alias alias')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT storage_path FROM serve.image_asset')) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected pool SQL: ${sql}`);
    },
  } as unknown as Pool;
  return {
    pool,
    get assetParams() { return captured.assetParams; },
    get referenceMetadata() { return captured.referenceMetadata; },
  };
}

function failurePool(): Pool {
  const tx = {
    query: async (sql: string) => {
      if (/^(?:BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [], rowCount: null };
      if (sql.includes('UPDATE serve.page_image')) return { rows: [], rowCount: 1 };
      if (sql.includes('UPDATE meta.image_ingest_job')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected transaction SQL: ${sql}`);
    },
    release: () => undefined,
  };
  return {
    connect: async () => tx,
    query: async (sql: string) => {
      if (sql.includes('FROM serve.page_image pi')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM serve.image_asset_url_alias alias')) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected pool SQL: ${sql}`);
    },
  } as unknown as Pool;
}

function responseClient(responses: Array<{ body: Buffer; contentType: string }>) {
  let index = 0;
  const urls: string[] = [];
  return {
    urls,
    get: async (url: string) => {
      urls.push(url);
      const response = responses[Math.min(index++, responses.length - 1)];
      if (response === undefined) throw new Error('missing response fixture');
      return {
        status: 200,
        headers: { 'content-type': response.contentType },
        body: response.body,
        text: () => response.body.toString('utf8'),
        telemetry: {},
      } as never;
    },
  };
}

function validPng(): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(1, 16);
  buffer.writeUInt32BE(1, 20);
  return buffer;
}

function validJpeg(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xda, 0x00, 0x00, 0x00]);
}

function validGif(): Buffer {
  const buffer = Buffer.alloc(13);
  buffer.write('GIF89a', 0, 'ascii');
  buffer.writeUInt16LE(1, 6);
  buffer.writeUInt16LE(1, 8);
  return buffer;
}

function validWebp(): Buffer {
  const buffer = Buffer.alloc(20);
  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(12, 4);
  buffer.write('WEBP', 8, 'ascii');
  buffer.write('VP8X', 12, 'ascii');
  buffer.writeUInt32LE(0, 16);
  return buffer;
}

function validAvif(): Buffer {
  const buffer = Buffer.alloc(20);
  buffer.writeUInt32BE(20, 0);
  buffer.write('ftyp', 4, 'ascii');
  buffer.write('avif', 8, 'ascii');
  buffer.writeUInt32BE(0, 12);
  buffer.write('avif', 16, 'ascii');
  return buffer;
}

function validBmp(): Buffer {
  const buffer = Buffer.alloc(26);
  buffer.write('BM', 0, 'ascii');
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(12, 14);
  return buffer;
}

function validIco(): Buffer {
  const buffer = Buffer.alloc(22);
  buffer.writeUInt16LE(0, 0);
  buffer.writeUInt16LE(1, 2);
  buffer.writeUInt16LE(1, 4);
  return buffer;
}

function validTiff(): Buffer {
  const buffer = Buffer.alloc(9);
  Buffer.from([0x49, 0x49, 0x2a, 0x00]).copy(buffer);
  buffer.writeUInt32LE(8, 4);
  return buffer;
}
