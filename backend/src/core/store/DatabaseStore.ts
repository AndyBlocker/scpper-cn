import { PrismaClient } from '@prisma/client';
import { Logger } from '../../utils/Logger.js';
import { MAX_FIRST } from '../../config/RateLimitConfig.js';

export class DatabaseStore {
  private prisma: PrismaClient;

  constructor() {
    this.prisma = new PrismaClient();
  }

  async loadProgress(phase = 'phase1') {
    switch (phase) {
      case 'phase1':
        return await this.prisma.page.findMany({
          include: {
            versions: {
              orderBy: { validFrom: 'desc' },
              take: 1,
            },
          },
        });
      case 'phase2':
        return await this.prisma.pageVersion.findMany({
          where: {
            validTo: null,
            textContent: { not: null },
          },
        });
      case 'phase3':
        return await this.prisma.pageVersion.findMany({
          where: {
            validTo: null,
          },
          include: {
            revisions: true,
            votes: true,
          },
        });
      default:
        return [];
    }
  }

  async append(phase: string, obj: any) {
    switch (phase) {
      case 'phase1':
        await this.upsertPageBasicInfo(obj);
        break;
      case 'phase2':
        await this.upsertPageContent(obj);
        break;
      case 'phase3':
        await this.upsertPageDetails(obj);
        break;
    }
  }

  private async upsertPageBasicInfo(data: any) {
    const urlKey = this.extractUrlKey(data.url);
    
    const page = await this.prisma.page.upsert({
      where: { url: data.url },
      update: { urlKey },
      create: {
        url: data.url,
        urlKey,
      },
    });

    const existingVersion = await this.prisma.pageVersion.findFirst({
      where: {
        pageId: page.id,
        validTo: null,
      },
    });

    if (this.needsNewVersion(existingVersion, data)) {
      if (existingVersion) {
        await this.prisma.pageVersion.update({
          where: { id: existingVersion.id },
          data: { validTo: new Date() },
        });
      }

      await this.prisma.pageVersion.create({
        data: {
          pageId: page.id,
          wikidotId: data.wikidotId,
          title: data.title,
          rating: data.rating,
          voteCount: data.voteCount,
          revisionCount: data.revisionCount,
          tags: data.tags || [],
          validFrom: new Date(),
          isDeleted: data.isDeleted || false,
        },
      });
    } else if (existingVersion) {
      await this.prisma.pageVersion.update({
        where: { id: existingVersion.id },
        data: {
          rating: data.rating,
          voteCount: data.voteCount,
          revisionCount: data.revisionCount,
          title: data.title,
          tags: data.tags || [],
        },
      });
    }
  }

