/**
 * AMC（ajax-module-connector.php）最小客户端 + **启动自检 #3**（TODO #13）。
 *
 * 现有两道自检：#1 assertHeaders（请求头契约，不发请求）、#2 assertTimezoneRoundTrip（DB 时区）。
 * 这是第三道，也是第一道**真的发请求**的自检，两个目的：
 *
 * ── 目的 A：AMC POST 契约（实测 P0，synthesis §2.2）────────────────────────────
 *   POST /ajax-module-connector.php 无 Referer  → **0/15 成功**（直连 curl(35)
 *      Recv failure: Connection reset by peer；经池 curl(52) Empty reply）
 *   POST 同端点 带任意 Referer                  → 15/15 200
 *   GET  同端点 无 Referer                      → 200
 *   ⇒ 这是**未文档化的边缘契约**，且值任意、只校验存在性 —— 典型的粗糙
 *     bot-mitigation 规则，说明该边缘规则集**正在被主动调整**。
 *     assertHeaders 只能证明"我们带了头"，证明不了"带这个头站点还认"。
 *     所以必须真打一个 POST：契约再变（例如改成校验 Referer 域名、或改校验
 *     Origin/Cookie），我们要在**启动时**知道，而不是在半轮采集之后从
 *     "连续传输重置"的熔断日志里反推。
 *
 * ── 目的 B：代理健康 ────────────────────────────────────────────────────────
 *   49 节点轮换池、**无 fallback、无健康检查**。最坏的故障形态不是"抓不到"，
 *   而是 mihomo 规则一改把 wikidot 流量落到 DIRECT —— 我们用家宽 IP 高频抓站
 *   而毫不知情。这里用两个独立判据抓它：
 *     (a) mihomo /connections 的 chains[0] 是否为 'DIRECT'（按连接的真值）；
 *     (b) 经代理取到的出口 IP 是否等于直连出口 IP（回显探针交叉验证）。
 *
 * ── 失败处理（任务硬要求）──────────────────────────────────────────────────
 *   探针失败 **指数退避重试**（默认 3 次，base 2s ×2，jitter，上限 20s），
 *   重试耗尽才非零退出。唯一的例外是断路器打开（连续 503/429）：那时
 *   **立刻停手**，不再重试 —— "503 的正确响应是停手，不是重发" 这条纪律优先于
 *   "探针要重试" 这条纪律，否则自检本身就变成了 503 洪水的发动机。
 *
 * ── 为什么现在就做（sitemap 是纯 GET，不经 AMC）──────────────────────────────
 *   sitemap 通道确实不需要它，所以默认策略是 skip；但 ListPages / WhoRatedPageModule /
 *   PageRevisionListModule 全部走 AMC，接它们的那天必须已经有这道闸。
 *   实现好并留一个按 CLI/模式判定的开关（见 amcProbePolicyFor()），
 *   上线 ListPages 那天只改一处常量。
 */

import { randomBytes } from 'node:crypto';
import {
  CircuitOpenError,
  HeaderContractError,
  HttpStatusError,
  type HttpClient,
} from './client.js';
import { probeExitIpDirect } from './egress.js';
import { createLogger, type Logger } from '../util/log.js';

// ─── 错误类型 ────────────────────────────────────────────────────────────────

/** AMC 契约被破坏（POST 被 reset / 非 JSON / status 非 ok / body 结构变形）。 */
export class AmcContractError extends Error {
  override readonly name = 'AmcContractError';
}

/** 代理链路不健康（回落直连 / 出口不可达）。 */
export class ProxyHealthError extends Error {
  override readonly name = 'ProxyHealthError';
}

// ─── 探针策略 ────────────────────────────────────────────────────────────────

/**
 * require = 失败即非零退出；warn = 只告警并记进 stats；skip = 不发探针。
 */
export type ProbePolicy = 'require' | 'warn' | 'skip';

export function parseProbePolicy(raw: string | undefined, fallback: ProbePolicy): ProbePolicy {
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (v === 'require' || v === 'warn' || v === 'skip') return v;
  throw new Error(`未知探针策略 ${raw}（require | warn | skip）`);
}

/**
 * 按采集通道给出 AMC 探针的默认策略。**接 ListPages 时只改这一处。**
 *   'wikidot_sitemap'        纯 GET，不经 AMC          → skip
 *   'wikidot_page_identity'  整页 GET，不经 AMC        → skip
 *   其它（listpages / tier2 / forum，全部走 AMC）      → require
 */
