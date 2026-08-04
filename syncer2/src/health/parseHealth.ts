/**
 * M7 全局解析健康熔断。
 *
 * 危险的上游故障不是“请求失败”，而是 AMC 仍返回 status=ok、解析结果却整体变形。
 * 本模块把每轮指纹先写进 meta.ingest_run，再与同
 * (source, mode, population_type) 的前 7 日合格轮次及
 * meta.parse_health_baseline 中的阈值比较。任何阈值（包括绝对红线）都必须先有至少
 * N 个同分层历史窗口；没有基线时只记录不判定。越界只冻结该采集通道实际影响的写入域，
 * `all` 总闸保留给人工/多域相关故障，不再由单个解析指标自动触发。
 */

import type { Pool, PoolClient } from 'pg';

import { query, withTransaction } from '../store/db.js';
import { toPgJson } from '../store/pgText.js';

export const PARSE_HEALTH_WINDOW_DAYS = 7;
export const PARSE_HEALTH_MIN_SAMPLES = 3;
export const PARSE_HEALTH_DEFAULT_MIN_CURRENT_SAMPLES = 20;
/**
 * 稀有事件率至少要观察到这么多个坏事件，才允许走相对偏离。
 * 这不是总样本门槛：42 个请求虽足以计算比率，但 1 个 500 没有足够分辨率支撑相对判定。
 */
export const PARSE_HEALTH_MIN_RARE_EVENT_COUNT = 5;
/** 轻微越界至少连续两轮；结构整体坍缩等严重越界仍立即冻结。 */
export const PARSE_HEALTH_REQUIRED_CONSECUTIVE_BREACHES = 2;
export const PARSE_HEALTH_IMMEDIATE_BREACH_MULTIPLIER = 1.5;

/**
 * “有历史基线”不等于“本轮有代表性”。每项指标必须先满足自己的本轮真实分母，
 * 才有资格和绝对阈值/七日基线比较；不足时指标照常落库，只是不下判决。
 */
export const PARSE_HEALTH_MIN_CURRENT_SAMPLES: Readonly<Record<string, number>> = {
  http_status_dist: 20,
  transport_failure_rate: 20,
  exit_ip_dist: 5,
  revision_type_dist: 20,
  selector_empty_rate: 20,
  // 默认红线 0.5%；n<200 时单个坏目标就必然显示为 >0.5%，没有判别分辨率。
  parse_drop_rate: 200,
  fetched_claimed_ratio: 20,
  checksum_ok_rate: 20,
};

/**
 * 规格 §6.2 的十项原始指纹，加上两项由 meta.page_scan 证据聚合出的
 * population-invariant 完整性指标。敏感指标仍作为取证材料落库，但不进入默认熔断策略。
 */
export const REQUIRED_PARSE_FINGERPRINT_KEYS = [
  'revision_type_dist',
  'avg_votes_per_page',
  'avg_tags_len',
  'avg_source_len',
  'avg_body_len',
  'http_status_dist',
  'exit_ip_dist',
  'transport_failure_rate',
  'parse_drop_rate',
  'selector_empty_rate',
  'fetched_claimed_ratio',
  'checksum_ok_rate',
] as const;

export type RequiredParseFingerprintKey = (typeof REQUIRED_PARSE_FINGERPRINT_KEYS)[number];
export type JsonObject = Record<string, unknown>;

export interface ParseFingerprint extends JsonObject {
  revision_type_dist: Record<string, number> | null;
  avg_votes_per_page: number | null;
  avg_tags_len: number | null;
  avg_source_len: number | null;
  avg_body_len: number | null;
  http_status_dist: Record<string, number> | null;
  exit_ip_dist: Record<string, number> | null;
  transport_failure_rate: number | null;
  parse_drop_rate: number | null;
  selector_empty_rate: Record<string, number> | null;
  fetched_claimed_ratio: number | null;
  checksum_ok_rate: number | null;
  /** 每个指标本轮的真实分母；不是历史 run 数。 */
  sample_counts: Record<string, number>;
}

export type ParseHealthDirection = 'both' | 'up' | 'down';
export type ParseHealthAction = 'freeze_write' | 'warn';
export type ParseHealthPopulationSensitivity = 'invariant' | 'sensitive';
export type ParseHealthPolicyMode = 'default_gate' | 'stratified_only' | 'evidence_only';
export type ParseHealthStatisticType =
  | 'distribution_drift'
  | 'stable_mean'
  | 'rare_event_rate'
  | 'concentration'
  | 'bounded_ratio';

export interface ParseHealthMetricClassification {
  populationSensitivity: ParseHealthPopulationSensitivity;
  policyMode: ParseHealthPolicyMode;
  statisticType: ParseHealthStatisticType;
  reason: string;
}

/**
 * R10 指标分类。绝对均值/内容分布会随“这批恰好抓了哪些页”改变，只留作证据；
 * 默认 gate 只使用不随页面人气、长度或内容类型改变的完整性/传输指标。
 */
export const PARSE_HEALTH_METRIC_CLASSIFICATION: Readonly<
  Record<RequiredParseFingerprintKey, ParseHealthMetricClassification>
> = {
  revision_type_dist: {
    populationSensitivity: 'sensitive',
    policyMode: 'stratified_only',
    statisticType: 'distribution_drift',
    reason: 'revision 类型构成随被抓页面与版本集合改变，只能在严格同总体内比较',
  },
  avg_votes_per_page: {
    populationSensitivity: 'sensitive',
    policyMode: 'evidence_only',
    statisticType: 'stable_mean',
    reason: '定向抓取天然偏向投票变化/高票页，批次均值不代表解析健康',
  },
  avg_tags_len: {
    populationSensitivity: 'sensitive',
    policyMode: 'evidence_only',
    statisticType: 'stable_mean',
    reason: '标签长度取决于页面类别与样本构成',
  },
  avg_source_len: {
    populationSensitivity: 'sensitive',
    policyMode: 'evidence_only',
    statisticType: 'stable_mean',
    reason: '源码长度取决于抓到的页面内容',
  },
  avg_body_len: {
    populationSensitivity: 'sensitive',
    policyMode: 'evidence_only',
    statisticType: 'stable_mean',
    reason: '正文长度取决于抓到的页面内容',
  },
  http_status_dist: {
    populationSensitivity: 'invariant',
    policyMode: 'default_gate',
    statisticType: 'rare_event_rate',
    reason: '非 2xx 占比描述请求健康，不依赖页面人气或长度',
  },
  exit_ip_dist: {
    populationSensitivity: 'invariant',
    policyMode: 'default_gate',
    statisticType: 'concentration',
    reason: '出口池塌缩描述传输路径，不依赖抓取页面',
  },
  transport_failure_rate: {
    populationSensitivity: 'invariant',
    policyMode: 'default_gate',
    statisticType: 'rare_event_rate',
    reason: '传输失败率不依赖抓取页面内容',
  },
  parse_drop_rate: {
    populationSensitivity: 'invariant',
    policyMode: 'default_gate',
    statisticType: 'rare_event_rate',
    reason: '解析器丢弃输入行的比例直接描述结构完整性',
  },
  selector_empty_rate: {
    populationSensitivity: 'invariant',
    policyMode: 'default_gate',
    statisticType: 'rare_event_rate',
    reason: '字段空值率在同 source/mode/population 分层内描述选择器完整性',
  },
  fetched_claimed_ratio: {
    populationSensitivity: 'invariant',
    policyMode: 'default_gate',
    statisticType: 'bounded_ratio',
    reason: '逐页 fetched/claimed 完整性比正常应接近 1',
  },
  checksum_ok_rate: {
    populationSensitivity: 'invariant',
    policyMode: 'default_gate',
    statisticType: 'bounded_ratio',
    reason: '独立声明值与解析结果校验通过率不依赖页面绝对票数',
  },
};