  async upsertPageContent(data: any) {
    Logger.debug(`📋 upsertPageContent called for: ${data?.url}`);
    
    if (!data || !data.url) {
      Logger.error(`❌ Invalid data passed to upsertPageContent:`, data);
      throw new Error('Invalid data: missing url');
    }
    
    const page = await this.prisma.page.findUnique({
      where: { url: data.url },
    });

    if (!page) {
      Logger.error(`❌ Page not found for URL: ${data.url}`);
      return;
    }
    
    Logger.debug(`📄 Found page ${page.id} for URL: ${data.url}`);

    const currentVersion = await this.prisma.pageVersion.findFirst({
      where: {
        pageId: page.id,
        validTo: null,
      },
    });

    if (!currentVersion) {
      Logger.error(`❌ No current version found for page ${page.id} (${data.url})`);
      return;
    }
    
    Logger.debug(`📑 Found current version ${currentVersion.id} for page ${page.id}`);
    
    // Get PhaseA data from staging table to update basic fields that PhaseB should maintain
    const stagingData = await this.prisma.pageMetaStaging.findUnique({
      where: { url: data.url }
    });
    
    Logger.debug(`📋 Data structure:`, {
      hasTextContent: !!data.textContent,
      hasSource: !!data.source,
      attributionsCount: data.attributions?.length || 0,
      revisionsCount: data.revisions?.length || 0,
      fuzzyVoteRecordsCount: data.fuzzyVoteRecords?.length || 0,
      hasStagingData: !!stagingData,
      stagingTitle: stagingData?.title,
      stagingRating: stagingData?.rating
    });

    // Update text content, source, AND PhaseA basic data (fix the missing data problem)
    const updateData: any = {
      textContent: data.textContent,
      source: data.source,
    };

    // Include PhaseA data from staging if available (fix for title=null issue)
    if (stagingData) {
      // Only update if staging has non-null values
      if (stagingData.title !== null && stagingData.title !== 'null') {
        updateData.title = stagingData.title;
      }
      if (stagingData.rating !== null) {
        updateData.rating = stagingData.rating;
      }
      if (stagingData.voteCount !== null) {
        updateData.voteCount = stagingData.voteCount;
      }
      if (stagingData.revisionCount !== null) {
        updateData.revisionCount = stagingData.revisionCount;
      }
      if (stagingData.tags && stagingData.tags.length > 0) {
        updateData.tags = stagingData.tags;
      }
      
      Logger.debug(`📋 Updating PageVersion with staging data:`, {
        title: updateData.title ? 'updated' : 'skipped',
        rating: updateData.rating !== undefined ? 'updated' : 'skipped',
        voteCount: updateData.voteCount !== undefined ? 'updated' : 'skipped',
        revisionCount: updateData.revisionCount !== undefined ? 'updated' : 'skipped',
        tags: updateData.tags ? 'updated' : 'skipped'
      });
    }

    await this.prisma.pageVersion.update({
      where: { id: currentVersion.id },
      data: updateData,
    });

    // === 1. Process Attributions (修复版) ===
    if (data.attributions && Array.isArray(data.attributions)) {
      Logger.debug(`📋 Processing ${data.attributions.length} attributions`);
      
      for (let i = 0; i < data.attributions.length; i++) {
        const attr = data.attributions[i];
        
        try {
          // 解析复杂的 user 结构
          let userData = null;
          if (attr.user) {
            // 处理嵌套的 wikidotUser 结构
            if (attr.user.wikidotUser) {
              userData = attr.user.wikidotUser;
            } else if (attr.user.displayName || attr.user.wikidotId) {
              userData = attr.user;
            } else if (typeof attr.user === 'string') {
              // 有时候 user 可能只是一个字符串
              userData = { displayName: attr.user };
            }
          }
          
          const userId = userData ? await this.upsertUser(userData) : null;
          const orderValue = attr.order ?? i; // 使用索引作为默认 order
          
          Logger.debug(`📋 Attribution ${i}: type=${attr.type}, order=${orderValue}, userId=${userId}`);
          
          if (userId) {
            // 先尝试查找现有记录
            const existing = await this.prisma.attribution.findFirst({
              where: {
                pageVerId: currentVersion.id,
                type: attr.type || 'unknown',
                order: orderValue,
                userId: userId,
              },
            });
            
            if (existing) {
              // 更新现有记录
              await this.prisma.attribution.update({
                where: { id: existing.id },
                data: { 
                  date: attr.date ? new Date(attr.date) : null 
                },
              });
            } else {
              // 创建新记录
              await this.prisma.attribution.create({
                data: {
                  pageVerId: currentVersion.id,
                  type: attr.type || 'unknown',
                  order: orderValue,
                  date: attr.date ? new Date(attr.date) : null,
                  userId,
                },
              });
            }
          } else {
            // 匿名 attribution
            const anonKey = `anon_${attr.type || 'unknown'}_${orderValue}_${currentVersion.id}`;
            
            const existing = await this.prisma.attribution.findFirst({
              where: {
                pageVerId: currentVersion.id,
                type: attr.type || 'unknown',
                order: orderValue,
                anonKey: anonKey,
              },
            });
            
            if (existing) {
              await this.prisma.attribution.update({
                where: { id: existing.id },
                data: { 
                  date: attr.date ? new Date(attr.date) : null 
                },
              });
            } else {
              await this.prisma.attribution.create({
                data: {
                  pageVerId: currentVersion.id,
                  type: attr.type || 'unknown',
                  order: orderValue,
                  date: attr.date ? new Date(attr.date) : null,
                  anonKey,
                  userId: null,
                },
              });
            }
          }
          
          Logger.debug(`✅ Processed attribution: type=${attr.type}, order=${orderValue}`);
        } catch (error) {
          Logger.error(`❌ Failed to process attribution ${i}:`, {
            message: error.message,
            code: error.code,
            attribution: attr,
            stack: error.stack?.split('\n').slice(0, 3).join('\n')
          });
        }
      }
    }

    // === 2. Process Revisions & Votes (lightweight version) ===
    await this._importVotesAndRevs(currentVersion.id, data);
  }

