/**
 * HTTP 护栏测试（README「后续 TODO」#11 第一组）。
 *
 * 前几轮这些护栏是手工用本地测试服打出来的（"打 503 看它退不退"），这里固化成断言。
 * 每一条对应 src/http/client.ts 文件头列的一条硬约束，都是 2026-07-27 实测得到的
 * 边缘行为，不是防御性直觉：
 *
 *   §1 头契约   —— 空 UA → WAF 503 空体；POST 缺 Referer → TCP 重置。构造期 + 每请求前双校验。
 *   §3 503 停手 —— 503/429 **零重试**、计入熔断；熔断后**完全不触网**（本文件用请求计数证明）。
 *                  500 才走正常重试；连续传输重置单独熔断。
 *   §4 记账     —— wireBytes / decodedBytes 分开记；每请求恰好一条遥测。
 *
 * 测试服全程 127.0.0.1，不发一个真实外网请求。
 */

// 护栏日志噪音很大（每次 warn 一条）。测试只关心行为，日志压到 error。
process.env.SYNCER2_LOG_LEVEL = 'error';

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';

import {
  CircuitOpenError,
  HeaderContractError,
  HttpClient,
  HttpStatusError,
  assertHeaderContract,
  decodeBody,
  type HttpClientOptions,
} from '../src/http/client.js';
import {
  RuntimeBudget,
  RuntimeBudgetExceededError,
} from '../src/util/runtimeBudget.js';

// ─── 本地测试服 ──────────────────────────────────────────────────────────────

/** 一段可压缩的 sitemap 形状载荷（gzip 后应当小一个量级，与实测 1.14 MB → 180 KB 同理）。 */
const PAYLOAD =
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n' +
  Array.from(
    { length: 400 },
    (_, i) =>
      `<url><loc>http://scp-wiki-cn.wikidot.com/scp-cn-${1000 + i}</loc>` +
      `<lastmod>2026-07-27T07:24:33+00:00</lastmod></url>`,
  ).join('\n') +
  '\n</urlset>\n';

interface TestServer {
  base: string;
  /** 每个 path 被真正打到的次数 —— "熔断后不触网" 全靠这个数字证明。 */
  hits: Map<string, number>;
  total(): number;
  hitsOf(path: string): number;
  /** 最近一次请求收到的头（用来证明 UA/Referer/accept-encoding 真的上了线）。 */
  lastHeaders: http.IncomingHttpHeaders;
  /** /flaky-500 前多少次返回 500。 */
  flakyFailures: number;
  reset(): void;
  close(): Promise<void>;
}

async function startServer(): Promise<TestServer> {
  const state: TestServer = {
    base: '',
    hits: new Map(),
    total: () => [...state.hits.values()].reduce((a, b) => a + b, 0),
    hitsOf: (p) => state.hits.get(p) ?? 0,
    lastHeaders: {},
    flakyFailures: 1,
    reset: () => {
      state.hits.clear();
      state.lastHeaders = {};
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  const server = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0]!;
    state.hits.set(path, (state.hits.get(path) ?? 0) + 1);
    state.lastHeaders = req.headers;

    switch (path) {
      case '/ok':
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('ok-body');
        return;
      case '/echo':
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ headers: req.headers, method: req.method }));
        return;
      case '/gzip': {
        const body = gzipSync(Buffer.from(PAYLOAD, 'utf-8'));
        res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'application/xml' });
        res.end(body);
        return;
      }
      case '/gzip-corrupt':
        // 声明 gzip 但给的是明文：解压必须失败，绝不能把乱码/空 body 当成成功结果返回。
        res.writeHead(200, { 'content-encoding': 'gzip' });
        res.end(Buffer.from('这不是 gzip 数据', 'utf-8'));
        return;
      case '/503':
        // 实测形态：空 UA 时 WAF 返回 503 **空体**（0 B）。
        res.writeHead(503);
        res.end();
        return;
      case '/429':
        res.writeHead(429, { 'retry-after': '120' });
        res.end('slow down');
        return;
      case '/500':
        res.writeHead(500);
        res.end('boom');
        return;
      case '/flaky-500': {
        if (state.hitsOf(path) <= state.flakyFailures) {
          res.writeHead(500);
          res.end('boom');
          return;
        }
        res.writeHead(200);
        res.end('recovered');
        return;
      }
      case '/404':
        res.writeHead(404);
        res.end('nope');
        return;
      case '/gzip-404': {
        const body = gzipSync(Buffer.from('页面不存在：这是解压后的可读错误体', 'utf8'));
        res.writeHead(404, {
          'content-encoding': 'gzip',
          'content-type': 'text/plain; charset=utf-8',
        });
        res.end(body);
        return;
      }
      case '/302':
        res.writeHead(302, { location: '/ok' });
        res.end();
        return;
      case '/reset':
        // 实测形态：AMC POST 缺 Referer 时边缘直接重置 TCP 连接。
        req.socket.destroy();
        return;
      case '/flaky-reset':
        if (state.hitsOf(path) <= state.flakyFailures) {
          req.socket.destroy();
          return;
        }
        res.writeHead(200);
        res.end('recovered');
        return;
      default:
        res.writeHead(418);
        res.end('teapot');
        return;
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as AddressInfo;
  state.base = `http://127.0.0.1:${addr.port}`;
  return state;
}

