import type { Context } from '../types/context.js'

// Decimal/Float conversion utility
const toNum = (v: any) => v == null ? null : Number(v)

export const interestingStatsResolvers = {
  Query: {
    // 获取综合统计信息集合
    interestingStats: async (_: any, args: {
      category?: string;
      type?: string;
      limit?: number;
    }, { prisma, redis, logger }: Context) => {
      const { category, type, limit = 10 } = args;
      
      // 构建缓存键
      const cacheKey = `interesting-stats:${JSON.stringify({category, type, limit})}`
      
      // 尝试从缓存获取
      if (redis) {
        try {
          const cached = await redis.get(cacheKey)
          if (cached) {
            return JSON.parse(cached)
          }
        } catch (error) {
          logger.warn({ error }, 'Interesting stats cache get failed')
        }
      }

      const [
        facts,
        timeMilestones,
        tagRecords,
        contentRecords,
        ratingRecords,
        userActivityRecords,
        trendingStats
      ] = await Promise.all([
        // 获取有趣事实
        prisma.interestingFacts.findMany({
          where: {
            ...(category && { category }),
            ...(type && { type }),
            isActive: true
          },
          include: {
            page: {
              include: {
                versions: {
                  where: { validTo: null },
                  take: 1
                }
              }
            },
            user: true
          },
          take: limit,
          orderBy: { calculatedAt: 'desc' }
        }),

        // 获取时间里程碑
        prisma.timeMilestones.findMany({
          include: {
            page: {
              include: {
                versions: {
                  where: { validTo: null },
                  take: 1
                }
              }
            }
          },
          take: limit,
          orderBy: { calculatedAt: 'desc' }
        }),

        // 获取标签记录
        prisma.tagRecords.findMany({
          include: {
            page: {
              include: {
                versions: {
                  where: { validTo: null },
                  take: 1
                }
              }
            },
            user: true
          },
          take: limit,
          orderBy: { calculatedAt: 'desc' }
        }),

        // 获取内容记录
        prisma.contentRecords.findMany({
          include: {
            page: {
              include: {
                versions: {
                  where: { validTo: null },
                  take: 1
                }
              }
            }
          },
          take: limit,
          orderBy: { calculatedAt: 'desc' }
        }),

        // 获取评分记录
        prisma.ratingRecords.findMany({
          include: {
            page: {
              include: {
                versions: {
                  where: { validTo: null },
                  take: 1
                }
              }
            }
          },
          take: limit,
          orderBy: { calculatedAt: 'desc' }
        }),

        // 获取用户活动记录
        prisma.userActivityRecords.findMany({
          include: {
            user: true
          },
          take: limit,
          orderBy: { calculatedAt: 'desc' }
        }),

        // 获取热点统计
        prisma.trendingStats.findMany({
          take: limit,
          orderBy: { score: 'desc' }
        })
      ]);

      const result = {
        facts,
        timeMilestones,
        tagRecords,
        contentRecords,
        ratingRecords,
        userActivityRecords,
        trendingStats
      };
      
      // 缓存结果
      if (redis) {
        try {
          await redis.setex(cacheKey, 600, JSON.stringify(result)) // 10分钟缓存
        } catch (error) {
          logger.warn({ error }, 'Interesting stats cache set failed')
        }
      }
      
      return result;
    },

    // 具体查询各类统计信息
    interestingFacts: async (_: any, args: {
      category?: string;
      type?: string;
      tagContext?: string;
      limit?: number;
    }, { prisma, redis, logger }: Context) => {
      const { category, type, tagContext, limit = 20 } = args;
      
      // 构建缓存键
      const cacheKey = `interesting-facts:${JSON.stringify({category, type, tagContext, limit})}`
      
      // 尝试从缓存获取
      if (redis) {
        try {
          const cached = await redis.get(cacheKey)
          if (cached) {
            return JSON.parse(cached)
          }
        } catch (error) {
          logger.warn({ error }, 'Interesting facts cache get failed')
        }
      }

      const result = await prisma.interestingFacts.findMany({
        where: {
          ...(category && { category }),
          ...(type && { type }),
          ...(tagContext && { tagContext }),
          isActive: true
        },
        include: {
          page: {
            include: {
              versions: {
                where: { validTo: null },
                take: 1
              }
            }
          },
          user: true
        },
        take: limit,
        orderBy: [
          { rank: 'asc' },
          { calculatedAt: 'desc' }
        ]
      });
      
      // 缓存结果
      if (redis) {
        try {
          await redis.setex(cacheKey, 900, JSON.stringify(result)) // 15分钟缓存
        } catch (error) {
          logger.warn({ error }, 'Interesting facts cache set failed')
        }
      }
      
      return result;
    },

    timeMilestones: async (_: any, args: {
      period?: string;
      milestoneType?: string;
      limit?: number;
    }, { prisma }: Context) => {
      const { period, milestoneType, limit = 20 } = args;

      return await prisma.timeMilestones.findMany({
        where: {
          ...(period && { period }),
          ...(milestoneType && { milestoneType })
        },
        include: {
          page: {
            include: {
              versions: {
                where: { validTo: null },
                take: 1
              }
            }
          }
        },
        take: limit,
        orderBy: { periodValue: 'desc' }
      });
    },

    tagRecords: async (_: any, args: {
      tag?: string;
      recordType?: string;
      limit?: number;
    }, { prisma }: Context) => {
      const { tag, recordType, limit = 20 } = args;

      return await prisma.tagRecords.findMany({
        where: {
          ...(tag && { tag }),
          ...(recordType && { recordType })
        },
        include: {
          page: {
            include: {
              versions: {
                where: { validTo: null },
                take: 1
              }
            }
          },
          user: true
        },
        take: limit,
        orderBy: [
          { value: 'desc' },
          { calculatedAt: 'desc' }
        ]
      });
    },

    contentRecords: async (_: any, args: {
      recordType?: string;
      limit?: number;
    }, { prisma }: Context) => {
      const { recordType, limit = 10 } = args;

      return await prisma.contentRecords.findMany({
        where: {
          ...(recordType && { recordType })
        },
        include: {
          page: {
            include: {
              versions: {
                where: { validTo: null },
                take: 1
              }
            }
          }
        },
        take: limit,
        orderBy: [
          { sourceLength: 'desc' },
          { contentLength: 'desc' }
        ]
      });
    },

    ratingRecords: async (_: any, args: {
      recordType?: string;
      timeframe?: string;
      limit?: number;
    }, { prisma }: Context) => {
      const { recordType, timeframe, limit = 10 } = args;

      return await prisma.ratingRecords.findMany({
        where: {
          ...(recordType && { recordType }),
          ...(timeframe && { timeframe })
        },
        include: {
          page: {
            include: {
              versions: {
                where: { validTo: null },
                take: 1
              }
            }
          }
        },
        take: limit,
        orderBy: [
          { value: 'desc' },
          { calculatedAt: 'desc' }
        ]
      });
    },

    userActivityRecords: async (_: any, args: {
      recordType?: string;
      limit?: number;
    }, { prisma }: Context) => {
      const { recordType, limit = 10 } = args;

      return await prisma.userActivityRecords.findMany({
        where: {
          ...(recordType && { recordType })
        },
        include: {
          user: true
        },
        take: limit,
        orderBy: [
          { value: 'desc' },
          { achievedAt: 'asc' }
        ]
      });
    },

    trendingStats: async (_: any, args: {
      statType?: string;
      period?: string;
      limit?: number;
    }, { prisma }: Context) => {
      const { statType, period, limit = 10 } = args;

      return await prisma.trendingStats.findMany({
        where: {
          ...(statType && { statType }),
          ...(period && { period })
        },
        take: limit,
        orderBy: { score: 'desc' }
      });
    },

    // 每日小知识（从有趣事实中随机选择一些简短的）
    dailyTrivia: async (_: any, __: any, { prisma, redis, logger }: Context) => {
      const cacheKey = 'daily-trivia'
      
      // 尝试从缓存获取
      if (redis) {
        try {
          const cached = await redis.get(cacheKey)
          if (cached) {
            return JSON.parse(cached)
          }
        } catch (error) {
          logger.warn({ error }, 'Daily trivia cache get failed')
        }
      }
      
      const facts = await prisma.interestingFacts.findMany({
        where: {
          isActive: true
        },
        include: {
          page: {
            include: {
              versions: {
                where: { validTo: null },
                take: 1
              }
            }
          },
          user: true
        },
        take: 50,
        orderBy: { calculatedAt: 'desc' }
      });

      // 随机选择并格式化为简短的一句话知识
      const shuffled = facts.sort(() => 0.5 - Math.random());
      const selected = shuffled.slice(0, 5);

      const result = selected.map(fact => {
        let trivia = fact.title;
        if (fact.description) {
          trivia = fact.description;
        }
        
        // 添加一些上下文信息
        if (fact.tagContext) {
          trivia += ` (#${fact.tagContext})`;
        }
        
        if (fact.dateContext) {
          const year = new Date(fact.dateContext).getFullYear();
          trivia += ` (${year}年)`;
        }

        return trivia;
      });
      
      // 缓存结果（4小时缓存，因为是"每日"内容）
      if (redis) {
        try {
          await redis.setex(cacheKey, 14400, JSON.stringify(result))
        } catch (error) {
          logger.warn({ error }, 'Daily trivia cache set failed')
        }
      }
      
      return result;
    }
  },

  // 嵌套字段解析器
  InterestingFact: {
    metadata: (parent: any) => parent.metadata ? JSON.stringify(parent.metadata) : null,
    page: (parent: any) => {
      if (!parent.page) return null;
      return {
        ...parent.page,
        currentVersion: parent.page.versions?.[0] || null
      };
    }
  },

  TagRecord: {
    value: (p: any) => toNum(p.value),
    metadata: (parent: any) => parent.metadata ? JSON.stringify(parent.metadata) : null,
    page: (parent: any) => {
      if (!parent.page) return null;
      return {
        ...parent.page,
        currentVersion: parent.page.versions?.[0] || null
      };
    }
  },

  ContentRecord: {
    complexity: (parent: any) => parent.complexity ? JSON.stringify(parent.complexity) : null,
    page: (parent: any) => ({
      ...parent.page,
      currentVersion: parent.page.versions?.[0] || null
    })
  },

  RatingRecord: {
    value: (p: any) => toNum(p.value),
    wilson95: (p: any) => toNum(p.wilson95),
    controversy: (p: any) => toNum(p.controversy),
    page: (parent: any) => ({
      ...parent.page,
      currentVersion: parent.page.versions?.[0] || null
    })
  },

  TimeMilestone: {
    page: (parent: any) => ({
      ...parent.page,
      currentVersion: parent.page.versions?.[0] || null
    })
  },

  UserActivityRecord: {
    value: (p: any) => toNum(p.value),
    context: (parent: any) => parent.context ? JSON.stringify(parent.context) : null
  },

  TrendingStat: {
    score: (p: any) => toNum(p.score),
    metadata: (parent: any) => parent.metadata ? JSON.stringify(parent.metadata) : null
  }
};