  async upsertPageDetails(data: any) {
    Logger.debug(`📋 upsertPageDetails called for: ${data?.url}`);
    
    if (!data || !data.url) {
      Logger.error(`❌ Invalid data passed to upsertPageDetails:`, data);
      throw new Error('Invalid data: missing url');
    }
    
    const page = await this.prisma.page.findUnique({
      where: { url: data.url },
    });

    if (!page) {
      Logger.error(`❌ Page not found for URL: ${data.url}`);
      return;
    }
    
    Logger.debug(`📄 Found page ${page.id} for URL: ${data.url}`);

    const currentVersion = await this.prisma.pageVersion.findFirst({
      where: {
        pageId: page.id,
        validTo: null,
      },
    });

    if (!currentVersion) {
      Logger.error(`❌ No current version found for page ${page.id} (${data.url})`);
      return;
    }
    
    Logger.debug(`📑 Found current version ${currentVersion.id} for page ${page.id}`);
    
    Logger.debug(`📋 Data structure:`, {
      revisionsCount: data.revisions?.length || 0,
      votesCount: data.votes?.length || 0
    });

    if (data.revisions) {
      Logger.debug(`📝 Processing ${data.revisions.length} revisions...`);
      for (const revision of data.revisions) {
        const userId = revision.user ? await this.upsertUser(revision.user) : null;
        const wikidotIdInt = revision.wikidotId ? parseInt(revision.wikidotId.toString()) : null;
        
        if (!wikidotIdInt) {
          Logger.warn(`⚠️ Invalid wikidotId for revision: ${JSON.stringify(revision)}`);
          continue;
        }
        
        try {
          await this.prisma.revision.upsert({
            where: {
              pageVersionId_wikidotId: {
                pageVersionId: currentVersion.id,
                wikidotId: wikidotIdInt,
              },
            },
            update: {
              timestamp: new Date(revision.timestamp),
              type: revision.type || 'unknown',  // Provide default for null type
              comment: revision.comment,
              userId,
            },
            create: {
              pageVersionId: currentVersion.id,
              wikidotId: wikidotIdInt,
              timestamp: new Date(revision.timestamp),
              type: revision.type || 'unknown',  // Provide default for null type
              comment: revision.comment,
              userId,
            },
          });
          Logger.debug(`✅ Processed revision ${wikidotIdInt}`);
        } catch (error) {
          Logger.error(`❌ Failed to process revision ${wikidotIdInt}:`, {
            message: error.message,
            code: error.code,
            name: error.name,
            revision: {
              wikidotId: wikidotIdInt,
              timestamp: revision.timestamp,
              type: revision.type,
              hasUser: !!revision.user,
              userDisplayName: revision.user?.displayName || 'N/A',
              userId: userId
            }
          });
        }
      }
    }

    if (data.votes) {
      Logger.debug(`📝 Processing ${data.votes.length} votes...`);
      for (const vote of data.votes) {
        const userId = vote.user ? await this.upsertUser(vote.user) : null;
        
        // Generate anonKey for anonymous votes (including deleted users)
        const anonKey = !userId ? `anon_${vote.userWikidotId || Date.parse(vote.timestamp) || 'unknown'}` : null;
        
        // Convert direction to integer
        const direction = typeof vote.direction === 'string'
          ? parseInt(vote.direction) : vote.direction;
        
        try {
          if (userId) {
            // For authenticated votes, use the original constraint
            await this.prisma.vote.upsert({
              where: {
                Vote_unique_constraint: {
                  pageVersionId: currentVersion.id,
                  userId,
                  timestamp: new Date(vote.timestamp),
                },
              },
              update: {
                direction,
              },
              create: {
                pageVersionId: currentVersion.id,
                timestamp: new Date(vote.timestamp),
                direction,
                userId,
              },
            });
          } else {
            // For anonymous votes (including deleted users), use the anonKey constraint
            await this.prisma.vote.upsert({
              where: {
                Vote_anon_unique_constraint: {
                  pageVersionId: currentVersion.id,
                  anonKey,
                  timestamp: new Date(vote.timestamp),
                },
              },
              update: {
                direction,
              },
              create: {
                pageVersionId: currentVersion.id,
                timestamp: new Date(vote.timestamp),
                direction,
                anonKey,
                userId: null,
              },
            });
          }
          Logger.debug(`✅ Processed vote: direction=${direction}, userId=${userId || 'anonymous'}, anonKey=${anonKey || 'N/A'}`);
        } catch (error) {
          // More detailed error handling for vote conflicts
          if (error.code === 'P2002') {
            Logger.warn(`⚠️ Vote already exists, skipping: pageVersionId=${currentVersion.id}, userId=${userId}, anonKey=${anonKey}, timestamp=${vote.timestamp}`);
          } else {
            Logger.error(`❌ Failed to upsert vote for page ${currentVersion.id}:`, {
              error: error.message,
              vote: {
                direction,
                timestamp: vote.timestamp,
                userId,
                anonKey,
                userWikidotId: vote.userWikidotId,
                userDisplayName: vote.user?.displayName || 'unknown'
              }
            });
          }
          continue;
        }
      }
    }
  }