const server = await startServer();
after(async () => {
  await server.close();
});

/** 一个够用的默认客户端；每个测试自己关。 */
function mk(overrides: Partial<HttpClientOptions> = {}): HttpClient {
  return new HttpClient({
    userAgent: 'scpper-cn-syncer2-test/0.1',
    referer: 'http://127.0.0.1/',
    timeoutMs: 3_000,
    maxAttempts: 3,
    breaker503: 3,
    breakerReset: 6,
    connections: 2,
    ...overrides,
  });
}

// ─── §1 头契约 ───────────────────────────────────────────────────────────────

describe('§1 请求头契约：构造期就炸，不给"退化成 503 洪水"的机会', () => {
  const cases: Array<[string, { userAgent: string; referer: string }, RegExp]> = [
    ['空 UA', { userAgent: '', referer: 'http://x/' }, /user-agent 头为空字符串/],
    ['纯空白 UA', { userAgent: '   ', referer: 'http://x/' }, /user-agent 头为空字符串/],
    ['空 Referer', { userAgent: 'ua', referer: '' }, /referer 头为空字符串/],
    ['纯空白 Referer', { userAgent: 'ua', referer: '\t\n ' }, /referer 头为空字符串/],
    ['UA 里塞 CRLF', { userAgent: 'ua\r\nX-Inject: 1', referer: 'http://x/' }, /含 CR\/LF\/NUL/],
    ['Referer 里塞 NUL', { userAgent: 'ua', referer: 'http://x/\0' }, /含 CR\/LF\/NUL/],
  ];

  for (const [name, opts, expected] of cases) {
    it(`${name} → 构造 HttpClient 直接抛 HeaderContractError`, () => {
      assert.throws(
        () => new HttpClient(opts),
        (err: unknown) => {
          assert.ok(err instanceof HeaderContractError, `应当是 HeaderContractError，实际 ${err}`);
          assert.match(err.message, expected);
          assert.match(err.message, /HttpClient 构造/); // 说清是构造期炸的
          return true;
        },
      );
    });
  }

  it('assertHeaderContract：头缺失（不是空值）也拒，并说明实测后果', () => {
    assert.throws(() => assertHeaderContract({ referer: 'http://x/' }, '单测'), (err: unknown) => {
      assert.ok(err instanceof HeaderContractError);
      assert.match(err.message, /缺少 user-agent 头/);
      assert.match(err.message, /WAF 503 空体/); // 错误信息本身带实测依据
      return true;
    });
    assert.throws(
      () => assertHeaderContract({ 'user-agent': 'ua' }, '单测'),
      /缺少 referer 头/,
    );
  });

  it('合法头 → 构造成功，assertHeaders() 启动自检通过', async () => {
    const c = mk();
    try {
      c.assertHeaders(); // 不抛即通过
      assert.equal(c.breakerOpen, false);
      assert.equal(c.stats().requests, 0);
    } finally {
      await c.close();
    }
  });

  it('每请求前再校验一次：调用方把 UA 覆盖成空 → 拒绝发出，且**不触网**', async () => {
    const c = mk();
    server.reset();
    try {
      await assert.rejects(
        c.get(`${server.base}/ok`, 'test:override', { headers: { 'User-Agent': '  ' } }),
        (err: unknown) => {
          assert.ok(err instanceof HeaderContractError);
          assert.match(err.message, /user-agent 头为空字符串/);
          assert.match(err.message, /GET http:\/\/127\.0\.0\.1/); // 上下文是具体请求
          return true;
        },
      );
      assert.equal(server.total(), 0, '被头契约拒掉的请求一个字节都不该上线');
      // 它从来没成为一个"请求"，所以不记遥测也不进 stats —— 记了反而会污染 503 占比等健康指标。
      assert.equal(c.stats().requests, 0);
      assert.equal(c.takeTelemetry().length, 0);
    } finally {
      await c.close();
    }
  });

  it('UA / Referer / accept-encoding 真的出现在线上（护的东西得先真的存在）', async () => {
    const c = mk({ userAgent: 'ua-on-the-wire/9', referer: 'http://referer.example/' });
    server.reset();
    try {
      const res = await c.get(`${server.base}/echo`, 'test:echo');
      const echoed = JSON.parse(res.text()) as { headers: Record<string, string> };
      assert.equal(echoed.headers['user-agent'], 'ua-on-the-wire/9');
      assert.equal(echoed.headers['referer'], 'http://referer.example/');
      // 这条头实测值 1 MB/次（sitemap 1.14 MB → gzip 180 KB）
      assert.equal(echoed.headers['accept-encoding'], 'gzip, deflate, br');
    } finally {
      await c.close();
    }
  });
});

