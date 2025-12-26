export interface SiteOverview {
  pages: { total: number; growth?: string; originals: number; translations: number; deleted: number; byCategory: Record<string, number> }
  users: { total: number; newThisYear: number; activeThisYear: number; authors: number; translators: number; voters: number }
  votes: { total: number; up: number; down: number; netScore: number; avgPerPage: number; avgPerActiveUser: number }
  revisions: { total: number; avgPerPage: number }
  comments: { total: number; avgPerPage: number }
  words: { totalOriginal: number; totalTranslation: number; avgPerOriginal: number; avgPerTranslation: number; total: number; avgPerDoc: number }
}

export interface PageRanking {
  rank: number
  wikidotId: number
  title: string
  slug: string
  rating: number
  createdAt?: string
  authorId?: number
  authorName?: string
  authorDisplayName?: string
  tags?: string[]
  wordCount?: number
  commentCount?: number
}

export interface AuthorRanking {
  rank: number
  userId: number
  wikidotId?: number | null
  userName: string
  displayName: string
  avatarUrl: string | null
  totalRating?: number
  pageCount?: number
  avgRating?: number
  originalCount?: number
  translationCount?: number
  totalWords?: number
  originalWords?: number
  translationWords?: number
  branches?: string[]
  topPage?: { wikidotId: number; title: string; slug: string; rating: number }
}

export interface SiteData {
  overview: SiteOverview
  pageRankings: {
    topRatedOriginals: PageRanking[]
    topRatedTranslations: PageRanking[]
    longestPages: PageRanking[]
    shortestHighRated: PageRanking[]
  }
  authorRankings: {
    topByTotalRating: AuthorRanking[]
    topByOriginalCount: AuthorRanking[]
    topByTranslationCount: AuthorRanking[]
    topByWordCount: AuthorRanking[]
  }
  voterRankings: {
    topByTotalVotes: any[]
  }
  trends: {
    monthlyPages: { month: string; originals: number; translations: number; total: number }[]
  }
  milestones: any[]
  funFacts: {
    popularTags: { tag: string; count: number; avgRating: number }[]
    topTagCombos: any[]
    weekendVsWeekday: any
    timeOfDayEffect: any
  }
  distributions?: {
    tagCount?: { total: number; buckets: { label: string; min: number | null; max: number | null; count: number }[] }
    titleLength?: { total: number; buckets: { label: string; min: number | null; max: number | null; count: number }[] }
    votesCast?: { total: number; buckets: { label: string; min: number | null; max: number | null; count: number }[] }
    contentWords?: { total: number; buckets: { label: string; min: number | null; max: number | null; count: number }[] }
  }
  tagStats: {
    byCategory: Record<string, { count: number; totalRating: number; avgRating: number }>
    byObjectClass: Record<string, { count: number; originals: number; translations: number; avgRating: number }>
    byBranch: Record<string, { count: number; avgRating: number }>
    boutiqueTags?: { totalPages: number; tags: { tag: string; count: number }[] }
    newTagsThisYear?: { tag: string; count: number; firstSeen: string }[]
  }
  categoryBest?: Record<string, {
    original?: { title: string; rating: number; authorDisplayName?: string; authorName?: string }
    translation?: { title: string; rating: number; authorDisplayName?: string; authorName?: string }
  }>
  extremeStats?: {
    mostVotesTotal?: { title: string; author: string; count: number }
    mostVotesOneDay?: { title: string; date: string; count: number }
    mostUpvotesOneDay?: { title: string; date: string; count: number }
    mostProlificDay?: { date: string; count: number }
  }
  categoryDetails?: Record<string, any>
  monthlyVoteStats?: {
    monthlyVotes: { month: string; total: number; up: number; down: number; upRate: number }[]
  }
  votesByCategory?: {
    votesByCategory: Record<string, { total: number; up: number; down: number; upRate: number }>
  }
  revisionTimeDistribution?: {
    monthlyRevisions: { month: string; count: number }[]
    hourlyRevisions: { hour: number; count: number }[]
    byTimeOfDay: { period: string; count: number }[]
    byWeekday?: { weekday: string | number; count: number }[]
    byDayOfWeek?: { weekday: string | number; count: number }[]
  }
  interestingStats?: {
    mostActiveVotingDay?: { date: string; voteCount: number }
    peakVotingHour?: { hour: number; voteCount: number; label: string }
    fastestRisingPage?: { title: string; author: string; first24hVotes: number; wikidotId: number }
    mostCollaborativePage?: { title: string; authors: string; authorCount: number; wikidotId: number }
    longestPage?: { title: string; author: string; wordCount: number; wikidotId: number }
    mostControversialPage?: { title: string; author: string; totalVotes: number; downVotes: number; downRate: number; wikidotId: number }
    weekdayVsWeekend?: { weekday: { votes: number; pages: number }; weekend: { votes: number; pages: number } }
  }
}