  private extractUrlKey(url: string): string {
    const match = url.match(/\/([^\/]+)$/);
    return match ? match[1] : url;
  }

  private async upsertUser(userData: any): Promise<number | null> {
    if (!userData) return null;
    
    // Convert wikidotId from string to integer
    const wikidotId = userData.wikidotId || userData.id;
    const wikidotIdInt = wikidotId ? parseInt(wikidotId.toString()) : null;
    const displayName = userData.displayName || userData.name;
    
    // Case 1: Valid wikidotId - normal user processing
    if (wikidotIdInt && !isNaN(wikidotIdInt)) {
      try {
        const user = await this.prisma.user.upsert({
          where: { wikidotId: wikidotIdInt },
          update: {
            displayName: displayName,
          },
          create: {
            wikidotId: wikidotIdInt,
            displayName: displayName,
          },
        });
        
        return user.id;
      } catch (error) {
        Logger.error(`❌ Failed to upsert user with wikidotId ${wikidotIdInt}:`, error.message);
        return null;
      }
    }
    
    // Case 2: No wikidotId but has displayName - deleted user with name
    if (displayName && displayName.trim() !== '') {
      // Skip obvious placeholder names
      if (displayName.includes('deleted') || displayName.includes('unknown') || displayName === '(unknown user)') {
        Logger.debug(`🗑️ Skipping placeholder user: ${displayName}`);
        return null;
      }
      
      try {
        // Try to find existing user with same displayName but no wikidotId
        const existingUser = await this.prisma.user.findFirst({
          where: {
            displayName: displayName,
            wikidotId: null,
          },
        });
        
        if (existingUser) {
          Logger.debug(`👤 Found existing deleted user: ${displayName} (ID: ${existingUser.id})`);
          return existingUser.id;
        }
        
        // Create new user record for deleted user with displayName only
        const newUser = await this.prisma.user.create({
          data: {
            wikidotId: null,
            displayName: displayName,
          },
        });
        
        Logger.info(`👤 Created user record for deleted user: ${displayName} (ID: ${newUser.id})`);
        return newUser.id;
        
      } catch (error) {
        Logger.error(`❌ Failed to create deleted user record for ${displayName}:`, error.message);
        return null;
      }
    }
    
    // Case 3: No useful information - truly anonymous
    Logger.debug(`🤷 No valid user information found: ${JSON.stringify(userData)}`);
    return null;
  }

