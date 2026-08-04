/**
 * HTTP 层 —— 全部护栏都来自 2026-07-27 的实测，不是防御性编程的直觉。
 *
 * 四条硬约束：
 *
 * 1. **请求头契约**（synthesis §2.2 / findings [MEDIUM] 空 UA）
 *    · 空 / 缺失 User-Agent → WAF 返回 HTTP 503 空体（实测 0 B，UA 一填任意值即 200）
 *    · AMC POST 缺 Referer → TCP 连接重置（实测 0/15 成功；带任意 Referer 15/15 200）
 *    两条都是**未文档化的边缘契约**，且值任意、只校验存在性 —— 典型的粗糙 bot-mitigation
 *    规则，说明该边缘的规则集正在被主动调整。所以不是"设个默认值就行"，而是
 *    `assertHeaders()` 启动自检 + 每次请求前再校验一遍：任何路径上把头弄丢都要立刻炸，
 *    绝不能安静地退化成 503 洪水。（v1 的 https-fix.ts 猴补丁 globalThis.fetch 就正是
 *    "把 headers 弄丢"最容易发生的地方。）
 *
 * 2. **per-client dispatcher，不用 setGlobalDispatcher**
 *    v1 的 utils/proxy.ts 调 setGlobalDispatcher(new ProxyAgent(...))，代价是同进程里
 *    任何其它出站（pg 不受影响，但 fetch、遥测上报、健康探针都受影响）全被拖到 wikidot
 *    的代理池上走。syncer2 把 dispatcher 绑在 client 实例上按请求传入，谁要走代理谁自己声明。
 *
 * 3. **503 与"连续传输重置"从 5xx 一律重试里摘出来，单独熔断**
 *    @ukwhatn/wikidot 的 fetchWithRetry 是"4xx 立即抛、5xx 重试"，AMC 层 retryLimit=5
 *    指数退避 base 1s ×2 上限 60s。于是一旦 UA 变空，每个请求变 5 次带退避的重试，
 *    在 IP 池上表现为持续数十分钟的 503 洪水 —— 这正是最容易招真封禁的行为模式。
 *    **503 的正确响应是停手，不是重发。** 这里 503 零重试、直接计入熔断计数器；
 *    连续 N 次即打开断路器，之后所有请求立即抛 CircuitOpenError，进程该退出就退出。
 *    传输重置同理（实测基线失败率 1–3%，偶发正常、连续说明出口坏了）。
 *
 * 4. **每次请求都记账**：mode / 耗时 / 尝试数 / 线上字节 / 解压后字节 / 状态码。
 *    按状态码分桶后写进 meta.ingest_run.stats，让 503 占比成为显式健康指标。
 */

import { Agent, ProxyAgent, request, type Dispatcher } from 'undici';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { createLogger, type Logger } from '../util/log.js';
import { EgressAttributor, type EgressAttributorOptions, type ExitIpStats } from './egress.js';

// ─── 错误类型 ────────────────────────────────────────────────────────────────

/** 请求头契约被破坏（UA/Referer 缺失或非法）。拒绝启动 / 拒绝发出。 */
export class HeaderContractError extends Error {
  override readonly name = 'HeaderContractError';
}

/** 非 2xx。retryable 由调用方看 status 决定，这里只是搬运。 */
export class HttpStatusError extends Error {
  override readonly name = 'HttpStatusError';
  constructor(
    readonly status: number,
    readonly url: string,
    readonly bodySnippet: string,
  ) {
    super(`HTTP ${status} for ${url}${bodySnippet ? ` :: ${bodySnippet}` : ''}`);
  }
}

/** 传输层错误（连接重置 / 超时 / socket 挂断）。 */
export class TransportError extends Error {
  override readonly name = 'TransportError';
  constructor(
    readonly kind: 'reset' | 'timeout' | 'other',
    readonly url: string,
    override readonly cause: unknown,
  ) {
    super(`transport ${kind} for ${url}: ${describeError(cause)}`);
  }
}

/** 断路器已打开，本进程不再发出任何请求。调用方应当**退出**而不是等它恢复。 */
export class CircuitOpenError extends Error {
  override readonly name = 'CircuitOpenError';
  constructor(readonly reason: string) {
    super(`egress circuit open: ${reason}`);
  }
}

