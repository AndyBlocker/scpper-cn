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
import {
  abortableSleep,
  isRuntimeBudgetExceededError,
  throwIfAborted,
} from '../util/runtimeBudget.js';
import {
  EgressAttributor,
  proxyInboundPortFromUrl,
  type EgressAttributorOptions,
  type ExitIpStats,
} from './egress.js';
import {
  AdaptiveEgressUnavailableError,
  isAdaptivePressureFailure,
  type AdaptiveAttemptOutcome,
  type AdaptiveEgressGate,
  type AdaptiveEgressPermit,
  type AdaptiveEgressRuntimeStats,
} from './adaptiveEgress.js';

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
  /** 全站共享反馈控制器；生产 Wikidot 通道必须非 null。 */
  adaptiveEgress: AdaptiveEgressRuntimeStats | null;
}

export interface HttpHealthScopeStats {
  /** 完成的逻辑请求数；一次请求内部的重试不重复计数。 */
  requests: number;
  attempts: number;
  /** 最终结果分桶；重试后成功只记最终 2xx，不把瞬时 reset 伪装成失败请求。 */
  statusBuckets: Record<string, number>;
  /** 最终因传输错误耗尽的逻辑请求数。 */
  transportFailures: number;
}

export interface HttpHealthStats {
  /** 真正采集业务数据的请求；这是 parse-health 唯一允许使用的分母。 */
  business: HttpHealthScopeStats;
  /** mode=probe:* 的启动探针，单独留证但不参与业务失败率。 */
  probe: HttpHealthScopeStats;
}

export function businessTransportFailureRate(http: HttpClient): number | null {
  const business = http.healthStats().business;
  return business.requests === 0 ? null : business.transportFailures / business.requests;
}

export function businessHttpStatusDistribution(http: HttpClient): Record<string, number> | null {
  const business = http.healthStats().business;
  return business.requests === 0 ? null : business.statusBuckets;
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
  /** 可选 TLS 上限；仅给已实测需要固定协商版本的专用出口使用。 */
  tlsMaxVersion?: 'TLSv1.2' | 'TLSv1.3';
  /** 相邻 HTTP 尝试的最小启动间隔；用于有明确 QPS 预算的补账任务。 */
  minRequestIntervalMs?: number;
  logger?: Logger;
  /** 每条请求遥测的回调（可选，用于流式落盘）。 */
  onTelemetry?: (t: RequestTelemetry) => void;
  /**
   * 出口归因（meta.ingest_run.exit_ip_stats 的生产者）。
   * 省略 = 不做归因（exitIpStats() 返回 null）。dispatcher 由 client 自己注入 ——
   * 探针必须走**同一个代理池**才有意义。
   */
  egress?: Omit<EgressAttributorOptions, 'dispatcher' | 'logger' | 'proxyInboundPort'>;
  /** L0/L1/Tier2/sitemap 等跨进程共享的站点级反馈控制器。 */
  adaptiveEgress?: AdaptiveEgressGate;
  /** 单轮墙钟预算；会中断 pace、permit、传输、重试退避与出口归因。 */
  signal?: AbortSignal;
}

export interface HttpRequestOptions {
  mode: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** 总出站 attempt 上限（含重定向的每一跳）。 */
  maxAttempts?: number;
  /** 瞬时失败的最大尝试次数（含首次失败）；默认与 maxAttempts 相同。 */
  maxTransientAttempts?: number;
  /** 默认 0；由 HttpClient 逐跳记 attempt，普通 Wikidot 采集仍严格拒绝 3xx。 */
  maxRedirections?: number;
  /** same-host 防止共享 Wikidot gate 跟到站外；无 gate 的图片外站 client 可显式 any。 */
  redirectPolicy?: 'same-host' | 'any';
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  /** 已按 content-encoding 解压。 */
  body: Buffer;
  text(): string;
  telemetry: RequestTelemetry;
}