export interface ParseHealthPolicy {
  metric: RequiredParseFingerprintKey;
  lowerBound?: number | null;
  upperBound?: number | null;
  maxRelDeviation?: number | null;
  direction: ParseHealthDirection;
  action: ParseHealthAction;
}

export type ParseHealthWriteDomain =
  | 'identity'
  | 'page'
  | 'vote'
  | 'revision'
  | 'attribution'
  | 'content'
  | 'forum'
  | 'projection';

const TRANSPORT_LAYER_METRICS = new Set([
  'http_status_dist',
  'exit_ip_dist',
  'transport_failure_rate',
]);

const WORK_KIND_DOMAINS: Readonly<Record<string, ParseHealthWriteDomain>> = {
  votes_full: 'vote',
  new_page_highfreq: 'vote',
  revisions_full: 'revision',
  files: 'revision',
  content: 'content',
  attributions: 'attribution',
  forum: 'forum',
  discussion: 'forum',
  meta: 'page',
  sitemap_delta: 'page',
  confirm_deleted: 'page',
};

/**
 * 单个指标的自动熔断爆炸半径。这里刻意没有 `all`：
 * 单来源/单总体的异常没有资格停掉无关域；总闸只允许人工或另行实现的多域相关性判据触发。
 */
export function freezeDomainsForMetric(
  source: string,
  mode: string,
  populationType: string,
  metric: string,
  stats: Record<string, unknown> = {},
): ParseHealthWriteDomain[] {
  if (
    mode === 'unspecified' ||
    populationType === 'unspecified' ||
    populationType === 'probe'
  ) {
    return [];
  }
  // HTTP/出口拓扑/传输失败是跨数据域的上游链路信号。失败请求已有逐请求拒绝采用与重试，
  // 把该信号归到本轮碰巧选中的 content/vote/revision 会制造无因果依据的写冻结。
  if (TRANSPORT_LAYER_METRICS.has(metric)) {
    return [];
  }
  if (source === 'wikidot_forum') return ['forum'];
  if (source === 'wikidot_sitemap') {
    return mode === 'threads' ? ['forum'] : ['page'];
  }
  if (source === 'wikidot_listpages') {
    return mode.startsWith('l1') ? ['vote'] : ['page'];
  }
  if (source === 'wikidot') return ['page'];
  if (source === 'wikidot_page_identity') return ['identity', 'page'];
  if (source !== 'wikidot_tier2') return [];

  // 这两项只来自 votes page_scan；即使同一 work-queue run 还跑了别的 kind，
  // 也不能因为投票完整性异常把内容/修订/论坛一起停掉。
  if (metric === 'fetched_claimed_ratio' || metric === 'checksum_ok_rate') {
    return ['vote'];
  }

  const byKind = asObject(stats['byKind']);
  const activeKinds =
    byKind === null
      ? arrayStrings(stats['selectedKinds'])
      : Object.entries(byKind)
          .filter(([, value]) => finiteNumber(asObject(value)?.['claimed'])! > 0)
          .map(([kind]) => kind);
  return uniqueDomains(
    activeKinds
      .map((kind) => WORK_KIND_DOMAINS[kind])
      .filter((domain): domain is ParseHealthWriteDomain => domain !== undefined),
  );
}

/**
 * 默认模板只定义相对偏离。绝对阈值不是 metric 的全局属性，必须在下方
 * PARSE_HEALTH_ABSOLUTE_THRESHOLDS 里按完整 stratum 显式登记。
 */
export const DEFAULT_PARSE_HEALTH_POLICIES: readonly ParseHealthPolicy[] = [
  {
    metric: 'http_status_dist',
    maxRelDeviation: 1,
    direction: 'up',
    action: 'warn',
  },
  { metric: 'exit_ip_dist', maxRelDeviation: 0.75, direction: 'up', action: 'warn' },
  {
    metric: 'transport_failure_rate',
    maxRelDeviation: 1,
    direction: 'up',
    action: 'warn',
  },
  {
    metric: 'parse_drop_rate',
    maxRelDeviation: 1,
    direction: 'up',
    action: 'freeze_write',
  },
  {
    metric: 'selector_empty_rate',
    maxRelDeviation: 0.5,
    direction: 'up',
    action: 'freeze_write',
  },
  {
    metric: 'fetched_claimed_ratio',
    maxRelDeviation: 0.02,
    direction: 'both',
    action: 'freeze_write',
  },
  {
    metric: 'checksum_ok_rate',
    maxRelDeviation: 0.01,
    direction: 'down',
    action: 'freeze_write',
  },
];

type AbsoluteThreshold = Pick<ParseHealthPolicy, 'lowerBound' | 'upperBound'>;

/**
 * 绝对阈值白名单。键必须是 (source,mode,population_type,metric) 四元组；
 * 未列出的组合只使用上面的相对偏离，绝不继承“同 metric 的全局红线”。
 */
export const PARSE_HEALTH_ABSOLUTE_THRESHOLDS: Readonly<
  Record<string, AbsoluteThreshold>
