/**
 * 出口归因 —— `meta.ingest_run.exit_ip_stats` 的生产者（TODO #12）。
 *
 * ── 问题 ────────────────────────────────────────────────────────────────────
 * 全部 wikidot 流量走 mihomo 的 **49 节点轮换池，无 fallback、无健康检查**
 * （synthesis P0-5 / findings#20）。不记出口就有两个不可归因的场景：
 *   (a) 「某几个节点坏了」表现为整体失败率上浮，但看不出是哪几个；
 *   (b) 更糟：mihomo 规则一改，wikidot 流量静默落到 DIRECT，我们用**家宽 IP**
 *       高频抓站而毫不知情（这才是真会招封的行为）。
 *
 * ── 两个信源，各自的可信度必须写清楚 ──────────────────────────────────────
 * 1. **IP 回显探针**（`http://api.ipify.org`，经同一个 dispatcher 即同一个代理）：
 *    给出「本次探针这条连接」的真实出口 IP。实测**每次探针都换 IP**
 *    （188.253.120.136 / 103.129.180.21 / … 连续三次三个不同 IP），
 *    所以它衡量的是**池的构成**，而不是相邻那个 wikidot 请求的出口。
 *    ⚠ 这条必须写在代码里而不是只在脑子里：把探针 IP 当成相邻请求的出口 IP
 *      是一个会产出「看起来精确、实际错位」的归因表，比没有归因更坏。
 *    因此探针结果落在 `byIp` 下、并显式标 `attribution:'sampled_pool'`。
 *
 * 2. **mihomo 本地控制器 `/connections`**（默认 http://127.0.0.1:9090）：
 *    实测返回每条活连接的 `chains[0]` = **实际承载该连接的节点名**
 *    （例：`["🇺🇸 美國 CN2 20260727", "🔀 负载均衡(爬虫IP池)"]`）
 *    与 `metadata.remoteDestination`。这是**按连接的真值**，也是唯一能回答
 *    「哪个节点坏了」的信源；而且它是本机 HTTP，**零 wikidot 成本**。
 *    HttpClient 的 keepAliveTimeout=4s ⇒ 请求结束后连接还在池里挂几秒，
 *    请求完成后立刻采样能抓到它。抓不到就是抓不到（记 `misses`），不猜。
 *
 * ── 成本纪律（任务硬要求：不要每请求都探）─────────────────────────────────
 *   · IP 探针：启动 1 次 + 每 N 个请求 1 次（默认 N=25）+ 失败时 1 次（总数封顶）
 *   · mihomo 采样：本机调用，按最小间隔节流（默认 250 ms），不计入 wikidot 预算
 *   · 探针**永不进入 wikidot 的断路器计数**：它走独立的 undici.request 调用，
 *     单次尝试、5s 超时，失败只记 `probeFailures`，绝不影响主链路判定。
 */

import { request, type Dispatcher } from 'undici';
import { createLogger, type Logger } from '../util/log.js';

/** 单个出口 IP 的账。 */
export interface ExitIpBucket {
  /** 被探针命中的次数（= 该 IP 在池中被抽到的次数）。 */
  probes: number;
  /** 探针命中该 IP 的最后时刻。 */
  lastSeenAt: string;
  /** 该 IP 是「失败后补探」抽到的次数 —— 高于 probes 的一半就值得盯。 */
  probesAfterFailure: number;
}

/** 单个 mihomo 节点（chains[0]）的账。 */
export interface ExitNodeBucket {
  /** 该节点承载我们连接的观测次数。 */
  observations: number;
  /** 观测到的远端目标 IP（去重，最多留 5 个）。 */
  remoteIps: string[];
  /** 观测发生在「一个请求刚失败之后」的次数 —— 定位坏节点的主要依据。 */
  observationsAfterFailure: number;
  lastSeenAt: string;
}

