export const typeDefs = `
  # 基础类型定义
  scalar DateTime

  # 分页相关类型
  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: String
    endCursor: String
  }

  # 站点统计
  type SiteSummary {
    totalUsers: Int!
    totalPages: Int!
    totalVotes: Int!
    activeUsers: Int!
    lastUpdated: DateTime!
  }

  # 用户类型
  type User {
    id: ID!
    wikidotId: Int
    displayName: String
    firstActivityAt: DateTime
    firstActivityType: String
    firstActivityDetails: String
    lastActivityAt: DateTime
    stats: UserStats
    votes(first: Int, after: String): VoteConnection
  }

  type UserStats {
    id: ID!
    totalUp: Int!
    totalDown: Int!
    totalRating: Int!
    favTag: String
    overallRating: Float
    overallRank: Int
    scpRating: Float
    scpRank: Int
    storyRating: Float
    storyRank: Int
    translationRating: Float
    translationRank: Int
    goiRating: Float
    goiRank: Int
    wanderersRating: Float
    wanderersRank: Int
    artRating: Float
    artRank: Int
    pageCount: Int!
    scpPageCount: Int!
    storyPageCount: Int!
    translationPageCount: Int!
    goiPageCount: Int!
    wanderersPageCount: Int!
    artPageCount: Int!
  }

  type UserConnection {
    edges: [UserEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type UserEdge {
    node: User!
    cursor: String!
  }

  # 页面类型
  type Page {
    id: ID!
    url: String!
    urlKey: String!
    createdAt: DateTime!
    updatedAt: DateTime!
    currentVersion: PageVersion
    versions(first: Int, after: String): PageVersionConnection
  }

  type PageVersion {
    id: ID!
    wikidotId: Int
    title: String
    rating: Int
    voteCount: Int
    revisionCount: Int
    textContent: String
    source: String
    tags: [String!]!
    validFrom: DateTime!
    validTo: DateTime
    isDeleted: Boolean!
    stats: PageStats
    page: Page!
    votes(first: Int, after: String): VoteConnection
    attributions: [Attribution!]!
  }

  type PageStats {
    id: ID!
    uv: Int!
    dv: Int!
    wilson95: Float!
    controversy: Float!
    likeRatio: Float!
  }

  type PageConnection {
    edges: [PageEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type PageEdge {
    node: Page!
    cursor: String!
  }

  type PageVersionConnection {
    edges: [PageVersionEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type PageVersionEdge {
    node: PageVersion!
    cursor: String!
  }

  # 投票类型
  type Vote {
    id: ID!
    timestamp: DateTime!
    direction: Int!
    user: User
    pageVersion: PageVersion!
  }

  type VoteConnection {
    edges: [VoteEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type VoteEdge {
    node: Vote!
    cursor: String!
  }

  # 归属信息
  type Attribution {
    id: ID!
    type: String!
    order: Int!
    date: DateTime
    user: User
  }

  # 趣味数据
  type TriviaCard {
    id: String!
    type: String!
    title: String!
    content: String!
    data: String
  }

  # 有趣统计信息
  type InterestingFact {
    id: ID!
    category: String!
    type: String!
    title: String!
    description: String
    value: String
    page: Page
    user: User
    dateContext: DateTime
    tagContext: String
    rank: Int!
    calculatedAt: DateTime!
    metadata: String  # JSON字符串形式
  }

  type TimeMilestone {
    id: ID!
    period: String!
    periodValue: String!
    milestoneType: String!
    page: Page!
    pageTitle: String
    pageRating: Int
    pageCreatedAt: DateTime
    calculatedAt: DateTime!
  }

  type TagRecord {
    id: ID!
    tag: String!
    recordType: String!
    page: Page
    user: User
    value: Float
    metadata: String  # JSON字符串形式
    calculatedAt: DateTime!
  }

  type ContentRecord {
    id: ID!
    recordType: String!
    page: Page!
    pageTitle: String
    sourceLength: Int
    contentLength: Int
    complexity: String  # JSON字符串形式
    calculatedAt: DateTime!
  }

  type RatingRecord {
    id: ID!
    recordType: String!
    page: Page!
    pageTitle: String
    rating: Int
    voteCount: Int
    controversy: Float
    wilson95: Float
    timeframe: String
    value: Float
    achievedAt: DateTime
    calculatedAt: DateTime!
  }

  type UserActivityRecord {
    id: ID!
    recordType: String!
    user: User!
    userDisplayName: String
    value: Float
    achievedAt: DateTime
    context: String  # JSON字符串形式
    calculatedAt: DateTime!
  }

  type TrendingStat {
    id: ID!
    statType: String!
    name: String!
    entityId: Int
    entityType: String
    score: Float!
    period: String!
    metadata: String  # JSON字符串形式
    calculatedAt: DateTime!
  }

  # 统计信息集合类型
  type InterestingStatsCollection {
    facts: [InterestingFact!]!
    timeMilestones: [TimeMilestone!]!
    tagRecords: [TagRecord!]!
    contentRecords: [ContentRecord!]!
    ratingRecords: [RatingRecord!]!
    userActivityRecords: [UserActivityRecord!]!
    trendingStats: [TrendingStat!]!
  }

  # 筛选和排序
  input PageFilter {
    title: String
    tags: [String!]
    ratingMin: Int
    ratingMax: Int
    dateFrom: DateTime
    dateTo: DateTime
    category: String
  }

  input UserFilter {
    displayName: String
    minRating: Int
    activityType: String
    hasStats: Boolean
  }

  enum PageSort {
    RATING_DESC
    RATING_ASC
    CREATED_DESC
    CREATED_ASC
    UPDATED_DESC
    UPDATED_ASC
    WILSON_DESC
    WILSON_ASC
    CONTROVERSY_DESC
  }

  enum UserSort {
    OVERALL_RATING_DESC
    SCP_RATING_DESC
    STORY_RATING_DESC
    TRANSLATION_RATING_DESC
    ACTIVITY_DESC
    CREATED_DESC
  }

  # 主查询
  type Query {
    # 站点统计
    siteSummary: SiteSummary!
    
    # 页面查询
    page(id: ID!): Page
    pages(
      filter: PageFilter
      sort: PageSort = RATING_DESC
      first: Int = 20
      after: String
    ): PageConnection!
    
    # 用户查询
    user(id: ID!): User
    users(
      filter: UserFilter
      sort: UserSort = OVERALL_RATING_DESC
      first: Int = 20
      after: String
    ): UserConnection!
    
    # 随机推荐
    randomPages(limit: Int = 3, tag: String): [Page!]!
    randomTrivia(limit: Int = 5): [TriviaCard!]!
    
    # 搜索
    searchPages(query: String!, first: Int = 10): PageConnection!
    searchUsers(query: String!, first: Int = 10): UserConnection!
    
    # 有趣统计信息查询
    interestingStats(
      category: String
      type: String  
      limit: Int = 10
    ): InterestingStatsCollection!
    
    # 具体统计信息查询
    interestingFacts(
      category: String
      type: String
      tagContext: String
      limit: Int = 20
    ): [InterestingFact!]!
    
    timeMilestones(
      period: String  # year, month, quarter, day
      milestoneType: String  # first_page, last_page, first_high_rated
      limit: Int = 20
    ): [TimeMilestone!]!
    
    tagRecords(
      tag: String
      recordType: String  # highest_rated, first_page, most_popular, most_controversial
      limit: Int = 20
    ): [TagRecord!]!
    
    contentRecords(
      recordType: String  # longest_source, shortest_source, most_complex
      limit: Int = 10
    ): [ContentRecord!]!
    
    ratingRecords(
      recordType: String  # highest_rated, most_votes, most_controversial, fastest_growth
      timeframe: String   # 24h, 7d, 30d, all_time
      limit: Int = 10
    ): [RatingRecord!]!
    
    userActivityRecords(
      recordType: String  # first_vote, first_page, longest_streak, most_votes_single_day
      limit: Int = 10
    ): [UserActivityRecord!]!
    
    trendingStats(
      statType: String    # hot_tag, active_user, trending_page
      period: String      # today, this_week, this_month
      limit: Int = 10
    ): [TrendingStat!]!
    
    # 一句话小知识（用于首页展示）
    dailyTrivia: [String!]!
  }
`