> = {
  'wikidot\u0000tier1\u0000full_scan\u0000http_status_dist': { upperBound: 0.1 },
  'wikidot\u0000tier1\u0000full_scan\u0000transport_failure_rate': { upperBound: 0.1 },
  'wikidot\u0000tier1\u0000full_scan\u0000parse_drop_rate': { upperBound: 0.005 },
  'wikidot\u0000tier1\u0000full_scan\u0000selector_empty_rate': { upperBound: 0.15 },
  'wikidot\u0000tier1\u0000l3_full_site_tier1\u0000http_status_dist': { upperBound: 0.1 },
  'wikidot\u0000tier1\u0000l3_full_site_tier1\u0000transport_failure_rate': {
    upperBound: 0.1,
  },
  'wikidot\u0000tier1\u0000l3_full_site_tier1\u0000parse_drop_rate': {
    upperBound: 0.005,
  },
  'wikidot\u0000tier1\u0000l3_full_site_tier1\u0000selector_empty_rate': {
    upperBound: 0.15,
  },
  'wikidot_listpages\u0000l1_votes\u0000l1_full_site_minimal\u0000http_status_dist': {
    upperBound: 0.1,
  },
  'wikidot_listpages\u0000l1_votes\u0000l1_full_site_minimal\u0000transport_failure_rate': {
    upperBound: 0.1,
  },
  'wikidot_listpages\u0000l1_votes\u0000l1_full_site_minimal\u0000parse_drop_rate': {
    upperBound: 0.005,
  },
  'wikidot_sitemap\u0000full\u0000full_scan\u0000parse_drop_rate': {
    upperBound: 0.1,
  },
  'wikidot_sitemap\u0000full\u0000l2_sitemap_absence\u0000parse_drop_rate': {
    upperBound: 0.1,
  },
  'wikidot_sitemap\u0000threads\u0000forum_scoped_scan\u0000parse_drop_rate': {
    upperBound: 0.1,
  },
  'wikidot_forum\u0000forum\u0000targeted_queue\u0000http_status_dist': {
    upperBound: 0.1,
  },
  'wikidot_forum\u0000forum\u0000targeted_queue\u0000transport_failure_rate': {
    upperBound: 0.1,
  },
  'wikidot_tier2\u0000tier2\u0000targeted_queue\u0000http_status_dist': {
    upperBound: 0.1,
  },
  'wikidot_tier2\u0000tier2\u0000targeted_queue\u0000transport_failure_rate': {
    upperBound: 0.1,
  },
  'wikidot_tier2\u0000tier2\u0000targeted_queue\u0000fetched_claimed_ratio': {
    lowerBound: 0.98,
    upperBound: 1.02,
  },
  'wikidot_tier2\u0000tier2\u0000targeted_queue\u0000checksum_ok_rate': {
    lowerBound: 0.99,
  },
  'wikidot_tier2\u0000tier2_replay\u0000acceptance_replay\u0000http_status_dist': {
    upperBound: 0.1,
  },
  'wikidot_tier2\u0000tier2_replay\u0000acceptance_replay\u0000transport_failure_rate': {
    upperBound: 0.1,
  },
  'wikidot_tier2\u0000tier2_replay\u0000acceptance_replay\u0000fetched_claimed_ratio': {
    lowerBound: 0.98,
    upperBound: 1.02,
  },
  'wikidot_tier2\u0000tier2_replay\u0000acceptance_replay\u0000checksum_ok_rate': {
    lowerBound: 0.99,
  },
  'wikidot_page_identity\u0000resolve_pages\u0000targeted_queue\u0000http_status_dist': {
    upperBound: 0.1,
  },
  'wikidot_page_identity\u0000resolve_pages\u0000targeted_queue\u0000transport_failure_rate': {
    upperBound: 0.1,
  },
  'wikidot_tier2\u0000revision_source_backfill\u0000revision_source_full\u0000http_status_dist': {
    upperBound: 0.1,
  },
  'wikidot_tier2\u0000revision_source_backfill\u0000revision_source_full\u0000transport_failure_rate': {
    upperBound: 0.1,
  },
};

/**
 * 定向 work queue 不是随机样本：它会主动富集 Tier1 差异、历史 partial 和待撤票页。
 * 因而 fetched/claimed 与 checksum 的聚合通过率在这个总体里是选择偏差指标，不能拿来
 * 冻结全站。逐页四重门控仍照常拒绝不完整快照；run 也会因 partial 非零退出。
 */
export function parseHealthPoliciesForStratum(
  source: string,
  populationType: string,
  mode = 'unspecified',
): readonly ParseHealthPolicy[] {
  const supported = supportedGateMetrics(source, mode, populationType);
  if (populationType === 'probe' || supported.size === 0) return [];
  return DEFAULT_PARSE_HEALTH_POLICIES
    .filter((policy) => supported.has(policy.metric))
    .map((policy) => {
      const absolute =
        PARSE_HEALTH_ABSOLUTE_THRESHOLDS[
          `${source}\u0000${mode}\u0000${populationType}\u0000${policy.metric}`
        ] ?? {};
      if (
        (populationType === 'targeted_queue' || populationType === 'acceptance_replay') &&
        (policy.metric === 'fetched_claimed_ratio' || policy.metric === 'checksum_ok_rate')
      ) {
        return { ...policy, ...absolute, action: 'warn' as const };
      }
      return { ...policy, ...absolute };
    });
}

/**
 * 已审计生产分层真正能产出的 gate 指标。这里使用精确的
 * (source,mode,population_type) 白名单：新增 mode/population 在矩阵复核前只能留证，
 * 不能仅因复用了已有 source 就自动继承 gate。
 */
function supportedGateMetrics(
  source: string,
  mode: string,
  populationType: string,
): ReadonlySet<RequiredParseFingerprintKey> {
  const key = `${source}\u0000${mode}\u0000${populationType}`;
  switch (key) {
    case 'wikidot\u0000tier1\u0000full_scan':
    case 'wikidot\u0000tier1\u0000l3_full_site_tier1':
      return new Set<RequiredParseFingerprintKey>([
        'http_status_dist',
        'exit_ip_dist',
        'transport_failure_rate',
        'parse_drop_rate',
        'selector_empty_rate',
      ]);
    case 'wikidot_listpages\u0000l1_votes\u0000l1_full_site_minimal':
      return new Set<RequiredParseFingerprintKey>([
        'http_status_dist',
        'exit_ip_dist',
        'transport_failure_rate',
        'parse_drop_rate',
      ]);
    case 'wikidot_sitemap\u0000full\u0000full_scan':
    case 'wikidot_sitemap\u0000full\u0000l2_sitemap_absence':
    case 'wikidot_sitemap\u0000threads\u0000forum_scoped_scan':
      // sitemap 每轮只有少量 HTTP 文件请求，但有数万行解析输入；只有丢行率具备样本量。
      return new Set<RequiredParseFingerprintKey>(['parse_drop_rate']);
    case 'wikidot_forum\u0000forum\u0000targeted_queue':
      return new Set<RequiredParseFingerprintKey>([
        'http_status_dist',
        'exit_ip_dist',
        'transport_failure_rate',
      ]);
    case 'wikidot_tier2\u0000tier2\u0000targeted_queue':
    case 'wikidot_tier2\u0000tier2_replay\u0000acceptance_replay':
      return new Set<RequiredParseFingerprintKey>([
        'http_status_dist',
        'exit_ip_dist',
        'transport_failure_rate',
        'fetched_claimed_ratio',
        'checksum_ok_rate',
      ]);
    case 'wikidot_tier2\u0000revision_source_backfill\u0000revision_source_full':
      // 这里的“失败”包括 no_permission、远端状态和落库结果，不是解析器丢行；
      // parse_drop_rate 仅留作任务结果证据，不能参与这个 population 的冻结。
      return new Set<RequiredParseFingerprintKey>([
        'http_status_dist',
        'transport_failure_rate',
      ]);
    case 'wikidot_page_identity\u0000resolve_pages\u0000targeted_queue':
      return new Set<RequiredParseFingerprintKey>([
        'http_status_dist',
        'transport_failure_rate',
      ]);
    default:
      return new Set();
  }
}