describe('请求启动节流：补账客户端遵守最小尝试间隔', () => {
  it('两个连续业务请求的启动间隔不会突破配置的 QPS 上限', async () => {
    const minIntervalMs = 50;
    const c = mk({ minRequestIntervalMs: minIntervalMs });
    server.reset();
    try {
      const started = performance.now();
      await c.get(`${server.base}/ok`, 'rate:first');
      await c.get(`${server.base}/ok`, 'rate:second');
      const elapsed = performance.now() - started;
      assert.equal(server.hitsOf('/ok'), 2);
      // 给调度/时钟 5ms 余量；错误实现（完全没等待）通常 <10ms。
      assert.ok(
        elapsed >= minIntervalMs - 5,
        `期望至少 ${minIntervalMs - 5}ms，实际 ${elapsed.toFixed(1)}ms`,
      );
    } finally {
      await c.close();
    }
  });
});

describe('请求边界 runtime budget', () => {
  it('单个逻辑任务跨过剩余预算时，redirect/retry 的下一次真实出站被截断', async () => {
    server.reset();
    const budget = new RuntimeBudget(
      1,
      () => server.hitsOf('/302') === 0 ? 0 : 1_001,
    );
    const c = mk({ requestBoundary: () => budget.assertRequestBoundary() });
    try {
      await assert.rejects(
        c.get(`${server.base}/302`, 'budget:redirect', {
          maxAttempts: 3,
          maxRedirections: 1,
          redirectPolicy: 'same-host',
        }),
        RuntimeBudgetExceededError,
      );
      assert.equal(server.hitsOf('/302'), 1, '首个 attempt 已在预算内启动');
      assert.equal(server.hitsOf('/ok'), 0, '跨预算后的 redirect attempt 不能触网');
      assert.equal(c.stats().attempts, 1);
      assert.equal(budget.stoppedByRuntimeBudget, true);
    } finally {
      await c.close();
    }
  });
});

// ─── §3 503：零重试 + 熔断 + 熔断后不触网 ───────────────────────────────────

