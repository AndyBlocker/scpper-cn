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
  priority: number;
}

/**
 * 0061 的代码侧镜像。门加载库内行时逐项比对并 fail closed，避免迁移未落地时
 * 新代码静默退回无通道配额。L1 的 2,100/h 比 145*12=1,740/h 多 20.7% attempt 余量。
 */
export const WIKIDOT_EGRESS_CHANNEL_QUOTAS: readonly WikidotEgressChannelQuota[] = Object.freeze([
  { group: 'l1', requestsPerHour: 2_100, priority: 100 },
  { group: 'forum', requestsPerHour: 900, priority: 60 },
  { group: 'work-queue', requestsPerHour: 1_300, priority: 50 },
  { group: 'image', requestsPerHour: 300, priority: 30 },
  { group: 'background', requestsPerHour: 800, priority: 10 },
]);

export const WIKIDOT_EGRESS_CHANNEL_QUOTA_TOTAL = WIKIDOT_EGRESS_CHANNEL_QUOTAS.reduce(
  (sum, item) => sum + item.requestsPerHour,
  0,
);

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

export function channelQuotaMinIntervalMs(quotaRequestsPerHour: number): number {
  if (!Number.isSafeInteger(quotaRequestsPerHour) || quotaRequestsPerHour <= 0) {
    throw new RangeError(`非法通道小时配额 ${quotaRequestsPerHour}`);
  }
  return Math.ceil(3_600_000 / quotaRequestsPerHour);
}

/**
 * 2026-08-12 的生产稳态计划。这里取“持续运行时的稳态”而非单轮理论硬上限：
 * L1/调度型链路按调度算术，work-queue 按 7 日活跃小时 p95 向上取整；forum 的
 * 700/h 稳态低于 900/h catch-up 配额，image 以门内 300/h 上限计，低流量链路按
 * 近期峰值或单轮上限。五组配额总和就是 5,400/h，不再由 CLI 本地 pace 暗中分配。
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
    basis: 'forum expected steady catch-up, bounded by the shared gate at 900 requests/hour',
  },
  {
    id: 'image',
    steadyRequestsPerHour: 300,
    basis: 'Wikidot-site image route shared-gate ceiling',
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