interface BaselineRow {
  source: string;
  mode: string;
  population_type: string;
  metric: string;
  window_days: number;
  min_history_windows: number;
  sample_count: number;
  baseline_value: string | number | null;
  baseline_stddev: string | number | null;
  lower_bound: string | number | null;
  upper_bound: string | number | null;
  max_rel_deviation: string | number | null;
  direction: ParseHealthDirection;
  action: ParseHealthAction;
  enabled: boolean;
  last_breach_run: string | number | null;
}

interface HistoricalRun {
  id: string;
  fingerprint: JsonObject;
}

export interface MetricEvaluation {
  metric: string;
  measured: boolean;
  currentValue: number | null;
  baselineValue: number | null;
  baselineStddev: number | null;
  /** 可用于动态基线的历史合格 run 数。 */
  sampleCount: number;
  /** 本轮指标的真实请求/页面/记录数。 */
  currentSampleCount: number;
  minimumCurrentSampleCount: number;
  /** 稀有事件率本轮实际坏事件数；其它统计量为 null。 */
  currentEventCount: number | null;
  /** 相对判定所需的最少坏事件数；其它统计量为 0。 */
  minimumRelativeEventCount: number;
  /** 只约束相对偏离；绝对红线仍可独立判定。 */
  relativeDecisionEligible: boolean;
  minimumBaselineSamples: number;
  baselineReady: boolean;
  decisionEligible: boolean;
  /** 本轮是否越过阈值；轻微单轮越界尚不足以冻结。 */
  thresholdExceeded: boolean;
  consecutiveBreachCount: number;
  requiredConsecutiveBreaches: number;
  immediateBreach: boolean;
  breached: boolean;
  action: ParseHealthAction;
  reasons: string[];
}

export interface ParseHealthReport {
  runId: number;
  source: string;
  mode: string;
  populationType: string;
  fingerprint: ParseFingerprint;
  policies: number;
  measured: number;
  insufficientBaseline: number;
  insufficientCurrentSample: number;
  breaches: MetricEvaluation[];
  warnings: MetricEvaluation[];
  freezeDomains: ParseHealthWriteDomain[];
  decisionSkipped: boolean;
  decisionSkipReason: string | null;
  frozen: boolean;
  freezeReason: string | null;
}

export interface EvaluateParseHealthArgs {
  runId: number;
  source: string;
  /**
   * 同一 source 可能承载 full/category/delta 等不同形态；七日动态基线必须同模式比较，
   * 否则 category 的合法根节点丢弃会被 full 基线误判为全站解析坍缩。
   */
  mode?: string | null;
  /**
   * 抓取总体类型，例如 full_scan / bounded_sample / targeted_queue。
   * mode 相同但总体不同的轮次也绝不能共享基线。
   */
  populationType?: string | null;
  fingerprint: Record<string, unknown>;
  exitIpStats?: Record<string, unknown> | null;
  /** 测试/人工演练可关闭默认策略登记，仅使用预置基线行。 */
  ensurePolicies?: boolean;
  frozenBy?: string;
  /** 空队列/probe-only 等整轮只留证、不判定的原因。 */
  decisionSkipReason?: string | null;
}

/**
 * 让每轮 JSON 都显式含 §6.2 全部项目。未观测写 null，绝不写 0：
 * “本轮没有采这个域”和“采到了合法空值”是两种语义。
 */
export function normalizeParseFingerprint(
  partial: Record<string, unknown> | null | undefined,
  exitIpStats?: Record<string, unknown> | null,
): ParseFingerprint {
  const input = partial ?? {};
  const exitFromStats = observationCountMap(
    asObject(exitIpStats)?.['byIp'],
    'probes',
  );
  const output: ParseFingerprint = {
    ...input,
    revision_type_dist: numericMap(input['revision_type_dist']),
    avg_votes_per_page: finiteNumber(input['avg_votes_per_page']),
    avg_tags_len: finiteNumber(input['avg_tags_len']),
    avg_source_len: finiteNumber(input['avg_source_len']),
    // 兼容早期原型使用过的 avg_text_len，但落库统一成规格名。
    avg_body_len: finiteNumber(input['avg_body_len'] ?? input['avg_text_len']),
    http_status_dist: numericMap(input['http_status_dist']),
    exit_ip_dist: numericMap(input['exit_ip_dist']) ?? exitFromStats,
    transport_failure_rate: finiteNumber(input['transport_failure_rate']),
    parse_drop_rate: finiteNumber(input['parse_drop_rate']),
    selector_empty_rate: numericMap(input['selector_empty_rate']),
    fetched_claimed_ratio: finiteNumber(input['fetched_claimed_ratio']),
    checksum_ok_rate: finiteNumber(input['checksum_ok_rate']),
    sample_counts: numericMap(input['sample_counts']) ?? {},
  };
  return output;
}

/** 首次出现的基线分层登记默认策略；已有人工配置一列都不覆盖。 */
export async function ensureParseHealthPolicies(
  pool: Pool,
  source: string,
  mode = 'unspecified',
  populationType = 'unspecified',
): Promise<number> {
  if (source.trim() === '') throw new Error('parse health source 不能为空');
  if (
    normalizeStratum(mode) === 'unspecified' ||
    normalizeStratum(populationType) === 'unspecified' ||
    normalizeStratum(populationType) === 'probe'
  ) {
    return 0;
  }
  let inserted = 0;
  const policies = parseHealthPoliciesForStratum(source, populationType, mode);
  for (const policy of policies) {
    const result = await query(
      pool,
      'parse_health:ensure_policy',
      `INSERT INTO meta.parse_health_baseline
       (source, mode, population_type, metric, window_days, lower_bound, upper_bound,
          min_history_windows, max_rel_deviation, direction, action, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)
       ON CONFLICT (source, mode, population_type, metric) DO NOTHING`,
      [
        source,
        normalizeStratum(mode),
        normalizeStratum(populationType),
        policy.metric,
        PARSE_HEALTH_WINDOW_DAYS,
        policy.lowerBound ?? null,
        policy.upperBound ?? null,
        PARSE_HEALTH_MIN_SAMPLES,
        policy.maxRelDeviation ?? null,
        policy.direction,
        policy.action,
      ],
    );
    inserted += result.rowCount ?? 0;
  }
  return inserted;
}

/**
 * 先写指纹、再评估、最后（如需）在同一事务里登记 breach 并按来源冻结具体域。
 * 同一 run 重复调用幂等：last_breach_run 相同不会重复累加 breach_count。
 */
