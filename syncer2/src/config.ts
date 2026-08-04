/**
 * 配置加载。所有变量都带 SYNCER2_ 前缀，刻意不复用 v1 syncer 的 SYNCER_* ——
 * 两套系统并行 2-3 周，共用变量名早晚会有人改错一边。
 */

import * as dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 项目根（src/ 的上一级）。 */
export const PROJECT_ROOT = path.resolve(__dirname, '..');

let loaded = false;

/** 幂等地加载 .env。quiet:true 防止 dotenv v17 把提示打到 stdout 污染 JSON 摘要。 */
export function loadEnv(): void {
  if (loaded) return;
  dotenv.config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });
  loaded = true;
}

export interface Syncer2Config {
  databaseUrl: string;
  siteBaseUrl: string;
  proxyUrl: string | null;
  userAgent: string;
  referer: string;
  httpTimeoutMs: number;
  httpMaxAttempts: number;
  breaker503: number;
  breakerReset: number;
  httpConcurrency: number;
  stateDir: string;
  minEnumeratedRatio: number;
  absenceCircuit: number;
  /** user_page/user_stats 是否纳入已删页作品；默认 false 与 v1 一致，等待产品裁决。 */
  projectIncludeDeletedPages: boolean;
  /** L0/L1 的共同调度周期。只允许 15 或 30 分钟；调度器必须使用同一个值。 */
  incrementalFrequencyMinutes: 15 | 30;
  /** L0 updated_at 回看窗口；默认 2h，至少覆盖四个共同调度周期。 */
  l0WindowHours: number;

  // ── 出口归因（TODO #12：meta.ingest_run.exit_ip_stats）────────────────────
  /** IP 回显探针 URL。空 = 关闭 IP 采样（仍可用 mihomo 节点归因）。 */
  exitIpProbeUrl: string | null;
  /** 每 N 个 wikidot 请求探一次出口 IP。0 = 只在启动与失败时探。 */
  exitIpProbeEvery: number;
  /** 单轮探针总数上限（含启动探针与失败补探）。 */
  exitIpProbeMax: number;
  /** mihomo 控制器地址（本机，零 wikidot 成本）。空 = 关闭节点归因。 */
  mihomoApi: string | null;

  // ── 启动自检 #3（TODO #13）──────────────────────────────────────────────
  /** AMC POST 契约探针策略；未设置时按采集通道取默认（见 http/amc.ts）。 */
  amcProbe: string | undefined;
  /** 代理健康探测策略。 */
  proxyCheck: string;

  // ── 未消化数据队列（TODO #14）───────────────────────────────────────────
  /**
   * pending_page 冷启动闸：待解析 slug 超过该值时，消化者拒绝自动跑。
   * 理由：空库/大回填场景下 pending 会有 3.6 万条，一页一个整页 GET =
   * 3.6 万请求，那正是 field-matrix 明确禁止的 "绝不为全站 36k 页各打一次 GET"。
   * 冷启动应当走 Phase 2 批量回填，而不是让发现层的消化者代劳。
   */
  pendingColdStart: number;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * 读字符串配置。
 *
 * 关键区分：**"没设置" 与 "设成了空值" 不是一回事。**
 *   · 没设置        → 用默认值（如果有），否则报错
 *   · 设置成空/纯空白 → **直接报错**，绝不悄悄回落到默认值
 *
 * 为什么这条值得单独写：空 UA 实测 100% 触发 WAF 503。如果"设成空串"能静默回落到默认值，
 * 那么 assertHeaders() 这道自检就永远不可能触发 —— 它保护的是"头被弄丢"这个场景，
 * 而配置层的静默回落恰恰把"头被弄丢"伪装成了"一切正常"。守卫必须能被真实触发，
 * 否则它只是一句注释。
 */
function str(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`缺少必需环境变量 ${key}（参见 .env.example）`);
  }
  if (v.trim() === '') {
    throw new ConfigError(
      `环境变量 ${key} 被显式设置为空值。这与"未设置"不同，不会回落到默认值 —— ` +
        `空 User-Agent 实测 100% 触发 WAF 503、缺 Referer 触发 TCP 重置，` +
        `静默回落会让这两条契约的自检永远无法触发。请填写有效值或整行删除。`,
    );
  }
  return v.trim();
}

function num(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ConfigError(`环境变量 ${key} 不是数字: ${v}`);
  return n;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v.trim() === '') return fallback;
  const normalized = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new ConfigError(`环境变量 ${key} 不是布尔值（true/false）：${v}`);
}

