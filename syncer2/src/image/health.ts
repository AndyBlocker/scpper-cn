/** 图片整轮健康：统一判据只定义一次，wikidot/external 分子与 breaker 严格分账。 */

import { evaluateRunHealth, type RunHealthDecision } from '../work/runHealth.js';
import type { ImageEgressClass, ProcessImageResult } from './worker.js';

export interface ImageRouteCounters {
  claimed: number;
  completed: number;
  retry: number;
  failed: number;
}

export interface ImagePipelineHealth {
  unified: RunHealthDecision;
  wikidotSite: RunHealthDecision;
  external: RunHealthDecision;
}

export function emptyImageRouteCounters(): ImageRouteCounters {
  return { claimed: 0, completed: 0, retry: 0, failed: 0 };
}

export function recordImageRouteResult(
  counters: Record<ImageEgressClass, ImageRouteCounters>,
  result: ProcessImageResult,
): void {
  const route = counters[result.egressClass];
  route.claimed++;
  route[result.status]++;
}

export function evaluateImagePipelineHealth(
  routes: Record<ImageEgressClass, ImageRouteCounters>,
  breakers: { wikidotSite: boolean; external: boolean },
): ImagePipelineHealth {
  const wikidotSite = decide(routes.wikidot_site, breakers.wikidotSite);
  const external = decide(routes.external, breakers.external);
  const combined: ImageRouteCounters = {
    claimed: routes.wikidot_site.claimed + routes.external.claimed,
    completed: routes.wikidot_site.completed + routes.external.completed,
    retry: routes.wikidot_site.retry + routes.external.retry,
    failed: routes.wikidot_site.failed + routes.external.failed,
  };
  return {
    unified: decide(combined, breakers.wikidotSite || breakers.external),
    wikidotSite,
    external,
  };
}

function decide(counters: ImageRouteCounters, breakerOpen: boolean): RunHealthDecision {
  return evaluateRunHealth({
    claimed: counters.claimed,
    processed: counters.completed + counters.retry + counters.failed,
    partial: 0,
    // retry 是本轮真实失败；重新入队不能让它从成功率分母消失。
    failed: counters.retry + counters.failed,
    breakerOpen,
  });
}