// ─── 类型 ────────────────────────────────────────────────────────────────────

export interface RequestTelemetry {
  /** 逻辑用途标签，例如 'sitemap:index' / 'sitemap:page_1'。进 stats 时按 mode 聚合。 */
  mode: string;
  method: string;
  url: string;
  /** 最终状态码；纯传输失败时为 null。 */
  status: number | null;
  /** 实际尝试次数（含成功那次）。 */
  attempts: number;
  durationMs: number;
  /** 线上字节（解压前，= 实际带宽消耗）。 */
  wireBytes: number;
  /** 解压后字节。 */
  decodedBytes: number;
  contentEncoding: string | null;
  ok: boolean;
  error?: string;
  /** 每次重试的原因，按发生顺序。 */
  retryReasons: string[];
}

export interface HttpClientStats {
  requests: number;
  attempts: number;
  wireBytes: number;
  decodedBytes: number;
  totalDurationMs: number;
  /** 状态码分桶，键是字符串以便直接 JSON 化；'transport' 表示没拿到状态码。 */
  statusBuckets: Record<string, number>;
  retries: number;
  consecutive503: number;
  consecutiveResets: number;
  breakerOpen: boolean;
  breakerReason: string | null;
}

export interface HttpClientOptions {
  userAgent: string;
  referer: string;
  /** 形如 http://127.0.0.1:7891。null/undefined = 不经代理（本机直出）。 */
  proxyUrl?: string | null;
  timeoutMs?: number;
  /** 可重试错误的最大尝试次数（含首次）。503 与重置不吃这个数。 */
  maxAttempts?: number;
  /** 连续 503 达到该值即熔断。 */
  breaker503?: number;
  /** 连续传输重置达到该值即熔断。 */
  breakerReset?: number;
  /** dispatcher 连接池大小。 */
  connections?: number;
  logger?: Logger;
  /** 每条请求遥测的回调（可选，用于流式落盘）。 */
  onTelemetry?: (t: RequestTelemetry) => void;
  /**
   * 出口归因（meta.ingest_run.exit_ip_stats 的生产者）。
   * 省略 = 不做归因（exitIpStats() 返回 null）。dispatcher 由 client 自己注入 ——
   * 探针必须走**同一个代理池**才有意义。
   */
  egress?: Omit<EgressAttributorOptions, 'dispatcher' | 'logger'>;
}

export interface HttpRequestOptions {
  mode: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  /** 已按 content-encoding 解压。 */
  body: Buffer;
  text(): string;
  telemetry: RequestTelemetry;
}

// ─── 头契约校验 ──────────────────────────────────────────────────────────────

const HEADER_VALUE_ILLEGAL = /[\r\n\0]/;

/**
 * 请求头契约的唯一判据。启动自检与每次请求前各跑一遍。
 * 校验的是**存在且非空**，不是值本身 —— 实测边缘只校验存在性。
 */
export function assertHeaderContract(
  headers: Readonly<Record<string, string>>,
  context: string,
): void {
  for (const key of ['user-agent', 'referer'] as const) {
    const value = headers[key];
    if (value === undefined) {
      throw new HeaderContractError(
        `${context}: 缺少 ${key} 头。实测后果：缺 user-agent → WAF 503 空体；` +
          `缺 referer（POST）→ TCP 连接重置。拒绝发出请求。`,
      );
    }
    if (value.trim() === '') {
      throw new HeaderContractError(
        `${context}: ${key} 头为空字符串。空 UA 与缺 UA 实测等价（都是 503）。拒绝发出请求。`,
      );
    }
    if (HEADER_VALUE_ILLEGAL.test(value)) {
      throw new HeaderContractError(`${context}: ${key} 头含 CR/LF/NUL，拒绝发出请求。`);
    }
  }
}

// ─── 错误分类 ────────────────────────────────────────────────────────────────

type Disposition =
  | { kind: 'fatal'; reason: string }
  | { kind: 'retry'; reason: string }
  | { kind: 'breaker-503'; reason: string }
  | { kind: 'breaker-reset'; reason: string };

