/** 站外图片按主机拆 HttpClient breaker，同时共享独立的站外图片 Postgres gate。 */

import {
  HttpClient,
  assertHeaderContract,
  type HttpClientStats,
  type HttpHealthScopeStats,
  type HttpHealthStats,
  type HttpRequestOptions,
  type HttpResponse,
} from '../http/client.js';
import type { AdaptiveEgressGate } from '../http/adaptiveEgress.js';
import { createLogger, type Logger } from '../util/log.js';
import {
  PostgresExternalImageEgressGate,
  type ExternalImageHostSnapshot,
} from './externalEgress.js';

export interface ExternalImageClientOptions {
  databaseUrl: string;
  userAgent: string;
  referer: string;
  proxyUrl?: string | null;
  timeoutMs: number;
  breaker503: number;
  breakerReset: number;
  globalMinIntervalMs: number;
  logger?: Logger;
}

export interface ExternalImageClientStats {
  aggregate: HttpClientStats;
  hosts: Record<string, HttpClientStats>;
  egressHosts: Record<string, ExternalImageHostSnapshot>;
}

/**
 * 单个 HttpClient 的 breaker 是实例级的；旧代码用一个实例服务所有 host，任一主机连续
 * reset 后剩余队列全部收到 CircuitOpen。这里每个 exact hostname 一个 client/dispatcher，
 * gate 的 DB pool 则全体共享，避免每个 host 再开两条 PG 连接。
 */
export class ExternalImageDownloadClient {
  readonly #opts: ExternalImageClientOptions;
  readonly #log: Logger;
  readonly #gate: PostgresExternalImageEgressGate;
  readonly #gateLease: AdaptiveEgressGate;
  readonly #clients = new Map<string, HttpClient>();

  constructor(opts: ExternalImageClientOptions) {
    this.#opts = opts;
    this.#log = opts.logger ?? createLogger('external-image-client');
    this.#gate = new PostgresExternalImageEgressGate(opts.databaseUrl, {
      logger: this.#log.child('gate'),
      globalMinIntervalMs: opts.globalMinIntervalMs,
    });
    // HttpClient.close() 会 close adaptive gate。多个 host 共用同一 gate 时由 manager 最后
    // 统一关闭；lease 的 close 刻意 no-op。
    this.#gateLease = {
      beforeAttempt: (url) => this.#gate.beforeAttempt(url),
      afterAttempt: (permit, outcome) => this.#gate.afterAttempt(permit, outcome),
      stats: () => this.#gate.stats(),
      close: async () => undefined,
    };
  }

  assertHeaders(): void {
    assertHeaderContract(
      { 'user-agent': this.#opts.userAgent, referer: this.#opts.referer },
      'ExternalImageDownloadClient 构造',
    );
  }

  async get(
    url: string,
    mode: string,
    extra?: Partial<HttpRequestOptions>,
  ): Promise<HttpResponse> {
    const host = new URL(url).hostname.toLowerCase();
    return this.#clientFor(host).get(url, mode, extra);
  }

  /** 只有所有本轮实际接触的 host 都熔断，才把整条 external 链路标成 breaker-open。 */
  get breakerOpen(): boolean {
    return this.#clients.size > 0 && [...this.#clients.values()].every((client) => client.breakerOpen);
  }

  stats(): ExternalImageClientStats {
    const hosts = Object.fromEntries(
      [...this.#clients.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([host, client]) => [host, client.stats()]),
    );
    return {
      aggregate: aggregateStats(Object.values(hosts), this.#gate.stats()),
      hosts,
      egressHosts: this.#gate.hostSnapshots(),
    };
  }

  healthStats(): HttpHealthStats {
    return aggregateHealth([...this.#clients.values()].map((client) => client.healthStats()));
  }

  async close(): Promise<void> {
    await Promise.all([...this.#clients.values()].map((client) => client.close()));
    await this.#gate.close();
  }

  #clientFor(host: string): HttpClient {
    const existing = this.#clients.get(host);
    if (existing !== undefined) return existing;
    const client = new HttpClient({
      userAgent: this.#opts.userAgent,
      referer: this.#opts.referer,
      proxyUrl: this.#opts.proxyUrl,
      timeoutMs: this.#opts.timeoutMs,
      maxAttempts: 1,
      breaker503: this.#opts.breaker503,
      breakerReset: this.#opts.breakerReset,
      connections: 1,
      minRequestIntervalMs: 0,
      logger: this.#log.child(host),
      adaptiveEgress: this.#gateLease,
    });
    client.assertHeaders();
    this.#clients.set(host, client);
    return client;
  }
}

function aggregateStats(
  stats: HttpClientStats[],
  adaptiveEgress: HttpClientStats['adaptiveEgress'],
): HttpClientStats {
  const out: HttpClientStats = {
    requests: 0,
    attempts: 0,
    wireBytes: 0,
    decodedBytes: 0,
    totalDurationMs: 0,
    statusBuckets: {},
    retries: 0,
    consecutive503: 0,
    consecutiveResets: 0,
    breakerOpen: stats.length > 0 && stats.every((item) => item.breakerOpen),
    breakerReason: null,
    adaptiveEgress,
  };
  const openHosts: string[] = [];
  for (const item of stats) {
    out.requests += item.requests;
    out.attempts += item.attempts;
    out.wireBytes += item.wireBytes;
    out.decodedBytes += item.decodedBytes;
    out.totalDurationMs += item.totalDurationMs;
    out.retries += item.retries;
    out.consecutive503 = Math.max(out.consecutive503, item.consecutive503);
    out.consecutiveResets = Math.max(out.consecutiveResets, item.consecutiveResets);
    for (const [bucket, count] of Object.entries(item.statusBuckets)) {
      out.statusBuckets[bucket] = (out.statusBuckets[bucket] ?? 0) + count;
    }
    if (item.breakerReason !== null) openHosts.push(item.breakerReason);
  }
  out.breakerReason = openHosts.length === 0
    ? null
    : `${openHosts.length} host breaker(s) open; isolated`;
  return out;
}

function emptyScope(): HttpHealthScopeStats {
  return { requests: 0, attempts: 0, statusBuckets: {}, transportFailures: 0 };
}

function aggregateHealth(stats: HttpHealthStats[]): HttpHealthStats {
  const out: HttpHealthStats = { business: emptyScope(), probe: emptyScope() };
  for (const item of stats) {
    mergeScope(out.business, item.business);
    mergeScope(out.probe, item.probe);
  }
  return out;
}

function mergeScope(target: HttpHealthScopeStats, source: HttpHealthScopeStats): void {
  target.requests += source.requests;
  target.attempts += source.attempts;
  target.transportFailures += source.transportFailures;
  for (const [bucket, count] of Object.entries(source.statusBuckets)) {
    target.statusBuckets[bucket] = (target.statusBuckets[bucket] ?? 0) + count;
  }
}
