/** 图片整轮健康：统一判据只定义一次，wikidot/external 分子与 breaker 严格分账。 */

import { evaluateRunHealth, type RunHealthDecision } from '../work/runHealth.js';
import type { ImageEgressClass, ProcessImageResult } from './worker.js';

export interface ImageRouteCounters {
  claimed: number;
  completed: number;
  retry: number;
  failed: number;
  /** 确定性坏资源或自我保护推迟；保留观测，但不计入站点健康压力分子。 */
  healthExcluded: number;
}

export interface ImagePipelineHealth {
  unified: RunHealthDecision;
  wikidotSite: RunHealthDecision;
  external: RunHealthDecision;
}

export function emptyImageRouteCounters(): ImageRouteCounters {
  return { claimed: 0, completed: 0, retry: 0, failed: 0, healthExcluded: 0 };
}

export function recordImageRouteResult(
  counters: Record<ImageEgressClass, ImageRouteCounters>,
  result: ProcessImageResult,
): void {
  const route = counters[result.egressClass];
  route.claimed++;
  route[result.status]++;
  /*
   * 健康度排除必须同时覆盖 failed 与 retry。
   *
   * 主动跳过（host_deferred）走的是 **retry** 状态——它会被重新入队等下轮，
   * 而我最初只在 status==='failed' 时累加 healthExcluded，于是 117 条推迟
   * 全被算成可重试失败，失败率 97.5%、每轮 exit 1。
   * 推迟是限速层的正常输出，不是压力来源；再拿它当压力信号会自我放大。
   */
  if (
    (result.status === 'failed' || result.status === 'retry')
    && isImageFailureExcludedFromHealth(result.failureClass)
  ) {
    route.healthExcluded++;
  }
}

/*
 * 图片健康度排除口径：这里回答的是“是否代表站点/链路压力”，不回答任务能否重试。
 *
 * 实测：降速与自适应退让生效后 http_transient 归零，剩下的主体变成
 * http_permanent 50——手工验证 https://i.loli.net/2020/11/26/… 返回 HTTP 404，
 * 是 2020 年的免费图床链接早已失效。SCP 页面引用外部图床失效是常态，
 * 把它计入失败率会让链路永远判 failed，掩盖真正的限流信号。
 *
 * http_permanent 等确定性坏资源与 host_deferred 都不代表链路压力，但生命周期不同：
 * 前者可以终态，后者必须重试。任务终态由 worker.isTerminalImageFailure 单独判断。
 */
export function isImageFailureExcludedFromHealth(
  failureClass: string | null | undefined,
): boolean {
  return failureClass === 'http_permanent'
    || failureClass === 'invalid_content_type'
    || failureClass === 'blocked_host'
    // 域名已消失，重试无意义；与 http_permanent 同级。
    || failureClass === 'host_unresolvable'
    // 主动跳过（主机放行太远）是退让的结果；只排除健康度，不代表任务终态。
    || failureClass === 'host_deferred';
}

export function evaluateImagePipelineHealth(
  routes: Record<ImageEgressClass, ImageRouteCounters>,
  breakers: { wikidotSite: boolean; external: boolean },
): ImagePipelineHealth {
  const wikidotSite = decide(routes.wikidot_site, breakers.wikidotSite);
  const external = decide(routes.external, breakers.external, EXTERNAL_IMAGE_FAILURE_RATE_THRESHOLD);
  const combined: ImageRouteCounters = {
    claimed: routes.wikidot_site.claimed + routes.external.claimed,
    completed: routes.wikidot_site.completed + routes.external.completed,
    retry: routes.wikidot_site.retry + routes.external.retry,
    failed: routes.wikidot_site.failed + routes.external.failed,
    healthExcluded: routes.wikidot_site.healthExcluded + routes.external.healthExcluded,
  };
  /*
   * unified 不再用合并计数直接判——站外的高失败率会把 wikidot 侧一起拖垮。
   * 改为两条链路各自判定后取「较差者」，但各自用各自的阈值。
   */
  const unified: RunHealthDecision =
    wikidotSite.exitCode !== 0 ? wikidotSite
    : external.exitCode !== 0 ? external
    : wikidotSite.status !== 'ok' ? wikidotSite
    : external;
  void combined;
  return {
    unified,
    wikidotSite,
    external,
  };
}

/*
 * 站外图床的失败率阈值必须独立于 wikidot。
 *
 * 实测：站外下载失败率稳定在 25.5% 上下（http_transient 456、network 31，
 * 均为可重试的瞬时错误；确定性的 invalid_content_type 68 / blocked_host 7 /
 * http_permanent 6 已单独归类）。而统一阈值是 25%，于是每轮都判 failed。
 *
 * 站外图床（wdfiles 等）本就不稳定——防盗链、限流、死链都会造成瞬时失败，
 * 25% 是常态而非故障。用 wikidot 的标准衡量另一个站点，是把「A 站健康线」
 * 当成了「所有出站的健康线」。
 *
 * wikidot 侧仍用统一阈值：那是我们必须保护的主站。
 */
export const EXTERNAL_IMAGE_FAILURE_RATE_THRESHOLD = 0.6;

function decide(
  counters: ImageRouteCounters,
  breakerOpen: boolean,
  failureRateThreshold?: number,
): RunHealthDecision {
  return evaluateRunHealth({
    claimed: counters.claimed,
    processed: counters.completed + counters.retry + counters.failed,
    partial: 0,
    // retry 是本轮真实失败；重新入队不能让它从成功率分母消失。
    failed: counters.retry + counters.failed,
    deterministicFailures: counters.healthExcluded,
    breakerOpen,
    ...(failureRateThreshold === undefined ? {} : { failureRateThreshold }),
  });
}