const RESET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'UND_ERR_SOCKET']);
const TIMEOUT_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'ETIMEDOUT',
  'ABORT_ERR',
]);
const RESET_MESSAGE_HINTS = [
  'other side closed',
  'socket hang up',
  'connection reset',
  'reset by peer',
  'empty reply',
  'terminated',
];

function classifyTransport(cause: unknown): 'reset' | 'timeout' | 'other' {
  const code = typeof cause === 'object' && cause !== null ? String((cause as { code?: unknown }).code ?? '') : '';
  if (TIMEOUT_CODES.has(code)) return 'timeout';
  if (RESET_CODES.has(code)) return 'reset';
  const msg = describeError(cause).toLowerCase();
  if (RESET_MESSAGE_HINTS.some((h) => msg.includes(h))) return 'reset';
  if (msg.includes('timeout') || msg.includes('aborted')) return 'timeout';
  return 'other';
}

function classifyStatus(status: number): Disposition | null {
  if (status >= 200 && status < 300) return null;
  // 503 单独摘出：绝不重试。空 UA / WAF 拦截都走这条路，重发只会放大。
  if (status === 503) {
    return { kind: 'breaker-503', reason: 'http_503' };
  }
  // 429 同样是"停手"信号，不是"再来一次"。归入 503 同一条熔断计数（都是被限流/拦截）。
  if (status === 429) {
    return { kind: 'breaker-503', reason: 'http_429' };
  }
  if (status >= 500) {
    return { kind: 'retry', reason: `http_${status}` };
  }
  // 3xx：不跟随。sitemap URL 由站点索引给出，出现重定向 = 枚举面变了，要人看。
  // 4xx：立即抛，重试无意义（403 握手抖动由更上层的 connect 重试负责，不在这层）。
  return { kind: 'fatal', reason: `http_${status}` };
}

export function describeError(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return code ? `${e.name}(${String(code)}): ${e.message}` : `${e.name}: ${e.message}`;
  }
  return String(e);
}

// ─── 客户端 ──────────────────────────────────────────────────────────────────

export class HttpClient {
  readonly #dispatcher: Dispatcher;
  readonly #baseHeaders: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #breaker503: number;
  readonly #breakerReset: number;
  readonly #log: Logger;
  readonly #onTelemetry: ((t: RequestTelemetry) => void) | undefined;
  readonly #telemetry: RequestTelemetry[] = [];
  readonly proxyUrl: string | null;
  readonly #egress: EgressAttributor | null;

  #consecutive503 = 0;
  #consecutiveResets = 0;
  #breakerReason: string | null = null;