export function amcProbePolicyFor(channel: string): ProbePolicy {
  return channel === 'wikidot_sitemap' || channel === 'wikidot_page_identity' ? 'skip' : 'require';
}

// ─── AMC 请求 ────────────────────────────────────────────────────────────────

export interface AmcResponse {
  /** 实测词表：'ok' / 'try_again' / 'no_permission' / 'not_ok' / 'same_revision'。 */
  status: string;
  body: string | null;
  message: string | null;
  currentTimestamp: number | null;
  raw: string;
}

/**
 * 生成 wikidot_token7。
 *
 * 刻意**随机**而不是照抄 `@ukwhatn/wikidot` 写死的 '123456'：那个固定值一旦被
 * 边缘拉黑，所有用该库的客户端会同时失联；随机值实测同样 200（本次实测的
 * WikiCategoriesModule 探针就是随机 16 hex）。双提交语义只要求 Cookie 与 body
 * **同值**，不要求特定值。
 */
export function randomToken7(): string {
  return randomBytes(8).toString('hex');
}

export interface AmcRequestOptions {
  moduleName: string;
  params?: Record<string, string | number>;
  /** 遥测标签，进 http stats 的 mode 维度。 */
  mode?: string;
  timeoutMs?: number;
  /** 单次调用的 HTTP 尝试次数。探针自己在外层做退避，所以默认 1。 */
  maxAttempts?: number;
  /**
   * 仅供受限分类专用 session 注入。普通 AMC 调用不设置，因而只发送 token7，
   * 不会意外把登录态带到论坛/投票/修订等匿名链路。
   */
  wikidotSessionId?: string;
}

/**
 * 打一次 AMC POST。
 *
 * 三个契约点都在这里，且都不是"防御性编程"而是实测：
 *   1. Referer 由 HttpClient 的 baseHeaders 提供（缺了 assertHeaderContract 直接拒发）；
 *   2. wikidot_token7 必须**同时**出现在 Cookie 与 body 且同值（double-submit CSRF）；
 *   3. content-type 必须是 application/x-www-form-urlencoded。
 */
export async function amcRequest(
  http: HttpClient,
  baseUrl: string,
  opts: AmcRequestOptions,
): Promise<AmcResponse> {
  const token = randomToken7();
  const form = new URLSearchParams();
  form.set('moduleName', opts.moduleName);
  for (const [k, v] of Object.entries(opts.params ?? {})) form.set(k, String(v));
  form.set('wikidot_token7', token);

  const res = await http.request(`${baseUrl.replace(/\/+$/, '')}/ajax-module-connector.php`, {
    mode: opts.mode ?? `amc:${opts.moduleName}`,
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      cookie:
        opts.wikidotSessionId === undefined
          ? `wikidot_token7=${token}`
          : `WIKIDOT_SESSION_ID=${opts.wikidotSessionId}; wikidot_token7=${token}`,
    },
    body: form.toString(),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    maxAttempts: opts.maxAttempts ?? 1,
  });

  const text = res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // 非 JSON = 契约破了（WAF 拦截页 / 登录页 / HTML 错误页）。
    // 绝不当成"空结果"继续 —— 那是 v1 幻影 removed 的同型模式。
    throw new AmcContractError(
      `AMC 响应不是 JSON（module=${opts.moduleName}, http=${res.status}）：` +
        text.slice(0, 200).replace(/\s+/g, ' ').trim(),
    );
  }
  if (typeof parsed['status'] !== 'string') {
    throw new AmcContractError(
      `AMC 响应缺少 status 字段（module=${opts.moduleName}）：${text.slice(0, 200)}`,
    );
  }

  return {
    status: parsed['status'] as string,
    body: typeof parsed['body'] === 'string' ? (parsed['body'] as string) : null,
    message: typeof parsed['message'] === 'string' ? (parsed['message'] as string) : null,
    currentTimestamp:
      typeof parsed['CURRENT_TIMESTAMP'] === 'number' ? (parsed['CURRENT_TIMESTAMP'] as number) : null,
    raw: text,
  };
}

/**
 * 从 WikiCategoriesModule 的 body 里解析 category 名 → 数字 id。
 * 实测形状：`<h3>_default</h3> … id="category-pages-toggler-3342264"`。
 * 这既是探针的**结构断言**（HTTP 200 + status ok 但 body 变形也必须被识破），
 * 也顺手拿到 CROM 完全没有的 categoryId 映射（零额外请求）。
 */
export function parseWikiCategories(body: string): Record<string, number> {
  const out: Record<string, number> = {};
  const re = /<h3>([^<]+)<\/h3>[\s\S]{0,400}?category-pages-toggler-(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out[m[1]!.trim()] = Number(m[2]);
  }
  return out;
}

