import { PrismaClient } from '@prisma/client';
import { Logger } from '../../utils/Logger.js';
import { MAX_FIRST } from '../../config/RateLimitConfig.js';
import { v4 as uuidv4 } from 'uuid';
import { SourceVersionService } from '../../services/SourceVersionService.js';

export class DatabaseStore {
  private prisma: PrismaClient;
  private sourceVersionService: SourceVersionService;

  constructor() {
    this.prisma = new PrismaClient();
    this.sourceVersionService = new SourceVersionService(this.prisma);
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
    
    Logger.info(`🔄 Processing ${data.url} (wikidotId: ${data.wikidotId})`);
    
    // 第1步：通过URL查找页面
    let targetPage = await this.prisma.page.findUnique({
      where: { url: data.url },
      include: {
        versions: {
          where: { validTo: null },
          take: 1
        }
      }
    });

    // 第2步：通过wikidotId查找现有的页面（无论URL是否找到）
    let existingPageVersion = null;
    if (data.wikidotId) {
      existingPageVersion = await this.prisma.pageVersion.findFirst({
        where: { 
          wikidotId: data.wikidotId,
          validTo: null 
        },
        include: { page: true }
      });
    }

    // 第3步：分析不同的情况并处理
    let page: any;
    if (targetPage && existingPageVersion) {
      // 情况A：两个页面都找到了
      if (targetPage.id === existingPageVersion.pageId) {
        // A1: 同一个页面，数据一致
        Logger.info(`✅ Page consistency check passed for ${data.url}`);
        page = targetPage;
      } else {
        // A2: 不同页面，需要合并！
        Logger.info(`🔀 Detected page merge needed: ${existingPageVersion.page.url} -> ${data.url}`);
        page = await this.handlePageMergeInUpsert(existingPageVersion.page, targetPage, data);
      }
    } else if (!targetPage && existingPageVersion) {
      // 情况B：URL没找到页面，但wikidotId对应的页面存在 -> 页面重命名
      Logger.info(`🔄 Detected page rename: ${existingPageVersion.page.url} -> ${data.url}`);
      page = await this.handlePageRenameInUpsert(existingPageVersion.page, data);
    } else if (targetPage && !existingPageVersion) {
      // 情况C：URL找到页面，但wikidotId没有对应页面 -> 页面身份变更
      Logger.info(`⚠️ Page identity change detected for ${data.url}`);
      page = await this.handlePageIdentityChangeInUpsert(targetPage, data);
    } else {
      // 情况D：都没找到 -> 新页面
      Logger.info(`📝 Creating new page: ${data.url}`);
      page = null; // 将在下面创建
    }

    // 如果仍未找到，创建新页面
    if (!page) {
      page = await this.prisma.page.create({
        data: {
          url: data.url,
          urlKey,
          pageUuid: uuidv4(),
        },
      });
      Logger.info(`📝 Created new page with UUID: ${page.pageUuid} for ${data.url}`);
    } else {
      // 更新现有页面的urlKey和确保有UUID
      const updateData: any = { urlKey };
      if (!page.pageUuid) {
        updateData.pageUuid = uuidv4();
        Logger.info(`🔧 Added missing UUID to existing page: ${page.id}`);
      }
      
      if (Object.keys(updateData).length > 1 || page.urlKey !== urlKey) {
        await this.prisma.page.update({
          where: { id: page.id },
          data: updateData
        });
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const existingVersion = await tx.pageVersion.findFirst({
        where: {
          pageId: page.id,
          validTo: null,
        },
      });

      if (this.needsNewVersion(existingVersion, data)) {
        if (existingVersion) {
          await tx.pageVersion.update({
            where: { id: existingVersion.id },
            data: { validTo: new Date() },
          });
        }

        await tx.pageVersion.create({
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
        await tx.pageVersion.update({
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
    });
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

    // === 0. Manage Source Code Versions ===
    if (data.textContent || data.source) {
      Logger.debug(`📋 Managing source code versions for PageVersion ${currentVersion.id}`);
      await this.sourceVersionService.manageSourceVersion(currentVersion.id, {
        source: data.source,
        textContent: data.textContent,
      });
    }

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
        } catch (error: any) {
          Logger.error(`❌ Failed to process attribution ${i}:`, {
            message: error?.message || 'Unknown error',
            code: error?.code,
            attribution: attr,
            stack: error?.stack?.split('\n').slice(0, 3).join('\n')
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
        const wikidotIdInt = Number.isFinite(Number(revision.wikidotId))
          ? Number(revision.wikidotId) : null;
        
        if (wikidotIdInt == null) {
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
        } catch (error: any) {
          Logger.error(`❌ Failed to process revision ${wikidotIdInt}:`, {
            message: error?.message || 'Unknown error',
            code: error?.code,
            name: error?.name,
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
          if ((error as any)?.code === 'P2002') {
            Logger.warn(`⚠️ Vote already exists, skipping: pageVersionId=${currentVersion.id}, userId=${userId}, anonKey=${anonKey || 'N/A'}, timestamp=${vote.timestamp}`);
          } else {
            Logger.error(`❌ Failed to upsert vote for page ${currentVersion.id}:`, {
              error: (error as any)?.message || 'Unknown error',
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
    try {
      const u = new URL(url, 'https://placeholder.local'); // 支持相对路径
      const path = u.pathname.replace(/\/+$/, '');         // 去掉末尾斜杠
      const last = path.split('/').filter(Boolean).pop() || '';
      return decodeURIComponent(last);
    } catch {
      // 兜底：剔除 ? 和 #，再取最后一段
      const cleaned = url.split('#')[0].split('?')[0].replace(/\/+$/, '');
      const parts = cleaned.split('/').filter(Boolean);
      return decodeURIComponent(parts.pop() || cleaned);
    }
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
      } catch (error: any) {
        Logger.error(`❌ Failed to upsert user with wikidotId ${wikidotIdInt}:`, error?.message || 'Unknown error');
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
        
      } catch (error: any) {
        Logger.error(`❌ Failed to create deleted user record for ${displayName}:`, error?.message || 'Unknown error');
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
        const wikidotIdInt = Number.isFinite(Number(revision.wikidotId))
          ? Number(revision.wikidotId) : null;
        
        if (wikidotIdInt == null) {
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
        } catch (error: any) {
          Logger.error(`❌ Failed to process revision ${wikidotIdInt}:`, {
            message: error?.message || 'Unknown error',
            code: error?.code,
            name: error?.name,
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
        } catch (error: any) {
          Logger.warn(`⚠️ Failed to upsert vote: ${error?.message || 'Unknown error'}`, {
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
      existingVersion.revisionCount !== newData.revisionCount || // 检查revision数量变化
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
      LEFT JOIN "PageMetaStaging" s ON s.url = p.url
      WHERE s.url IS NULL
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
    `;
    
    // Also handle new pages not in database yet
    const newPages = await this.prisma.$queryRaw<Array<{url: string}>>`
      SELECT s.url
      FROM "PageMetaStaging" s
      LEFT JOIN "Page" p ON p.url = s.url
      WHERE p.url IS NULL
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
    
    // Handle page recreation (existing page but no current version due to wikidotId change)
    const pagesNeedingRecreation = await this.prisma.$queryRaw<Array<{
      pageId: number;
      url: string;
      lastWikidotId: number | null;
    }>>`
      SELECT 
        p.id as "pageId", 
        p.url,
        (SELECT pv."wikidotId" 
         FROM "PageVersion" pv 
         WHERE pv."pageId" = p.id AND pv."wikidotId" IS NOT NULL 
         ORDER BY pv."createdAt" DESC 
         LIMIT 1) as "lastWikidotId"
      FROM "Page" p
      JOIN "PageMetaStaging" s ON s.url = p.url
      WHERE NOT EXISTS (
        SELECT 1 FROM "PageVersion" pv 
        WHERE pv."pageId" = p.id AND pv."validTo" IS NULL
      )
      AND s."wikidotId" IS NOT NULL
      AND s."wikidotId" != COALESCE(
        (SELECT pv."wikidotId" 
         FROM "PageVersion" pv 
         WHERE pv."pageId" = p.id AND pv."wikidotId" IS NOT NULL 
         ORDER BY pv."createdAt" DESC 
         LIMIT 1), 
        0
      )
    `;
    
    console.log(`Found ${pagesNeedingRecreation.length} pages needing recreation due to wikidotId change...`);
    
    for (const pageInfo of pagesNeedingRecreation) {
      const stagingData = await this.prisma.pageMetaStaging.findUnique({
        where: { url: pageInfo.url }
      });
      
      if (stagingData) {
        console.log(`🔥 Recreation detected: ${pageInfo.url} (wikidotId: ${pageInfo.lastWikidotId} → ${stagingData.wikidotId})`);
        
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
            validTo: null,  // New current version
            isDeleted: stagingData.isDeleted || false,
          },
        });
        console.log(`✅ Created recreation version for: ${pageInfo.url}`);
      }
    }
    
    // Create pages for new URLs and add to dirty queue
    for (const newPage of newPages) {
      const urlKey = this.extractUrlKey(newPage.url);
      const page = await this.prisma.page.create({
        data: {
          url: newPage.url,
          urlKey,
          pageUuid: uuidv4(),
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

  async buildDirtyQueueTestMode() {
    console.log('🧪 Building dirty page queue for test mode (staging data only)...');
    
    // Get all staging URLs for test batch
    const stagingUrls = await this.prisma.pageMetaStaging.findMany({
      select: { url: true }
    });
    
    if (stagingUrls.length === 0) {
      console.log('No staging data found for test mode');
      return {
        total: 0,
        phaseB: 0,
        phaseC: 0,
        deleted: 0,
      };
    }
    
    const stagingUrlSet = new Set(stagingUrls.map(s => s.url));
    
    console.log(`Found ${stagingUrls.length} URLs in staging for test batch`);
    
    // Only check for deleted pages within our test batch URLs
    // (pages that exist in DB but not in our test batch staging data)
    const testBatchPages = await this.prisma.page.findMany({
      where: {
        url: { in: Array.from(stagingUrlSet) }
      },
      include: {
        versions: {
          where: { validTo: null },
          take: 1,
        }
      }
    });
    
    console.log(`Found ${testBatchPages.length} existing pages in test batch range`);
    
    // Build dirty queue only for test batch pages
    const dirtyPages: Array<{
      pageId: number;
      url: string;
      needPhaseB: boolean;
      needPhaseC: boolean;
      reasons: string[];
    }> = [];
    
    // Check existing pages for changes (within test batch)
    const existingPagesMap = new Map(testBatchPages.map(p => [p.url, p]));
    
    for (const stagingPage of await this.prisma.pageMetaStaging.findMany()) {
      const existingPage = existingPagesMap.get(stagingPage.url);
      
      if (!existingPage) {
        // This is a new page that doesn't exist in DB yet
        // It will be handled by the "new pages" logic below
        continue;
      }
      
      const currentVersion = existingPage.versions[0];
      if (!currentVersion) {
        // Page exists but has no current version - needs Phase B
        dirtyPages.push({
          pageId: existingPage.id,
          url: stagingPage.url,
          needPhaseB: true,
          needPhaseC: false,
          reasons: ['missing current version'],
        });
        continue;
      }
      
      // Check for changes that require Phase B (content changes)
      const needPhaseB = 
        currentVersion.title !== stagingPage.title ||
        currentVersion.rating !== stagingPage.rating ||
        currentVersion.revisionCount !== stagingPage.revisionCount ||
        JSON.stringify((currentVersion.tags || []).slice().sort()) !== JSON.stringify((stagingPage.tags || []).slice().sort()) ||
        currentVersion.isDeleted !== (stagingPage.isDeleted || false);
      
      // Check for changes that require Phase C (vote/revision changes)  
      const needPhaseC = currentVersion.voteCount !== stagingPage.voteCount;
      
      if (needPhaseB || needPhaseC) {
        const reasons: string[] = [];
        if (needPhaseB) {
          if (currentVersion.title !== stagingPage.title) reasons.push('title change');
          if (currentVersion.rating !== stagingPage.rating) reasons.push('rating change');
          if (currentVersion.revisionCount !== stagingPage.revisionCount) reasons.push('revision count change');
          if (JSON.stringify((currentVersion.tags || []).slice().sort()) !== JSON.stringify((stagingPage.tags || []).slice().sort())) reasons.push('tags change');
          if (currentVersion.isDeleted !== (stagingPage.isDeleted || false)) reasons.push('deletion status change');
        }
        if (needPhaseC) {
          if (currentVersion.voteCount !== stagingPage.voteCount) reasons.push('vote count change');
        }
        
        dirtyPages.push({
          pageId: existingPage.id,
          url: stagingPage.url,
          needPhaseB,
          needPhaseC,
          reasons,
        });
      }
    }
    
    // Check for new pages in staging that don't exist in DB
    const newPages = await this.prisma.pageMetaStaging.findMany({
      where: {
        url: {
          notIn: testBatchPages.map(p => p.url)
        }
      }
    });
    
    console.log(`Found ${newPages.length} new pages in test batch`);
    
    // Create pages for new URLs and add to dirty queue
    for (const newPage of newPages) {
      const urlKey = this.extractUrlKey(newPage.url);
      const page = await this.prisma.page.create({
        data: {
          url: newPage.url,
          urlKey,
          pageUuid: uuidv4(),
        },
      });
      
      // Get staging data to create initial PageVersion
      const stagingData = await this.prisma.pageMetaStaging.findUnique({
        where: { url: newPage.url }
      });
      
      if (stagingData) {
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
            validTo: null,
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
    
    // Insert dirty pages for test batch only
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
    
    console.log(`✅ Test mode dirty queue built: ${dirtyPagesToInsert.length} pages need processing`);
    console.log(`  - Phase B needed: ${dirtyPagesToInsert.filter(dp => dp.needPhaseB).length}`);
    console.log(`  - Phase C needed: ${dirtyPagesToInsert.filter(dp => dp.needPhaseC).length}`);
    
    return {
      total: dirtyPagesToInsert.length,
      phaseB: dirtyPagesToInsert.filter(dp => dp.needPhaseB).length,
      phaseC: dirtyPagesToInsert.filter(dp => dp.needPhaseC).length,
      deleted: 0, // No deletion handling in test mode
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

    await this.prisma.dirtyPage.updateMany({
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

  /**
   * 根据UUID或URL查找页面（支持历史URL）
   */
  private async findPageByUuidOrUrl(identifier: string) {
    // 尝试UUID格式
    if (identifier.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      return await this.prisma.page.findFirst({
        where: { pageUuid: identifier }
      });
    }
    
    // 尝试URL
    let page = await this.prisma.page.findUnique({
      where: { url: identifier }
    });
    
    // 如果直接URL未找到，检查历史URL
    if (!page) {
      page = await this.prisma.page.findFirst({
        where: {
          historicalUrls: {
            has: identifier
          }
        }
      });
      
      if (page) {
        Logger.info(`📋 Found page via historical URL: ${identifier} -> ${page.url} (UUID: ${page.pageUuid})`);
      }
    }
    
    return page;
  }

  /**
   * 公开版本：根据UUID或URL查找页面
   */
  async findPageByIdentifier(identifier: string) {
    return await this.findPageByUuidOrUrl(identifier);
  }

  /**
   * 改进版buildDirtyQueue - 使用wikidotId智能匹配
   */
  async buildDirtyQueueEnhanced() {
    console.log('🔍 Building enhanced dirty page queue with smart matching...');
    
    // 清空现有的dirty queue
    await this.prisma.dirtyPage.deleteMany({});
    
    // 首先处理删除的页面（在数据库中但不在staging中）
    const deletedPages = await this.prisma.$queryRaw<Array<{pageId: number, url: string}>>`
      SELECT p.id as "pageId", p.url
      FROM "Page" p
      LEFT JOIN "PageMetaStaging" s ON s.url = p.url
      WHERE s.url IS NULL
      AND EXISTS (SELECT 1 FROM "PageVersion" pv WHERE pv."pageId" = p.id AND pv."validTo" IS NULL)
    `;
    
    console.log(`Found ${deletedPages.length} deleted pages`);
    
    // 标记删除的页面
    for (const deletedPage of deletedPages) {
      await this.prisma.pageVersion.updateMany({
        where: {
          pageId: deletedPage.pageId,
          validTo: null,
        },
        data: {
          validTo: new Date(),
        },
      });
      
      await this.prisma.pageVersion.create({
        data: {
          pageId: deletedPage.pageId,
          validFrom: new Date(),
          isDeleted: true,
        },
      });
      
      console.log(`Marked page as deleted: ${deletedPage.url}`);
    }
    
    // 智能分析：使用wikidotId作为主要匹配标准
    const smartAnalysis = await this.prisma.$queryRaw<Array<{
      pageId: number | null;
      stagingUrl: string;
      currentUrl: string | null;
      wikidotId: number;
      matchType: 'NEW_PAGE' | 'URL_CHANGED' | 'EXISTING_PAGE';
      needsProcessing: boolean;
      reasons: string[];
    }>>`
      WITH smart_page_matching AS (
        SELECT 
          s.url as staging_url,
          s."wikidotId",
          s.title, s.rating, s."voteCount", s.tags, s."revisionCount",
          
          -- 🎯 核心改进：通过wikidotId匹配页面
          pv.\"pageId\" as page_id,
          p.url as current_url,
          pv.title as current_title,
          pv.rating as current_rating,
          pv.\"voteCount\" as current_vote_count,
          pv.tags as current_tags,
          pv.\"revisionCount\" as current_revision_count,
          
          -- 🚀 智能状态判断
          CASE 
            WHEN pv.\"pageId\" IS NULL THEN 'NEW_PAGE'
            WHEN pv.\"pageId\" IS NOT NULL AND p.url != s.url THEN 'URL_CHANGED'  -- 🔥 检测重命名
            ELSE 'EXISTING_PAGE'
          END as match_type,
          
          -- 变化检测
          CASE WHEN 
            pv.\"pageId\" IS NULL OR
            p.url != s.url OR  -- URL变化需要处理
            s.title IS DISTINCT FROM pv.title OR
            s.rating IS DISTINCT FROM pv.rating OR
            s.\"voteCount\" IS DISTINCT FROM pv.\"voteCount\" OR
            s.tags IS DISTINCT FROM pv.tags OR
            s.\"revisionCount\" IS DISTINCT FROM pv.\"revisionCount\"
          THEN TRUE ELSE FALSE END as needs_processing,
          
          -- 详细变化原因
          array_remove(ARRAY[
            CASE WHEN pv.\"pageId\" IS NULL THEN 'new page' END,
            CASE WHEN p.url != s.url THEN 'url changed (rename detected)' END,
            CASE WHEN s.title IS DISTINCT FROM pv.title THEN 'title changed' END,
            CASE WHEN s.rating IS DISTINCT FROM pv.rating THEN 'rating changed' END,
            CASE WHEN s.\"voteCount\" IS DISTINCT FROM pv.\"voteCount\" THEN 'vote count changed' END,
            CASE WHEN s.tags IS DISTINCT FROM pv.tags THEN 'tags changed' END,
            CASE WHEN s.\"revisionCount\" IS DISTINCT FROM pv.\"revisionCount\" THEN 'revision count changed' END
          ], NULL) as reasons
          
        FROM \"PageMetaStaging\" s
        -- 🎯 关键改进：通过wikidotId连接而不是URL
        LEFT JOIN \"PageVersion\" pv ON pv.\"wikidotId\" = s.\"wikidotId\" 
                                     AND pv.\"validTo\" IS NULL
        LEFT JOIN \"Page\" p ON p.id = pv.\"pageId\"
      )
      
      SELECT 
        page_id as "pageId",
        staging_url as "stagingUrl", 
        current_url as "currentUrl",
        "wikidotId",
        match_type as "matchType",
        needs_processing as "needsProcessing",
        reasons
      FROM smart_page_matching
      WHERE needs_processing = true
      ORDER BY match_type, staging_url
    `;

    console.log(`\n📊 智能分析结果:`);
    console.log(`  新页面: ${smartAnalysis.filter(p => p.matchType === 'NEW_PAGE').length}`);
    console.log(`  重命名页面: ${smartAnalysis.filter(p => p.matchType === 'URL_CHANGED').length}`);
    console.log(`  更新页面: ${smartAnalysis.filter(p => p.matchType === 'EXISTING_PAGE').length}`);

    // 显示重命名页面详情
    const renamedPages = smartAnalysis.filter(p => p.matchType === 'URL_CHANGED');
    if (renamedPages.length > 0) {
      console.log(`\n🔄 检测到的页面重命名:`);
      for (const page of renamedPages.slice(0, 5)) {
        console.log(`  ${page.currentUrl} → ${page.stagingUrl} (wikidotId: ${page.wikidotId})`);
      }
      if (renamedPages.length > 5) {
        console.log(`  ... 还有 ${renamedPages.length - 5} 个重命名页面`);
      }
    }

    // 将结果写入DirtyPage表
    for (const rec of smartAnalysis) {
      if (!rec.pageId && rec.matchType === 'NEW_PAGE') {
        const page = await this.prisma.page.create({
          data: { 
            url: rec.stagingUrl, 
            urlKey: this.extractUrlKey(rec.stagingUrl), 
            pageUuid: uuidv4() 
          }
        });
        // 从 staging 取元数据
        const staging = await this.prisma.pageMetaStaging.findUnique({ 
          where: { url: rec.stagingUrl }
        });
        if (staging) {
          await this.prisma.pageVersion.create({
            data: {
              pageId: page.id,
              wikidotId: staging.wikidotId,
              title: staging.title,
              rating: staging.rating,
              voteCount: staging.voteCount,
              revisionCount: staging.revisionCount,
              tags: staging.tags ?? [],
              validFrom: new Date(),
              isDeleted: staging.isDeleted ?? false,
            }
          });
        }
        await this.prisma.dirtyPage.create({
          data: { 
            pageId: page.id, 
            needPhaseB: true, 
            needPhaseC: false, 
            reasons: ['new page'] 
          }
        });
        continue;
      }
      if (rec.pageId) {
        await this.prisma.dirtyPage.upsert({
          where: { pageId: rec.pageId },
          update: { 
            needPhaseB: true, 
            needPhaseC: false, 
            reasons: [`${rec.matchType}: ${rec.reasons.join(', ')}`], 
            donePhaseB: false, 
            donePhaseC: false, 
            updatedAt: new Date() 
          },
          create: { 
            pageId: rec.pageId, 
            needPhaseB: true, 
            needPhaseC: false, 
            reasons: [`${rec.matchType}: ${rec.reasons.join(', ')}`] 
          }
        });
      }
    }

    console.log(`\n✅ 增强dirty queue构建完成，共 ${smartAnalysis.length} 个需要处理的页面`);
    return smartAnalysis;
  }

  /**
   * 专门处理页面重命名的方法
   */
  async handlePageRename(options: {
    pageId: number;
    oldUrl: string;
    newUrl: string;
    preserveHistory?: boolean;
  }) {
    const { pageId, oldUrl, newUrl, preserveHistory = true } = options;
    
    Logger.info(`🔄 处理页面重命名: ${oldUrl} → ${newUrl}`);
    
    const page = await this.prisma.page.findUnique({
      where: { id: pageId }
    });
    
    if (!page) {
      throw new Error(`Page ${pageId} not found`);
    }
    
    // 更新URL并保存历史
    const historicalUrls = preserveHistory 
      ? [...(page.historicalUrls || []), oldUrl]
        .filter((url, index, arr) => arr.indexOf(url) === index && url !== newUrl)
      : page.historicalUrls;
    
    await this.prisma.page.update({
      where: { id: pageId },
      data: {
        url: newUrl,
        urlKey: this.extractUrlKey(newUrl),
        historicalUrls,
        updatedAt: new Date()
      }
    });
    
    Logger.info(`✅ 页面重命名完成: ${page.pageUuid}`);
    Logger.info(`   历史URLs: ${historicalUrls?.join(', ') || '无'}`);
    
    return page;
  }

  /**
   * 合并两个页面记录（用于处理重复页面）
   */
  async mergePageRecords(options: {
    sourcePageId: number;
    targetPageId: number;
    preserveHistory?: boolean;
  }) {
    const { sourcePageId, targetPageId, preserveHistory = true } = options;
    
    await this.prisma.$transaction(async (tx) => {
      // 获取源页面信息
      const sourcePage = await tx.page.findUnique({
        where: { id: sourcePageId },
        include: { versions: true }
      });
      
      if (!sourcePage) {
        throw new Error(`Source page ${sourcePageId} not found`);
      }
      
      Logger.info(`🔀 合并页面 ${sourcePageId} (${sourcePage.url}) → ${targetPageId}`);
      
      // 1. 迁移所有PageVersion
      await tx.pageVersion.updateMany({
        where: { pageId: sourcePageId },
        data: { pageId: targetPageId }
      });
      
      // 2. 迁移DirtyPage
      await tx.dirtyPage.updateMany({
        where: { pageId: sourcePageId },
        data: { pageId: targetPageId }
      });
      
      // 3. 记录源页面URL为历史URL
      if (preserveHistory) {
        const targetPage = await tx.page.findUnique({
          where: { id: targetPageId }
        });
        
        if (targetPage) {
          const newHistoricalUrls = [
            ...(targetPage.historicalUrls || []),
            ...(sourcePage.historicalUrls || []),
            sourcePage.url
          ].filter((url, index, arr) => arr.indexOf(url) === index && url !== targetPage.url);
          
          await tx.page.update({
            where: { id: targetPageId },
            data: { historicalUrls: newHistoricalUrls }
          });
        }
      }
      
      // 4. 删除源页面
      await tx.page.delete({
        where: { id: sourcePageId }
      });
      
      Logger.info(`✅ 页面合并完成: ${sourcePage.url} → 目标页面`);
    });
  }

  /**
   * 在upsert中处理页面合并
   */
  private async handlePageMergeInUpsert(sourcePage: any, targetPage: any, data: any) {
    Logger.info(`🔀 Merging pages in upsert: ${sourcePage.id} -> ${targetPage.id}`);

    await this.prisma.$transaction(async (tx) => {
      // 1. 迁移所有PageVersion
      await tx.pageVersion.updateMany({
        where: { pageId: sourcePage.id },
        data: { pageId: targetPage.id }
      });

      // 2. 迁移DirtyPage
      await tx.dirtyPage.updateMany({
        where: { pageId: sourcePage.id },
        data: { pageId: targetPage.id }
      });

      // 3. 更新目标页面的历史URLs
      const newHistoricalUrls = [
        ...(targetPage.historicalUrls || []),
        sourcePage.url
      ].filter((url, index, arr) => arr.indexOf(url) === index && url !== data.url);

      await tx.page.update({
        where: { id: targetPage.id },
        data: { 
          historicalUrls: newHistoricalUrls,
          updatedAt: new Date()
        }
      });

      // 4. 删除源页面
      await tx.page.delete({
        where: { id: sourcePage.id }
      });

      Logger.info(`✅ Page merge completed: ${sourcePage.url} merged into ${targetPage.url}`);
    });

    return targetPage;
  }

  /**
   * 在upsert中处理页面重命名
   */
  private async handlePageRenameInUpsert(existingPage: any, data: any) {
    Logger.info(`🔄 Renaming page in upsert: ${existingPage.url} -> ${data.url}`);

    const historicalUrls = [
      ...(existingPage.historicalUrls || []),
      existingPage.url
    ].filter((url, index, arr) => arr.indexOf(url) === index && url !== data.url);

    const updatedPage = await this.prisma.page.update({
      where: { id: existingPage.id },
      data: {
        url: data.url,
        urlKey: this.extractUrlKey(data.url),
        historicalUrls,
        updatedAt: new Date()
      }
    });

    Logger.info(`✅ Page renamed: ${existingPage.url} -> ${data.url} (UUID: ${updatedPage.pageUuid})`);
    return updatedPage;
  }

  /**
   * 在upsert中处理页面替换（旧页面被删除，新页面创建在相同URL）
   */
  private async handlePageIdentityChangeInUpsert(existingPage: any, data: any) {
    Logger.info(`🔄 Page replacement detected: ${data.url} - old page deleted, new page created`);
    Logger.info(`  Old page ${existingPage.id} (UUID: ${existingPage.pageUuid})`);
    Logger.info(`  New wikidotId: ${data.wikidotId}`);
    
    await this.prisma.$transaction(async (tx) => {
      // 1. 标记旧页面的所有版本为过期（表示页面已被删除）
      await tx.pageVersion.updateMany({
        where: {
          pageId: existingPage.id,
          validTo: null
        },
        data: { validTo: new Date() }
      });

      // 2. 为旧页面创建一个删除版本
      await tx.pageVersion.create({
        data: {
          pageId: existingPage.id,
          validFrom: new Date(),
          isDeleted: true,
          title: `Deleted: ${data.title || 'Unknown'}`
        }
      });

      // 3. 修改旧页面的URL，为新页面让路
      const stamp = new Date().toISOString().replace(/[-:TZ.]/g,''); // 到秒
      const historicalUrl = `${data.url}-deleted-${stamp}-${uuidv4().slice(0,8)}`;
      
      await tx.page.update({
        where: { id: existingPage.id },
        data: {
          url: historicalUrl,
          urlKey: this.extractUrlKey(historicalUrl),
          updatedAt: new Date()
        }
      });

      Logger.info(`  ✅ Old page moved to: ${historicalUrl}`);
    });

    // 4. 返回null，让调用方创建新页面
    Logger.info(`  📝 Will create new page for wikidotId: ${data.wikidotId}`);
    return null;
  }

  async disconnect() {
    await this.prisma.$disconnect();
  }
}