  private async _importVotesAndRevs(pageVersionId: number, data: any) {
    // Process revisions (limit to first MAX_FIRST)
    if (data.revisions) {
      // Handle both edges format and direct array format
      let revisionsToProcess;
      if (data.revisions.edges) {
        revisionsToProcess = data.revisions.edges.slice(0, MAX_FIRST).map(edge => edge.node);
      } else if (Array.isArray(data.revisions)) {
        revisionsToProcess = data.revisions.slice(0, MAX_FIRST);
      } else {
        revisionsToProcess = [];
      }
      
      for (const revision of revisionsToProcess) {
        const userId = revision.user ? await this.upsertUser(revision.user) : null;
        const wikidotIdInt = revision.wikidotId ? parseInt(revision.wikidotId.toString()) : null;
        
        if (!wikidotIdInt) {
          Logger.warn(`⚠️ Invalid wikidotId for revision: ${JSON.stringify(revision)}`);
          continue;
        }
        
        try {
          await this.prisma.revision.upsert({
            where: {
              pageVersionId_wikidotId: {
                pageVersionId,
                wikidotId: wikidotIdInt,
              },
            },
            update: {
              timestamp: new Date(revision.timestamp),
              type: revision.type || 'unknown',  // Provide default for null type
              comment: revision.comment,
              userId,
            },
            create: {
              pageVersionId,
              wikidotId: wikidotIdInt,
              timestamp: new Date(revision.timestamp),
              type: revision.type || 'unknown',  // Provide default for null type
              comment: revision.comment,
              userId,
            },
          });
          Logger.debug(`✅ Processed revision ${wikidotIdInt}`);
        } catch (error) {
          Logger.error(`❌ Failed to process revision ${wikidotIdInt}:`, {
            message: error.message,
            code: error.code,
            name: error.name,
            revision: {
              wikidotId: wikidotIdInt,
              timestamp: revision.timestamp,
              type: revision.type,
              hasUser: !!revision.user,
              userDisplayName: revision.user?.displayName || 'N/A',
              userId: userId
            }
          });
          // Continue processing other revisions even if one fails
          continue;
        }
      }
    }

    // Process votes (limit to first MAX_FIRST)
    if (data.fuzzyVoteRecords) {
      // Handle both edges format and direct array format
      let votesToProcess;
      if (data.fuzzyVoteRecords.edges) {
        votesToProcess = data.fuzzyVoteRecords.edges.slice(0, MAX_FIRST).map(edge => edge.node);
      } else if (Array.isArray(data.fuzzyVoteRecords)) {
        votesToProcess = data.fuzzyVoteRecords.slice(0, MAX_FIRST);
      } else {
        votesToProcess = [];
      }
      
      for (const vote of votesToProcess) {
        const userId = vote.user ? await this.upsertUser(vote.user) : null;
        
        // Generate anonKey for anonymous votes (including deleted users)
        const anonKey = !userId ? `anon_${vote.userWikidotId || Date.parse(vote.timestamp) || 'unknown'}` : null;
        
        // Convert direction to integer
        const direction = typeof vote.direction === 'string'
          ? parseInt(vote.direction) : vote.direction;
        
        try {
          if (userId) {
            // For authenticated votes, use the original constraint
            await this.prisma.vote.upsert({
              where: {
                Vote_unique_constraint: {
                  pageVersionId,
                  userId,
                  timestamp: new Date(vote.timestamp),
                },
              },
              update: {
                direction,
              },
              create: {
                pageVersionId,
                timestamp: new Date(vote.timestamp),
                direction,
                userId,
              },
            });
          } else {
            // For anonymous votes (including deleted users), use the anonKey constraint
            await this.prisma.vote.upsert({
              where: {
                Vote_anon_unique_constraint: {
                  pageVersionId,
                  anonKey,
                  timestamp: new Date(vote.timestamp),
                },
              },
              update: {
                direction,
              },
              create: {
                pageVersionId,
                timestamp: new Date(vote.timestamp),
                direction,
                anonKey,
                userId: null,
              },
            });
          }
          Logger.debug(`✅ Processed vote: direction=${direction}, userId=${userId || 'anonymous'}, anonKey=${anonKey || 'N/A'}`);
        } catch (error) {
          Logger.warn(`⚠️ Failed to upsert vote: ${error.message}`, {
            pageVersionId,
            userId,
            anonKey,
            direction,
            timestamp: vote.timestamp,
            userDisplayName: vote.user?.displayName || 'unknown'
          });
        }
      }
    }
  }

  private needsNewVersion(existingVersion: any, newData: any): boolean {
    if (!existingVersion) return true;
    
    return (
      existingVersion.wikidotId !== newData.wikidotId ||
      existingVersion.title !== newData.title ||
      (existingVersion.isDeleted !== (newData.isDeleted || false))
    );
  }

  /**
   * 将指定页面标记为已删除（物理删除或彻底隐藏）。
   * 逻辑：终结当前有效版本 → 写入一个仅含 isDeleted=true 的新版本。
   * 修复：避免为已经删除的页面创建重复的deleted版本。
   */
  async markPageDeleted(pageId: number): Promise<void> {
    const now = new Date();

    // 1) 检查当前有效版本是否已经是deleted状态
    const currentVersion = await this.prisma.pageVersion.findFirst({
      where: { pageId, validTo: null },
      select: { id: true, isDeleted: true }
    });

    // 如果当前版本已经是deleted状态，跳过操作
    if (currentVersion?.isDeleted) {
      Logger.debug(`⚠️  Page ${pageId} is already marked as deleted, skipping duplicate deletion`);
      return;
    }

    // 2) 终结现行版本
    await this.prisma.pageVersion.updateMany({
      where: { pageId, validTo: null },
      data: { validTo: now }
    });

    // 3) 写入删除标记版本
    await this.prisma.pageVersion.create({
      data: {
        pageId,
        validFrom: now,
        isDeleted: true
      }
    });
  }

