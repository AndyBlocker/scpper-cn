process.env.SYNCER2_LOG_LEVEL = 'error';

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { scanAuthenticatedRevisionSourcesOnDemand } from '../src/collect/source.js';
import { HttpStatusError, type HttpResponse } from '../src/http/client.js';
import {
  createRestrictedStableHttp,
  RESTRICTED_STABLE_PROXY_URL,
  RestrictedIdentitySession,
  RestrictedSessionUnavailableError,
  type RestrictedIdentityHttp,
  type RestrictedSourceSession,
} from '../src/http/restrictedSession.js';
import {
  evaluateRevisionSourceOutputHealth,
  REVISION_SOURCE_ZERO_OUTPUT_ALERT_ROUNDS,
} from '../src/store/revisionSource.js';
import type { Logger } from '../src/util/log.js';
import { RuntimeBudgetExceededError } from '../src/util/runtimeBudget.js';

describe('历史源码账号 session', () => {
  it('复用登录 session；首次 no_permission 重登后可得则正常返回源码', async () => {
    let loginRequests = 0;
    let sourceRequests = 0;
    const sourceCookies: string[] = [];
    const fake = {
      proxyUrl: RESTRICTED_STABLE_PROXY_URL,
      request: async (
        url: string,
        options?: { headers?: Record<string, string>; body?: string },
      ) => {
        if (url.includes('LoginPopupScreen')) {
          loginRequests++;
          return response('', {
            'set-cookie': `WIKIDOT_SESSION_ID=history-session-${loginRequests}; Path=/`,
          });
        }
        sourceRequests++;
        sourceCookies.push(options?.headers?.cookie ?? '');
        assert.match(options?.body ?? '', /moduleName=history%2FPageSourceModule/);
        return response(JSON.stringify(
          sourceRequests === 1
            ? { status: 'no_permission', message: 'Permission denied' }
            : { status: 'ok', body: '<div class="page-source">历史源码</div>' },
        ));
      },
      get: async () => response(''),
    } as unknown as RestrictedIdentityHttp;
    const session = new RestrictedIdentitySession(
      fake,
      { username: 'fixture', password: 'fixture', source: 'test' },
      'https://scp-wiki-cn.wikidot.com',
      quietLogger(),
    );

    const result = await session.fetchRevisionSource(620463997);
    assert.equal(result.status, 'ok');
    assert.equal(loginRequests, 2);
    assert.equal(sourceRequests, 2);
    assert.match(sourceCookies[0]!, /history-session-1/);
    assert.match(sourceCookies[1]!, /history-session-2/);
  });

  it('session 失效重登仍失败时显式降级，不返回空集合或删除结论', async () => {
    let loginRequests = 0;
    let sourceRequests = 0;
    let warned = false;
    const fake = {
      proxyUrl: RESTRICTED_STABLE_PROXY_URL,
      request: async (url: string) => {
        if (url.includes('LoginPopupScreen')) {
          loginRequests++;
          return response('', {
            'set-cookie': `WIKIDOT_SESSION_ID=expired-${loginRequests}; Path=/`,
          });
        }
        sourceRequests++;
        throw new HttpStatusError(302, url, 'login redirect');
      },
      get: async () => response(''),
    } as unknown as RestrictedIdentityHttp;
    const session = new RestrictedIdentitySession(
      fake,
      { username: 'fixture', password: 'fixture', source: 'test' },
      'https://scp-wiki-cn.wikidot.com',
      {
        ...quietLogger(),
        warn: (message: string) => {
          warned ||= /登录态失效候选.*强制重登/.test(message);
        },
      } as Logger,
    );

    await assert.rejects(
      session.fetchRevisionSource(620463997),
      (error: unknown) => {
        assert.ok(error instanceof RestrictedSessionUnavailableError);
        assert.match(error.message, /emptyResult=false/);
        assert.doesNotMatch(error.message, /gone|deleted/i);
        return true;
      },
    );
    assert.equal(loginRequests, 2);
    assert.equal(sourceRequests, 2);
    assert.equal(warned, true);
  });

  it('墙钟预算中断原样上抛，不误报成 session 失效', async () => {
    const budgetError = new RuntimeBudgetExceededError(Date.now());
    const fake = {
      proxyUrl: RESTRICTED_STABLE_PROXY_URL,
      request: async (url: string) => {
        if (url.includes('LoginPopupScreen')) {
          return response('', { 'set-cookie': 'WIKIDOT_SESSION_ID=budget; Path=/' });
        }
        throw budgetError;
      },
      get: async () => response(''),
    } as unknown as RestrictedIdentityHttp;
    const session = new RestrictedIdentitySession(
      fake,
      { username: 'fixture', password: 'fixture', source: 'test' },
      'https://scp-wiki-cn.wikidot.com',
      quietLogger(),
    );
    await assert.rejects(
      session.fetchRevisionSource(620463997),
      (error: unknown) => error === budgetError,
    );
  });
});