describe('§3 503/429：零重试，连续到阈值即熔断，熔断后完全不触网', () => {
  it('单个 503：maxAttempts=3 也只打一次（重发只会放大 WAF 拦截）', async () => {
    const c = mk({ maxAttempts: 3, breaker503: 99 });
    server.reset();
    try {
      await assert.rejects(c.get(`${server.base}/503`, 'test:503'), (err: unknown) => {
        assert.ok(err instanceof HttpStatusError, `应当是 HttpStatusError，实际 ${err}`);
        assert.equal(err.status, 503);
        return true;
      });
      assert.equal(server.hitsOf('/503'), 1, '503 必须零重试');
      const st = c.stats();
      assert.equal(st.attempts, 1);
      assert.equal(st.retries, 0);
      assert.equal(st.statusBuckets['503'], 1);
      assert.equal(st.consecutive503, 1);
      assert.equal(st.breakerOpen, false);
      const tel = c.takeTelemetry();
      assert.equal(tel.length, 1);
      assert.equal(tel[0]!.attempts, 1);
      assert.equal(tel[0]!.ok, false);
      assert.equal(tel[0]!.status, 503);
      assert.deepEqual(tel[0]!.retryReasons, []);
      // 实测 503 是空体，wireBytes=0 也要如实记账
      assert.equal(tel[0]!.wireBytes, 0);
    } finally {
      await c.close();
    }
  });

  it('连续 3 次 503 → 第 3 次抛 CircuitOpenError；第 4 次起请求数不再增长', async () => {
    const c = mk({ maxAttempts: 3, breaker503: 3 });
    server.reset();
    try {
      await assert.rejects(c.get(`${server.base}/503`, 'test:503'), HttpStatusError);
      assert.equal(c.breakerOpen, false);
      await assert.rejects(c.get(`${server.base}/503`, 'test:503'), HttpStatusError);
      assert.equal(c.breakerOpen, false);
      assert.equal(c.stats().consecutive503, 2);

      // 第 3 次：请求发出去了（拿到 503 才知道是第 3 次），然后当场熔断
      await assert.rejects(c.get(`${server.base}/503`, 'test:503'), (err: unknown) => {
        assert.ok(err instanceof CircuitOpenError, `应当是 CircuitOpenError，实际 ${err}`);
        assert.match(err.message, /连续 3 次 http_503/);
        assert.match(err.message, /停手/); // 语义：停手，不是等它恢复
        return true;
      });
      assert.equal(server.hitsOf('/503'), 3);
      assert.equal(c.breakerOpen, true);
      assert.match(c.breakerReason ?? '', /疑似被 WAF 拦截或 UA 头丢失/);

      const hitsAtTrip = server.total();
      const requestsAtTrip = c.stats().requests;
      assert.equal(requestsAtTrip, 3, '三次都真的出网了，各记一条遥测');

      // ★ 熔断后：任何 URL、任何方法都立即抛，**一个字节都不上线**
      for (const p of ['/503', '/ok', '/echo']) {
        await assert.rejects(c.get(`${server.base}${p}`, 'test:after-breaker'), CircuitOpenError);
      }
      assert.equal(server.total(), hitsAtTrip, '熔断后必须完全不触网');
      assert.equal(server.hitsOf('/ok'), 0);
      // 也不该被记成"请求"（否则 503 占比会被这些从未出网的请求稀释）
      assert.equal(c.stats().requests, requestsAtTrip);
      assert.equal(c.takeTelemetry().length, 3);
    } finally {
      await c.close();
    }
  });

  it('429 与 503 共用同一个熔断计数器（都是"停手"信号）', async () => {
    const c = mk({ maxAttempts: 3, breaker503: 2 });
    server.reset();
    try {
      await assert.rejects(c.get(`${server.base}/429`, 'test:429'), (err: unknown) => {
        assert.ok(err instanceof HttpStatusError);
        assert.equal(err.status, 429);
        return true;
      });
      assert.equal(server.hitsOf('/429'), 1, '429 同样零重试');
      // 混着来：429 + 503 = 连续 2 次 → 熔断
      await assert.rejects(c.get(`${server.base}/503`, 'test:503'), CircuitOpenError);
      assert.equal(c.breakerOpen, true);
      assert.match(c.breakerReason ?? '', /连续 2 次 http_503/);
      assert.deepEqual(c.stats().statusBuckets, { '429': 1, '503': 1 });
    } finally {
      await c.close();
    }
  });

  it('断路器只对**连续**失败开火：中间一次成功就清零', async () => {
    const c = mk({ maxAttempts: 3, breaker503: 3 });
    server.reset();
    try {
      await assert.rejects(c.get(`${server.base}/503`, 'm'), HttpStatusError);
      await assert.rejects(c.get(`${server.base}/503`, 'm'), HttpStatusError);
      assert.equal(c.stats().consecutive503, 2);

      const ok = await c.get(`${server.base}/ok`, 'm');
      assert.equal(ok.status, 200);
      assert.equal(c.stats().consecutive503, 0, '成功一次即清零');

      // 再来两次也还不该熔断（说明清零是真的生效了，不是只改了展示字段）
      await assert.rejects(c.get(`${server.base}/503`, 'm'), HttpStatusError);
      await assert.rejects(c.get(`${server.base}/503`, 'm'), HttpStatusError);
      assert.equal(c.breakerOpen, false);
      assert.equal(server.hitsOf('/503'), 4);
    } finally {
      await c.close();
    }
  });
});