export interface UserData {
  userId: number
  wikidotId?: number | null
  userName: string
  displayName: string
  avatarUrl: string | null
  overview: {
    rankChange: { startRank: number; endRank: number; change: number; direction: string }
    creation: { originalCount: number; translationCount: number; totalCount: number; totalWords: number; originalWords: number; translationWords: number }
    ratings: { totalRatingGained: number; avgRating: number; highestRatedPage: any; lowestRatedPage: any }
    votesReceived: { total: number; up: number; down: number; netScore: number; upRate: number }
    votesCast: { total: number; up: number; down: number; upRate: number; activeDays: number }
    activity: { activeDays: number; firstActivityDate: string; lastActivityDate: string; mostActiveMonth: string; longestStreak: number }
  }
  achievements: {
    id: string
    category: string
    tier: string
    icon: string
    title: string
    description: string
    value: number
    valueLabel: string
    period: string
    periodText: string
    tag: string | null
    earnedAt: string
    relatedPage: any
    rarity: number
    rarityLabel: string
  }[]
  highlights: {
    bestPage: any
    mostVotedPage: any
    allPages: any[]
  }
  preferences: {
    favoriteTagsByVotes: { tag: string; voteCount: number; upCount: number; upRate: number }[]
    favoriteAuthors: any[]
    votingHabits: { avgUpRate: number; mostActiveHour: number; mostActiveDay: number; avgVotesPerActiveDay: number }
    creationPreferences: { preferredTags: string[]; avgWordCount: number; preferredTime: { hour: number; dayOfWeek: number } }
  }
  revisionTimeDistribution?: {
    hourly: { hour: number; count: number }[]
    byTimeOfDay: { period: string; count: number }[]
    peakHour?: { hour: number; count: number; label: string }
    totalRevisions?: number
  }
  percentiles?: {
    votesCast?: { value: number; rank: number; total: number; percentile: number; percentileLabel: string } | null
    contentWords?: { value: number; rank: number; total: number; percentile: number; percentileLabel: string } | null
  }
  rankings: {
    overall: { rank: number; total: number; percentile: number; percentileLabel: string }
    asAuthor: { rank: number; total: number; percentile: number; percentileLabel: string }
    asVoter: { rank: number; total: number; percentile: number; percentileLabel: string }
    byCategory: Record<string, { rank: number; total: number; rating: number }>
    radar: { creation: number; translation: number; voting: number; social: number; consistency: number }
  }
  timeline: {
    month: string
    pages?: any
    pageCount?: number
    votesReceived?: number
    votesCast?: number
    highlight: { type: string; text: string } | null
  }[]
  comparisons: {
    upRate: { user: number; siteAvg: number; difference: number; verdict: string; label: string }
    avgPageRating: { user: number; siteAvg: number; difference: number; verdict: string; label: string }
    activityLevel: { user: number; siteAvg: number; difference: number; verdict: string; label: string }
  }
}

export interface UsersIndex {
  users: Record<string, {
    userName: string
    displayName: string
    avatarUrl: string | null
    hasOriginals: boolean
    hasTranslations: boolean
    hasVotes: boolean
    achievementCount: number
    highlightAchievement: string
  }>
  totalCount: number
}

export interface CategoryMonthlyItem {
  monthLabel: string
  total: number
  originals: number
  translations: number
}

export interface CategorySplit {
  originals: number
  translations: number
  total: number
  originalPercent: number
  translationPercent: number
}

export interface CategoryTopPage {
  title: string
  rating?: number
  wordCount?: number
  authorDisplayName?: string
}