  // New methods for improved incremental sync architecture
  
  async upsertPageMetaStaging(meta: {
    url: string;
    wikidotId?: number;
    title?: string;
    rating?: number;
    voteCount?: number;
    revisionCount?: number;
    tags?: string[];
    isDeleted?: boolean;
    estimatedCost?: number;
    category?: string;
    parentUrl?: string;
    childCount?: number;
    attributionCount?: number;
    voteUp?: number;
    voteDown?: number;
  }) {
    await this.prisma.pageMetaStaging.upsert({
      where: { url: meta.url },
      update: {
        wikidotId: meta.wikidotId,
        title: meta.title,
        rating: meta.rating,
        voteCount: meta.voteCount,
        revisionCount: meta.revisionCount,
        tags: meta.tags || [],
        isDeleted: meta.isDeleted || false,
        estimatedCost: meta.estimatedCost,
        category: meta.category,
        parentUrl: meta.parentUrl,
        childCount: meta.childCount,
        attributionCount: meta.attributionCount,
        voteUp: meta.voteUp,
        voteDown: meta.voteDown,
        lastSeenAt: new Date(),
      },
      create: {
        url: meta.url,
        wikidotId: meta.wikidotId,
        title: meta.title,
        rating: meta.rating,
        voteCount: meta.voteCount,
        revisionCount: meta.revisionCount,
        tags: meta.tags || [],
        isDeleted: meta.isDeleted || false,
        estimatedCost: meta.estimatedCost,
        category: meta.category,
        parentUrl: meta.parentUrl,
        childCount: meta.childCount,
        attributionCount: meta.attributionCount,
        voteUp: meta.voteUp,
        voteDown: meta.voteDown,
        lastSeenAt: new Date(),
      },
    });
  }

