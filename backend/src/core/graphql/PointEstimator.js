// src/core/graphql/PointEstimator.js
import { MAX_FIRST } from '../../config/RateLimitConfig.js';


export const RateLimitCosts = {
  wikidotPage: 1,
  attributions: 2,
  alternateTitles: 1,
  children: 1,
  source: 1,
  textContent: 1,
  revisionEdge: 1,
  voteEdge: 1,
};


export class PointEstimator {
  static estimatePageCost(
    pageBasic = {},
    {
      revisionLimit = MAX_FIRST,
      voteLimit = MAX_FIRST,
      includeAttributions = true,
      includeAlternateTitles = true,
      includeChildren = false,
      includeSource = false,
      includeTextContent = false,
      multiplier = 1,
    } = {},
  ) {
    let cost = 0;

    // 根字段
    cost += RateLimitCosts.wikidotPage;

    // 标量 / 对象字段
    if (includeAttributions)    cost += RateLimitCosts.attributions;
    if (includeAlternateTitles) cost += RateLimitCosts.alternateTitles;
    if (includeChildren)        cost += RateLimitCosts.children;
    if (includeSource)          cost += RateLimitCosts.source;
    if (includeTextContent)     cost += RateLimitCosts.textContent;

    // 分页字段
    const revTotal  = Math.max(0, pageBasic.revisionCount ?? 0);
    const voteTotal = Math.max(0, pageBasic.voteCount    ?? 0);

    const revPages  = Math.ceil(revTotal  / revisionLimit);
    const votePages = Math.ceil(voteTotal / voteLimit);

    cost += revPages  * revisionLimit * RateLimitCosts.revisionEdge;
    cost += votePages * voteLimit    * RateLimitCosts.voteEdge;

    return cost * multiplier;
  }

  static estimateQueryCost(pages = []) {
    return pages.reduce((sum, p) => sum + (p.estimatedCost ?? 0), 0);
  }
}