export function loadConfig(opts: { requireDatabase?: boolean } = {}): Syncer2Config {
  loadEnv();
  const requireDatabase = opts.requireDatabase !== false;

  const siteBaseUrl = str('SYNCER2_SITE_BASE_URL', 'https://scp-wiki-cn.wikidot.com').replace(/\/+$/, '');
  const proxyRaw = process.env.SYNCER2_HTTP_PROXY;
  const incrementalFrequencyMinutes = num('SYNCER2_INCREMENTAL_FREQUENCY_MINUTES', 30);
  if (incrementalFrequencyMinutes !== 15 && incrementalFrequencyMinutes !== 30) {
    throw new ConfigError(
      `SYNCER2_INCREMENTAL_FREQUENCY_MINUTES 只允许 15 或 30，收到 ${incrementalFrequencyMinutes}`,
    );
  }
  const l0WindowHours = num('SYNCER2_L0_WINDOW_HOURS', 2);
  const minimumWindowHours = (incrementalFrequencyMinutes * 4) / 60;
  if (
    !Number.isInteger(l0WindowHours) ||
    l0WindowHours < minimumWindowHours ||
    l0WindowHours > 24
  ) {
    throw new ConfigError(
      `SYNCER2_L0_WINDOW_HOURS 必须是 ${minimumWindowHours}..24 的整数，` +
        `以覆盖至少四个 L0 周期；收到 ${l0WindowHours}`,
    );
  }

  return {
    databaseUrl: requireDatabase ? str('SYNCER2_DATABASE_URL') : (process.env.SYNCER2_DATABASE_URL ?? ''),
    siteBaseUrl,
    proxyUrl: proxyRaw && proxyRaw.trim() !== '' ? proxyRaw.trim() : null,
    // 没有默认值可以兜底成空串 —— 空 UA 实测 100% 503，宁可拒绝启动。
    userAgent: str('SYNCER2_USER_AGENT', 'scpper-cn-syncer2/0.1 (+https://scpper.cn)'),
    referer: str('SYNCER2_REFERER', `${siteBaseUrl}/`),
    httpTimeoutMs: num('SYNCER2_HTTP_TIMEOUT_MS', 30_000),
    httpMaxAttempts: num('SYNCER2_HTTP_MAX_ATTEMPTS', 3),
    // 传输基线失败率约 2.3%，连续 5 次的误跳闸概率约 6e-9；与采集规格铁律一致。
    breaker503: num('SYNCER2_HTTP_503_BREAKER', 5),
    breakerReset: num('SYNCER2_HTTP_RESET_BREAKER', 5),
    httpConcurrency: num('SYNCER2_HTTP_CONCURRENCY', 2),
    stateDir: path.resolve(PROJECT_ROOT, str('SYNCER2_STATE_DIR', './state')),
    minEnumeratedRatio: num('SYNCER2_MIN_ENUMERATED_RATIO', 0.98),
    absenceCircuit: num('SYNCER2_ABSENCE_CIRCUIT', 500),
    projectIncludeDeletedPages: bool('SYNCER2_PROJECT_INCLUDE_DELETED_PAGES', false),
    incrementalFrequencyMinutes,
    l0WindowHours,

    // ── 出口归因 ─────────────────────────────────────────────────────────────
    // 这三个用 optional()（空值 = 关闭）而不是 str()（空值 = 报错）：
    // 归因是**可选的监控**，"显式关掉它"是一个合法运维决定；而 UA/Referer 是
    // 站点契约，关掉等于 100% 503，两者语义相反，所以刻意用不同的读取函数。
    exitIpProbeUrl: optional('SYNCER2_EXIT_IP_PROBE_URL', 'http://api.ipify.org'),
    exitIpProbeEvery: num('SYNCER2_EXIT_IP_PROBE_EVERY', 25),
    exitIpProbeMax: num('SYNCER2_EXIT_IP_PROBE_MAX', 8),
    mihomoApi: optional('SYNCER2_MIHOMO_API', 'http://127.0.0.1:9090'),

    // ── 启动自检 #3 ──────────────────────────────────────────────────────────
    // amcProbe 不给默认值：undefined 表示"按采集通道自动判定"（http/amc.ts 的
    // amcProbePolicyFor），显式设置才覆盖。
    amcProbe: process.env['SYNCER2_AMC_PROBE']?.trim() || undefined,
    proxyCheck: process.env['SYNCER2_PROXY_CHECK']?.trim() || 'warn',

    // ── 未消化数据队列 ───────────────────────────────────────────────────────
    pendingColdStart: num('SYNCER2_PENDING_COLD_START', 2_000),
  };
}

/**
 * 读"可选"配置：**空值 = 显式关闭**（返回 null），未设置 = 用默认值。
 * 与 str() 的空值语义刻意相反，理由见 loadConfig 里的注释。
 */
function optional(key: string, fallback: string): string | null {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v.trim() === '' ? null : v.trim();
}