  async buildDirtyQueue() {
    console.log('🔍 Building dirty page queue...');
    
    // First, detect deleted pages (in DB but not in staging)
    const deletedPages = await this.prisma.$queryRaw<Array<{pageId: number, url: string}>>`
      SELECT p.id as "pageId", p.url
      FROM "Page" p
      WHERE p.url NOT IN (SELECT url FROM "PageMetaStaging")
      AND EXISTS (SELECT 1 FROM "PageVersion" pv WHERE pv."pageId" = p.id AND pv."validTo" IS NULL)
    `;
    
    console.log(`Found ${deletedPages.length} deleted pages`);
    
    // Mark deleted pages
    for (const deletedPage of deletedPages) {
      // Mark current version as expired
      await this.prisma.pageVersion.updateMany({
        where: {
          pageId: deletedPage.pageId,
          validTo: null,
        },
        data: {
          validTo: new Date(),
        },
      });
      
      // Create new version marked as deleted
      await this.prisma.pageVersion.create({
        data: {
          pageId: deletedPage.pageId,
          validFrom: new Date(),
          isDeleted: true,
        },
      });
      
      console.log(`Marked page as deleted: ${deletedPage.url}`);
    }
    
    // Clear existing dirty queue
    await this.prisma.dirtyPage.deleteMany({});
    
    // Build dirty queue with change detection
    const dirtyPages = await this.prisma.$queryRaw<Array<{
      pageId: number;
      url: string;
      needPhaseB: boolean;
      needPhaseC: boolean;
      reasons: string[];
    }>>`
      SELECT 
        p.id as "pageId",
        p.url,
        -- Only check fields that PhaseA actually obtained and are meaningful for dirty detection
        CASE WHEN 
          -- Basic metadata changes (PhaseA always gets these)
          s.title IS DISTINCT FROM v.title OR
          s.tags IS DISTINCT FROM v.tags OR
          s."isDeleted" IS DISTINCT FROM v."isDeleted" OR
          -- Rating changes (with special handling for fragment/component pages)
          (s.rating IS DISTINCT FROM v.rating AND NOT 
           (s.url LIKE '%fragment:%' AND s.rating IS NULL AND (v.rating IS NULL OR v.rating = 0)) AND NOT
           (s.url LIKE '%component:%' AND s.rating IS NULL AND (v.rating IS NULL OR v.rating = 0))) OR
          -- Vote count changes (with special handling for fragment/component pages) 
          (s."voteCount" IS DISTINCT FROM v."voteCount" AND NOT 
           (s.url LIKE '%fragment:%' AND s."voteCount" IS NULL AND v."voteCount" = 0) AND NOT
           (s.url LIKE '%component:%' AND s."voteCount" IS NULL AND v."voteCount" = 0)) OR
          -- Revision count changes (PhaseA gets this from API)
          s."revisionCount" IS DISTINCT FROM v."revisionCount" OR
          -- Attribution count changes (PhaseA calculates this from API data)
          s."attributionCount" IS DISTINCT FROM (SELECT COUNT(*) FROM "Attribution" a WHERE a."pageVerId" = v.id) OR
          -- New pages (not in database yet)
          v.id IS NULL
        THEN TRUE ELSE FALSE END as "needPhaseB",
        
        -- Phase C determination is now handled by Phase B, so default to false
        FALSE as "needPhaseC",
        
        array_remove(ARRAY[
          -- Only include reasons based on PhaseA data
          CASE WHEN s.title IS DISTINCT FROM v.title THEN 'title changed' END,
          CASE WHEN s.tags IS DISTINCT FROM v.tags THEN 'tags changed' END,
          CASE WHEN s."isDeleted" IS DISTINCT FROM v."isDeleted" THEN 'deletion status changed' END,
          -- Rating with fragment/component special handling
          CASE WHEN s.rating IS DISTINCT FROM v.rating AND NOT 
                    (s.url LIKE '%fragment:%' AND s.rating IS NULL AND (v.rating IS NULL OR v.rating = 0)) AND NOT
                    (s.url LIKE '%component:%' AND s.rating IS NULL AND (v.rating IS NULL OR v.rating = 0))
               THEN 'rating changed' END,
          -- Vote count with fragment/component special handling  
          CASE WHEN s."voteCount" IS DISTINCT FROM v."voteCount" AND NOT 
                    (s.url LIKE '%fragment:%' AND s."voteCount" IS NULL AND v."voteCount" = 0) AND NOT
                    (s.url LIKE '%component:%' AND s."voteCount" IS NULL AND v."voteCount" = 0)
               THEN 'vote count changed' END,
          -- Revision count (PhaseA gets this from API)
          CASE WHEN s."revisionCount" IS DISTINCT FROM v."revisionCount" THEN 'revision count changed' END,
          -- Attribution count (PhaseA calculates this)
          CASE WHEN s."attributionCount" IS DISTINCT FROM (SELECT COUNT(*) FROM "Attribution" a WHERE a."pageVerId" = v.id) THEN 'attribution count changed' END,
          -- New pages
          CASE WHEN v.id IS NULL THEN 'new page' END
        ], NULL) as reasons
        
      FROM "PageMetaStaging" s
      JOIN "Page" p ON p.url = s.url
      LEFT JOIN "PageVersion" v ON v."pageId" = p.id AND v."validTo" IS NULL
      WHERE s.url IN (SELECT url FROM "PageMetaStaging")
    `;
    
    // Also handle new pages not in database yet
    const newPages = await this.prisma.$queryRaw<Array<{url: string}>>`
      SELECT s.url
      FROM "PageMetaStaging" s
      WHERE s.url NOT IN (SELECT url FROM "Page")
    `;
    
    console.log(`Found ${newPages.length} new pages, ${dirtyPages.length} existing pages to check`);
    
    // Ensure all existing pages have at least one PageVersion
    const pagesWithoutVersions = await this.prisma.$queryRaw<Array<{pageId: number, url: string}>>`
      SELECT p.id as "pageId", p.url
      FROM "Page" p
      WHERE NOT EXISTS (SELECT 1 FROM "PageVersion" pv WHERE pv."pageId" = p.id)
      AND p.url IN (SELECT url FROM "PageMetaStaging")
    `;
    
    console.log(`Found ${pagesWithoutVersions.length} pages without versions, creating initial versions...`);
    
    for (const pageInfo of pagesWithoutVersions) {
      const stagingData = await this.prisma.pageMetaStaging.findUnique({
        where: { url: pageInfo.url }
      });
      
      if (stagingData) {
        await this.prisma.pageVersion.create({
          data: {
            pageId: pageInfo.pageId,
            wikidotId: stagingData.wikidotId,
            title: stagingData.title,
            rating: stagingData.rating,
            voteCount: stagingData.voteCount,
            revisionCount: stagingData.revisionCount,
            tags: stagingData.tags || [],
            validFrom: new Date(),
            isDeleted: stagingData.isDeleted || false,
          },
        });
        console.log(`Created initial version for: ${pageInfo.url}`);
      }
    }
    
    // Create pages for new URLs and add to dirty queue
    for (const newPage of newPages) {
      const urlKey = this.extractUrlKey(newPage.url);
      const page = await this.prisma.page.create({
        data: {
          url: newPage.url,
          urlKey,
        },
      });
      
      // Get staging data to create initial PageVersion
      const stagingData = await this.prisma.pageMetaStaging.findUnique({
        where: { url: newPage.url }
      });
      
      if (stagingData) {
        // Create initial PageVersion for new pages using staging data
        await this.prisma.pageVersion.create({
          data: {
            pageId: page.id,
            wikidotId: stagingData.wikidotId,
            title: stagingData.title,
            rating: stagingData.rating,
            voteCount: stagingData.voteCount,
            revisionCount: stagingData.revisionCount,
            tags: stagingData.tags || [],
            validFrom: new Date(),
            isDeleted: stagingData.isDeleted || false,
          },
        });
      }
      
      // Add to dirty queue (new pages need Phase B, which will determine Phase C needs)
      dirtyPages.push({
        pageId: page.id,
        url: newPage.url,
        needPhaseB: true,
        needPhaseC: false,
        reasons: ['new page'],
      });
    }
    
    // Insert dirty pages
    const dirtyPagesToInsert = dirtyPages.filter(dp => dp.needPhaseB || dp.needPhaseC);
    
    for (const dirtyPage of dirtyPagesToInsert) {
      await this.prisma.dirtyPage.upsert({
        where: { pageId: dirtyPage.pageId },
        update: {
          needPhaseB: dirtyPage.needPhaseB,
          needPhaseC: dirtyPage.needPhaseC,
          reasons: dirtyPage.reasons,
          donePhaseB: false,
          donePhaseC: false,
          updatedAt: new Date(),
        },
        create: {
          pageId: dirtyPage.pageId,
          needPhaseB: dirtyPage.needPhaseB,
          needPhaseC: dirtyPage.needPhaseC,
          reasons: dirtyPage.reasons,
          donePhaseB: false,
          donePhaseC: false,
        },
      });
    }
    
    console.log(`✅ Dirty queue built: ${dirtyPagesToInsert.length} pages need processing`);
    console.log(`  - Phase B needed: ${dirtyPagesToInsert.filter(dp => dp.needPhaseB).length}`);
    console.log(`  - Phase C needed: ${dirtyPagesToInsert.filter(dp => dp.needPhaseC).length}`);
    
    return {
      total: dirtyPagesToInsert.length,
      phaseB: dirtyPagesToInsert.filter(dp => dp.needPhaseB).length,
      phaseC: dirtyPagesToInsert.filter(dp => dp.needPhaseC).length,
      deleted: deletedPages.length,
    };
  }

