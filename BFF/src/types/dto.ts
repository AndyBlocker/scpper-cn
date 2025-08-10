// Data Transfer Objects for API responses

export interface PageDetailDTO {
  page: {
    id: number;
    url: string;
    pageUuid: string;
    urlKey: string;
    historicalUrls: string[];
    firstPublishedAt?: string;
  };
  currentVersion: {
    id: number;
    title: string;
    rating: number;
    voteCount: number;
    revisionCount: number;
    tags: string[];
    isDeleted: boolean;
    createdAt: string;
    updatedAt: string;
  };
  stats?: {
    wilson95: number;
    controversy: number;
    likeRatio: number;
    upvotes: number;
    downvotes: number;
  };
  attributions: Array<{
    type: string;
    order: number;
    user?: {
      id: number;
      displayName: string;
      wikidotId: number;
    };
    date?: string;
  }>;
  recentRevisions: Array<{
    id: number;
    wikidotId: number;
    timestamp: string;
    type: string;
    comment?: string;
    user?: {
      displayName: string;
      wikidotId: number;
    };
  }>;
  recentVotes: Array<{
    id: number;
    timestamp: string;
    direction: number;
    user?: {
      displayName: string;
      wikidotId: number;
    };
  }>;
  relatedPages: any[];
}

export interface PageListDTO {
  pages: Array<{
    id: number;
    url: string;
    title: string;
    rating: number;
    voteCount: number;
    tags: string[];
    createdAt: string;
    updatedAt: string;
  }>;
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export interface SearchResultDTO {
  results: Array<{
    pageId: number;
    url: string;
    urlKey: string;
    title: string;
    rating: number;
    voteCount: number;
    tags: string[];
    content: string;
    score: number;
  }>;
  total: number;
  query: string;
  filters: any;
  suggestions: string[];
  pagination: {
    limit: number;
    offset: number;
    hasMore: boolean;
    totalPages: number;
  };
}

export interface UserDetailDTO {
  id: number;
  displayName: string;
  wikidotId: number;
  karma: number;
  firstActivityAt?: string;
  lastActivityAt?: string;
  createdAt: string;
}

export interface SiteStatsDTO {
  current: {
    totalUsers: number;
    activeUsers: number;
    totalPages: number;
    totalVotes: number;
    lastUpdated: string;
  };
  recent: any;
  categories: Array<{
    name: string;
    pageCount: number;
    avgRating: number;
    totalVotes: number;
    maxRating: number;
    minRating: number;
  }>;
  topTags: Array<{
    tag: string;
    count: number;
  }>;
  ratingDistribution: any;
  topContributors: Array<{
    user: UserDetailDTO;
    contributionCount: number;
  }>;
}

export interface InterestingStatsDTO {
  timeMilestones: any;
  tagRecords: any;
  contentRecords: any;
  ratingRecords: any;
  userActivityRecords: any;
  trendingStats: any;
}