describe('历史源码权限终态与出口', () => {
  it('新 session 仍 no_permission 时形成 authenticated unavailable，不进入空结果', async () => {
    const session = {
      http: { proxyUrl: RESTRICTED_STABLE_PROXY_URL },
      fetchRevisionSource: async () => ({
        status: 'no_permission',
        body: null,
        message: 'Permission denied',
        currentTimestamp: null,
        raw: '{"status":"no_permission"}',
      }),
    } as RestrictedSourceSession;
    const results = await scanAuthenticatedRevisionSourcesOnDemand(session, [{
      pageId: 1,
      wikidotId: 2,
      revisionId: 620463997,
    }]);
    const result = results.get(620463997);
    assert.equal(result?.status, 'unavailable');
    if (result?.status !== 'unavailable') return;
    assert.equal(result.reason, 'authenticated_no_permission');
    assert.match(result.error, /emptyResult=false/);

    const [storeSource, migration] = await Promise.all([
      readFile(new URL('../src/store/revisionSource.ts', import.meta.url), 'utf8'),
      readFile(
        new URL('../migrations/0067_revision_source_authenticated_unavailable.sql', import.meta.url),
        'utf8',
      ),
    ]);
    assert.match(
      storeSource,
      /outcome\.status === 'unavailable'[\s\S]{0,700}SET status = 'unavailable'/,
    );
    assert.match(migration, /'unavailable'/);
  });

  it('回填专用客户端和扫描器都 fail closed 到 7890，不接受 7891', async () => {
    const http = createRestrictedStableHttp({
      userAgent: 'revision-source-auth-test/1',
      referer: 'https://scp-wiki-cn.wikidot.com/',
      timeoutMs: 1_000,
      maxAttempts: 1,
      breaker503: 1,
      breakerReset: 1,
    });
    assert.equal(http.proxyUrl, RESTRICTED_STABLE_PROXY_URL);
    await http.close();

    const wrong = {
      http: { proxyUrl: 'http://127.0.0.1:7891' },
      fetchRevisionSource: async () => {
        throw new Error('不应发出请求');
      },
    } as RestrictedSourceSession;
    await assert.rejects(
      scanAuthenticatedRevisionSourcesOnDemand(wrong, [{
        pageId: 1,
        wikidotId: 2,
        revisionId: 3,
      }]),
      /只允许.*7890/,
    );

    const cli = await readFile(
      new URL('../src/cli/revision-source-backfill.ts', import.meta.url),
      'utf8',
    );
    assert.match(cli, /createRestrictedStableHttp\(\{/);
    assert.doesNotMatch(cli, /proxyUrl:\s*config\.proxyUrl/);
    assert.match(
      cli,
      /RestrictedSessionUnavailableError[\s\S]{0,900}releaseRevisionSourceClaims[\s\S]{0,700}deletionInference: false/,
    );
  });
});

describe('历史源码零产出告警', () => {
  it('连续三轮 selected>0 且 stored=0 时告警；有存储或空队列会复位', () => {
    assert.equal(REVISION_SOURCE_ZERO_OUTPUT_ALERT_ROUNDS, 3);
    assert.deepEqual(
      evaluateRevisionSourceOutputHealth(
        { selected: 291, stored: 0, blobsInserted: 0 },
        [0, 0],
      ),
      {
        selected: 291,
        stored: 0,
        blobsInserted: 0,
        consecutiveZeroOutputRuns: 3,
        alertAfterRuns: 3,
        alert: true,
      },
    );
    assert.equal(
      evaluateRevisionSourceOutputHealth(
        { selected: 291, stored: 1, blobsInserted: 1 },
        [0, 0],
      ).alert,
      false,
    );
    assert.equal(
      evaluateRevisionSourceOutputHealth(
        { selected: 0, stored: 0, blobsInserted: 0 },
        [0, 0],
      ).consecutiveZeroOutputRuns,
      0,
    );
  });
});

function quietLogger(): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  return logger;
}

function response(body: string, headers: Record<string, string> = {}): HttpResponse {
  const bytes = Buffer.from(body);
  return {
    status: 200,
    headers,
    body: bytes,
    text: () => body,
    telemetry: {
      mode: 'test',
      method: 'POST',
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
