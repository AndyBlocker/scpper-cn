import { PrismaClient } from '@prisma/client';
import { CacheService } from './cache.service.js';
import { CacheKeyBuilder, CACHE_TTL } from '../types/cache.js';
import { logger } from '../utils/logger.js';

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export interface UserDetailDTO {
  id: number;
  displayName: string | null;
  wikidotId: number | null;
  firstActivityAt?: string;
  lastActivityAt?: string;
  stats?: {
    totalUp: number;
    totalDown: number;
    totalRating: number;
    pageCount: number;
    overallRating: number | null;
    overallRank: number | null;
    scpPageCount: number;
    scpRating: number | null;
    scpRank: number | null;
    goiPageCount: number;
    goiRating: number | null;
    goiRank: number | null;
    storyPageCount: number;
    storyRating: number | null;
    storyRank: number | null;
    translationPageCount: number;
    translationRating: number | null;
    translationRank: number | null;
    artPageCount: number;
    artRating: number | null;
    artRank: number | null;
    wanderersPageCount: number;
    wanderersRating: number | null;
    wanderersRank: number | null;
    favTag: string | null;
    ratingUpdatedAt?: string;
  };
  contributionCount?: number;
}

export interface UserListDTO {
  users: UserDetailDTO[];
  pagination: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export interface UserStatsDTO {
  user: UserDetailDTO;
  recentActivity: Array<{
    type: string;
    date: string;
    pageTitle?: string;
    pageUrl?: string;
    rating?: number;
    voteDirection?: number;
  }>;
  contributionHistory: Array<{
    type: string;
    count: number;
    rating: number | null;
    rank: number | null;
  }>;
  tagPreferences: Array<{
    tag: string;
    upvoteCount: number;
    downvoteCount: number;
    totalVotes: number;
  }>;
}

export interface UserAttributionsDTO {
  attributions: Array<{
    id: number;
    type: string;
    order: number;
    date?: string;
    page: {
      id: number;
      url: string;
      title: string;
      rating: number;
    };
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

export interface UserVotesDTO {
  votes: Array<{
    id: number;
    timestamp: string;
    direction: number;
    page: {
      id: number;
      url: string;
      title: string;
      rating: number;
    };
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

export interface UserActivityDTO {
  activities: Array<{
    type: 'vote' | 'revision' | 'attribution';
    timestamp: string;
    details: any;
    page?: {
      id: number;
      url: string;
      title: string;
      rating: number;
    };
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

export class UserService {
  constructor(
    private prisma: PrismaClient,
    private cache: CacheService
  ) {}

  async getUserList(params: {
    page?: number;
    limit?: number;
    sort?: 'karma' | 'contributions' | 'latest';
  }): Promise<UserListDTO> {
    const cacheKey = CacheKeyBuilder.userList(params);
    
    return this.cache.getOrSet(
      cacheKey,
      async () => {
        const page = params.page || 1;
        const limit = params.limit || 20;
        const offset = (page - 1) * limit;

        let orderBy: any;
        switch (params.sort) {
          case 'contributions':
            orderBy = { UserStats: { pageCount: 'desc' } };
            break;
          case 'latest':
            orderBy = { lastActivityAt: 'desc' };
            break;
          default: // karma
            orderBy = { UserStats: { overallRating: 'desc' } };
        }

        // 优先查询有UserStats的用户，如果不够再补充无stats的用户
        let users: any[] = [];
        
        if (params.sort !== 'latest') {
          // 对于karma和contributions排序，优先显示有stats的用户
          const usersWithStats = await this.prisma.user.findMany({
            where: {
              displayName: { not: null },
              lastActivityAt: { not: null },
              UserStats: { isNot: null },
            },
            include: {
              UserStats: true,
              Attribution: {
                select: { id: true },
              },
            },
            orderBy,
            skip: offset,
            take: limit,
          });
          
          users = usersWithStats;
          
          // 如果有stats的用户不够填满一页，补充无stats的用户
          if (users.length < limit) {
            const remainingCount = limit - users.length;
            const usersWithoutStats = await this.prisma.user.findMany({
              where: {
                displayName: { not: null },
                lastActivityAt: { not: null },
                UserStats: null,
              },
              include: {
                UserStats: true,
                Attribution: {
                  select: { id: true },
                },
              },
              orderBy: { lastActivityAt: 'desc' },
              take: remainingCount,
            });
            
            users = [...users, ...usersWithoutStats];
          }
        } else {
          // 对于latest排序，不区分有无stats
          users = await this.prisma.user.findMany({
            where: {
              displayName: { not: null },
              lastActivityAt: { not: null },
            },
            include: {
              UserStats: true,
              Attribution: {
                select: { id: true },
              },
            },
            orderBy,
            skip: offset,
            take: limit,
          });
        }
        
        const total = await this.prisma.user.count({
          where: {
            displayName: { not: null },
            lastActivityAt: { not: null },
          },
        });

        return {
          users: users.map(user => this.formatUserDetail(user)),
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            hasNext: page * limit < total,
            hasPrev: page > 1,
          },
        };
      },
      CACHE_TTL.USER_PROFILE
    );
  }

  async getUserDetail(identifier: string): Promise<UserDetailDTO> {
    const cacheKey = CacheKeyBuilder.userDetail(identifier);
    
    return this.cache.getOrSet(
      cacheKey,
      async () => {
        const user = await this.prisma.user.findFirst({
          where: {
            OR: [
              { id: isNaN(parseInt(identifier)) ? undefined : parseInt(identifier) },
              { wikidotId: isNaN(parseInt(identifier)) ? undefined : parseInt(identifier) },
              { displayName: identifier },
            ],
          },
          include: {
            UserStats: true,
            Attribution: {
              select: { id: true },
            },
          },
        });

        if (!user) {
          throw new NotFoundError('User not found');
        }

        return this.formatUserDetail(user);
      },
      CACHE_TTL.USER_PROFILE
    );
  }

  async getUserStats(identifier: string): Promise<UserStatsDTO> {
    const cacheKey = CacheKeyBuilder.userStats(identifier);
    
    return this.cache.getOrSet(
      cacheKey,
      async () => {
        const user = await this.getUserDetail(identifier);
        
        const [recentVotes, recentRevisions, recentAttributions, tagPreferences] = await Promise.all([
          this.getRecentVotes(user.id),
          this.getRecentRevisions(user.id),
          this.getRecentAttributions(user.id),
          this.getUserTagPreferences(user.id),
        ]);

        const recentActivity = [
          ...recentVotes.map(vote => ({
            type: 'vote',
            date: vote.timestamp.toISOString(),
            pageTitle: vote.PageVersion?.title || undefined,
            pageUrl: vote.PageVersion?.Page?.url || undefined,
            voteDirection: vote.direction,
          })),
          ...recentRevisions.map(rev => ({
            type: 'revision',
            date: rev.timestamp.toISOString(),
            pageTitle: rev.PageVersion?.title || undefined,
            pageUrl: rev.PageVersion?.Page?.url || undefined,
          })),
          ...recentAttributions.map(attr => ({
            type: 'attribution',
            date: attr.date?.toISOString() || attr.PageVersion.createdAt.toISOString(),
            pageTitle: attr.PageVersion?.title || undefined,
            pageUrl: attr.PageVersion?.Page?.url || undefined,
          })),
        ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 20);

        const contributionHistory = user.stats ? [
          { type: 'SCP', count: user.stats.scpPageCount, rating: user.stats.scpRating, rank: user.stats.scpRank },
          { type: 'GOI', count: user.stats.goiPageCount, rating: user.stats.goiRating, rank: user.stats.goiRank },
          { type: '故事', count: user.stats.storyPageCount, rating: user.stats.storyRating, rank: user.stats.storyRank },
          { type: '翻译', count: user.stats.translationPageCount, rating: user.stats.translationRating, rank: user.stats.translationRank },
          { type: '艺作', count: user.stats.artPageCount, rating: user.stats.artRating, rank: user.stats.artRank },
          { type: '流浪者', count: user.stats.wanderersPageCount, rating: user.stats.wanderersRating, rank: user.stats.wanderersRank },
        ].filter(item => item.count > 0) : [];

        return {
          user,
          recentActivity,
          contributionHistory,
          tagPreferences: tagPreferences.map(pref => ({
            tag: pref.tag,
            upvoteCount: pref.upvoteCount,
            downvoteCount: pref.downvoteCount,
            totalVotes: pref.totalVotes,
          })),
        };
      },
      CACHE_TTL.USER_STATS
    );
  }

  async getUserAttributions(identifier: string, params: {
    page?: number;
    limit?: number;
  }): Promise<UserAttributionsDTO> {
    const cacheKey = CacheKeyBuilder.userAttributions(identifier, params);
    
    return this.cache.getOrSet(
      cacheKey,
      async () => {
        const user = await this.getUserDetail(identifier);
        const page = params.page || 1;
        const limit = params.limit || 20;
        const offset = (page - 1) * limit;

        const [attributions, total] = await Promise.all([
          this.prisma.attribution.findMany({
            where: { userId: user.id },
            include: {
              PageVersion: {
                include: {
                  Page: true,
                },
              },
            },
            orderBy: { date: 'desc' },
            skip: offset,
            take: limit,
          }),
          this.prisma.attribution.count({
            where: { userId: user.id },
          }),
        ]);

        return {
          attributions: attributions.map(attr => ({
            id: attr.id,
            type: attr.type,
            order: attr.order,
            date: attr.date?.toISOString(),
            page: {
              id: attr.PageVersion.Page.id,
              url: attr.PageVersion.Page.url,
              title: attr.PageVersion.title || 'Untitled',
              rating: attr.PageVersion.rating || 0,
            },
          })),
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            hasNext: page * limit < total,
            hasPrev: page > 1,
          },
        };
      },
      CACHE_TTL.USER_STATS
    );
  }

  async getUserVotes(identifier: string, params: {
    page?: number;
    limit?: number;
  }): Promise<UserVotesDTO> {
    const cacheKey = CacheKeyBuilder.userVotes(identifier, params);
    
    return this.cache.getOrSet(
      cacheKey,
      async () => {
        const user = await this.getUserDetail(identifier);
        const page = params.page || 1;
        const limit = params.limit || 20;
        const offset = (page - 1) * limit;

        const [votes, total] = await Promise.all([
          this.prisma.vote.findMany({
            where: { userId: user.id },
            include: {
              PageVersion: {
                include: {
                  Page: true,
                },
              },
            },
            orderBy: { timestamp: 'desc' },
            skip: offset,
            take: limit,
          }),
          this.prisma.vote.count({
            where: { userId: user.id },
          }),
        ]);

        return {
          votes: votes.map(vote => ({
            id: vote.id,
            timestamp: vote.timestamp.toISOString(),
            direction: vote.direction,
            page: {
              id: vote.PageVersion.Page.id,
              url: vote.PageVersion.Page.url,
              title: vote.PageVersion.title || 'Untitled',
              rating: vote.PageVersion.rating || 0,
            },
          })),
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            hasNext: page * limit < total,
            hasPrev: page > 1,
          },
        };
      },
      CACHE_TTL.USER_STATS
    );
  }

  async getUserActivity(identifier: string, params: {
    page?: number;
    limit?: number;
  }): Promise<UserActivityDTO> {
    const cacheKey = CacheKeyBuilder.userActivity(identifier, params);
    
    return this.cache.getOrSet(
      cacheKey,
      async () => {
        const user = await this.getUserDetail(identifier);
        const page = params.page || 1;
        const limit = params.limit || 20;
        const offset = (page - 1) * limit;

        const [recentVotes, recentRevisions, recentAttributions] = await Promise.all([
          this.prisma.vote.findMany({
            where: { userId: user.id },
            include: {
              PageVersion: {
                include: { Page: true },
              },
            },
            orderBy: { timestamp: 'desc' },
            take: limit,
          }),
          this.prisma.revision.findMany({
            where: { userId: user.id },
            include: {
              PageVersion: {
                include: { Page: true },
              },
            },
            orderBy: { timestamp: 'desc' },
            take: limit,
          }),
          this.prisma.attribution.findMany({
            where: { userId: user.id },
            include: {
              PageVersion: {
                include: { Page: true },
              },
            },
            orderBy: { date: 'desc' },
            take: limit,
          }),
        ]);

        const allActivities = [
          ...recentVotes.map(vote => ({
            type: 'vote' as const,
            timestamp: vote.timestamp.toISOString(),
            details: {
              direction: vote.direction,
              voteId: vote.id,
            },
            page: {
              id: vote.PageVersion.Page.id,
              url: vote.PageVersion.Page.url,
              title: vote.PageVersion.title || 'Untitled',
              rating: vote.PageVersion.rating || 0,
            },
          })),
          ...recentRevisions.map(rev => ({
            type: 'revision' as const,
            timestamp: rev.timestamp.toISOString(),
            details: {
              type: rev.type,
              comment: rev.comment,
              wikidotId: rev.wikidotId,
            },
            page: {
              id: rev.PageVersion.Page.id,
              url: rev.PageVersion.Page.url,
              title: rev.PageVersion.title || 'Untitled',
              rating: rev.PageVersion.rating || 0,
            },
          })),
          ...recentAttributions.map(attr => ({
            type: 'attribution' as const,
            timestamp: attr.date?.toISOString() || attr.PageVersion.createdAt.toISOString(),
            details: {
              attributionType: attr.type,
              order: attr.order,
            },
            page: {
              id: attr.PageVersion.Page.id,
              url: attr.PageVersion.Page.url,
              title: attr.PageVersion.title || 'Untitled',
              rating: attr.PageVersion.rating || 0,
            },
          })),
        ];

        allActivities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
        
        const paginatedActivities = allActivities.slice(offset, offset + limit);
        const total = allActivities.length;

        return {
          activities: paginatedActivities,
          pagination: {
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit),
            hasNext: page * limit < total,
            hasPrev: page > 1,
          },
        };
      },
      CACHE_TTL.HOT_DATA
    );
  }

  private async getRecentVotes(userId: number) {
    return this.prisma.vote.findMany({
      where: { userId },
      include: {
        PageVersion: {
          include: { Page: true },
        },
      },
      orderBy: { timestamp: 'desc' },
      take: 10,
    });
  }

  private async getRecentRevisions(userId: number) {
    return this.prisma.revision.findMany({
      where: { userId },
      include: {
        PageVersion: {
          include: { Page: true },
        },
      },
      orderBy: { timestamp: 'desc' },
      take: 10,
    });
  }

  private async getRecentAttributions(userId: number) {
    return this.prisma.attribution.findMany({
      where: { userId },
      include: {
        PageVersion: {
          include: { Page: true },
        },
      },
      orderBy: { date: 'desc' },
      take: 10,
    });
  }

  async getUserRatingHistory(identifier: string) {
    const cacheKey = `user_rating_history:${identifier}`;
    
    return this.cache.getOrSet(
      cacheKey,
      async () => {
        const user = await this.prisma.user.findFirst({
          where: {
            OR: [
              { id: isNaN(parseInt(identifier)) ? undefined : parseInt(identifier) },
              { wikidotId: isNaN(parseInt(identifier)) ? undefined : parseInt(identifier) },
              { displayName: identifier },
            ],
          },
          select: {
            id: true,
            attributionVotingTimeSeriesCache: true,
            attributionVotingCacheUpdatedAt: true,
          },
        });
        
        if (!user) {
          throw new NotFoundError('User not found');
        }
        
        return {
          userId: user.id,
          ratingHistory: user.attributionVotingTimeSeriesCache || null,
          lastUpdated: user.attributionVotingCacheUpdatedAt?.toISOString(),
        };
      },
      CACHE_TTL.USER_STATS
    );
  }

  private async getUserTagPreferences(userId: number) {
    return this.prisma.userTagPreference.findMany({
      where: { userId },
      orderBy: { totalVotes: 'desc' },
      take: 10,
    });
  }

  private formatUserDetail(user: any): UserDetailDTO {
    return {
      id: user.id,
      displayName: user.displayName,
      wikidotId: user.wikidotId,
      firstActivityAt: user.firstActivityAt?.toISOString(),
      lastActivityAt: user.lastActivityAt?.toISOString(),
      stats: user.UserStats ? {
        totalUp: user.UserStats.totalUp,
        totalDown: user.UserStats.totalDown,
        totalRating: user.UserStats.totalRating,
        pageCount: user.UserStats.pageCount,
        overallRating: user.UserStats.overallRating ? parseFloat(user.UserStats.overallRating.toString()) : null,
        overallRank: user.UserStats.overallRank,
        scpPageCount: user.UserStats.scpPageCount,
        scpRating: user.UserStats.scpRating ? parseFloat(user.UserStats.scpRating.toString()) : null,
        scpRank: user.UserStats.scpRank,
        goiPageCount: user.UserStats.goiPageCount,
        goiRating: user.UserStats.goiRating ? parseFloat(user.UserStats.goiRating.toString()) : null,
        goiRank: user.UserStats.goiRank,
        storyPageCount: user.UserStats.storyPageCount,
        storyRating: user.UserStats.storyRating ? parseFloat(user.UserStats.storyRating.toString()) : null,
        storyRank: user.UserStats.storyRank,
        translationPageCount: user.UserStats.translationPageCount,
        translationRating: user.UserStats.translationRating ? parseFloat(user.UserStats.translationRating.toString()) : null,
        translationRank: user.UserStats.translationRank,
        artPageCount: user.UserStats.artPageCount,
        artRating: user.UserStats.artRating ? parseFloat(user.UserStats.artRating.toString()) : null,
        artRank: user.UserStats.artRank,
        wanderersPageCount: user.UserStats.wanderersPageCount,
        wanderersRating: user.UserStats.wanderersRating ? parseFloat(user.UserStats.wanderersRating.toString()) : null,
        wanderersRank: user.UserStats.wanderersRank,
        favTag: user.UserStats.favTag,
        ratingUpdatedAt: user.UserStats.ratingUpdatedAt?.toISOString(),
      } : undefined,
      contributionCount: user.Attribution ? user.Attribution.length : undefined,
    };
  }
}