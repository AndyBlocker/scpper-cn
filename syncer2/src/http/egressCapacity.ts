/** Wikidot 共享出口预算的显式容量计划；新增生产链路必须在这里登记后才能过检查。 */

export interface EgressCapacityRoute {
  id: string;
  steadyRequestsPerHour: number;
  basis: string;
}

export interface EgressCapacityPlan {
  routes: readonly EgressCapacityRoute[];
  steadyRequestsPerHour: number;
  headroomRatio: number;
  headroomRequestsPerHour: number;
  requiredBudgetRequestsPerHour: number;
}

export interface EgressCapacityCheck extends EgressCapacityPlan {
  configuredBudgetRequestsPerHour: number;
  sufficient: boolean;
  shortfallRequestsPerHour: number;
}

export const WIKIDOT_EGRESS_CAPACITY_HEADROOM_RATIO = 0.15;

export type WikidotEgressChannelGroup =
  | 'l1'
  | 'forum'
  | 'work-queue'
  | 'image'
  | 'background';

export interface WikidotEgressChannelQuota {
  group: WikidotEgressChannelGroup;
  requestsPerHour: number;
  bucketCapacity: number;
  priority: number;
}

/**
 * 0062 的代码侧镜像。配额是连续补充速率，不是逐请求固定间隔；capacity 只决定
 * 最多可积攒多少突发，不改变长期斜率。
 *
 * - L1 175 = 2,100/12：每五分钟 145 个基础请求另留 30 个 retry；
 * - forum 75、image 25 分别是一轮五分钟额度；
 * - work-queue 109 = ceil(1,300/12)；
 * - background 400 = 800/2，容纳半小时一次的 300-request revision-source。
 */
export const WIKIDOT_EGRESS_CHANNEL_QUOTAS: readonly WikidotEgressChannelQuota[] = Object.freeze([
  { group: 'l1', requestsPerHour: 2_100, bucketCapacity: 175, priority: 100 },
  { group: 'forum', requestsPerHour: 900, bucketCapacity: 75, priority: 60 },
  { group: 'work-queue', requestsPerHour: 1_300, bucketCapacity: 109, priority: 50 },
  { group: 'image', requestsPerHour: 300, bucketCapacity: 25, priority: 30 },
  { group: 'background', requestsPerHour: 800, bucketCapacity: 400, priority: 10 },
]);

export const WIKIDOT_EGRESS_CHANNEL_QUOTA_TOTAL = WIKIDOT_EGRESS_CHANNEL_QUOTAS.reduce(
  (sum, item) => sum + item.requestsPerHour,
  0,
);

export const WIKIDOT_EGRESS_CHANNEL_BUCKET_CAPACITY_TOTAL =
  WIKIDOT_EGRESS_CHANNEL_QUOTAS.reduce((sum, item) => sum + item.bucketCapacity, 0);

export function wikidotEgressChannelQuota(channel: string): WikidotEgressChannelQuota {
  const group: WikidotEgressChannelGroup = channel === 'l1'
    ? 'l1'
    : channel === 'forum'
      ? 'forum'
      : channel === 'work-queue' || channel.startsWith('work-queue:')
        ? 'work-queue'
        : channel === 'image' || channel === 'image-sample'
          ? 'image'
          : 'background';
  const quota = WIKIDOT_EGRESS_CHANNEL_QUOTAS.find((item) => item.group === group);
  if (quota === undefined) throw new Error(`缺少 Wikidot 出口通道组 ${group}`);
  return quota;
}

export interface TokenBucketState {
  availableTokens: number;
  refilledAtMs: number;
}

export interface TokenBucketDecision extends TokenBucketState {
  granted: boolean;
  waitMs: number;
}