function safeRedirectUrl(currentUrl: string, location: string): string | null {
  try {
    const next = new URL(location, currentUrl);
    if (!['http:', 'https:'].includes(next.protocol)) return null;
    if (next.username !== '' || next.password !== '') return null;
    return next.toString();
  } catch {
    return null;
  }
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
  #minRequestIntervalMs: number;
  readonly #log: Logger;
  readonly #onTelemetry: ((t: RequestTelemetry) => void) | undefined;
  readonly #telemetry: RequestTelemetry[] = [];
  readonly proxyUrl: string | null;
  readonly tlsMaxVersion: 'TLSv1.2' | 'TLSv1.3' | null;
  readonly #egress: EgressAttributor | null;
  readonly #adaptiveEgress: AdaptiveEgressGate | null;
  readonly #signal: AbortSignal | undefined;
  #adaptiveOutcomeBatch: Array<{
    permit: AdaptiveEgressPermit;
    outcome: AdaptiveAttemptOutcome;
  }> | null = null;

  #consecutive503 = 0;
  #consecutiveResets = 0;
  #breakerReason: string | null = null;
  #lastAttemptStartedAt = Number.NEGATIVE_INFINITY;
  #paceTail: Promise<void> = Promise.resolve();

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
    adaptiveEgress: null,
  };
  #health: HttpHealthStats = {
    business: emptyHealthScope(),
    probe: emptyHealthScope(),
  };

  constructor(opts: HttpClientOptions) {
    this.#log = opts.logger ?? createLogger('http');
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    this.#maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
    // 采集规格铁律：基线传输失败率约 2.3%，N=5 的误跳闸概率约 6e-9。
    // 这里也用 5，避免绕过 config.ts 直接构造客户端时退回旧的 3/6。
    this.#breaker503 = Math.max(1, opts.breaker503 ?? 5);
    this.#breakerReset = Math.max(1, opts.breakerReset ?? 5);
    this.#minRequestIntervalMs = Math.max(
      0,
      Math.floor(opts.minRequestIntervalMs ?? 0),
    );
    this.#onTelemetry = opts.onTelemetry;
    this.#adaptiveEgress = opts.adaptiveEgress ?? null;
    this.#signal = opts.signal;
    this.proxyUrl = opts.proxyUrl && opts.proxyUrl.trim() !== '' ? opts.proxyUrl.trim() : null;
    this.tlsMaxVersion = opts.tlsMaxVersion ?? null;

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
      ? new ProxyAgent({
          uri: this.proxyUrl,
          ...agentOptions,
          ...(this.tlsMaxVersion === null
            ? {}
            : { requestTls: { maxVersion: this.tlsMaxVersion } }),
        })
      : new Agent({
          ...agentOptions,
          ...(this.tlsMaxVersion === null
            ? {}
            : { connect: { maxVersion: this.tlsMaxVersion } }),
        });

    // 出口归因：探针必须绑在同一个 dispatcher 上（同一个代理池），否则量的是别人的出口。
    this.#egress = opts.egress
      ? new EgressAttributor({
          ...opts.egress,
          dispatcher: this.#dispatcher,
          proxyInboundPort: proxyInboundPortFromUrl(this.proxyUrl),
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
      minRequestIntervalMs: this.#minRequestIntervalMs,
      tlsMaxVersion: this.tlsMaxVersion,
      adaptiveEgress: this.#adaptiveEgress === null ? 'disabled' : 'shared_postgres',
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

  /** 在任务认领后按批次启用/关闭请求启动节流；不会取消已经发出的请求。 */
  setMinRequestIntervalMs(value: number): void {
    this.#minRequestIntervalMs = Math.max(0, Math.floor(value));
    this.#lastAttemptStartedAt = Number.NEGATIVE_INFINITY;
    this.#log.info('请求启动节流已更新', {
      minRequestIntervalMs: this.#minRequestIntervalMs,
    });
  }

  get breakerOpen(): boolean {
    return this.#breakerReason !== null;
  }

  get breakerReason(): string | null {
    return this.#breakerReason;
  }

  get signal(): AbortSignal | undefined {
    return this.#signal;
  }

  stats(): HttpClientStats {
    return {
      ...this.#stats,
      statusBuckets: { ...this.#stats.statusBuckets },
      consecutive503: this.#consecutive503,
      consecutiveResets: this.#consecutiveResets,
      breakerOpen: this.breakerOpen,
      breakerReason: this.#breakerReason,
      adaptiveEgress: this.#adaptiveEgress?.stats() ?? null,
    };
  }

  /**
   * 面向全局 parse-health 的逻辑请求口径。
   *
   * `stats()` 仍保留全部逐尝试诊断（含 probe 和已恢复的瞬时错误）；健康判定必须使用
   * 本口径，避免空队列启动探针的一次 reset 把 n=1 算成 50% 全局故障。
   */
  healthStats(): HttpHealthStats {
    return {
      business: cloneHealthScope(this.#health.business),
      probe: cloneHealthScope(this.#health.probe),
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
    return (await this.#egress?.primeOnStart(this.#signal)) ?? null;
  }

  async close(): Promise<void> {
    if (this.#adaptiveOutcomeBatch !== null) {
      await this.finishAdaptiveOutcomeClassification(null).catch(() => undefined);
    }
    await Promise.all([
      this.#dispatcher.close().catch(() => undefined),
      this.#adaptiveEgress?.close().catch(() => undefined),
    ]);
  }

  async get(url: string, mode: string, extra?: Partial<HttpRequestOptions>): Promise<HttpResponse> {
    return this.request(url, { mode, method: 'GET', ...extra });
  }

  /**
   * work-queue 在任务级既有失败分类完成前暂存 gate outcome。任务是串行执行的，因此
   * 同一 HttpClient 同时只允许一个 batch；其它通道仍逐 attempt 立即反馈。
   */
  beginAdaptiveOutcomeClassification(): void {
    if (this.#adaptiveOutcomeBatch !== null) {
      throw new Error('自适应出口 outcome 分类 batch 不允许嵌套');
    }
    this.#adaptiveOutcomeBatch = [];
  }

  /**
   * deterministicFailureClass 必须直接来自既有 WorkFailurePolicy；传 null 表示按 HTTP
   * 原始压力信号结算。只有原本的压力 attempt 会被改记为确定性失败，成功响应不变。
   */
  async finishAdaptiveOutcomeClassification(
    deterministicFailureClass: string | null,
  ): Promise<void> {
    const pending = this.#adaptiveOutcomeBatch;
    if (pending === null) throw new Error('没有待结算的自适应出口 outcome 分类 batch');
    if (
      deterministicFailureClass !== null
      && deterministicFailureClass.trim() === ''
    ) {
      throw new Error('deterministicFailureClass 不允许空字符串');
    }
    this.#adaptiveOutcomeBatch = null;
    for (const item of pending) {
      // 当前既有分类中，只有 page-bound AMC 的“空体 HTTP 500”会在 HTTP 层被误认
      // 为站点压力。不要把同一任务此前真实的 transport/429/其它 5xx 一并洗掉。
      const matchesDeterministicPressureShape =
        deterministicFailureClass?.endsWith(':page_bound_amc_http_500_empty') === true
        && item.outcome.status === 500;
      const outcome = matchesDeterministicPressureShape && !item.outcome.ok
        ? {
            ...item.outcome,
            ok: true,
            deterministicFailureClass,
          }
        : item.outcome;
      await this.#adaptiveEgress?.afterAttempt(item.permit, outcome, this.#signal);
    }
  }

  /** 预算中断的任务没有形成业务分类；丢弃暂存项，让 claim 按“未执行”释放。 */
  discardAdaptiveOutcomeClassification(): void {
    if (this.#adaptiveOutcomeBatch === null) return;
    this.#adaptiveOutcomeBatch = null;
  }

  /**
   * 单次请求。遥测**恰好记一条**（无论成功、重试后成功、还是彻底失败），
   * 由 request() 统一在出口处 #finish，#handleDisposition 只负责分类与计数器。
   */
  async request(url: string, opts: HttpRequestOptions): Promise<HttpResponse> {
    const signal = combineSignals(this.#signal, opts.signal);
    throwIfAborted(signal);
    if (this.#breakerReason !== null) {
      throw new CircuitOpenError(this.#breakerReason);
    }

    const method = opts.method ?? 'GET';
    const headers: Record<string, string> = { ...this.#baseHeaders, ...lowercaseKeys(opts.headers) };
    // 每次请求前再校验一次：调用方 merge 的自定义头可能把 UA/Referer 覆盖成空。
    assertHeaderContract(headers, `${method} ${url}`);

    const timeoutMs = opts.timeoutMs ?? this.#timeoutMs;
    const maxAttempts = Math.max(1, opts.maxAttempts ?? this.#maxAttempts);
    const maxTransientAttempts = Math.max(
      1,
      Math.min(maxAttempts, opts.maxTransientAttempts ?? maxAttempts),
    );
    const startedAt = performance.now();
    const retryReasons: string[] = [];

    let attempts = 0;
    let transientFailures = 0;
    let lastError: unknown;
    let lastStatus: number | null = null;
    let lastWireBytes = 0;
    let requestUrl = url;
    let redirectsRemaining = Math.max(0, Math.min(5, opts.maxRedirections ?? 0));
    try {
      while (attempts < maxAttempts) {
        await this.#paceRequestAttempt(signal);
        if (this.#breakerReason !== null) {
          throw new CircuitOpenError(this.#breakerReason);
        }
        // 本地任务节流之后，再向跨进程控制器预留真实出站 attempt。控制库不可用时
        // fail closed：宁可本轮退出，也不能悄悄绕过用户要求的安全前提。
        const adaptivePermit = await this.#adaptiveEgress?.beforeAttempt(requestUrl, signal);
        attempts++;
        this.#stats.attempts++;

        let attemptOutcome: Disposition | null = null;
        let adaptiveOutcomeRecorded = false;
        try {
          const res = await request(requestUrl, {
            method,
            headers,
            body: opts.body,
            dispatcher: this.#dispatcher,
            headersTimeout: timeoutMs,
            bodyTimeout: timeoutMs,
            signal,
            // 默认不跟随重定向：sitemap/AMC 一旦出现 3xx 是要人看的枚举面变化。
            // 图片路径的重定向由本循环逐跳处理，确保每个真实出站都单独经过 gate/记账。
          });
          lastStatus = res.statusCode;
          const raw = Buffer.from(await res.body.arrayBuffer());
          lastWireBytes = raw.byteLength;
          const resHeaders = flattenHeaders(res.headers);
          this.#bucket(String(lastStatus));

          attemptOutcome = classifyStatus(lastStatus);
          await this.#recordAdaptiveOutcome(adaptivePermit, {
            ok: !isAdaptivePressureFailure(lastStatus),
            status: lastStatus,
            errorKind: attemptOutcome?.reason ?? null,
          }, signal);
          adaptiveOutcomeRecorded = true;
          const location = resHeaders['location'];
          if (
            lastStatus >= 300 && lastStatus < 400
            && location !== undefined
            && redirectsRemaining > 0
            && attempts < maxAttempts
          ) {
            const nextUrl = safeRedirectUrl(requestUrl, location);
            const sameHost = nextUrl !== null
              && new URL(nextUrl).hostname.toLowerCase() === new URL(requestUrl).hostname.toLowerCase();
            if (nextUrl !== null && (opts.redirectPolicy === 'any' || sameHost)) {
              redirectsRemaining--;
              retryReasons.push(`redirect_${lastStatus}`);
              requestUrl = nextUrl;
              continue;
            }
          }
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
            await this.#egress?.afterRequest(true, signal);
            throwIfAborted(signal);
            return {
              status: lastStatus,
              headers: resHeaders,
              body: decoded,
              text: () => decoded.toString('utf-8'),
              telemetry,
            };
          }

          // 非 2xx 也可能被 gzip/br 压缩。旧实现把压缩字节直接当 UTF-8：
          // gzip 头的 mtime/xfl/os 字段天然含 0x00，随后进入 HttpStatusError.message，
          // 最终让 meta.record_page_scan(error text) 自身报 22021。
          const snippet = errorBodySnippet(raw, resHeaders['content-encoding'] ?? null);
          lastError = new HttpStatusError(lastStatus, requestUrl, snippet);
        } catch (err) {
          throwIfAborted(signal);
          if (
            err instanceof CircuitOpenError
            || err instanceof HeaderContractError
            || err instanceof AdaptiveEgressUnavailableError
          ) throw err;
          if (err instanceof HttpStatusError) throw err; // 不该发生，保险
          const kind = classifyTransport(err);
          lastStatus = null;
          lastWireBytes = 0;
          lastError = new TransportError(kind, requestUrl, err);
          this.#bucket('transport');
          attemptOutcome =
            kind === 'reset'
              ? { kind: 'breaker-reset', reason: 'transport_reset' }
              : { kind: 'retry', reason: `transport_${kind}` };
          if (!adaptiveOutcomeRecorded) {
            await this.#recordAdaptiveOutcome(adaptivePermit, {
              ok: false,
              status: null,
              errorKind: `transport_${kind}`,
            }, signal);
            adaptiveOutcomeRecorded = true;
          }
        }

        // #handleDisposition 可能因熔断阈值达成而抛 CircuitOpenError（由外层 catch 记账）
        this.#handleDisposition(attemptOutcome, requestUrl, retryReasons, attempts);

        const retryable = attemptOutcome.kind === 'retry' || attemptOutcome.kind === 'breaker-reset';
        if (retryable) transientFailures++;
        if (retryable && transientFailures < maxTransientAttempts && attempts < maxAttempts) {
          // 重置类在断路器未打开时仍允许重试 —— 实测基线传输失败率 1–3%，
          // 完全不重试会让整轮 sitemap 因为一次抖动就白跑；断路器负责拦住"连续"失败。
          await abortableSleep(backoffMs(attempts), signal);
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
      if (
        !(err instanceof AdaptiveEgressUnavailableError)
        && !isRuntimeBudgetExceededError(err)
      ) {
        await this.#egress?.afterRequest(false, signal);
      }
      throw err;
    }
  }

  async #recordAdaptiveOutcome(
    permit: AdaptiveEgressPermit | undefined,
    outcome: AdaptiveAttemptOutcome,
    signal?: AbortSignal,
  ): Promise<void> {
    if (permit === undefined || this.#adaptiveEgress === null) return;
    if (this.#adaptiveOutcomeBatch !== null) {
      this.#adaptiveOutcomeBatch.push({ permit, outcome });
      return;
    }
    await this.#adaptiveEgress.afterAttempt(permit, outcome, signal);
  }

  async #paceRequestAttempt(signal?: AbortSignal): Promise<void> {
    if (this.#minRequestIntervalMs === 0) return;
    let release = (): void => undefined;
    const previous = this.#paceTail;
    this.#paceTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      throwIfAborted(signal);
      const waitMs = Math.max(
        0,
        this.#lastAttemptStartedAt + this.#minRequestIntervalMs - performance.now(),
      );
      if (waitMs > 0) await abortableSleep(waitMs, signal);
      this.#lastAttemptStartedAt = performance.now();
    } finally {
      release();
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
    const scope = t.mode.startsWith('probe:') ? this.#health.probe : this.#health.business;
    scope.requests++;
    scope.attempts += t.attempts;
    const bucket = t.status === null ? 'transport' : String(t.status);
    scope.statusBuckets[bucket] = (scope.statusBuckets[bucket] ?? 0) + 1;
    if (!t.ok && t.status === null) scope.transportFailures++;
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

function emptyHealthScope(): HttpHealthScopeStats {
  return { requests: 0, attempts: 0, statusBuckets: {}, transportFailures: 0 };
}

function cloneHealthScope(scope: HttpHealthScopeStats): HttpHealthScopeStats {
  return { ...scope, statusBuckets: { ...scope.statusBuckets } };
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

function errorBodySnippet(raw: Buffer, contentEncoding: string | null): string {
  let decoded: Buffer;
  try {
    decoded = decodeBody(raw, contentEncoding);
  } catch (err) {
    // HTTP 状态仍是首要证据；错误页压缩损坏不能把它改判成“传输失败”，也绝不回退
    // 到把原始压缩字节塞进人类消息。
    return `[响应体解压失败：${describeError(err)}]`;
  }
  return [...decoded.toString('utf8')]
    .slice(0, 200)
    .join('')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '\ufffd')
    .replace(/\s+/g, ' ')
    .trim();
}

function backoffMs(attempt: number): number {
  // 上限 8s。刻意远低于库的 60s —— 短进程模型下，等 60s 不如让调度器重启。
  const base = Math.min(500 * 2 ** (attempt - 1), 8_000);
  return base + Math.floor(Math.random() * 250);
}

function combineSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined {
  if (first === undefined) return second;
  if (second === undefined || second === first) return first;
  return AbortSignal.any([first, second]);
}