// ─── §3 500：正常重试到 maxAttempts ─────────────────────────────────────────

describe('§3 500：与 503 分开处理，正常重试到 maxAttempts', () => {
  it('持续 500 → 恰好打 maxAttempts 次，且不污染 503 熔断计数', async () => {
    const c = mk({ maxAttempts: 3, breaker503: 3 });
    server.reset();
    try {
      await assert.rejects(c.get(`${server.base}/500`, 'test:500'), (err: unknown) => {
        assert.ok(err instanceof HttpStatusError);
        assert.equal(err.status, 500);
        assert.match(err.message, /boom/); // body 片段带在错误里，便于归因
        return true;
      });
      assert.equal(server.hitsOf('/500'), 3, '500 该重试到 maxAttempts');
      const st = c.stats();
      assert.equal(st.attempts, 3);
      assert.equal(st.statusBuckets['500'], 3);
      // 500 是"服务端这一下没成"，不是"出口被拦"→ 不进 503 熔断计数
      assert.equal(st.consecutive503, 0);
      assert.equal(st.consecutiveResets, 0);
      assert.equal(st.breakerOpen, false);

      const tel = c.takeTelemetry();
      assert.equal(tel.length, 1, '一次 request() = 一条遥测，重试不加条数');
      assert.equal(tel[0]!.attempts, 3);
      // 语义说明：retryReasons 记的是"可重试失败的次数"（含最后那次不再重试的），
      // 不是"实际重试次数"。stats.retries 同口径。钉在这里，免得将来被当成新 bug。
      assert.deepEqual(tel[0]!.retryReasons, ['http_500', 'http_500', 'http_500']);
      assert.equal(st.retries, 3);
    } finally {
      await c.close();
    }
  });

  it('maxAttempts=1 → 500 也只打一次（配置说话）', async () => {
    const c = mk({ maxAttempts: 1 });
    server.reset();
    try {
      await assert.rejects(c.get(`${server.base}/500`, 'm'), HttpStatusError);
      assert.equal(server.hitsOf('/500'), 1);
    } finally {
      await c.close();
    }
  });

  it('先 500 后 200 → 重试成功，遥测仍然恰好一条（attempts=2）', async () => {
    const c = mk({ maxAttempts: 3 });
    server.reset();
    server.flakyFailures = 1;
    try {
      const res = await c.get(`${server.base}/flaky-500`, 'test:flaky');
      assert.equal(res.status, 200);
      assert.equal(res.text(), 'recovered');
      assert.equal(server.hitsOf('/flaky-500'), 2);
      const tel = c.takeTelemetry();
      assert.equal(tel.length, 1);
      assert.equal(tel[0]!.attempts, 2);
      assert.equal(tel[0]!.ok, true);
      assert.deepEqual(tel[0]!.retryReasons, ['http_500']);
    } finally {
      await c.close();
    }
  });

  it('probe 瞬时 reset 后成功：探针单独记账，业务失败率分母仍为 0', async () => {
    const c = mk({ maxAttempts: 3, breakerReset: 6 });
    server.reset();
    server.flakyFailures = 1;
    try {
      const res = await c.get(`${server.base}/flaky-reset`, 'probe:amc');
      assert.equal(res.status, 200);
      assert.equal(server.hitsOf('/flaky-reset'), 2);
      assert.deepEqual(c.healthStats(), {
        business: {
          requests: 0,
          attempts: 0,
          statusBuckets: {},
          transportFailures: 0,
        },
        probe: {
          requests: 1,
          attempts: 2,
          statusBuckets: { '200': 1 },
          transportFailures: 0,
        },
      });
      assert.deepEqual(c.stats().statusBuckets, { '200': 1, transport: 1 });
    } finally {
      await c.close();
    }
  });

  it('4xx / 3xx 立即抛、零重试、不计熔断；3xx 刻意不跟随', async () => {
    const c = mk({ maxAttempts: 3 });
    server.reset();
    try {
      await assert.rejects(c.get(`${server.base}/404`, 'm'), (err: unknown) => {
        assert.ok(err instanceof HttpStatusError);
        assert.equal(err.status, 404);
        return true;
      });
      assert.equal(server.hitsOf('/404'), 1);

      await assert.rejects(c.get(`${server.base}/302`, 'm'), (err: unknown) => {
        assert.ok(err instanceof HttpStatusError);
        // 3xx = "枚举面变了"，是要人看的信号，不是要静默跟过去的
        assert.equal(err.status, 302);
        return true;
      });
      assert.equal(server.hitsOf('/302'), 1);
      assert.equal(server.hitsOf('/ok'), 0, '绝不跟随重定向');

      const st = c.stats();
      assert.equal(st.consecutive503, 0);
      assert.equal(st.breakerOpen, false);
      assert.equal(st.retries, 0);
    } finally {
      await c.close();
    }
  });

  it('图片重定向与瞬时失败重试分账：跟随 302，500 仍只打一次', async () => {
    const c = mk({ maxAttempts: 4 });
    const imageOptions = {
      maxAttempts: 4,
      maxTransientAttempts: 1,
      maxRedirections: 3,
      redirectPolicy: 'any' as const,
    };
    server.reset();
    try {
      const res = await c.get(`${server.base}/302`, 'image:external', imageOptions);
      assert.equal(res.status, 200);
      assert.equal(server.hitsOf('/302'), 1);
      assert.equal(server.hitsOf('/ok'), 1);
      assert.equal(res.telemetry.attempts, 2);

      await assert.rejects(c.get(`${server.base}/500`, 'image:external', imageOptions), HttpStatusError);
      assert.equal(server.hitsOf('/500'), 1, '瞬时失败不得在同一 job 内放大');
    } finally {
      await c.close();
    }
  });

  it('回归：gzip 404 先解压再构造错误消息，压缩头的 NUL 不得泄漏', async () => {
    const c = mk({ maxAttempts: 1 });
    server.reset();
    try {
      await assert.rejects(c.get(`${server.base}/gzip-404`, 'm'), (err: unknown) => {
        assert.ok(err instanceof HttpStatusError);
        assert.equal(err.status, 404);
        assert.match(err.message, /页面不存在：这是解压后的可读错误体/);
        assert.doesNotMatch(err.message, /\u0000/);
        assert.doesNotMatch(err.message, /[\u0001-\u0008\u000b\u000c\u000e-\u001f]/);
        return true;
      });
      assert.equal(server.hitsOf('/gzip-404'), 1);
    } finally {
      await c.close();
    }
  });
});