/** 惰性连续补充并尝试消费一个 token；空桶只返回下一 token 的等待，不会拒绝。 */
export function consumeTokenBucket(
  state: TokenBucketState,
  quota: Pick<WikidotEgressChannelQuota, 'requestsPerHour' | 'bucketCapacity'>,
  atMs: number,
): TokenBucketDecision {
  if (!Number.isFinite(state.availableTokens) || state.availableTokens < 0) {
    throw new RangeError(`非法令牌数 ${state.availableTokens}`);
  }
  if (!Number.isFinite(state.refilledAtMs) || !Number.isFinite(atMs)) {
    throw new RangeError(`非法令牌桶时钟 ${state.refilledAtMs}/${atMs}`);
  }
  if (!Number.isSafeInteger(quota.requestsPerHour) || quota.requestsPerHour <= 0) {
    throw new RangeError(`非法通道小时配额 ${quota.requestsPerHour}`);
  }
  if (!Number.isSafeInteger(quota.bucketCapacity) || quota.bucketCapacity <= 0) {
    throw new RangeError(`非法通道桶容量 ${quota.bucketCapacity}`);
  }
  if (state.availableTokens > quota.bucketCapacity + 1e-6) {
    throw new RangeError(
      `令牌数 ${state.availableTokens} 超过桶容量 ${quota.bucketCapacity}`,
    );
  }

  const refillAtMs = Math.max(state.refilledAtMs, atMs);
  const elapsedMs = Math.max(0, atMs - state.refilledAtMs);
  const refilled = Math.min(
    quota.bucketCapacity,
    state.availableTokens + elapsedMs * quota.requestsPerHour / 3_600_000,
  );
  if (refilled + 1e-9 >= 1) {
    return {
      granted: true,
      availableTokens: Math.max(0, refilled - 1),
      refilledAtMs: refillAtMs,
      waitMs: 0,
    };
  }
  return {
    granted: false,
    availableTokens: refilled,
    refilledAtMs: refillAtMs,
    waitMs: Math.max(
      1,
      Math.ceil((1 - refilled) * 3_600_000 / quota.requestsPerHour),
    ),
  };
}

/**
 * 2026-08-12 的生产稳态计划。这里取“持续运行时的稳态”而非单轮理论硬上限：
 * L1/调度型链路按调度算术，work-queue 按 7 日活跃小时 p95 向上取整；forum 的
 * 700/h 稳态低于 900/h catch-up 配额，image 以门内 300/h 上限计，低流量链路按
 * 近期峰值或单轮上限。五组补充速率总和就是 5,400/h。
 */
export const WIKIDOT_EGRESS_CAPACITY_ROUTES: readonly EgressCapacityRoute[] = Object.freeze([
  {
    id: 'l1',
    steadyRequestsPerHour: 1_740,
    basis: '145 requests/round * 12 rounds/hour (every 5 minutes)',
  },
  {
    id: 'work-queue',
    steadyRequestsPerHour: 1_300,
    basis: '7-day active-hour p95 1,282 requests, rounded up',
  },
  {
    id: 'forum',
    steadyRequestsPerHour: 700,
    basis: 'forum expected steady catch-up, bounded by the shared bucket at 900 requests/hour',
  },
  {
    id: 'image',
    steadyRequestsPerHour: 300,
    basis: 'Wikidot-site image route shared-bucket refill ceiling',
  },
  {
    id: 'sitemap:full',
    steadyRequestsPerHour: 5,
    basis: 'hourly sitemap index plus four page sitemap requests',
  },
  {
    id: 'l0',
    steadyRequestsPerHour: 2,
    basis: 'one request every 30 minutes',
  },
  {
    id: 'resolve-pages',
    steadyRequestsPerHour: 10,
    basis: '7-day peak 8 requests/hour, rounded up for normal identity arrivals',
  },
  {
    id: 'revision-source',
    steadyRequestsPerHour: 600,
    basis: '300 requests/run * 2 scheduled runs/hour while backlog is enabled',
  },
] satisfies EgressCapacityRoute[]);

