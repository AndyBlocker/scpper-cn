process.env.SYNCER2_LOG_LEVEL = 'error';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { scanPageIds } from '../src/collect/pageid.js';
import { parseSourceBody } from '../src/collect/source.js';
import {
  buildRestrictedContentRequest,
  buildRestrictedListPagesRequest,
  parseRestrictedListPagesResponse,
  RESTRICTED_CONTENT_END,
  RESTRICTED_CONTENT_START,
  RESTRICTED_SLUG_END,
  RESTRICTED_SLUG_START,
} from '../src/collect/restrictedListPages.js';
import type { HttpClient, HttpResponse } from '../src/http/client.js';
import {
  RESTRICTED_STABLE_PROXY_URL,
  RESTRICTED_TLS_MAX_VERSION,
  createRestrictedStableHttp,
  RestrictedIdentitySession,
  RestrictedSessionUnavailableError,
  type RestrictedIdentityHttp,
} from '../src/http/restrictedSession.js';
import {
  findSharedPageIdentityCollisions,
  SharedPageIdentityError,
  assertNoSharedPageIdentities,
} from '../src/page/identity.js';
import { httpForWorkTask, type WorkHandlerContext } from '../src/work/handlers.js';
import { classifyWorkFailure } from '../src/work/failurePolicy.js';
import { waitingForRestrictedSession } from '../src/work/pendingPage.js';
import type { Logger } from '../src/util/log.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('adult ListPages 权威数据', () => {
  it('请求只用 fullname 身份与 %%content%%，绝不请求 page_id/id selector', () => {
    const request = buildRestrictedListPagesRequest('adult', 1);
    assert.equal(request.params.category, 'adult');
    assert.equal(request.params.offset, 0);
    assert.doesNotMatch(String(request.params.module_body), /%%content%%/);
    const contentRequest = buildRestrictedContentRequest('adult', 'fixture');
    const body = String(contentRequest.params.module_body);
    assert.match(body, new RegExp(`${RESTRICTED_SLUG_START}%%fullname%%${RESTRICTED_SLUG_END}`));
    assert.match(body, new RegExp(`${RESTRICTED_CONTENT_START}%%content%%${RESTRICTED_CONTENT_END}`));
    assert.doesNotMatch(body, /%%(?:page_id|id)%%/);
  });

  it('元数据与嵌套正文按 fullname 一一对应，正文内分隔符不污染字段', () => {
    const base = fs.readFileSync(path.join(FIXTURES, 'listpages_page_1.reconstructed.html'), 'utf8');
    const contents = [
      '<p>真实正文一</p><div><span>A|||B</span></div>',
      '<p>真实正文二</p>',
    ];
    let index = 0;
    const html = base.replace(
      /(<div class="syncer2-listpages-row">[\s\S]*?<\/div>)/g,
      (row) => `${row}\n${RESTRICTED_SLUG_START}` +
        `${index === 0 ? 'scp-cn-4813' : 'deleted-author-page'}${RESTRICTED_SLUG_END}` +
        `${RESTRICTED_CONTENT_START}${contents[index++]}${RESTRICTED_CONTENT_END}`,
    ).replaceAll('%%_default%%', '%%adult%%');
    const parsed = parseRestrictedListPagesResponse(html, 'adult');
    assert.equal(parsed.status, 'ok');
    if (parsed.status !== 'ok') return;
    assert.equal(parsed.rows.length, 2);
    assert.match(parsed.rows[0]!.contentHtml, /A\|\|\|B/);
    assert.match(parsed.rows[0]!.textContent, /真实正文一/);
    assert.equal(parsed.rows[0]!.createdById, 6649472);
  });
});

describe('共享 pageId 通用守卫', () => {
  it('多个 slug 解析到同一 pageId 时整组拒绝并生成可告警错误', () => {
    let alerted = false;
    const logger = {
      error: (message: string) => {
        alerted = /身份冲突守卫/.test(message);
      },
    } as unknown as Logger;
    const bindings = [
      { slug: 'adult:a', wikidotId: 1306434388 },
      { slug: 'adult:b', wikidotId: 1306434388 },
    ];
    assert.deepEqual(findSharedPageIdentityCollisions(bindings), [
      { wikidotId: 1306434388, slugs: ['adult:a', 'adult:b'] },
    ]);
    assert.throws(
      () => assertNoSharedPageIdentities(bindings, logger),
      (error: unknown) => {
        assert.ok(error instanceof SharedPageIdentityError);
        assert.match(error.message, /拒绝写入/);
        return true;
      },
    );
    assert.equal(alerted, true);
  });

  it('通用 scanPageIds 不返回可写 ok 结果', async () => {
    const fake = {
      get: async () => response(
        'WIKIREQUEST.info.pageId = 1306434388;',
      ),
    } as unknown as HttpClient;
    const outcomes = await scanPageIds(fake, 'https://example.test', ['adult:a', 'adult:b'], 2);
    const adultA = outcomes.get('adult:a');
    assert.equal(adultA?.status, 'failed');
    assert.equal(outcomes.get('adult:b')?.status, 'failed');
    assert.ok(adultA?.status === 'failed');
    assert.match(adultA.error, /身份冲突守卫/);
  });
});