export async function evaluateParseHealth(
  pool: Pool,
  args: EvaluateParseHealthArgs,
): Promise<ParseHealthReport> {
  const fingerprint = normalizeParseFingerprint(args.fingerprint, args.exitIpStats);
  const run = await query<{ started_at: Date | string; stats: JsonObject }>(
    pool,
    'parse_health:current_run',
    `SELECT started_at, stats
       FROM meta.ingest_run
      WHERE id = $1 AND source = $2`,
    [args.runId, args.source],
  );
  if (run.rows.length !== 1) {
    throw new Error(`parse health run=${args.runId} / source=${args.source} 不存在或不匹配`);
  }
  const stratum = resolveParseHealthStratum(
    args.source,
    args.mode,
    args.populationType,
    run.rows[0]!.stats,
  );

  if (args.ensurePolicies !== false) {
    try {
      await ensureParseHealthPolicies(
        pool,
        args.source,
        stratum.mode,
        stratum.populationType,
      );
    } catch (err) {
      // 角色矩阵允许 ingestor 读基线和写 breach，但默认策略由 projector/运维维护。
      // 在最小权限账号下 INSERT 会是 42501；已有基线仍必须继续比较。
      if (pgCode(err) !== '42501') throw err;
    }
  }

  await query(
    pool,
    'parse_health:record_fingerprint',
    `UPDATE meta.ingest_run
        SET parse_fingerprint = $2::jsonb,
            stats = stats || jsonb_build_object(
              'mode', $3::text,
              'population_type', $4::text
            )
      WHERE id = $1`,
    [args.runId, toPgJson(fingerprint, 'parse_health.fingerprint'), stratum.mode, stratum.populationType],
  );

  const baselines = await query<BaselineRow>(
    pool,
    'parse_health:baselines',
    `SELECT source, mode, population_type, metric, window_days, min_history_windows, sample_count,
            baseline_value, baseline_stddev,
            lower_bound, upper_bound, max_rel_deviation, direction, action, enabled,
            last_breach_run
       FROM meta.parse_health_baseline
      WHERE source = $1
        AND mode = $2
        AND population_type = $3
        AND enabled
      ORDER BY metric`,
    [args.source, stratum.mode, stratum.populationType],
  );

  const evaluations: MetricEvaluation[] = [];
  for (const baseline of baselines.rows) {
    const history = await loadHistory(
      pool,
      args.source,
      args.runId,
      baseline.metric,
      Math.max(1, Number(baseline.window_days)),
      run.rows[0]!.started_at,
      stratum.mode,
      stratum.populationType,
    );
    // 缓存与动态历史都已按三维 stratum 隔离；历史不足时所有阈值都只暖机、不判定。
    const evaluation = evaluateMetric(
      fingerprint,
      history.length === 0
        ? {
            ...baseline,
            sample_count: 0,
            baseline_value: null,
            baseline_stddev: null,
          }
        : baseline,
      history,
    );
    evaluations.push(evaluation);
    await refreshBaselineCache(pool, baseline, history, evaluation).catch((err) => {
      // ingestor_role 没有维护 baseline_value 等列的权限；动态比较已经完成，
      // 缓存失败不影响本轮判定。
      if (pgCode(err) !== '42501') throw err;
    });
  }

  const decisionSkipReason =
    args.decisionSkipReason?.trim() ||
    (stratum.mode === 'unspecified' || stratum.populationType === 'unspecified'
      ? 'unspecified_stratum_evidence_only'
      : stratum.populationType === 'probe'
        ? 'probe_only'
        : null);
  const breaches =
    decisionSkipReason === null
      ? evaluations.filter((e) => e.breached && e.action === 'freeze_write')
      : [];
  const warnings =
    decisionSkipReason === null
      ? evaluations.filter(
          (e) =>
            (e.breached && e.action === 'warn') ||
            (e.thresholdExceeded && !e.breached),
        )
      : [];
  const measured = evaluations.filter((e) => e.measured).length;
  const insufficientBaseline = evaluations.filter(
    (e) => e.measured && !e.baselineReady,
  ).length;
  const insufficientCurrentSample = evaluations.filter(
    (e) => e.measured && e.currentSampleCount < e.minimumCurrentSampleCount,
  ).length;
  const freezeReason =
    breaches.length === 0
      ? null
      : `parse_health 越界 run=${args.runId} source=${args.source} ` +
        `mode=${stratum.mode} population=${stratum.populationType}: ` +
        breaches
          .map(
            (b) =>
              `${b.metric}=${formatNumber(b.currentValue)} baseline=${formatNumber(
                b.baselineValue,
              )} (${b.reasons.join(',')})`,
          )
          .join('；');
  const freezeDomains = uniqueDomains(
    breaches.flatMap((breach) =>
      freezeDomainsForMetric(
        args.source,
        stratum.mode,
        stratum.populationType,
        breach.metric,
        run.rows[0]!.stats,
      ),
    ),
  );

  if (breaches.length > 0 && freezeDomains.length > 0) {
    await withTransaction(pool, 'parse_health:freeze', async (db) => {
      for (const breach of breaches) {
        await query(
          db,
          'parse_health:record_breach',
          `UPDATE meta.parse_health_baseline
              SET last_breach_at = now(),
                  last_breach_value = $3,
                  last_breach_run = $2,
                  breach_count = breach_count +
                    CASE WHEN last_breach_run IS DISTINCT FROM $2 THEN 1 ELSE 0 END
            WHERE source = $1
              AND mode = $5
              AND population_type = $6
              AND metric = $4`,
          [
            args.source,
            args.runId,
            breach.currentValue,
            breach.metric,
            stratum.mode,
            stratum.populationType,
          ],
        );
      }
      for (const domain of freezeDomains) {
        await query(
          db,
          'parse_health:freeze_writes',
          `SELECT meta.freeze_writes($1, $2, $3, $4, $5)`,
          [
            domain,
            freezeReason,
            args.frozenBy ?? 'syncer2.parseHealth',
            breaches[0]!.metric,
            args.runId,
          ],
        );
      }
    });
  }

  await query(
    pool,
    'parse_health:record_decision',
    `UPDATE meta.ingest_run
        SET stats = stats || jsonb_build_object(
          'parseHealthDecision',
          jsonb_build_object(
            'skipped', $2::boolean,
            'skipReason', $3::text,
            'measured', $4::int,
            'insufficientCurrentSample', $5::int,
            'insufficientBaseline', $6::int,
            'breaches', $7::int,
            'warnings', $8::int,
            'freezeDomains', $9::jsonb,
            'pendingConsecutiveBreaches', $10::jsonb
          )
        )
      WHERE id = $1`,
    [
      args.runId,
      decisionSkipReason !== null,
      decisionSkipReason,
      measured,
      insufficientCurrentSample,
      insufficientBaseline,
      breaches.length,
      warnings.length,
      toPgJson(freezeDomains, 'parse_health.freeze_domains'),
      toPgJson(
        evaluations
          .filter((evaluation) => evaluation.thresholdExceeded && !evaluation.breached)
          .map((evaluation) => ({
            metric: evaluation.metric,
            count: evaluation.consecutiveBreachCount,
            required: evaluation.requiredConsecutiveBreaches,
          })),
        'parse_health.pending_consecutive_breaches',
      ),
    ],
  );

  return {
    runId: args.runId,
    source: args.source,
    mode: stratum.mode,
    populationType: stratum.populationType,
    fingerprint,
    policies: baselines.rows.length,
    measured,
    insufficientBaseline,
    insufficientCurrentSample,
    breaches,
    warnings,
    freezeDomains,
    decisionSkipped: decisionSkipReason !== null,
    decisionSkipReason,
    frozen: breaches.length > 0 && freezeDomains.length > 0,
    freezeReason,
  };
}

