// src/core/graphql/PointEstimator.js
import { MAX_FIRST } from '../../config/RateLimitConfig.js';


export const RateLimitCosts = {
  wikidotPage: 1,
  attributions: 10,
  alternateTitles: 1,
  children: 10,  // Array field, potentially multiple items
  parent: 1,     // Added parent cost
  source: 1,
  textContent: 1,
  revisionEdge: 5,  // Cost per edge in the revisions connection
  voteEdge: 3,      // Cost per edge in the votes connection
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
      includeParent = true,  // Always included in WikidotPageBasic
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
    if (includeParent)          cost += RateLimitCosts.parent;
    if (includeSource)          cost += RateLimitCosts.source;
    if (includeTextContent)     cost += RateLimitCosts.textContent;

    // 分页字段
    const revTotal  = Math.max(0, pageBasic.revisionCount ?? 0);
    const voteTotal = Math.max(0, pageBasic.voteCount    ?? 0);

    // 使用实际数量计算，但加上最小系数5，并且不超过limit
    const MIN_FACTOR = 5;
    const actualRevisions = Math.min(revTotal + MIN_FACTOR, revisionLimit);
    const actualVotes = Math.min(voteTotal + MIN_FACTOR, voteLimit);

    cost += actualRevisions * RateLimitCosts.revisionEdge;
    cost += actualVotes * RateLimitCosts.voteEdge;

    return cost * multiplier;
  }

  static estimateQueryCost(pages = []) {
    return pages.reduce((sum, p) => sum + (p.estimatedCost ?? 0), 0);
  }
}