  async fetchDirtyPages(phase: 'B' | 'C', limit = 500) {
    const whereCondition = phase === 'B' 
      ? { needPhaseB: true, donePhaseB: false }
      : { needPhaseC: true, donePhaseC: false };

    return await this.prisma.dirtyPage.findMany({
      where: whereCondition,
      include: {
        page: {
          include: {
            versions: {
              where: { validTo: null },
              take: 1,
            },
          },
        },
      },
      take: limit,
      orderBy: { createdAt: 'asc' },
    });
  }

  async clearDirtyFlag(pageId: number, phase: 'B' | 'C') {
    const updateData = phase === 'B' 
      ? { donePhaseB: true, updatedAt: new Date() }
      : { donePhaseC: true, updatedAt: new Date() };

    await this.prisma.dirtyPage.update({
      where: { pageId },
      data: updateData,
    });
  }

  async cleanupStagingData(olderThanHours = 24) {
    const cutoffTime = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
    
    const deleted = await this.prisma.pageMetaStaging.deleteMany({
      where: {
        lastSeenAt: {
          lt: cutoffTime,
        },
      },
    });
    
    console.log(`🧹 Cleaned up ${deleted.count} old staging records`);
    return deleted.count;
  }

  async disconnect() {
    await this.prisma.$disconnect();
  }
}