async function loadHistory(
  pool: Pool,
  source: string,
  runId: number,
  metric: string,
  windowDays: number,
  currentStartedAt: Date | string,
  mode: string,
  populationType: string,
): Promise<HistoricalRun[]> {
  const rows = await query<{ id: string; fingerprint: JsonObject }>(
    pool,
    'parse_health:history',
    `SELECT id::text, parse_fingerprint AS fingerprint
       FROM meta.ingest_run
      WHERE source = $1
        AND id <> $2
        AND status IN ('ok', 'partial')
        AND started_at < $3::timestamptz
        AND started_at >= $3::timestamptz - ($4::int || ' days')::interval
        AND parse_fingerprint ? $5
        AND COALESCE(NULLIF(stats->>'mode', ''), 'unspecified') = $6
        AND COALESCE(NULLIF(stats->>'population_type', ''), 'unspecified') = $7
      ORDER BY started_at DESC, id DESC`,
    [source, runId, iso(currentStartedAt), windowDays, metric, mode, populationType],
  );
  return rows.rows;
}

export function evaluateMetric(
  fingerprint: Record<string, unknown>,
  baseline: Pick<
    BaselineRow,
    | 'metric'
    | 'sample_count'
    | 'baseline_value'
    | 'baseline_stddev'
    | 'lower_bound'
    | 'upper_bound'
    | 'max_rel_deviation'
    | 'direction'
    | 'action'
  > & { min_history_windows?: number },
  history: readonly HistoricalRun[],
): MetricEvaluation {
  const currentRaw = fingerprint[baseline.metric];
  const historicalRaw = history
    .filter(
      (row) =>
        metricCurrentSampleCount(row.fingerprint, baseline.metric) >=
        minimumCurrentSampleCount(baseline.metric),
    )
    .map((row) => row.fingerprint[baseline.metric])
    .filter((value) => value !== null && value !== undefined);

  const reduced = reduceMetric(baseline.metric, currentRaw, historicalRaw);
  const effectiveSampleCount =
    history.length > 0 ? reduced.sampleCount : Number(baseline.sample_count);
  const storedBaseline = finiteNumber(baseline.baseline_value);
  const baselineValue =
    reduced.baselineValue ??
    (effectiveSampleCount >= PARSE_HEALTH_MIN_SAMPLES ? storedBaseline : null);
  const baselineStddev =
    reduced.baselineStddev ?? finiteNumber(baseline.baseline_stddev);
  const currentValue = reduced.currentValue;
  const measured =
    currentRaw !== null &&
    currentRaw !== undefined &&
    (!(typeof currentRaw === 'object' && !Array.isArray(currentRaw)) ||
      Object.keys(currentRaw as Record<string, unknown>).length > 0);
  const currentSampleCount = metricCurrentSampleCount(fingerprint, baseline.metric);
  const minimumSamples = minimumCurrentSampleCount(baseline.metric);
  const currentEventCount = metricCurrentEventCount(fingerprint, baseline.metric);
  const rareEventRate = isRareEventRate(baseline.metric);
  const minimumRelativeEventCount = rareEventRate
    ? PARSE_HEALTH_MIN_RARE_EVENT_COUNT
    : 0;
  const relativeDecisionEligible =
    !rareEventRate ||
    (currentEventCount !== null &&
      currentEventCount >= minimumRelativeEventCount);
  const minimumBaselineSamples = Math.max(
    PARSE_HEALTH_MIN_SAMPLES,
    Number(baseline.min_history_windows) || PARSE_HEALTH_MIN_SAMPLES,
  );
  const baselineReady =
    effectiveSampleCount >= minimumBaselineSamples && baselineValue !== null;
  const decisionEligible =
    currentValue !== null &&
    currentSampleCount >= minimumSamples &&
    baselineReady;
  const reasons = decisionEligible
    ? metricBreachReasons(
        currentValue,
        baselineValue,
        baseline,
        relativeDecisionEligible,
      )
    : [];
  const thresholdExceeded = reasons.length > 0;
  let consecutiveBreachCount = thresholdExceeded ? 1 : 0;
  if (thresholdExceeded) {
    for (const row of history) {
      if (
        metricCurrentSampleCount(row.fingerprint, baseline.metric) <
        minimumSamples
      ) {
        break;
      }
      const historicalValue = reduceMetric(
        baseline.metric,
        row.fingerprint[baseline.metric],
        historicalRaw,
      ).currentValue;
      const historicalEventCount = metricCurrentEventCount(
        row.fingerprint,
        baseline.metric,
      );
      const historicalRelativeEligible =
        !rareEventRate ||
        (historicalEventCount !== null &&
          historicalEventCount >= minimumRelativeEventCount);
      if (
        historicalValue === null ||
        metricBreachReasons(
          historicalValue,
          baselineValue,
          baseline,
          historicalRelativeEligible,
        ).length === 0
      ) {
        break;
      }
      consecutiveBreachCount++;
    }
  }
  const immediateBreach =
    thresholdExceeded &&
    currentValue !== null &&
    isImmediateBreach(
      currentValue,
      baselineValue,
      baseline,
      relativeDecisionEligible,
    );
  const breached =
    thresholdExceeded &&
    (immediateBreach ||
      consecutiveBreachCount >= PARSE_HEALTH_REQUIRED_CONSECUTIVE_BREACHES);

  return {
    metric: baseline.metric,
    measured,
    currentValue,
    baselineValue,
    baselineStddev,
    sampleCount: effectiveSampleCount,
    currentSampleCount,
    minimumCurrentSampleCount: minimumSamples,
    currentEventCount,
    minimumRelativeEventCount,
    relativeDecisionEligible,
    minimumBaselineSamples,
    baselineReady,
    decisionEligible,
    thresholdExceeded,
    consecutiveBreachCount,
    requiredConsecutiveBreaches: PARSE_HEALTH_REQUIRED_CONSECUTIVE_BREACHES,
    immediateBreach,
    breached,
    action: effectiveMetricAction(baseline.metric, baseline.action),
    reasons,
  };
}

function metricBreachReasons(
  currentValue: number,
  baselineValue: number | null,
  baseline: Pick<
    BaselineRow,
    'lower_bound' | 'upper_bound' | 'max_rel_deviation' | 'direction'
  >,
  allowRelative = true,
): string[] {
  const reasons: string[] = [];
  const lower = finiteNumber(baseline.lower_bound);
  const upper = finiteNumber(baseline.upper_bound);
  if (lower !== null && currentValue < lower) reasons.push(`below:${lower}`);
  if (upper !== null && currentValue > upper) reasons.push(`above:${upper}`);

  const maxRel = finiteNumber(baseline.max_rel_deviation);
  // 零基线没有“相对百分比”的定义。该 population 若希望从严格 0 起判定，
  // 必须显式配置绝对阈值，不能用 1e-12 把任意单点噪声放大成天文数字。
  // 稀有事件率还必须先有足够的本轮坏事件；总请求数达标并不代表比率已有分辨率。
  if (
    allowRelative &&
    maxRel !== null &&
    baselineValue !== null &&
    Math.abs(baselineValue) > 1e-12
  ) {
    const rel = (currentValue - baselineValue) / Math.abs(baselineValue);
    if (baseline.direction === 'both' && Math.abs(rel) > maxRel) {
      reasons.push(`relative:${rel}`);
    } else if (baseline.direction === 'up' && rel > maxRel) {
      reasons.push(`relative_up:${rel}`);
    } else if (baseline.direction === 'down' && -rel > maxRel) {
      reasons.push(`relative_down:${rel}`);
    }
  }
  return reasons;
}