// ─── 启动自检 #3 ─────────────────────────────────────────────────────────────

export interface EgressGateReport {
  ok: boolean;
  amc: {
    policy: ProbePolicy;
    attempts: number;
    status: string | null;
    httpOk: boolean;
    moduleName: string;
    /** 顺手取到的 category 名→id（环境指纹：站点换皮/改分类时能定位时点）。 */
    categories: Record<string, number> | null;
    durationMs: number;
    error: string | null;
  };
  proxy: {
    policy: ProbePolicy;
    proxyUrl: string | null;
    /** 经代理的出口 IP（采样，语义见 egress.ts）。 */
    proxyExitIp: string | null;
    /** 直连出口 IP（仅做泄漏比对用；关掉泄漏检查时为 null）。 */
    directExitIp: string | null;
    /** mihomo 观测到的承载节点（chains[0]）。 */
    nodes: string[];
    leaked: boolean;
    error: string | null;
  };
  /** 两个探针的问题清单（policy=warn 时非空但仍放行）。 */
  problems: string[];
}

export interface EgressGateOptions {
  baseUrl: string;
  amcPolicy: ProbePolicy;
  proxyPolicy: ProbePolicy;
  /** 探针重试次数（含首次）。 */
  maxAttempts?: number;
  /** 退避基数（ms）。 */
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** 直连泄漏比对用的 IP 回显 URL；null = 不做泄漏比对。 */
  ipProbeUrl?: string | null;
  logger?: Logger;
}

/**
 * 启动自检 #3：AMC POST 探针 + 代理健康。
 *
 * 返回报告（进 ingest_run.stats.startupProbe）；policy=require 且失败时抛异常，
 * 由 CLI 转成非零退出。policy=warn 只把问题记进 problems。
 */
