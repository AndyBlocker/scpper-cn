// backend/src/core/processors/ForumSyncProcessor.ts
import { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../../utils/db-connection.js';
import { Logger } from '../../utils/Logger.js';
import { WikidotForumClient, ForumCategoryDTO, ForumThreadDTO, ForumPostDTO } from '../client/WikidotForumClient.js';
import { ForumInteractionAlertJob } from '../../jobs/ForumInteractionAlertJob.js';

export interface ForumSyncOptions {
  full?: boolean;
  dryRun?: boolean;
  categoryId?: number;
}

export interface ForumSyncResult {
  categoriesSynced: number;
  categoriesSkipped: number;
  threadsFetched: number;
  threadsSkipped: number;
  postsSynced: number;
  errors: string[];
}

export class ForumSyncProcessor {
  private prisma: PrismaClient;
  private client: WikidotForumClient;
  private options: ForumSyncOptions;
  private upsertedUserIds: Set<number> = new Set();
  private newPostIds: Set<number> = new Set();
  private syncedCategoryIds: Set<number> = new Set();

  constructor(options: ForumSyncOptions = {}) {
    this.prisma = getPrismaClient();
    this.client = new WikidotForumClient();
    this.options = options;
  }

  async run(): Promise<ForumSyncResult> {
    const mode = this.options.full ? 'full' : 'incremental';
    const taskName = this.options.full ? 'full' : 'incremental';
    const syncStartedAt = new Date();
    Logger.info(`[ForumSync] Starting ${mode} sync...`);

    const result: ForumSyncResult = {
      categoriesSynced: 0,
      categoriesSkipped: 0,
      threadsFetched: 0,
      threadsSkipped: 0,
      postsSynced: 0,
      errors: [],
    };
    this.newPostIds.clear();
    this.syncedCategoryIds.clear();

    // Record sync start
    await this.prisma.forumSyncState.upsert({
      where: { task: taskName },
      create: { task: taskName, lastRunAt: new Date() },
      update: { lastRunAt: new Date(), errorMessage: null },
    });

    try {
      await this.client.connect();

      // Step 1: Get all categories from remote (single API call)
      const { dtos: remoteCategories, rawMap: rawCatMap } = await this.client.getCategoriesWithRawObjects();
      Logger.info(`[ForumSync] Found ${remoteCategories.length} categories`);

      // If targeting a specific category, filter
      const categoriesToSync = this.options.categoryId
        ? remoteCategories.filter(c => c.id === this.options.categoryId)
        : remoteCategories;

      if (this.options.categoryId && categoriesToSync.length === 0) {
        Logger.warn(`[ForumSync] Category ${this.options.categoryId} not found`);
        return result;
      }

      // Step 2: Process each category
      for (const remoteCat of categoriesToSync) {
        try {
          await this.processCategory(remoteCat, rawCatMap.get(remoteCat.id), result);
          this.syncedCategoryIds.add(remoteCat.id);
        } catch (err: any) {
          const msg = `Error processing category ${remoteCat.id} (${remoteCat.title}): ${err.message}`;
          Logger.error(`[ForumSync] ${msg}`);
          result.errors.push(msg);
        }
      }

      // Step 3: Mark deleted threads (full sync only)
      if (this.options.full && !this.options.dryRun) {
        await this.markDeletedThreads(Array.from(this.syncedCategoryIds), syncStartedAt);
      }

      // Step 4: Build forum interaction alerts from newly inserted posts
      if (!this.options.dryRun && this.newPostIds.size > 0) {
        try {
          const job = new ForumInteractionAlertJob(this.prisma);
          const created = await job.run(Array.from(this.newPostIds));
          Logger.info(`[ForumSync] Forum interaction alerts: created ${created} from ${this.newPostIds.size} new posts.`);
        } catch (alertErr: any) {
          const msg = `Forum interaction alert generation failed: ${alertErr?.message || alertErr}`;
          Logger.error(`[ForumSync] ${msg}`);
          result.errors.push(msg);
        }
      }

      // Record success
      if (!this.options.dryRun) {
        await this.prisma.forumSyncState.upsert({
          where: { task: taskName },
          create: {
            task: taskName,
            lastRunAt: new Date(),
            lastSuccessAt: new Date(),
            categoriesSynced: result.categoriesSynced,
            threadsSynced: result.threadsFetched,
            postsSynced: result.postsSynced,
          },
          update: {
            lastSuccessAt: new Date(),
            categoriesSynced: result.categoriesSynced,
            threadsSynced: result.threadsFetched,
            postsSynced: result.postsSynced,
            errorMessage: result.errors.length > 0 ? result.errors.join('; ') : null,
          },
        });
      }

      Logger.info(`[ForumSync] Completed: ${result.categoriesSynced} categories, ${result.threadsFetched} threads fetched (${result.threadsSkipped} skipped), ${result.postsSynced} posts`);
      if (result.errors.length > 0) {
        Logger.warn(`[ForumSync] ${result.errors.length} errors occurred`);
      }
    } catch (err: any) {
      Logger.error(`[ForumSync] Fatal error: ${err.message}`);
      if (!this.options.dryRun) {
        await this.prisma.forumSyncState.upsert({
          where: { task: taskName },
          create: { task: taskName, lastRunAt: new Date(), errorMessage: err.message },
          update: { errorMessage: err.message },
        });
      }
      throw err;
    } finally {
      await this.client.close();
    }

    return result;
  }

  private async processCategory(
    remoteCat: ForumCategoryDTO,
    rawCatObj: any,
    result: ForumSyncResult
  ): Promise<void> {
    // Check if category needs sync (incremental mode)
    if (!this.options.full) {
      const localCat = await this.prisma.forumCategory.findUnique({
        where: { id: remoteCat.id },
      });

      if (
        localCat &&
        localCat.threadsCount === remoteCat.threadsCount &&
        localCat.postsCount === remoteCat.postsCount
      ) {
        Logger.info(`[ForumSync] Category "${remoteCat.title}" (${remoteCat.id}): no changes, skipping`);
        result.categoriesSkipped++;
        return;
      }
    }

    Logger.info(`[ForumSync] Syncing category "${remoteCat.title}" (${remoteCat.id}): ${remoteCat.threadsCount} threads, ${remoteCat.postsCount} posts`);

    // Upsert category
    if (!this.options.dryRun) {
      await this.prisma.forumCategory.upsert({
        where: { id: remoteCat.id },
        create: {
          id: remoteCat.id,
          title: remoteCat.title,
          description: remoteCat.description,
          threadsCount: remoteCat.threadsCount,
          postsCount: remoteCat.postsCount,
          lastSyncedAt: new Date(),
        },
        update: {
          title: remoteCat.title,
          description: remoteCat.description,
          threadsCount: remoteCat.threadsCount,
          postsCount: remoteCat.postsCount,
          lastSyncedAt: new Date(),
        },
      });
    }

    result.categoriesSynced++;

    // Get threads for this category
    if (!rawCatObj) {
      Logger.warn(`[ForumSync] No raw category object for ${remoteCat.id}, skipping threads`);
      return;
    }

    const threads = await this.client.getThreadsFromCategoryObject(rawCatObj);
    Logger.info(`[ForumSync]   Found ${threads.length} threads in category "${remoteCat.title}"`);

    for (const thread of threads) {
      try {
        const fetched = await this.processThread(thread, result);
        // Only delay between API-calling iterations (not skipped threads or dry-run)
        if (fetched) await this.client.delay();
      } catch (err: any) {
        const msg = `Error processing thread ${thread.id} (${thread.title}): ${err.message}`;
        Logger.error(`[ForumSync]   ${msg}`);
        result.errors.push(msg);
      }
    }
  }

  private async processThread(
    remoteThread: ForumThreadDTO,
    result: ForumSyncResult
  ): Promise<boolean> {
    // Incremental check: compare postCount
    if (!this.options.full) {
      const localThread = await this.prisma.forumThread.findUnique({
        where: { id: remoteThread.id },
        select: { postCountAtSync: true },
      });

      if (localThread && localThread.postCountAtSync === remoteThread.postCount) {
        result.threadsSkipped++;
        return false;
      }
    }

    // Try to resolve pageId for page discussion threads
    const pageId = await this.resolvePageId(remoteThread);

    // Upsert thread
    if (!this.options.dryRun) {
      await this.prisma.forumThread.upsert({
        where: { id: remoteThread.id },
        create: {
          id: remoteThread.id,
          categoryId: remoteThread.categoryId,
          title: remoteThread.title,
          description: remoteThread.description,
          createdByName: remoteThread.createdByName,
          createdByWikidotId: remoteThread.createdByWikidotId,
          createdAt: remoteThread.createdAt ? new Date(remoteThread.createdAt) : null,
          postCount: remoteThread.postCount,
          postCountAtSync: remoteThread.postCount,
          pageId,
          lastSyncedAt: new Date(),
        },
        update: {
          title: remoteThread.title,
          description: remoteThread.description,
          postCount: remoteThread.postCount,
          postCountAtSync: remoteThread.postCount,
          pageId,
          lastSyncedAt: new Date(),
          isDeleted: false,
        },
      });
    }

    // Upsert thread creator as User
    if (remoteThread.createdByWikidotId && remoteThread.createdByWikidotId > 0) {
      await this.upsertForumUser(remoteThread.createdByWikidotId, remoteThread.createdByName);
    }

    result.threadsFetched++;

    // Fetch and sync posts
    if (this.options.dryRun) {
      Logger.info(`[ForumSync]   [DRY RUN] Would fetch posts for thread ${remoteThread.id} (${remoteThread.title})`);
      return false;
    }

    try {
      const posts = await this.client.getPosts(remoteThread.id);
      Logger.info(`[ForumSync]   Thread ${remoteThread.id} "${remoteThread.title}": ${posts.length} posts`);

      const existingPostRows = await this.prisma.forumPost.findMany({
        where: { threadId: remoteThread.id },
        select: { id: true },
      });
      const existingPostIds = new Set(existingPostRows.map((row) => row.id));

      for (const post of posts) {
        const isNewPost = !existingPostIds.has(post.id);
        await this.upsertPost(remoteThread.id, post);
        if (isNewPost) {
          this.newPostIds.add(post.id);
        }
      }

      // Mark posts not in remote as deleted (full sync)
      if (this.options.full) {
        const remotePostIds = posts.map(p => p.id);
        await this.prisma.forumPost.updateMany({
          where: {
            threadId: remoteThread.id,
            id: { notIn: remotePostIds },
            isDeleted: false,
          },
          data: { isDeleted: true },
        });
      }

      result.postsSynced += posts.length;
    } catch (err: any) {
      Logger.error(`[ForumSync]   Failed to fetch posts for thread ${remoteThread.id}: ${err.message}`);
      result.errors.push(`Posts fetch failed for thread ${remoteThread.id}: ${err.message}`);
    }

    return true;  // Did fetch from API
  }

  private async upsertPost(threadId: number, post: ForumPostDTO): Promise<void> {
    await this.prisma.forumPost.upsert({
      where: { id: post.id },
      create: {
        id: post.id,
        threadId,
        parentId: post.parentId,
        title: post.title,
        textHtml: post.textHtml,
        createdByName: post.createdByName,
        createdByWikidotId: post.createdByWikidotId,
        createdByType: post.createdByType,
        createdAt: post.createdAt ? new Date(post.createdAt) : null,
        editedAt: post.editedAt ? new Date(post.editedAt) : null,
        syncedAt: new Date(),
      },
      update: {
        title: post.title,
        textHtml: post.textHtml,
        editedAt: post.editedAt ? new Date(post.editedAt) : null,
        isDeleted: false,
        syncedAt: new Date(),
      },
    });

    // Upsert post creator as User
    if (post.createdByWikidotId && post.createdByType === 'user') {
      await this.upsertForumUser(post.createdByWikidotId, post.createdByName);
    }
  }

  private async upsertForumUser(wikidotId: number, displayName?: string | null): Promise<void> {
    if (this.upsertedUserIds.has(wikidotId)) return;
    this.upsertedUserIds.add(wikidotId);
    try {
      await this.prisma.user.upsert({
        where: { wikidotId },
        update: displayName ? { displayName } : {},
        create: {
          wikidotId,
          displayName: displayName || undefined,
          isGuest: wikidotId < 0,
        },
      });
    } catch (err: any) {
      Logger.error(`[ForumSync] Failed to upsert user ${wikidotId}: ${err.message}`);
    }
  }

  private async resolvePageId(thread: ForumThreadDTO): Promise<number | null> {
    // Only attempt page-thread linking for "单页讨论" category (per-page discussions)
    // This category ID is specific to scp-wiki-cn
    if (thread.categoryId !== 675245) return null;
    if (!thread.title) return null;

    // In "单页讨论", thread titles usually match the page URL slug exactly
    const slug = thread.title.toLowerCase().trim();
    if (!slug) return null;

    // Try exact match: Page.currentUrl ends with the slug
    const page = await this.prisma.page.findFirst({
      where: {
        currentUrl: { endsWith: `/${slug}` },
        isDeleted: false,
      },
      select: { id: true },
    });

    return page?.id ?? null;
  }

  private async markDeletedThreads(categoryIds: number[], syncStartedAt: Date): Promise<void> {
    if (categoryIds.length === 0) {
      Logger.info('[ForumSync] No fully synced categories available for stale thread pruning');
      return;
    }

    // Only prune categories that completed successfully in this run, and only
    // threads that were not refreshed after the sync started.
    await this.prisma.forumThread.updateMany({
      where: {
        categoryId: { in: categoryIds },
        isDeleted: false,
        OR: [
          { lastSyncedAt: null },
          { lastSyncedAt: { lt: syncStartedAt } },
        ],
      },
      data: { isDeleted: true },
    });

    Logger.info('[ForumSync] Marked stale threads as deleted');
  }
}