  #stats: HttpClientStats = {
    requests: 0,
    attempts: 0,
    wireBytes: 0,
    decodedBytes: 0,
    totalDurationMs: 0,
    statusBuckets: {},
    retries: 0,
    consecutive503: 0,
    consecutiveResets: 0,
    breakerOpen: false,
    breakerReason: null,
  };

  constructor(opts: HttpClientOptions) {
    this.#log = opts.logger ?? createLogger('http');
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    this.#maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    this.#breaker503 = Math.max(1, opts.breaker503 ?? 3);
    this.#breakerReset = Math.max(1, opts.breakerReset ?? 6);
    this.#onTelemetry = opts.onTelemetry;
    this.proxyUrl = opts.proxyUrl && opts.proxyUrl.trim() !== '' ? opts.proxyUrl.trim() : null;

    this.#baseHeaders = {
      'user-agent': opts.userAgent,
      referer: opts.referer,
      // 显式声明可接受的压缩：sitemap 1.14 MB → gzip 180 KB，这条头值 1 MB/次。
      'accept-encoding': 'gzip, deflate, br',
      accept: '*/*',
    };
    // 构造即校验：配置错误在 new 的那一刻炸，而不是在第一个请求 503 之后。
    assertHeaderContract(this.#baseHeaders, 'HttpClient 构造');

    const agentOptions = {
      connections: opts.connections ?? 4,
      headersTimeout: this.#timeoutMs,
      bodyTimeout: this.#timeoutMs,
      // keepAlive 短一点：轮换 IP 池下长连接会把流量钉在同一个节点上
      keepAliveTimeout: 4_000,
      keepAliveMaxTimeout: 10_000,
    };
    // per-client dispatcher。刻意不调 setGlobalDispatcher —— 见文件头 §2。
    this.#dispatcher = this.proxyUrl
      ? new ProxyAgent({ uri: this.proxyUrl, ...agentOptions })
      : new Agent(agentOptions);

    // 出口归因：探针必须绑在同一个 dispatcher 上（同一个代理池），否则量的是别人的出口。
    this.#egress = opts.egress
      ? new EgressAttributor({
          ...opts.egress,
          dispatcher: this.#dispatcher,
          logger: this.#log.child('egress'),
        })
      : null;

    this.#log.info('client 就绪', {
      proxy: this.proxyUrl ?? '(direct)',
      userAgent: opts.userAgent,
      referer: opts.referer,
      timeoutMs: this.#timeoutMs,
      maxAttempts: this.#maxAttempts,
      breaker503: this.#breaker503,
      breakerReset: this.#breakerReset,
    });
  }

  /**
   * 启动自检：不发请求，只断言本进程即将使用的头满足契约。
   * 缺任一项直接抛 HeaderContractError，调用方应当拒绝启动。
   *
   * 之所以做成显式方法而不是"反正构造时也校验了"：调用方可能在中途 merge 自定义头，
   * 而这个自检是写进启动流程的一道**可被 code review 看见**的关卡。
   */
  assertHeaders(): void {
    assertHeaderContract(this.#baseHeaders, 'assertHeaders 启动自检');
    this.#log.info('assertHeaders 通过', {
      userAgent: this.#baseHeaders['user-agent'],
      referer: this.#baseHeaders['referer'],
    });
  }

  get breakerOpen(): boolean {
    return this.#breakerReason !== null;
  }

  get breakerReason(): string | null {
    return this.#breakerReason;
  }

  stats(): HttpClientStats {
    return {
      ...this.#stats,
      statusBuckets: { ...this.#stats.statusBuckets },
      consecutive503: this.#consecutive503,
      consecutiveResets: this.#consecutiveResets,
      breakerOpen: this.breakerOpen,
      breakerReason: this.#breakerReason,
    };
  }

  /** 取走并清空累积的逐请求遥测。 */
  takeTelemetry(): RequestTelemetry[] {
    return this.#telemetry.splice(0, this.#telemetry.length);
  }

  /**
   * 出口归因统计（落 meta.ingest_run.exit_ip_stats）。未开启归因时返回 null。
   * 语义与可信度见 http/egress.ts 文件头 —— byIp 是池构成采样，byNode 才是按连接真值。
   */
  exitIpStats(): ExitIpStats | null {
    return this.#egress?.stats() ?? null;
  }

  /** 当前采样到的出口 IP（用于日志/诊断，不作逐请求归因用）。 */
  get currentExitIp(): string | null {
    return this.#egress?.currentIp ?? null;
  }

  /**
   * 启动时探一次出口（IP 回显 + mihomo 节点）。
   * 失败不抛 —— 「代理是否健康」这个判断由 http/amc.ts 的启动自检 #3 负责下结论，
   * 这里只负责采样。
   */
  async primeEgress(): Promise<string | null> {
    return (await this.#egress?.primeOnStart()) ?? null;
  }

  async close(): Promise<void> {
    await this.#dispatcher.close().catch(() => undefined);
  }

  async get(url: string, mode: string, extra?: Partial<HttpRequestOptions>): Promise<HttpResponse> {
    return this.request(url, { mode, method: 'GET', ...extra });
  }

  /**
   * 单次请求。遥测**恰好记一条**（无论成功、重试后成功、还是彻底失败），
   * 由 request() 统一在出口处 #finish，#handleDisposition 只负责分类与计数器。
   */
  async request(url: string, opts: HttpRequestOptions): Promise<HttpResponse> {
    if (this.#breakerReason !== null) {
      throw new CircuitOpenError(this.#breakerReason);
    }

    const method = opts.method ?? 'GET';
    const headers: Record<string, string> = { ...this.#baseHeaders, ...lowercaseKeys(opts.headers) };
    // 每次请求前再校验一次：调用方 merge 的自定义头可能把 UA/Referer 覆盖成空。
    assertHeaderContract(headers, `${method} ${url}`);

    const timeoutMs = opts.timeoutMs ?? this.#timeoutMs;
    const maxAttempts = Math.max(1, opts.maxAttempts ?? this.#maxAttempts);
    const startedAt = performance.now();
    const retryReasons: string[] = [];

    let attempts = 0;
    let lastError: unknown;
    let lastStatus: number | null = null;
    let lastWireBytes = 0;

    try {
      while (attempts < maxAttempts) {
        attempts++;
        this.#stats.attempts++;

        let attemptOutcome: Disposition | null = null;
        try {
          const res = await request(url, {
            method,
            headers,
            body: opts.body,
            dispatcher: this.#dispatcher,
            headersTimeout: timeoutMs,
            bodyTimeout: timeoutMs,
            // 刻意不跟随重定向：sitemap 的 URL 是站点自己在索引里给的，
            // 一旦出现 3xx 说明枚举面变了（换域名 / 加了拦截跳转），这是要人看的信号，
            // 不是要静默跟过去的。3xx 在 classifyStatus 里归入 fatal。
          });
          lastStatus = res.statusCode;
          const raw = Buffer.from(await res.body.arrayBuffer());
          lastWireBytes = raw.byteLength;
          const resHeaders = flattenHeaders(res.headers);
          this.#bucket(String(lastStatus));

          attemptOutcome = classifyStatus(lastStatus);
          if (attemptOutcome === null) {
            // 成功：连续计数器归零。断路器只对**连续**失败开火。
            this.#consecutive503 = 0;
            this.#consecutiveResets = 0;
            const encoding = resHeaders['content-encoding'] ?? null;
            const decoded = decodeBody(raw, encoding);
            const telemetry = this.#finish({
              mode: opts.mode,
              method,
              url,
              status: lastStatus,
              attempts,
              durationMs: performance.now() - startedAt,
              wireBytes: raw.byteLength,
              decodedBytes: decoded.byteLength,
              contentEncoding: encoding,
              ok: true,
              retryReasons,
            });
            // 出口归因：成功路径按 N 节流采样（不是每请求都探，见 egress.ts 成本纪律）
            await this.#egress?.afterRequest(true);
            return {
              status: lastStatus,
              headers: resHeaders,
              body: decoded,
              text: () => decoded.toString('utf-8'),
              telemetry,
            };
          }

          const snippet = raw.subarray(0, 200).toString('utf-8').replace(/\s+/g, ' ').trim();
          lastError = new HttpStatusError(lastStatus, url, snippet);
        } catch (err) {
          if (err instanceof CircuitOpenError || err instanceof HeaderContractError) throw err;
          if (err instanceof HttpStatusError) throw err; // 不该发生，保险
          const kind = classifyTransport(err);
          lastStatus = null;
          lastWireBytes = 0;
          lastError = new TransportError(kind, url, err);
          this.#bucket('transport');
          attemptOutcome =
            kind === 'reset'
              ? { kind: 'breaker-reset', reason: 'transport_reset' }
              : { kind: 'retry', reason: `transport_${kind}` };
        }

        // #handleDisposition 可能因熔断阈值达成而抛 CircuitOpenError（由外层 catch 记账）
        this.#handleDisposition(attemptOutcome, url, retryReasons, attempts);

        const retryable = attemptOutcome.kind === 'retry' || attemptOutcome.kind === 'breaker-reset';
        if (retryable && attempts < maxAttempts) {
          // 重置类在断路器未打开时仍允许重试 —— 实测基线传输失败率 1–3%，
          // 完全不重试会让整轮 sitemap 因为一次抖动就白跑；断路器负责拦住"连续"失败。
          await sleep(backoffMs(attempts));
          continue;
        }
        break;
      }

      throw lastError ?? new Error(`request failed without error: ${url}`);
    } catch (err) {
      this.#finish({
        mode: opts.mode,
        method,
        url,
        status: lastStatus,
        attempts,
        durationMs: performance.now() - startedAt,
        wireBytes: lastWireBytes,
        decodedBytes: 0,
        contentEncoding: null,
        ok: false,
        error: describeError(err),
        retryReasons,
      });
      // 失败路径**必采**：mihomo 节点归因 + 一次 IP 补探（受 maxProbes 封顶）。
      // 「某几个节点坏了」这个问题只有在失败的那一刻采样才答得上来。
      await this.#egress?.afterRequest(false);
      throw err;
    }
  }

  #handleDisposition(d: Disposition, url: string, retryReasons: string[], attempts: number): void {
    if (d.kind === 'breaker-503') {
      this.#consecutive503++;
      this.#consecutiveResets = 0;
      this.#log.warn('503/429：不重试，计入熔断', {
        url,
        reason: d.reason,
        consecutive: this.#consecutive503,
        limit: this.#breaker503,
      });
      if (this.#consecutive503 >= this.#breaker503) {
        this.#trip(
          `连续 ${this.#consecutive503} 次 ${d.reason} —— 疑似被 WAF 拦截或 UA 头丢失。` +
            `503 的正确响应是停手，进程应当退出而不是重发。`,
        );
      }
      return;
    }

    if (d.kind === 'breaker-reset') {
      this.#consecutiveResets++;
      this.#log.warn('传输重置', {
        url,
        consecutive: this.#consecutiveResets,
        limit: this.#breakerReset,
      });
      retryReasons.push(d.reason);
      this.#stats.retries++;
      if (this.#consecutiveResets >= this.#breakerReset) {
        this.#trip(
          `连续 ${this.#consecutiveResets} 次传输重置 —— 出口链路不可用（代理池节点全坏 / ` +
            `POST 缺 Referer 触发边缘 reset）。停手。`,
        );
      }
      return;
    }

    if (d.kind === 'retry') {
      retryReasons.push(d.reason);
      this.#stats.retries++;
      this.#log.warn('可重试失败', { url, reason: d.reason, attempt: attempts });
      return;
    }

    // fatal：4xx，不计熔断（4xx 是"这个 URL 不对"，不是"出口坏了"）
    this.#log.warn('不可重试失败', { url, reason: d.reason, attempt: attempts });
  }

  #trip(reason: string): never {
    this.#breakerReason = reason;
    this.#stats.breakerOpen = true;
    this.#stats.breakerReason = reason;
    this.#log.error('断路器打开', { reason });
    throw new CircuitOpenError(reason);
  }

  #bucket(key: string): void {
    this.#stats.statusBuckets[key] = (this.#stats.statusBuckets[key] ?? 0) + 1;
  }

  #finish(t: RequestTelemetry): RequestTelemetry {
    this.#stats.requests++;
    this.#stats.wireBytes += t.wireBytes;
    this.#stats.decodedBytes += t.decodedBytes;
    this.#stats.totalDurationMs += t.durationMs;
    this.#telemetry.push(t);
    this.#onTelemetry?.(t);
    this.#log.debug('request', {
      mode: t.mode,
      status: t.status,
      attempts: t.attempts,
      ms: Math.round(t.durationMs),
      wire: t.wireBytes,
      decoded: t.decodedBytes,
    });
    return t;
  }
}