export async function assertEgressContract(
  http: HttpClient,
  opts: EgressGateOptions,
): Promise<EgressGateReport> {
  const log = opts.logger ?? createLogger('probe');
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const baseMs = opts.backoffBaseMs ?? 2_000;
  const capMs = opts.backoffCapMs ?? 20_000;
  const problems: string[] = [];

  const report: EgressGateReport = {
    ok: true,
    amc: {
      policy: opts.amcPolicy,
      attempts: 0,
      status: null,
      httpOk: false,
      moduleName: 'list/WikiCategoriesModule',
      categories: null,
      durationMs: 0,
      error: null,
    },
    proxy: {
      policy: opts.proxyPolicy,
      proxyUrl: http.proxyUrl,
      proxyExitIp: null,
      directExitIp: null,
      nodes: [],
      leaked: false,
      error: null,
    },
    problems,
  };

  // ── B. 代理健康（先做：它比 AMC 便宜，且 AMC 失败时先知道出口状况更好归因）──
  if (opts.proxyPolicy !== 'skip') {
    try {
      // primeEgress 会经**同一个代理**打一次 IP 回显 + 采一次 mihomo
      const proxyIp = await http.primeEgress();
      report.proxy.proxyExitIp = proxyIp;
      const egress = http.exitIpStats();
      report.proxy.nodes = egress ? Object.keys(egress.byNode) : [];

      // 判据 (a)：mihomo 明确告诉我们这条连接走了 DIRECT
      if (report.proxy.nodes.some((n) => n.toUpperCase() === 'DIRECT')) {
        report.proxy.leaked = true;
        problems.push(
          `代理泄漏：mihomo /connections 显示目标连接的 chains[0]=DIRECT —— ` +
            `wikidot 流量正在走本机出口（家宽 IP），而 IP 池是唯一的封禁缓冲。`,
        );
      }

      // 判据 (b)：经代理的出口 IP == 直连出口 IP
      if (http.proxyUrl !== null && opts.ipProbeUrl) {
        const directIp = await probeExitIpDirect(opts.ipProbeUrl);
        report.proxy.directExitIp = directIp;
        if (proxyIp !== null && directIp !== null && proxyIp === directIp) {
          report.proxy.leaked = true;
          problems.push(
            `代理泄漏：经代理与直连取到同一个出口 IP（${proxyIp}）—— 代理已静默回落成直连。`,
          );
        }
      }

      if (http.proxyUrl !== null && proxyIp === null) {
        problems.push(
          `代理出口探针未取到 IP（${egress?.probe.lastError ?? '未知'}）。` +
            `注意这不必然等于"代理坏了"（回显服务本身也可能不可达），` +
            `但配了代理却探不到出口时，本轮的出口归因是瞎的。`,
        );
      }
      if (http.proxyUrl === null) {
        problems.push('未配置代理：wikidot 流量走本机出口。本机 IP 不是 fallback（封禁面是共享节点）。');
      }
    } catch (err) {
      report.proxy.error = String(err);
      problems.push(`代理健康探测异常：${String(err)}`);
    }
  }

  // ── A. AMC POST 探针 ────────────────────────────────────────────────────
  if (opts.amcPolicy !== 'skip') {
    const t0 = Date.now();
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      report.amc.attempts = attempt;
      try {
        const res = await amcRequest(http, opts.baseUrl, {
          moduleName: report.amc.moduleName,
          mode: 'probe:amc',
          maxAttempts: 1,
        });
        report.amc.httpOk = true;
        report.amc.status = res.status;
        if (res.status === 'try_again') {
          // 站点自己说"再来一次" —— 唯一一种"值得重试"的非 ok 状态
          lastError = new AmcContractError('AMC status=try_again');
          throw lastError;
        }
        if (res.status !== 'ok') {
          // no_permission / not_ok 等：重试没有意义，直接判契约失败
          throw new AmcContractError(
            `AMC status=${res.status}（module=${report.amc.moduleName}, message=${res.message ?? '-'}）` +
              `。这是权限/模块状态问题，重试无意义。`,
          );
        }
        const categories = parseWikiCategories(res.body ?? '');
        if (Object.keys(categories).length === 0) {
          // 结构断言：200 + status ok 但 body 变形，同样必须炸（parse.ts 的同一原则）
          throw new AmcContractError(
            `AMC status=ok 但 body 里解析不出任何 category（module=${report.amc.moduleName}）。` +
              `响应结构已变，解析层需要跟着改。`,
          );
        }
        report.amc.categories = categories;
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        // 断路器打开（连续 503/429）= 停手，不再退避重试。见文件头「失败处理」。
        if (err instanceof CircuitOpenError) break;
        // 503 / 429 一律不在探针层重试。
        // 这条判断刻意**不依赖** client.ts 的 classifyStatus（那里 503 已经是零重试 +
        // 熔断计数）—— 探针是启动闸，它必须在任何情况下都不成为 503 洪水的发动机。
        // 把"要不要重试 503"这个决定完全外包给另一个文件，等于让自检的安全性
        // 依赖一处随时可能被改的分类逻辑；这里再挡一道，代价是一行。
        if (err instanceof HttpStatusError && (err.status === 503 || err.status === 429)) break;
        // 头契约破了是配置问题，重试同样是浪费
        if (err instanceof HeaderContractError) break;
        // status=no_permission / not_ok / 结构变形：不重试
        if (err instanceof AmcContractError && !/try_again/.test(err.message)) break;
        if (attempt < maxAttempts) {
          const wait = Math.min(baseMs * 2 ** (attempt - 1), capMs) + Math.floor(Math.random() * 250);
          log.warn('AMC 探针失败，指数退避后重试', {
            attempt,
            maxAttempts,
            waitMs: wait,
            error: err instanceof HttpStatusError ? `HTTP ${err.status}` : String(err),
          });
          await sleep(wait);
        }
      }
    }
    report.amc.durationMs = Date.now() - t0;
    if (lastError !== null) {
      report.amc.error = String(lastError);
      problems.push(`AMC POST 契约探针失败（${report.amc.attempts} 次尝试）：${String(lastError)}`);
    } else {
      log.info('AMC POST 探针通过', {
        attempts: report.amc.attempts,
        categories: Object.keys(report.amc.categories ?? {}).length,
        ms: report.amc.durationMs,
      });
    }
  }

  // ── 判定 ────────────────────────────────────────────────────────────────
  const amcFailed = report.amc.error !== null;
  const proxyFailed = report.proxy.leaked || report.proxy.error !== null;
  report.ok = problems.length === 0;

  if (amcFailed && opts.amcPolicy === 'require') {
    throw new AmcContractError(
      `启动自检 #3 失败（AMC 契约，policy=require）：${report.amc.error}。` +
        `实测缺 Referer 会让 POST 在传输层被 reset，而库的重试逻辑会把它放大成数十分钟的重连洪水 —— ` +
        `拒绝启动。`,
    );
  }
  if (proxyFailed && opts.proxyPolicy === 'require') {
    throw new ProxyHealthError(
      `启动自检 #3 失败（代理健康，policy=require）：${problems.join(' / ')}`,
    );
  }
  for (const p of problems) log.warn('启动自检 #3 告警', { problem: p });
  return report;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