export function deriveEgressCapacityPlan(
  routes: readonly EgressCapacityRoute[] = WIKIDOT_EGRESS_CAPACITY_ROUTES,
  headroomRatio = WIKIDOT_EGRESS_CAPACITY_HEADROOM_RATIO,
): EgressCapacityPlan {
  if (!Number.isFinite(headroomRatio) || headroomRatio < 0 || headroomRatio > 1) {
    throw new RangeError(`非法出口容量余量 ${headroomRatio}`);
  }
  const ids = new Set<string>();
  let steadyRequestsPerHour = 0;
  for (const route of routes) {
    if (route.id.trim() === '' || ids.has(route.id)) {
      throw new Error(`出口容量链路 id 为空或重复: ${route.id}`);
    }
    if (!Number.isSafeInteger(route.steadyRequestsPerHour) || route.steadyRequestsPerHour < 0) {
      throw new RangeError(
        `链路 ${route.id} 非法稳态请求量 ${route.steadyRequestsPerHour}`,
      );
    }
    ids.add(route.id);
    steadyRequestsPerHour += route.steadyRequestsPerHour;
  }
  const headroomRequestsPerHour = steadyRequestsPerHour * headroomRatio;
  const requiredBudgetRequestsPerHour = Math.ceil(
    (steadyRequestsPerHour + headroomRequestsPerHour) / 100,
  ) * 100;
  return {
    routes,
    steadyRequestsPerHour,
    headroomRatio,
    headroomRequestsPerHour,
    requiredBudgetRequestsPerHour,
  };
}

export const WIKIDOT_EGRESS_CAPACITY_PLAN = Object.freeze(deriveEgressCapacityPlan());
export const WIKIDOT_EGRESS_REQUIRED_BUDGET_REQUESTS_PER_HOUR =
  WIKIDOT_EGRESS_CAPACITY_PLAN.requiredBudgetRequestsPerHour;

export function checkEgressBudgetCapacity(
  configuredBudgetRequestsPerHour: number,
  routes: readonly EgressCapacityRoute[] = WIKIDOT_EGRESS_CAPACITY_ROUTES,
  headroomRatio = WIKIDOT_EGRESS_CAPACITY_HEADROOM_RATIO,
): EgressCapacityCheck {
  if (
    !Number.isSafeInteger(configuredBudgetRequestsPerHour)
    || configuredBudgetRequestsPerHour <= 0
  ) {
    throw new RangeError(`非法出口预算 ${configuredBudgetRequestsPerHour}`);
  }
  const plan = deriveEgressCapacityPlan(routes, headroomRatio);
  return {
    ...plan,
    configuredBudgetRequestsPerHour,
    sufficient: configuredBudgetRequestsPerHour >= plan.requiredBudgetRequestsPerHour,
    shortfallRequestsPerHour: Math.max(
      0,
      plan.requiredBudgetRequestsPerHour - configuredBudgetRequestsPerHour,
    ),
  };
}

export function assertEgressBudgetCapacity(
  configuredBudgetRequestsPerHour: number,
  routes: readonly EgressCapacityRoute[] = WIKIDOT_EGRESS_CAPACITY_ROUTES,
  headroomRatio = WIKIDOT_EGRESS_CAPACITY_HEADROOM_RATIO,
): EgressCapacityCheck {
  const check = checkEgressBudgetCapacity(
    configuredBudgetRequestsPerHour,
    routes,
    headroomRatio,
  );
  if (!check.sufficient) {
    throw new Error(
      `Wikidot 出口预算不足: configured=${configuredBudgetRequestsPerHour}/h, `
      + `steady=${check.steadyRequestsPerHour}/h, headroom=${Math.round(check.headroomRatio * 100)}%, `
      + `required=${check.requiredBudgetRequestsPerHour}/h, shortfall=${check.shortfallRequestsPerHour}/h`,
    );
  }
  return check;
}