// ─── 辅助 ────────────────────────────────────────────────────────────────────

function lowercaseKeys(h: Record<string, string> | undefined): Record<string, string> {
  if (!h) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function flattenHeaders(h: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

/**
 * 按 content-encoding 解压。等价于 curl --compressed。
 *
 * 刻意用低层 undici.request + 手工解压而不是 undici.fetch 的自动解压：
 *  (a) 能同时拿到**线上字节**和解压后字节，前者才是真实带宽账；
 *  (b) 解压行为可见可测，不依赖 fetch 实现细节在版本间的变化。
 */
export function decodeBody(raw: Buffer, contentEncoding: string | null): Buffer {
  if (!contentEncoding) return raw;
  const enc = contentEncoding.toLowerCase().trim();
  try {
    if (enc.includes('gzip')) return gunzipSync(raw);
    if (enc.includes('br')) return brotliDecompressSync(raw);
    if (enc.includes('deflate')) return inflateSync(raw);
  } catch (e) {
    throw new Error(`解压失败（content-encoding=${contentEncoding}）: ${describeError(e)}`);
  }
  return raw;
}

function backoffMs(attempt: number): number {
  // 上限 8s。刻意远低于库的 60s —— 短进程模型下，等 60s 不如让调度器重启。
  const base = Math.min(500 * 2 ** (attempt - 1), 8_000);
  return base + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
