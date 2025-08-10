import { createHash } from 'crypto';

// 缓存键前缀定义
export const CACHE_PREFIXES = {
  PAGE: 'page:',
  PAGE_LIST: 'page_list:',
  PAGE_VERSION: 'page_ver:',
  USER: 'user:',
  USER_LIST: 'user_list:',
  USER_STATS: 'user_stats:',
  USER_ATTRIBUTIONS: 'user_attr:',
  USER_VOTES: 'user_votes:',
  USER_ACTIVITY: 'user_activity:',
  SEARCH: 'search:',
  STATS_SITE: 'stats:site:',
  STATS_SERIES: 'stats:series:',
  STATS_INTERESTING: 'stats:interesting:',
  LEADERBOARD: 'leaderboard:',
  TAG_CLOUD: 'tag_cloud:',
} as const;

// 缓存TTL配置
export interface CacheTTLConfig {
  HOT_DATA: number;
  SEARCH_RESULTS: number;
  PAGE_DETAIL: number;
  USER_PROFILE: number;
  PAGE_STATS: number;
  USER_STATS: number;
  SITE_STATS: number;
  SERIES_STATS: number;
  STATIC_CONFIG: number;
  TAG_METADATA: number;
}

export const CACHE_TTL: CacheTTLConfig = {
  HOT_DATA: 60,
  SEARCH_RESULTS: 300,
  PAGE_DETAIL: 900,
  USER_PROFILE: 1800,
  PAGE_STATS: 3600,
  USER_STATS: 7200,
  SITE_STATS: 21600,
  SERIES_STATS: 43200,
  STATIC_CONFIG: 0,
  TAG_METADATA: 0,
};

// 缓存键生成函数
export class CacheKeyBuilder {
  static pageDetail(identifier: string): string {
    return `${CACHE_PREFIXES.PAGE}${identifier}`;
  }
  
  static pageList(params: any): string {
    const hash = createHash('md5')
      .update(JSON.stringify(params))
      .digest('hex');
    return `${CACHE_PREFIXES.PAGE_LIST}${hash}`;
  }
  
  static userDetail(identifier: string): string {
    return `${CACHE_PREFIXES.USER}${identifier}`;
  }
  
  static userList(params: any): string {
    const hash = createHash('md5')
      .update(JSON.stringify(params))
      .digest('hex');
    return `${CACHE_PREFIXES.USER_LIST}${hash}`;
  }
  
  static userStats(identifier: string): string {
    return `${CACHE_PREFIXES.USER_STATS}${identifier}`;
  }
  
  static userAttributions(identifier: string, params: any): string {
    const hash = createHash('md5')
      .update(JSON.stringify({ identifier, params }))
      .digest('hex');
    return `${CACHE_PREFIXES.USER_ATTRIBUTIONS}${hash}`;
  }
  
  static userVotes(identifier: string, params: any): string {
    const hash = createHash('md5')
      .update(JSON.stringify({ identifier, params }))
      .digest('hex');
    return `${CACHE_PREFIXES.USER_VOTES}${hash}`;
  }
  
  static userActivity(identifier: string, params: any): string {
    const hash = createHash('md5')
      .update(JSON.stringify({ identifier, params }))
      .digest('hex');
    return `${CACHE_PREFIXES.USER_ACTIVITY}${hash}`;
  }
  
  static search(query: string, filters: any): string {
    const hash = createHash('md5')
      .update(JSON.stringify({ query, filters }))
      .digest('hex');
    return `${CACHE_PREFIXES.SEARCH}${hash}`;
  }
}