export interface CategoryTopAuthor {
  wikidotId?: number | null
  displayName: string
  pageCount?: number
  avgRating?: number
  totalRating?: number
}

export interface AnnualCategoryHelpers {
  getCategoryMonthlyTrends: (key: string) => CategoryMonthlyItem[]
  getCategoryMonthlyTotal: (key: string) => number
  getCategoryMonthlyMax: (key: string) => number
  getCategoryTopPages: (key: string, kind: 'original' | 'translation') => CategoryTopPage[]
  getCategoryTopAuthors: (key: string, kind: 'original' | 'translation') => CategoryTopAuthor[]
  getCategorySplit: (key: string) => CategorySplit
}

export interface AnnualSiteData {
  overview: {
    pages: { total: number; growth: string; originals: number; translations: number; deleted: number }
    users: { total: number; newThisYear: number; activeThisYear: number; translators: number }
    votes: { total: number; up: number; down: number; upRate: number; avgPerPage: number; dailyAvg: number }
    words: { total: number; totalOriginal: number; totalTranslation: number; avgPerOriginal: number; avgPerTranslation: number; avgPerDoc: number }
  }
  topContributors: {
    mostRating: { user: string; count: number; wikidotId: number | null; unit: string; label: string }
    mostOriginals: { user: string; count: number; wikidotId: number | null; unit: string; label: string }
    mostTranslations: { user: string; count: number; wikidotId: number | null; unit: string; label: string }
    mostWords: { user: string; count: number; wikidotId: number | null; unit: string; label: string }
    mostVotes: { user: string; count: number; wikidotId: number | null; unit: string; label: string }
  }
  categoryBest: {
    cat: string
    icon: string
    iconClass: string
    iconBgClass: string
    original: { title: string; author: string; rating: number; wikidotId: number | null } | null
    translation: { title: string; author: string; rating: number; wikidotId: number | null } | null
  }[]
  records: {
    longest: { title: string; author: string; count: number; label: string }
    shortest: { title: string; author: string; count: number; label: string }
    topTranslation: { title: string; author: string; rating: number } | null
    mostProlificAuthor: { name: string; count: number; wikidotId?: number | null } | null
    mostActiveVoter: { name: string; count: number; wikidotId?: number | null } | null
    mostProlificWriter: { name: string; count: number; wikidotId?: number | null } | null
  }
  extremeStats: {
    mostVotesTotal: { title: string; author: string; count: number } | null
    mostVotesOneDay: { title: string; date: string; count: number } | null
    mostUpvotesOneDay: { title: string; date: string; count: number } | null
    mostProlificDay: { date: string; count: number } | null
  }
  breakdown: {
    byCategory: { label: string; count: number; colorFrom: string; colorTo: string; ratio: number; percent: number }[]
    scpByClass: { key: string; label: string; count: number; originals: number; translations: number; ratio: number; percent: number; color: string }[]
    translationsByBranch: { branch: string; branchKey: string; count: number; percent: number; flag: string }[]
  }
  trends: {
    monthly: number[]
    monthlySeries: { monthLabel: string; total: number; originals: number; translations: number }[]
  }
  pageRankings: {
    topRatedOriginals: { rank: number; title: string; rating: number; author: string; tags: string[]; desc: string }[]
    topOriginal: { title: string; rating: number; author: string; tags: string[]; desc: string }
    topTranslation: { title: string; rating: number; author: string; tags: string[]; desc: string }
  }
  funFacts: {
    popularTags: { tag: string; count: number; colorClass: string }[]
  }
  tagInsights: {
    boutiqueTags: { totalPages: number; tags: { tag: string; count: number }[] }
    newTagsThisYear: { tag: string; count: number; firstSeen: string }[]
  }
  distributions: {
    tagCount: { total: number; buckets: { label: string; count: number; min: number | null; max: number | null; heightPercent: number }[] }
    titleLength: { total: number; buckets: { label: string; count: number; min: number | null; max: number | null; heightPercent: number }[] }
    votesCast: { total: number; buckets: { label: string; count: number; min: number | null; max: number | null; heightPercent: number }[] }
    contentWords: { total: number; buckets: { label: string; count: number; min: number | null; max: number | null; heightPercent: number }[] }
  }
  categoryDetails: Record<string, any>
  categoryMonthly: Record<string, CategoryMonthlyItem[]>
  monthlyVotes: { month: string; monthLabel: string; total: number; up: number; down: number; upRate: number; upHeight: number; downHeight: number }[]
  votesByCategory: { name: string; total: number; up: number; down: number; upPercent: number; downPercent: number; scaledPercent: number }[]
  hourlyRevisions: { hour: number; count: number; height: number; isNight: boolean; isPeak: boolean }[]
  revisionByTimeOfDay: { period: string; count: number; percent: number; colorClass: string }[]
  revisionByWeekday: { weekday: string; count: number; percent: number; isPeak: boolean }[]
  monthlyRevisions: { month: string; monthLabel: string; count: number; height: number }[]
  interestingStats: {
    mostActiveVotingDay: { date: string; voteCount: number } | null
    peakVotingHour: { hour: number; voteCount: number; label: string } | null
    fastestRisingPage: { title: string; author: string; first24hVotes: number; wikidotId: number } | null
    mostCollaborativePage: { title: string; authors?: string; author?: string; authorCount: number; wikidotId: number } | null
    longestPage: { title: string; author: string; wordCount: number; wikidotId: number } | null
    mostControversialPage: { title: string; author: string; totalVotes: number; downVotes: number; downRate: number; wikidotId: number } | null
    longestTitlePage: { title: string; author: string; titleLength: number; wikidotId?: number } | null
    mostTagsPage: { title: string; author: string; tagCount: number; wikidotId?: number } | null
    weekdayVsWeekend: { weekday: { votes: number; pages: number }; weekend: { votes: number; pages: number }; weekdayPercent: number; weekendPercent: number }
    firstRevision?: { timestamp: string; type: string; title: string; author: string; wikidotId: number; label: string } | null
  }
  deletedPageStats?: {
    total: number
    byCategory: {
      scp: number
      tale: number
      goi: number
      wanderers: number
      art: number
      article: number
    }
    originalCount: number
    translationCount: number
    topAuthors: {
      rank: number
      userId: number
      wikidotId: number | null
      displayName: string
      deletedCount: number
    }[]
    monthlyTrend: {
      month: string
      count: number
    }[]
  }
}