function isImmediateBreach(
  currentValue: number,
  baselineValue: number | null,
  baseline: Pick<
    BaselineRow,
    'lower_bound' | 'upper_bound' | 'max_rel_deviation' | 'direction'
  >,
  allowRelative = true,
): boolean {
  const lower = finiteNumber(baseline.lower_bound);
  const upper = finiteNumber(baseline.upper_bound);
  if (
    upper !== null &&
    upper > 0 &&
    currentValue > upper * PARSE_HEALTH_IMMEDIATE_BREACH_MULTIPLIER
  ) {
    return true;
  }
  if (
    lower !== null &&
    lower > 0 &&
    currentValue < lower / PARSE_HEALTH_IMMEDIATE_BREACH_MULTIPLIER
  ) {
    return true;
  }
  const maxRel = finiteNumber(baseline.max_rel_deviation);
  if (
    !allowRelative ||
    maxRel === null ||
    baselineValue === null ||
    Math.abs(baselineValue) <= 1e-12
  ) {
    return false;
  }
  const rel = (currentValue - baselineValue) / Math.abs(baselineValue);
  const severe = maxRel * PARSE_HEALTH_IMMEDIATE_BREACH_MULTIPLIER;
  return (
    (baseline.direction === 'both' && Math.abs(rel) > severe) ||
    (baseline.direction === 'up' && rel > severe) ||
    (baseline.direction === 'down' && -rel > severe)
  );
}

function reduceMetric(
  metric: string,
  currentRaw: unknown,
  historicalRaw: readonly unknown[],
): {
  currentValue: number | null;
  baselineValue: number | null;
  baselineStddev: number | null;
  sampleCount: number;
} {
  if (metric === 'revision_type_dist') {
    return reduceDistributionDrift(currentRaw, historicalRaw);
  }
  if (metric === 'selector_empty_rate') {
    return reduceMapDrift(currentRaw, historicalRaw);
  }

  const transform =
    metric === 'http_status_dist'
      ? httpUnhealthyRate
      : metric === 'exit_ip_dist'
        ? topBucketShare
        : finiteNumber;
  const currentValue = transform(currentRaw);
  const values = historicalRaw.map(transform).filter((v): v is number => v !== null);
  return {
    currentValue,
    baselineValue: mean(values),
    baselineStddev: stddev(values),
    sampleCount: values.length,
  };
}

/** revision type 用总变差距离；整体塌向 UNKNOWN 时会接近 1。 */
function reduceDistributionDrift(
  currentRaw: unknown,
  historicalRaw: readonly unknown[],
): ReturnType<typeof reduceMetric> {
  const current = numericMap(currentRaw);
  const history = historicalRaw.map(numericMap).filter((v): v is Record<string, number> => v !== null);
  if (!current || Object.keys(current).length === 0) {
    return { currentValue: null, baselineValue: null, baselineStddev: null, sampleCount: history.length };
  }
  const aggregate = sumMaps(history);
  if (history.length === 0 || Object.keys(aggregate).length === 0) {
    return { currentValue: null, baselineValue: null, baselineStddev: null, sampleCount: 0 };
  }
  const deviations = history.map((value) => totalVariation(value, aggregate));
  return {
    currentValue: totalVariation(current, aggregate),
    baselineValue: mean(deviations),
    baselineStddev: stddev(deviations),
    sampleCount: history.length,
  };
}

/** selector 空值率逐 selector 比较，取最大绝对漂移，避免平均值稀释单列塌缩。 */
function reduceMapDrift(
  currentRaw: unknown,
  historicalRaw: readonly unknown[],
): ReturnType<typeof reduceMetric> {
  const current = numericMap(currentRaw);
  const history = historicalRaw.map(numericMap).filter((v): v is Record<string, number> => v !== null);
  if (!current || Object.keys(current).length === 0) {
    return { currentValue: null, baselineValue: null, baselineStddev: null, sampleCount: history.length };
  }
  const average = averageMaps(history);
  if (history.length === 0 || Object.keys(average).length === 0) {
    return { currentValue: null, baselineValue: null, baselineStddev: null, sampleCount: 0 };
  }
  const drift = (value: Record<string, number>): number =>
    Math.max(
      0,
      ...[...new Set([...Object.keys(value), ...Object.keys(average)])].map((key) =>
        Math.abs((value[key] ?? 0) - (average[key] ?? 0)),
      ),
    );
  const deviations = history.map(drift);
  return {
    currentValue: drift(current),
    baselineValue: mean(deviations),
    baselineStddev: stddev(deviations),
    sampleCount: history.length,
  };
}

/**
 * HTTP 分桶压成“非 2xx 尝试占比”。不能用熵：全 200 与全 503 的熵都为 0，
 * 恰好会把最危险的坍缩判成“分布没变”。
 */
function httpUnhealthyRate(raw: unknown): number | null {
  const map = numericMap(raw);
  if (!map) return null;
  const total = Object.values(map).reduce((sum, value) => sum + value, 0);
  if (total <= 0) return null;
  const healthy = Object.entries(map).reduce(
    (sum, [key, value]) => sum + (/^2\d\d$/.test(key) ? value : 0),
    0,
  );
  return (total - healthy) / total;
}

/**
 * 轮换池的 IP 名字每轮都可能完全不同，直接做 TVD 会天天误跳闸。
 * 比较最大桶占比才能抓住“49 节点池塌成单出口”，又不把健康轮换误判成漂移。
 */
function topBucketShare(raw: unknown): number | null {
  const map = numericMap(raw);
  if (!map) return null;
  const values = Object.values(map);
  const total = values.reduce((sum, value) => sum + value, 0);
  return total <= 0 ? null : Math.max(...values) / total;
}

async function refreshBaselineCache(
  pool: Pool,
  baseline: BaselineRow,
  history: readonly HistoricalRun[],
  evaluation: MetricEvaluation,
): Promise<void> {
  if (evaluation.sampleCount === 0) return;
  const latestRun = history[0]?.id ?? null;
  await query(
    pool,
    'parse_health:refresh_baseline',
    `UPDATE meta.parse_health_baseline
        SET sample_count = $5,
            baseline_value = $6,
            baseline_stddev = $7,
            computed_from_run = $8,
            computed_at = now()
      WHERE source = $1
        AND mode = $2
        AND population_type = $3
        AND metric = $4`,
    [
      baseline.source,
      baseline.mode,
      baseline.population_type,
      baseline.metric,
      evaluation.sampleCount,
      evaluation.baselineValue,
      evaluation.baselineStddev,
      latestRun,
    ],
  );
}

