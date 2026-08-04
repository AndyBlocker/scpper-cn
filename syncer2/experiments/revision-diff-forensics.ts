/**
 * 定点保存 PageDiff 原始 HTML 与两侧 PageSource 全文，并输出字节级首差异。
 *
 * 用法：
 *   node --import tsx/esm experiments/revision-diff-forensics.ts
 *
 * 本脚本只请求命令行中写死的单个相邻 revision pair，不写数据库。
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  parseRevisionDiffBody,
  REVISION_DIFF_PARSER_VERSION,
} from '../src/collect/revisionDiff.js';
import { parseSourceBody } from '../src/collect/source.js';
import { loadConfig, PROJECT_ROOT } from '../src/config.js';
import { amcRequest } from '../src/http/amc.js';
import { HttpClient } from '../src/http/client.js';
import { createLogger } from '../src/util/log.js';

interface ForensicTarget {
  pageId: number;
  wikidotId: number;
  fromRevisionId: number;
  toRevisionId: number;
}

const DEFAULT_TARGET: ForensicTarget = {
  pageId: 27_409,
  wikidotId: 822_940_057,
  fromRevisionId: 870_091_898,
  toRevisionId: 870_095_552,
} as const;

function targetFromArgs(): ForensicTarget {
  if (process.argv.length === 2) return DEFAULT_TARGET;
  const values = process.argv.slice(2).map(Number);
  if (
    values.length !== 4 ||
    values.some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new Error(
      '参数必须是 pageId wikidotId fromRevisionId toRevisionId（或不传参数使用失败样本）',
    );
  }
  return {
    pageId: values[0]!,
    wikidotId: values[1]!,
    fromRevisionId: values[2]!,
    toRevisionId: values[3]!,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function byteSummary(expected: string, actual: string): Record<string, unknown> {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(actual, 'utf8');
  let offset = 0;
  while (offset < a.length && offset < b.length && a[offset] === b[offset]) offset++;
  let suffix = 0;
  while (
    suffix < a.length - offset &&
    suffix < b.length - offset &&
    a[a.length - suffix - 1] === b[b.length - suffix - 1]
  ) {
    suffix++;
  }
  const contextStart = Math.max(0, offset - 80);
  const contextEndA = Math.min(a.length, offset + 160);
  const contextEndB = Math.min(b.length, offset + 160);
  return {
    equal: a.equals(b),
    firstDifferentByte: offset < a.length || offset < b.length ? offset : null,
    commonSuffixBytes: suffix,
    expectedBytes: a.length,
    actualBytes: b.length,
    expectedSha256: sha256(expected),
    actualSha256: sha256(actual),
    expectedContextHex: a.subarray(contextStart, contextEndA).toString('hex'),
    actualContextHex: b.subarray(contextStart, contextEndB).toString('hex'),
    contextStart,
  };
}

async function main(): Promise<void> {
  const target = targetFromArgs();
  const outputDir = path.join(
    PROJECT_ROOT,
    'docs',
    `revision-diff-${target.pageId}-${target.toRevisionId}`,
  );
  const config = loadConfig({ requireDatabase: false });
  const http = new HttpClient({
    userAgent: config.userAgent,
    referer: config.referer,
    proxyUrl: config.proxyUrl,
    timeoutMs: config.httpTimeoutMs,
    maxAttempts: Math.max(3, config.httpMaxAttempts),
    breaker503: Math.max(5, config.breaker503),
    breakerReset: Math.max(5, config.breakerReset),
    connections: 1,
    logger: createLogger('revision-diff-forensics:http'),
  });

  try {
    const diff = await amcRequest(http, config.siteBaseUrl, {
      moduleName: 'history/PageDiffModule',
      params: {
        page_id: target.wikidotId,
        from_revision_id: target.fromRevisionId,
        to_revision_id: target.toRevisionId,
      },
      mode: 'forensics:revision-diff',
      maxAttempts: 3,
    });
    if (diff.status !== 'ok' || diff.body === null) {
      throw new Error(`PageDiff status=${diff.status} message=${diff.message ?? '-'}`);
    }

    const sourceBodies = new Map<number, string>();
    const sources = new Map<number, string>();
    for (const revisionId of [target.fromRevisionId, target.toRevisionId]) {
      const response = await amcRequest(http, config.siteBaseUrl, {
        moduleName: 'history/PageSourceModule',
        params: { revision_id: revisionId },
        mode: 'forensics:revision-source',
        maxAttempts: 3,
      });
      if (response.status !== 'ok' || response.body === null) {
        throw new Error(
          `PageSource revision=${revisionId} status=${response.status} message=${response.message ?? '-'}`,
        );
      }
      const parsed = parseSourceBody(response.body.replace(/&nbsp;/gi, ' '), target);
      if (parsed.status !== 'ok') {
        throw new Error(`PageSource revision=${revisionId}: ${parsed.error}`);
      }
      sourceBodies.set(revisionId, response.body);
      sources.set(revisionId, parsed.data.source);
    }

    const parsedDiff = parseRevisionDiffBody(diff.body, target);
    if (parsedDiff.status !== 'ok') throw new Error(parsedDiff.error);
    if (parsedDiff.data.beforeSource === null || parsedDiff.data.afterSource === null) {
      throw new Error('PageDiff 没有返回两侧源码');
    }

    const before = sources.get(target.fromRevisionId)!;
    const after = sources.get(target.toRevisionId)!;
    await mkdir(outputDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(outputDir, 'diff.raw.html'), diff.body, 'utf8'),
      writeFile(
        path.join(outputDir, `source-${target.fromRevisionId}.raw.html`),
        sourceBodies.get(target.fromRevisionId)!,
        'utf8',
      ),
      writeFile(
        path.join(outputDir, `source-${target.toRevisionId}.raw.html`),
        sourceBodies.get(target.toRevisionId)!,
        'utf8',
      ),
      writeFile(
        path.join(outputDir, `source-${target.fromRevisionId}.txt`),
        before,
        'utf8',
      ),
      writeFile(
        path.join(outputDir, `source-${target.toRevisionId}.txt`),
        after,
        'utf8',
      ),
      writeFile(
        path.join(
          outputDir,
          `diff-derived-${target.fromRevisionId}.${REVISION_DIFF_PARSER_VERSION}.txt`,
        ),
        parsedDiff.data.beforeSource,
        'utf8',
      ),
      writeFile(
        path.join(
          outputDir,
          `diff-derived-${target.toRevisionId}.${REVISION_DIFF_PARSER_VERSION}.txt`,
        ),
        parsedDiff.data.afterSource,
        'utf8',
      ),
      writeFile(
        path.join(outputDir, `patch.${REVISION_DIFF_PARSER_VERSION}.json`),
        `${JSON.stringify(parsedDiff.data.patch, null, 2)}\n`,
        'utf8',
      ),
    ]);

    const report = {
      target,
      capturedAt: new Date().toISOString(),
      files: {
        diffRawHtml: {
          bytes: Buffer.byteLength(diff.body, 'utf8'),
          sha256: sha256(diff.body),
        },
        beforeRawHtml: {
          bytes: Buffer.byteLength(sourceBodies.get(target.fromRevisionId)!, 'utf8'),
          sha256: sha256(sourceBodies.get(target.fromRevisionId)!),
        },
        afterRawHtml: {
          bytes: Buffer.byteLength(sourceBodies.get(target.toRevisionId)!, 'utf8'),
          sha256: sha256(sourceBodies.get(target.toRevisionId)!),
        },
        beforeSource: {
          bytes: Buffer.byteLength(before, 'utf8'),
          sha256: sha256(before),
        },
        afterSource: {
          bytes: Buffer.byteLength(after, 'utf8'),
          sha256: sha256(after),
        },
      },
      diffParser: {
        version: REVISION_DIFF_PARSER_VERSION,
        responseBytes: parsedDiff.data.responseBytes,
        patchHunks: parsedDiff.data.patch.length,
        beforeVsPageSource: byteSummary(before, parsedDiff.data.beforeSource),
        afterVsPageSource: byteSummary(after, parsedDiff.data.afterSource),
      },
      http: http.stats(),
    };
    await writeFile(
      path.join(outputDir, `capture.${REVISION_DIFF_PARSER_VERSION}.json`),
      `${JSON.stringify(report, null, 2)}\n`,
      'utf8',
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await http.close();
  }
}

await main();