export interface AnnualPercentile {
  value: number
  rank: number
  total: number
  percentile: number
  percentileLabel: string
}

export interface AnnualUserData {
  userId: number
  wikidotId: number | null
  userName: string
  displayName: string
  overview: {
    rankChange: { startRank: number; endRank: number; change: number; direction: string }
    creation: { totalCount: number; totalWords: number; originals: number; translations: number }
    ratings: { totalRatingGained: number; avgRating: number }
    votesReceived: { total: number; up: number; down: number; netScore: number; upRate: number }
    votesCast: { total: number; up: number; down: number; upRate: number; activeDays: number }
    activity: { activeDays: number; firstActivityDate: string; lastActivityDate: string; mostActiveMonth: string; longestStreak: number }
  }
  timeline: { month: string; event: string; dotClass: string; textClass: string }[]
  preferences: {
    topTags: { tag: string; value: number; unit: string; detail: string; barPercent: number; bgClass: string }[]
    topTagsSource: string
    votingTopTags: { tag: string; voteCount: number; upRate: number; bgClass: string }[]
    votingStyle: { up: number; down: number; label: string; desc: string }
  }
  achievements: {
    id: string
    tier: string
    title: string
    description: string
    originalTitle: string
    value: string
    period: string
    periodText: string
    rarityLabel: string
    tag: string
    earnedAt: string
    qualifierLength: number
    metric: string
  }[]
  percentiles: {
    votesCast: AnnualPercentile | null
    contentWords: AnnualPercentile | null
  }
  rankings: {
    overall: { rank: number; percentile: number; percentileLabel: string }
  }
  revisionTimeDistribution: {
    hourly: { hour: number; count: number; height: number; isNight: boolean; isPeak: boolean }[]
    byTimeOfDay: { period: string; count: number; percent: number; colorClass: string }[]
    peakHour: { hour: number; count: number; label: string } | null
    totalRevisions: number
  }
}