// ─── §3 连续传输重置的熔断 ──────────────────────────────────────────────────

describe('§3 传输重置：偶发允许重试，连续到阈值即熔断', () => {
  it('连续重置 → 到 breakerReset 抛 CircuitOpenError，之后不再触网', async () => {
    // maxAttempts=4 但 breakerReset=2：熔断阈值先到，重试次数用不完。
    const c = mk({ maxAttempts: 4, breakerReset: 2 });
    server.reset();
    try {
      await assert.rejects(c.get(`${server.base}/reset`, 'test:reset'), (err: unknown) => {
        assert.ok(err instanceof CircuitOpenError, `应当是 CircuitOpenError，实际 ${err}`);
        assert.match(err.message, /连续 2 次传输重置/);
        assert.match(err.message, /出口链路不可用/);
        return true;
      });
      // 第 1 次重置后仍会重试（实测基线传输失败率 1–3%，一次抖动不该让整轮白跑），
      // 第 2 次达到阈值 → 熔断。所以恰好打了 2 次。
      assert.equal(server.hitsOf('/reset'), 2);
      const st = c.stats();
      assert.equal(st.attempts, 2);
      assert.equal(st.statusBuckets['transport'], 2);
      assert.equal(st.consecutiveResets, 2);
      assert.equal(st.breakerOpen, true);

      const tel = c.takeTelemetry();
      assert.equal(tel.length, 1);
      assert.equal(tel[0]!.status, null, '纯传输失败没有状态码，必须是 null 而不是 0/200');
      assert.equal(tel[0]!.ok, false);
      assert.match(tel[0]!.error ?? '', /CircuitOpenError|transport/);

      const hitsAtTrip = server.total();
      await assert.rejects(c.get(`${server.base}/ok`, 'm'), CircuitOpenError);
      assert.equal(server.total(), hitsAtTrip, '熔断后必须完全不触网');
    } finally {
      await c.close();
    }
  });

  it('偶发重置（一次后恢复）不熔断：重试即成功', async () => {
    const c = mk({ maxAttempts: 3, breakerReset: 6 });
    server.reset();
    try {
      // /flaky-reset 不存在，改用"先打 /reset 再打 /ok"证明计数器语义：
      await assert.rejects(c.get(`${server.base}/reset`, 'm'), (err: unknown) => {
        // maxAttempts=3、breakerReset=6：三次都重置，重试耗尽但**不熔断**
        assert.match(String(err), /transport reset|TransportError/);
        return true;
      });
      assert.equal(server.hitsOf('/reset'), 3);
      assert.equal(c.stats().consecutiveResets, 3);
      assert.equal(c.breakerOpen, false, '3 < 6，还不到阈值');

      const ok = await c.get(`${server.base}/ok`, 'm');
      assert.equal(ok.status, 200);
      assert.equal(c.stats().consecutiveResets, 0, '成功一次即清零');
    } finally {
      await c.close();
    }
  });
});

