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

/**
 * 2026-08-12 的生产稳态计划。这里取“持续运行时的稳态”而非单轮理论硬上限：
 * L1/调度型链路按调度算术，work-queue 按 7 日活跃小时 p95 向上取整，forum/image
 * 按各自 7.2s 本地 pace 上限，低流量链路按近期峰值或单轮上限。
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
    steadyRequestsPerHour: 500,
    basis: 'forum discovery/consumer shared channel, 7.2s local steady pace ceiling',
  },
  {
    id: 'image',
    steadyRequestsPerHour: 500,
    basis: 'Wikidot-site image route, 7.2s local steady pace ceiling',
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