function numericMap(raw: unknown): Record<string, number> | null {
  const object = asObject(raw);
  if (!object) return null;
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(object)) {
    const n = finiteNumber(value);
    if (n !== null && n >= 0) result[key] = n;
  }
  return Object.keys(result).length === 0 ? null : result;
}

/**
 * exit_ip_stats.byIp 的当前形状是 {ip:{probes,...}}；早期形状曾是 {ip:number}。
 * 两种都接受，但嵌套对象只能读取明确的计数字段，不能把对象静默丢成 null。
 */
function observationCountMap(
  raw: unknown,
  countField: string,
): Record<string, number> | null {
  const direct = numericMap(raw);
  if (direct !== null) return direct;
  const object = asObject(raw);
  if (object === null) return null;
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(object)) {
    const count = finiteNumber(asObject(value)?.[countField]);
    if (count !== null && count >= 0) result[key] = count;
  }
  return Object.keys(result).length === 0 ? null : result;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function uniqueDomains(
  domains: readonly ParseHealthWriteDomain[],
): ParseHealthWriteDomain[] {
  return [...new Set(domains)];
}

function finiteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function minimumCurrentSampleCount(metric: string): number {
  return (
    PARSE_HEALTH_MIN_CURRENT_SAMPLES[metric] ??
    PARSE_HEALTH_DEFAULT_MIN_CURRENT_SAMPLES
  );
}

function isRareEventRate(metric: string): boolean {
  return (
    PARSE_HEALTH_METRIC_CLASSIFICATION[
      metric as RequiredParseFingerprintKey
    ]?.statisticType === 'rare_event_rate'
  );
}

/**
 * 返回相对偏离所针对的本轮坏事件数。HTTP 分桶直接数非 2xx；其余率用生产者写下的
 * 真实分母还原。selector map 取最坏字段的空值数，与 reduceMapDrift 的最坏字段语义一致。
 */
export function metricCurrentEventCount(
  fingerprint: Record<string, unknown>,
  metric: string,
): number | null {
  if (!isRareEventRate(metric)) return null;

  if (metric === 'http_status_dist') {
    const counts = numericMap(fingerprint[metric]);
    if (counts === null) return null;
    return Math.round(
      Object.entries(counts).reduce(
        (sum, [status, count]) =>
          sum + (/^2\d\d$/.test(status) ? 0 : count),
        0,
      ),
    );
  }

  const sampleCount = metricCurrentSampleCount(fingerprint, metric);
  if (sampleCount <= 0) return null;

  if (metric === 'selector_empty_rate') {
    const rates = numericMap(fingerprint[metric]);
    if (rates === null || Object.keys(rates).length === 0) return null;
    return Math.round(
      Math.max(0, ...Object.values(rates)) * sampleCount,
    );
  }

  const rate = finiteNumber(fingerprint[metric]);
  if (rate === null || rate < 0) return null;
  return Math.round(rate * sampleCount);
}

/**
 * HTTP 状态、出口拓扑与传输失败是全局上游链路信号，不具备冻结某个数据写域的因果归属。
 * 即使数据库里残留旧 freeze_write 策略，运行时也降为告警，避免部署顺序窗口误冻。
 */
function effectiveMetricAction(
  metric: string,
  configured: ParseHealthAction,
): ParseHealthAction {
  return TRANSPORT_LAYER_METRICS.has(metric) ? 'warn' : configured;
}

/**
 * 优先读取生产者写下的真实分母。只有“桶值本身就是计数”的三个分布指标可以安全推导；
 * selector_empty_rate 之类的 map 装的是比例，绝不能把比例之和冒充页面数。
 */
export function metricCurrentSampleCount(
  fingerprint: Record<string, unknown>,
  metric: string,
): number {
  const explicit = finiteNumber(asObject(fingerprint['sample_counts'])?.[metric]);
  if (explicit !== null && explicit >= 0) return Math.floor(explicit);

  const inferredMetric =
    metric === 'transport_failure_rate' ? 'http_status_dist' : metric;
  if (
    inferredMetric === 'http_status_dist' ||
    inferredMetric === 'exit_ip_dist' ||
    inferredMetric === 'revision_type_dist'
  ) {
    const counts = numericMap(fingerprint[inferredMetric]);
    if (counts !== null) {
      return Math.floor(
        Object.values(counts).reduce((sum, value) => sum + value, 0),
      );
    }
  }
  return 0;
}

function sumMaps(maps: readonly Record<string, number>[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const map of maps) {
    for (const [key, value] of Object.entries(map)) result[key] = (result[key] ?? 0) + value;
  }
  return result;
}

function averageMaps(maps: readonly Record<string, number>[]): Record<string, number> {
  if (maps.length === 0) return {};
  const sums = sumMaps(maps);
  for (const key of Object.keys(sums)) sums[key] = sums[key]! / maps.length;
  return sums;
}

function totalVariation(a: Record<string, number>, b: Record<string, number>): number {
  const at = Object.values(a).reduce((sum, value) => sum + value, 0);
  const bt = Object.values(b).reduce((sum, value) => sum + value, 0);
  if (at <= 0 || bt <= 0) return 1;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let distance = 0;
  for (const key of keys) distance += Math.abs((a[key] ?? 0) / at - (b[key] ?? 0) / bt);
  return distance / 2;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stddev(values: readonly number[]): number | null {
  const avg = mean(values);
  if (avg === null || values.length < 2) return null;
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1),
  );
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function pgCode(err: unknown): string | null {
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
    ? String((err as { code: string }).code)
    : null;
}

function formatNumber(value: number | null): string {
  return value === null ? 'null' : Number(value.toPrecision(6)).toString();
}

export interface ParseHealthStratum {
  mode: string;
  populationType: string;
}

export function resolveParseHealthStratum(
  source: string,
  explicitMode: string | null | undefined,
  explicitPopulationType: string | null | undefined,
  stats: Record<string, unknown> | null | undefined,
): ParseHealthStratum {
  const input = stats ?? {};
  const mode = normalizeStratum(explicitMode ?? stringValue(input['mode']));
  const populationType = normalizeStratum(
    explicitPopulationType ??
      stringValue(input['population_type']) ??
      stringValue(input['populationType']) ??
      inferPopulationType(source, mode, input),
  );
  return { mode, populationType };
}

function inferPopulationType(
  source: string,
  mode: string,
  stats: Record<string, unknown>,
): string {
  if (source.endsWith(':probe') || stats['probeOnly'] === true) return 'probe';
  if (stringValue(stats['domain']) === 'work_queue') return 'targeted_queue';
  if (mode === 'tier1_range' || stats['sampleLimited'] === true) return 'bounded_sample';
  if (mode === 'tier1' || mode === 'full') return 'full_scan';
  if (mode === 'delta') return 'change_slice';
  if (mode === 'category' || mode === 'threads') return 'scoped_scan';
  if (mode === 'forum') return 'targeted_queue';
  return 'unspecified';
}

function normalizeStratum(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized ? normalized : 'unspecified';
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** 仅给需要在已有事务内编排的调用方使用。 */
export type ParseHealthDb = Pool | PoolClient;