export interface ExitIpStats {
  /** 采样得到的出口 IP 分布。语义 = 池构成，**不是**逐请求归因。 */
  byIp: Record<string, ExitIpBucket>;
  /** mihomo 节点分布（按连接的真值）。 */
  byNode: Record<string, ExitNodeBucket>;
  /** 失败发生时采到的出口 IP → 次数。 */
  transportFailureByIp: Record<string, number>;
  /** 失败发生时采到的 mihomo 节点 → 次数。这就是「某几个节点坏了」的答案。 */
  transportFailureByNode: Record<string, number>;
  probe: {
    url: string | null;
    everyNRequests: number;
    ok: number;
    failed: number;
    lastError: string | null;
    /** 探针总耗时（ms），用来确认这项监控本身没有变贵。 */
    totalMs: number;
  };
  mihomo: {
    api: string | null;
    /** 采样次数。 */
    samples: number;
    /** 采样了但没在活连接里找到目标 host 的次数（keepAlive 已回收）。 */
    misses: number;
    reachable: boolean;
    lastError: string | null;
  };
  distinctIps: number;
  distinctNodes: number;
  /** 归因口径声明。落库后半年再看这张表的人，靠这一行知道能不能用它下结论。 */
  attribution: string;
}

export interface EgressAttributorOptions {
  dispatcher: Dispatcher;
  /** IP 回显探针 URL。null/'' = 关闭 IP 探针（仍可用 mihomo 归因）。 */
  probeUrl: string | null;
  /** 每 N 个 wikidot 请求探一次。<=0 表示只在启动与失败时探。 */
  everyNRequests: number;
  /** 单轮探针总数上限（含启动探针与失败补探）。 */
  maxProbes: number;
  /** mihomo 控制器地址。null = 关闭节点归因。 */
  mihomoApi: string | null;
  /** 只统计目标 host 的连接（例：scp-wiki-cn.wikidot.com）。 */
  hostFilter: string;
  /** 只统计当前 HttpClient 所用 mihomo 入口，避免混入其它进程/端口的同 host 连接。 */
  proxyInboundPort: string | null;
  /** mihomo 采样最小间隔（ms）。 */
  mihomoMinIntervalMs?: number;
  probeTimeoutMs?: number;
  logger?: Logger;
}

const ATTRIBUTION_NOTE =
  'byIp = 采样自 IP 回显探针，语义是「池构成」而非逐请求出口（实测 mihomo 每连接换 IP，' +
  '连续三次探针得到三个不同 IP）；byNode = mihomo /connections 的 chains[0]，是按连接的真值。' +
  'mihomo 连接同时按目标 host 与当前代理入口端口过滤，避免混入其它进程的 DIRECT；' +
  '定位坏节点请优先看 transportFailureByNode。';