describe('登录 session 降级与 7890 出口', () => {
  it('并发 adult 源码首次使用只建立一个登录 session', async () => {
    let loginRequests = 0;
    let sourceRequests = 0;
    const fake = {
      proxyUrl: RESTRICTED_STABLE_PROXY_URL,
      request: async (url: string) => {
        if (url.includes('LoginPopupScreen')) {
          loginRequests++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return response('', { 'set-cookie': 'WIKIDOT_SESSION_ID=shared-session; Path=/' });
        }
        sourceRequests++;
        return response(JSON.stringify({
          status: 'ok',
          body: '<div class="page-source">concurrent</div>',
        }));
      },
      get: async () => response(''),
    } as unknown as RestrictedIdentityHttp;
    const session = new RestrictedIdentitySession(
      fake,
      { username: 'fixture', password: 'fixture', source: 'test' },
      'https://scp-wiki-cn.wikidot.com',
      { info: () => undefined, warn: () => undefined } as unknown as Logger,
    );
    const results = await Promise.all([
      session.fetchCurrentSource('adult:a', 1),
      session.fetchCurrentSource('adult:b', 2),
      session.fetchCurrentSource('adult:c', 3),
      session.fetchCurrentSource('adult:d', 4),
    ]);
    assert.equal(loginRequests, 1);
    assert.equal(sourceRequests, 4);
    assert.deepEqual(results.map((result) => result.status), ['ok', 'ok', 'ok', 'ok']);
  });

  it('adult ViewSource 携带 7890 登录态取到源码；no_permission 只重登一次', async () => {
    let loginRequests = 0;
    let sourceRequests = 0;
    const sourceCookies: string[] = [];
    const fake = {
      proxyUrl: RESTRICTED_STABLE_PROXY_URL,
      request: async (url: string, options?: { headers?: Record<string, string> }) => {
        if (url.includes('LoginPopupScreen')) {
          loginRequests++;
          return response('', { 'set-cookie': `WIKIDOT_SESSION_ID=session-${loginRequests}; Path=/` });
        }
        sourceRequests++;
        sourceCookies.push(options?.headers?.cookie ?? '');
        return response(JSON.stringify(
          sourceRequests === 1
            ? { status: 'no_permission', message: 'Permission denied' }
            : { status: 'ok', body: '<div class="page-source">[[module ListPages]]</div>' },
        ));
      },
      get: async () => response(''),
    } as unknown as RestrictedIdentityHttp;
    const session = new RestrictedIdentitySession(
      fake,
      { username: 'fixture', password: 'fixture', source: 'test' },
      'https://scp-wiki-cn.wikidot.com',
      { info: () => undefined, warn: () => undefined } as unknown as Logger,
    );
    const source = await session.fetchCurrentSource('adult:fixture', 1448285468);
    assert.equal(source.status, 'ok');
    assert.equal(loginRequests, 2);
    assert.equal(sourceRequests, 2);
    assert.match(sourceCookies[0]!, /WIKIDOT_SESSION_ID=session-1/);
    assert.match(sourceCookies[1]!, /WIKIDOT_SESSION_ID=session-2/);
    const parsed = parseSourceBody(source.body!, { pageId: 1, wikidotId: 1448285468 });
    assert.equal(parsed.status, 'ok');
    if (parsed.status === 'ok') assert.equal(parsed.data.source, '[[module ListPages]]');
  });

  it('adult ViewSource 重登后仍 no_permission 时显式降级，绝不形成空源码', async () => {
    let loginRequests = 0;
    let sourceRequests = 0;
    const fake = {
      proxyUrl: RESTRICTED_STABLE_PROXY_URL,
      request: async (url: string) => {
        if (url.includes('LoginPopupScreen')) {
          loginRequests++;
          return response('', { 'set-cookie': `WIKIDOT_SESSION_ID=session-${loginRequests}; Path=/` });
        }
        sourceRequests++;
        return response(JSON.stringify({ status: 'no_permission', message: 'Permission denied' }));
      },
      get: async () => response(''),
    } as unknown as RestrictedIdentityHttp;
    const session = new RestrictedIdentitySession(
      fake,
      { username: 'fixture', password: 'fixture', source: 'test' },
      'https://scp-wiki-cn.wikidot.com',
      { info: () => undefined, warn: () => undefined } as unknown as Logger,
    );
    await assert.rejects(
      session.fetchCurrentSource('adult:fixture', 1448285468),
      /emptyResult=false/,
    );
    assert.equal(loginRequests, 2);
    assert.equal(sourceRequests, 2);
    assert.deepEqual(
      classifyWorkFailure(
        'content',
        'RestrictedSessionUnavailableError: 受限源码失败；emptyResult=false',
      ),
      {
        family: 'prerequisite',
        signature: 'restricted_session_unavailable',
        action: 'retry',
        identityReviewThreshold: null,
        rationale: '前置 L1/本地证据可由后续完整轮补齐，不是页面身份结论',
      },
    );
  });

  it('session 失效会重登一次，仍失败则抛显式前置条件错误而非空结果', async () => {
    let loginRequests = 0;
    let identityRequests = 0;
    let warned = false;
    const fake = {
      proxyUrl: RESTRICTED_STABLE_PROXY_URL,
      request: async (url: string) => {
        if (url.includes('LoginPopupScreen')) {
          loginRequests++;
          return response('', { 'set-cookie': `WIKIDOT_SESSION_ID=session-${loginRequests}; Path=/` });
        }
        return response('{"status":"ok"}');
      },
      get: async () => {
        identityRequests++;
        return response(
          'WIKIREQUEST.info.pageUnixName = "category:_public";' +
          'WIKIREQUEST.info.requestPageName = "category:_public";' +
          'WIKIREQUEST.info.pageId = 1306434388;',
        );
      },
    } as unknown as RestrictedIdentityHttp;
    const session = new RestrictedIdentitySession(
      fake,
      { username: 'fixture', password: 'fixture', source: 'test' },
      'https://scp-wiki-cn.wikidot.com',
      {
        info: () => undefined,
        warn: (message: string) => {
          warned ||= /登录态失效.*强制重登/.test(message);
        },
      } as unknown as Logger,
    );
    await assert.rejects(
      session.fetchIdentity('adult:fixture'),
      RestrictedSessionUnavailableError,
    );
    assert.equal(loginRequests, 2);
    assert.equal(identityRequests, 2);
    assert.equal(warned, true, 'session 失效必须留下显式重登告警');

    const degraded = waitingForRestrictedSession('adult:fixture', 'session expired', 0);
    assert.equal(degraded.status, 'waiting_evidence');
    assert.equal(degraded.resolutionSource, 'restricted_session_unavailable');
    assert.deepEqual(degraded.resolutionEvidence?.['emptyResult'], false);
    assert.notEqual(degraded.status, 'gone');
  });

  it('受限 session 与 work task 均 fail closed 到 7890，绝不回落 7891', () => {
    const wrong = { proxyUrl: 'http://127.0.0.1:7891' } as RestrictedIdentityHttp;
    assert.throws(
      () => new RestrictedIdentitySession(
        wrong,
        { username: 'fixture', password: 'fixture', source: 'test' },
        'https://scp-wiki-cn.wikidot.com',
      ),
      /只允许.*7890/,
    );

    const general = { proxyUrl: 'http://127.0.0.1:7891' } as HttpClient;
    const stable = { proxyUrl: RESTRICTED_STABLE_PROXY_URL } as HttpClient;
    const context = { http: general, restrictedHttp: stable } as WorkHandlerContext;
    assert.equal(httpForWorkTask(context, { slug: 'scp-cn-1000' }), general);
    assert.equal(httpForWorkTask(context, { slug: 'adult:fixture' }), stable);
    assert.throws(
      () => httpForWorkTask(
        { http: general, restrictedHttp: general } as WorkHandlerContext,
        { slug: 'adult:fixture' },
      ),
      /拒绝回落通用出口/,
    );

    const actual = createRestrictedStableHttp({
      userAgent: 'adult-egress-test/1',
      referer: 'https://scp-wiki-cn.wikidot.com/',
      timeoutMs: 1_000,
      maxAttempts: 1,
      breaker503: 1,
      breakerReset: 1,
    });
    assert.equal(actual.proxyUrl, RESTRICTED_STABLE_PROXY_URL);
    assert.equal(actual.tlsMaxVersion, RESTRICTED_TLS_MAX_VERSION);
    void actual.close();
  });
});

describe('page_source 来源追溯', () => {
  it('迁移区分 v1 遗留、匿名 v2 与登录 v2，并要求 run id', () => {
    const migration = fs.readFileSync(
      path.join(path.dirname(FIXTURES), '..', 'migrations', '0206_page_source_provenance.sql'),
      'utf8',
    );
    assert.match(migration, /observation_source text NOT NULL/);
    assert.match(migration, /'v1_backfill'/);
    assert.match(migration, /'wikidot_anonymous'/);
    assert.match(migration, /'wikidot_authenticated'/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS run_id bigint/);
    assert.match(migration, /apply_current_page_source/);
  });
});

function response(body: string, headers: Record<string, string> = {}): HttpResponse {
  const bytes = Buffer.from(body);
  return {
    status: 200,
    headers,
    body: bytes,
    text: () => body,
    telemetry: {
      mode: 'test',
      method: 'GET',
      url: 'https://example.test',
      status: 200,
      attempts: 1,
      durationMs: 1,
      wireBytes: bytes.length,
      decodedBytes: bytes.length,
      contentEncoding: null,
      ok: true,
      retryReasons: [],
    },
  };
}