// ─── §4 gzip 与字节记账 ─────────────────────────────────────────────────────

describe('§4 gzip 解压 + wireBytes/decodedBytes 分别记账', () => {
  it('gzip 正文完整解压；线上字节远小于解压后字节，两者各记各的', async () => {
    const c = mk();
    server.reset();
    try {
      const res = await c.get(`${server.base}/gzip`, 'test:gzip');
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-encoding'], 'gzip');
      assert.equal(res.text(), PAYLOAD, '解压后必须逐字节等于原文');

      const wire = gzipSync(Buffer.from(PAYLOAD, 'utf-8')).byteLength;
      const decoded = Buffer.byteLength(PAYLOAD, 'utf-8');
      assert.equal(res.telemetry.wireBytes, wire, 'wireBytes = 压缩后（真实带宽账）');
      assert.equal(res.telemetry.decodedBytes, decoded, 'decodedBytes = 解压后');
      assert.notEqual(res.telemetry.wireBytes, res.telemetry.decodedBytes);
      assert.ok(wire * 5 < decoded, `实测量级：1.14 MB → 180 KB。本例 ${wire} vs ${decoded}`);
      assert.equal(res.telemetry.contentEncoding, 'gzip');

      // 客户端级累计同样分两笔
      const st = c.stats();
      assert.equal(st.wireBytes, wire);
      assert.equal(st.decodedBytes, decoded);
    } finally {
      await c.close();
    }
  });

  it('不压缩时两个数相等（记账口径一致，不是"压缩才记"）', async () => {
    const c = mk();
    server.reset();
    try {
      const res = await c.get(`${server.base}/ok`, 'm');
      assert.equal(res.telemetry.contentEncoding, null);
      assert.equal(res.telemetry.wireBytes, Buffer.byteLength('ok-body'));
      assert.equal(res.telemetry.decodedBytes, res.telemetry.wireBytes);
    } finally {
      await c.close();
    }
  });

  it('声明 gzip 但内容不是 gzip → 失败上抛，绝不返回乱码/空 body', async () => {
    const c = mk({ maxAttempts: 1 });
    server.reset();
    try {
      await assert.rejects(c.get(`${server.base}/gzip-corrupt`, 'm'), (err: unknown) => {
        // 现状：解压失败发生在响应读取之后，被归到 transport('other') 一类去重试。
        // 归类不算精确（不是传输问题），但**行为是对的**：不重试的路径会把一个坏 body
        // 当成成功结果返回，那才是灾难。原始病因串（"解压失败"）被完整保留在错误里。
        assert.match(String(err), /解压失败/);
        assert.match(String(err), /content-encoding=gzip/);
        return true;
      });
      assert.equal(server.hitsOf('/gzip-corrupt'), 1);
    } finally {
      await c.close();
    }
  });

  it('decodeBody 单元：gzip / deflate / br / 无编码 / 未知编码 / 坏数据', () => {
    const raw = Buffer.from('sitemap 内容', 'utf-8');
    assert.equal(decodeBody(gzipSync(raw), 'gzip').toString('utf-8'), 'sitemap 内容');
    assert.equal(decodeBody(deflateSync(raw), 'deflate').toString('utf-8'), 'sitemap 内容');
    assert.equal(decodeBody(brotliCompressSync(raw), 'br').toString('utf-8'), 'sitemap 内容');
    assert.equal(decodeBody(gzipSync(raw), 'GZIP').toString('utf-8'), 'sitemap 内容'); // 大小写
    assert.equal(decodeBody(raw, null).toString('utf-8'), 'sitemap 内容');
    // 未知编码：原样返回（总比猜错好；解析层会因为"不是 urlset"当场炸）
    assert.equal(decodeBody(raw, 'identity').toString('utf-8'), 'sitemap 内容');
    assert.throws(() => decodeBody(raw, 'gzip'), /解压失败（content-encoding=gzip）/);
  });
});