export class EgressAttributor {
  readonly #opts: Required<Omit<EgressAttributorOptions, 'logger' | 'dispatcher'>> & {
    dispatcher: Dispatcher;
  };
  readonly #log: Logger;

  #byIp = new Map<string, ExitIpBucket>();
  #byNode = new Map<string, ExitNodeBucket>();
  #failByIp = new Map<string, number>();
  #failByNode = new Map<string, number>();
  #currentIp: string | null = null;
  #probeOk = 0;
  #probeFailed = 0;
  #probeMs = 0;
  #probeLastError: string | null = null;
  #requestsSeen = 0;
  #mihomoSamples = 0;
  #mihomoMisses = 0;
  #mihomoReachable = false;
  #mihomoLastError: string | null = null;
  #lastMihomoAt = 0;

  constructor(opts: EgressAttributorOptions) {
    this.#log = opts.logger ?? createLogger('egress');
    this.#opts = {
      dispatcher: opts.dispatcher,
      probeUrl: opts.probeUrl && opts.probeUrl.trim() !== '' ? opts.probeUrl.trim() : null,
      everyNRequests: opts.everyNRequests,
      maxProbes: Math.max(0, opts.maxProbes),
      mihomoApi: opts.mihomoApi && opts.mihomoApi.trim() !== '' ? opts.mihomoApi.replace(/\/+$/, '') : null,
      hostFilter: opts.hostFilter,
      proxyInboundPort: opts.proxyInboundPort,
      mihomoMinIntervalMs: opts.mihomoMinIntervalMs ?? 250,
      probeTimeoutMs: opts.probeTimeoutMs ?? 5_000,
    };
  }

  /** 当前采样到的出口 IP（可能为 null；语义见文件头 §1）。 */
  get currentIp(): string | null {
    return this.#currentIp;
  }

  /** 启动时探一次：既给池构成一个初值，也是「代理确实通」的第一手证据。 */
  async primeOnStart(signal?: AbortSignal): Promise<string | null> {
    const ip = await this.#probeIp(false, signal);
    await this.#sampleMihomo(false, true, signal);
    return ip;
  }

  /**
   * 每个 wikidot 请求结束后调用（成功或失败都调）。
   * 本方法**不得抛异常** —— 监控崩了不能把采集带走。
   */
  async afterRequest(ok: boolean, signal?: AbortSignal): Promise<void> {
    try {
      this.#requestsSeen++;
      const failed = !ok;
      // mihomo 采样：失败必采（要归因坏节点），成功则按节流采
      await this.#sampleMihomo(failed, failed, signal);
      if (failed) {
        // 失败补探：知道「此刻池里是什么」比什么都不知道好，但仍受 maxProbes 封顶
        await this.#probeIp(true, signal);
        if (this.#currentIp) {
          this.#failByIp.set(this.#currentIp, (this.#failByIp.get(this.#currentIp) ?? 0) + 1);
        }
        return;
      }
      const n = this.#opts.everyNRequests;
      if (n > 0 && this.#requestsSeen % n === 0) await this.#probeIp(false, signal);
    } catch (err) {
      this.#log.debug('归因采样异常（已忽略）', { error: String(err) });
    }
  }

  stats(): ExitIpStats {
    return {
      byIp: Object.fromEntries(this.#byIp),
      byNode: Object.fromEntries(this.#byNode),
      transportFailureByIp: Object.fromEntries(this.#failByIp),
      transportFailureByNode: Object.fromEntries(this.#failByNode),
      probe: {
        url: this.#opts.probeUrl,
        everyNRequests: this.#opts.everyNRequests,
        ok: this.#probeOk,
        failed: this.#probeFailed,
        lastError: this.#probeLastError,
        totalMs: Math.round(this.#probeMs),
      },
      mihomo: {
        api: this.#opts.mihomoApi,
        samples: this.#mihomoSamples,
        misses: this.#mihomoMisses,
        reachable: this.#mihomoReachable,
        lastError: this.#mihomoLastError,
      },
      distinctIps: this.#byIp.size,
      distinctNodes: this.#byNode.size,
      attribution: ATTRIBUTION_NOTE,
    };
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────

  /** 经**同一个 dispatcher**（同一个代理池）取一次出口 IP。 */
  async #probeIp(afterFailure: boolean, signal?: AbortSignal): Promise<string | null> {
    const url = this.#opts.probeUrl;
    if (url === null) return null;
    if (this.#probeOk + this.#probeFailed >= this.#opts.maxProbes) return this.#currentIp;

    const t0 = Date.now();
    try {
      const res = await request(url, {
        method: 'GET',
        dispatcher: this.#opts.dispatcher,
        headers: {
          // 探针也带 UA：空 UA 在很多边缘同样是 403/503，没必要给自己制造噪声
          'user-agent': 'scpper-cn-syncer2-egress-probe/0.1',
          accept: 'text/plain',
        },
        headersTimeout: this.#opts.probeTimeoutMs,
        bodyTimeout: this.#opts.probeTimeoutMs,
        signal,
      });
      const body = (await res.body.text()).trim();
      this.#probeMs += Date.now() - t0;
      if (res.statusCode !== 200 || !isIpLike(body)) {
        this.#probeFailed++;
        this.#probeLastError = `status=${res.statusCode} body=${body.slice(0, 60)}`;
        return this.#currentIp;
      }
      this.#probeOk++;
      this.#currentIp = body;
      const b = this.#byIp.get(body) ?? { probes: 0, lastSeenAt: '', probesAfterFailure: 0 };
      b.probes++;
      if (afterFailure) b.probesAfterFailure++;
      b.lastSeenAt = new Date().toISOString();
      this.#byIp.set(body, b);
      this.#log.debug('出口 IP 采样', { ip: body, afterFailure, distinct: this.#byIp.size });
      return body;
    } catch (err) {
      this.#probeMs += Date.now() - t0;
      this.#probeFailed++;
      this.#probeLastError = String(err);
      // 探针失败本身也是信号（代理不通），但**不**参与 wikidot 断路器
      this.#log.warn('出口 IP 探针失败（不影响主链路判定）', { error: String(err) });
      return this.#currentIp;
    }
  }

  /**
   * 采样 mihomo `/connections`，把目标 host 的活连接归到 chains[0] 节点上。
   * force=true 时忽略节流（失败后要立刻采）。
   */
  async #sampleMihomo(
    afterFailure: boolean,
    force: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const api = this.#opts.mihomoApi;
    if (api === null) return;
    const now = Date.now();
    if (!force && now - this.#lastMihomoAt < this.#opts.mihomoMinIntervalMs) return;
    this.#lastMihomoAt = now;

    try {
      // 刻意**不**走 this.#opts.dispatcher：这是本机控制器，绝不能被代理接管
      // （v1 setGlobalDispatcher 把健康探针也拖进代理池，正是这里要避免的）。
      const res = await request(`${api}/connections`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        headersTimeout: 2_000,
        bodyTimeout: 2_000,
        signal,
      });
      if (res.statusCode !== 200) {
        this.#mihomoLastError = `status=${res.statusCode}`;
        await res.body.dump();
        return;
      }
      const payload = (await res.body.json()) as {
        connections?: Array<{
          chains?: string[];
          metadata?: {
            host?: string;
            sniffHost?: string;
            remoteDestination?: string;
            inboundPort?: string;
          };
        }>;
      };
      this.#mihomoReachable = true;
      this.#mihomoSamples++;
      let hit = 0;
      for (const c of payload.connections ?? []) {
        const host = `${c.metadata?.host ?? ''}|${c.metadata?.sniffHost ?? ''}`;
        if (!host.includes(this.#opts.hostFilter)) continue;
        if (
          this.#opts.proxyInboundPort !== null &&
          c.metadata?.inboundPort !== this.#opts.proxyInboundPort
        ) {
          continue;
        }
        const node = c.chains?.[0];
        if (!node) continue;
        hit++;
        const b =
          this.#byNode.get(node) ??
          ({ observations: 0, remoteIps: [], observationsAfterFailure: 0, lastSeenAt: '' } as ExitNodeBucket);
        b.observations++;
        if (afterFailure) b.observationsAfterFailure++;
        b.lastSeenAt = new Date().toISOString();
        const rd = c.metadata?.remoteDestination;
        if (rd && !b.remoteIps.includes(rd) && b.remoteIps.length < 5) b.remoteIps.push(rd);
        this.#byNode.set(node, b);
        if (afterFailure) this.#failByNode.set(node, (this.#failByNode.get(node) ?? 0) + 1);
      }
      if (hit === 0) this.#mihomoMisses++;
    } catch (err) {
      this.#mihomoLastError = String(err);
      // 控制器不可达不是错误：代理也可能不是 mihomo。只降级为「无节点归因」。
      this.#log.debug('mihomo 控制器采样失败（降级为无节点归因）', { error: String(err) });
    }
  }
}

export function proxyInboundPortFromUrl(proxyUrl: string | null): string | null {
  if (proxyUrl === null || proxyUrl.trim() === '') return null;
  const parsed = new URL(proxyUrl);
  if (parsed.port !== '') return parsed.port;
  if (parsed.protocol === 'http:') return '80';
  if (parsed.protocol === 'https:') return '443';
  return null;
}

/**
 * **不经代理**取一次出口 IP（走本机默认出口）。
 *
 * 唯一用途：与经代理取到的 IP 比对。两者相等 ⇒ 代理静默回落成了直连
 * （mihomo 规则改动/节点全挂时的真实故障形态），这时我们正在用**家宽 IP**
 * 高频抓站而毫不知情 —— 这比"抓不到数据"严重得多，所以要有一道显式检查。
 * 刻意不传 dispatcher：这条请求就是要走直连，不能被代理接管。
 */
export async function probeExitIpDirect(url: string, timeoutMs = 5_000): Promise<string | null> {
  try {
    const res = await request(url, {
      method: 'GET',
      headers: { 'user-agent': 'scpper-cn-syncer2-egress-probe/0.1', accept: 'text/plain' },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    const body = (await res.body.text()).trim();
    if (res.statusCode !== 200 || !isIpLike(body)) return null;
    return body;
  } catch {
    return null;
  }
}

/** 极窄的 IPv4 / IPv6 形状校验：够用来识破「代理返回了一个 HTML 错误页」。 */
export function isIpLike(s: string): boolean {
  if (s.length === 0 || s.length > 45) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) {
    return s.split('.').every((p) => Number(p) <= 255);
  }
  return /^[0-9a-fA-F:]+$/.test(s) && s.includes(':');
}