// ─── §4 遥测：每请求恰好一条 ────────────────────────────────────────────────

describe('§4 遥测：每请求恰好一条，成功/重试/失败/熔断都一样', () => {
  it('五种结局混着跑：requests === 5，telemetry.length === 5，一一对应', async () => {
    const seen: string[] = [];
    const c = mk({
      maxAttempts: 2,
      breaker503: 2,
      onTelemetry: (t) => seen.push(t.mode),
    });
    server.reset();
    server.flakyFailures = 1;
    try {
      await c.get(`${server.base}/ok`, 'm1:ok'); // 一次成功
      await c.get(`${server.base}/gzip`, 'm2:gzip'); // gzip 成功
      await assert.rejects(c.get(`${server.base}/404`, 'm3:fatal'), HttpStatusError); // 立即失败
      await assert.rejects(c.get(`${server.base}/500`, 'm4:retry-exhausted'), HttpStatusError);
      await c.get(`${server.base}/flaky-500`, 'm5:retry-then-ok'); // 重试后成功

      const st = c.stats();
      assert.equal(st.requests, 5, '5 次 request() = 5 条账');
      assert.equal(st.attempts, 1 + 1 + 1 + 2 + 2, '尝试次数另算，不与请求数混淆');
      assert.deepEqual(st.statusBuckets, { '200': 3, '404': 1, '500': 3 });

      const tel = c.takeTelemetry();
      assert.equal(tel.length, 5);
      assert.deepEqual(
        tel.map((t) => t.mode),
        ['m1:ok', 'm2:gzip', 'm3:fatal', 'm4:retry-exhausted', 'm5:retry-then-ok'],
      );
      assert.deepEqual(
        tel.map((t) => t.ok),
        [true, true, false, false, true],
      );
      assert.deepEqual(seen, tel.map((t) => t.mode), 'onTelemetry 回调与累积列表一致');
      assert.ok(tel.every((t) => t.durationMs >= 0 && t.method === 'GET'));
      assert.ok(tel.every((t) => typeof t.url === 'string' && t.url.startsWith(server.base)));

      // takeTelemetry 是"取走"：第二次调用为空，不会把同一条账重复写进 ingest_run
      assert.equal(c.takeTelemetry().length, 0);
      assert.equal(c.stats().requests, 5, 'takeTelemetry 不清 stats');

      // 熔断那次也恰好记一条：503 → 503 触发熔断，共 2 条
      await assert.rejects(c.get(`${server.base}/503`, 'm6'), HttpStatusError);
      await assert.rejects(c.get(`${server.base}/503`, 'm7'), CircuitOpenError);
      assert.equal(c.takeTelemetry().length, 2);
      // 熔断之后的请求不产生任何账（它们从未出网）
      await assert.rejects(c.get(`${server.base}/ok`, 'm8'), CircuitOpenError);
      assert.equal(c.takeTelemetry().length, 0);
      assert.equal(c.stats().requests, 7);
    } finally {
      await c.close();
    }
  });
});
