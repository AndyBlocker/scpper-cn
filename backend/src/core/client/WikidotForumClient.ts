// backend/src/core/client/WikidotForumClient.ts
import { Client } from '@ukwhatn/wikidot';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { Logger } from '../../utils/Logger.js';

export interface ForumCategoryDTO {
  id: number;
  title: string;
  description: string | null;
  threadsCount: number;
  postsCount: number;
}

export interface ForumThreadDTO {
  id: number;
  title: string;
  description: string | null;
  createdAt: string | null;
  createdByName: string | null;
  createdByWikidotId: number | null;
  createdByType: string | null;
  postCount: number;
  categoryId: number;
}

export interface ForumPostDTO {
  id: number;
  parentId: number | null;
  title: string | null;
  textHtml: string;
  createdByName: string | null;
  createdByWikidotId: number | null;
  createdByType: string | null;
  createdAt: string | null;
  editedAt: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function redactProxyForLog(rawProxy: string): string {
  try {
    const parsed = new URL(rawProxy);
    const auth = parsed.username || parsed.password ? '[redacted]@' : '';
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.protocol}//${auth}${parsed.hostname}${port}`;
  } catch {
    return '[configured]';
  }
}

export class WikidotForumClient {
  private client: any = null;
  private site: any = null;
  private siteName: string;
  private delayMs: number;

  constructor(options: { siteName?: string; delayMs?: number } = {}) {
    this.siteName = options.siteName || process.env.SITE_NAME || 'scp-wiki-cn';
    this.delayMs = options.delayMs ?? 400;
  }

  static setupProxy(): void {
    const proxy = String(process.env.FORUM_HTTP_PROXY || '').trim();
    if (!proxy) {
      Logger.info('[ForumClient] No forum proxy configured; using direct outbound requests');
      return;
    }
    setGlobalDispatcher(new ProxyAgent(proxy));
    Logger.info(`[ForumClient] Proxy set to ${redactProxyForLog(proxy)} (IP pool)`);
  }

  async connect(): Promise<void> {
    const username = process.env.WIKIDOT_USERNAME;
    const password = process.env.WIKIDOT_PASSWORD;

    if (username && password) {
      const clientRes = await Client.create({ username, password });
      if (!clientRes.isOk()) {
        throw new Error(`Failed to create wikidot client: ${clientRes.error}`);
      }
      this.client = clientRes.value;
      Logger.info('[ForumClient] Authenticated client created');
    } else {
      this.client = Client.createAnonymous();
      Logger.info('[ForumClient] Anonymous client created');
    }

    const siteRes = await this.client.site.get(this.siteName);
    if (!siteRes.isOk()) {
      throw new Error(`Failed to get site "${this.siteName}": ${siteRes.error}`);
    }
    this.site = siteRes.value;
    Logger.info(`[ForumClient] Connected to site: ${this.site.title} (${this.site.unixName})`);
  }

  async close(): Promise<void> {
    if (!this.client) return;
    try {
      const closeRes = await this.client.close();
      if (!closeRes.isOk()) {
        Logger.warn(`[ForumClient] client.close failed: ${closeRes.error?.message || closeRes.error}`);
      }
    } catch (err: any) {
      Logger.warn(`[ForumClient] client.close threw: ${err?.message || err}`);
    }
    this.client = null;
    this.site = null;
  }

  async getCategories(): Promise<ForumCategoryDTO[]> {
    this.ensureConnected();
    const res = await this.site.forum.getCategories();
    if (!res.isOk()) {
      throw new Error(`Failed to get forum categories: ${res.error}`);
    }

    return Array.from(res.value).map((cat: any) => ({
      id: cat.id,
      title: cat.title ?? '',
      description: cat.description ?? null,
      threadsCount: cat.threadsCount ?? 0,
      postsCount: cat.postsCount ?? 0,
    }));
  }

  async getCategoriesWithRawObjects(): Promise<{ dtos: ForumCategoryDTO[]; rawMap: Map<number, any> }> {
    this.ensureConnected();
    const res = await this.site.forum.getCategories();
    if (!res.isOk()) {
      throw new Error(`Failed to get forum categories: ${res.error}`);
    }

    const rawArray = Array.from(res.value) as any[];
    const dtos = rawArray.map((cat: any) => ({
      id: cat.id,
      title: cat.title ?? '',
      description: cat.description ?? null,
      threadsCount: cat.threadsCount ?? 0,
      postsCount: cat.postsCount ?? 0,
    }));
    const rawMap = new Map(rawArray.map((c: any) => [c.id, c]));

    return { dtos, rawMap };
  }

  async getThreads(category: ForumCategoryDTO): Promise<ForumThreadDTO[]> {
    this.ensureConnected();

    // We need to re-fetch the category object from the site to call getThreads
    const categoriesRes = await this.site.forum.getCategories();
    if (!categoriesRes.isOk()) {
      throw new Error(`Failed to get categories for thread fetch: ${categoriesRes.error}`);
    }

    const catObj = Array.from(categoriesRes.value).find((c: any) => c.id === category.id) as any;
    if (!catObj) {
      Logger.warn(`[ForumClient] Category ${category.id} not found, skipping`);
      return [];
    }

    const threadsRes = await catObj.getThreads();
    if (!threadsRes.isOk()) {
      throw new Error(`Failed to get threads for category ${category.id}: ${threadsRes.error}`);
    }

    return Array.from(threadsRes.value).map((thread: any) => ({
      id: thread.id,
      title: thread.title ?? '',
      description: thread.description ?? null,
      createdAt: thread.createdAt ? new Date(thread.createdAt).toISOString() : null,
      createdByName: thread.createdBy?.name ?? null,
      createdByWikidotId: thread.createdBy?.id ?? null,
      createdByType: thread.createdBy?.userType ?? null,
      postCount: thread.postCount ?? 0,
      categoryId: category.id,
    }));
  }

  async getThreadsFromCategoryObject(catObj: any): Promise<ForumThreadDTO[]> {
    const threadsRes = await catObj.getThreads();
    if (!threadsRes.isOk()) {
      throw new Error(`Failed to get threads for category ${catObj.id}: ${threadsRes.error}`);
    }

    return Array.from(threadsRes.value).map((thread: any) => ({
      id: thread.id,
      title: thread.title ?? '',
      description: thread.description ?? null,
      createdAt: thread.createdAt ? new Date(thread.createdAt).toISOString() : null,
      createdByName: thread.createdBy?.name ?? null,
      createdByWikidotId: thread.createdBy?.id ?? null,
      createdByType: thread.createdBy?.userType ?? null,
      postCount: thread.postCount ?? 0,
      categoryId: catObj.id,
    }));
  }

  async getPosts(threadId: number): Promise<ForumPostDTO[]> {
    this.ensureConnected();
    const threadRes = await this.site.forum.getThread(threadId);
    if (!threadRes.isOk()) {
      throw new Error(`Failed to get thread ${threadId}: ${threadRes.error}`);
    }

    const thread = threadRes.value;
    const postsRes = await thread.getPosts();
    if (!postsRes.isOk()) {
      throw new Error(`Failed to get posts for thread ${threadId}: ${postsRes.error}`);
    }

    return Array.from(postsRes.value).map((post: any) => ({
      id: post.id,
      parentId: post.parentId ?? null,
      title: post.title ?? null,
      textHtml: post.text ?? '',
      createdByName: post.createdBy?.name ?? null,
      createdByWikidotId: post.createdBy?.id ?? null,
      createdByType: post.createdBy?.userType ?? null,
      createdAt: post.createdAt ? new Date(post.createdAt).toISOString() : null,
      editedAt: post.editedAt ? new Date(post.editedAt).toISOString() : null,
    }));
  }

  async getRawCategoryObjects(): Promise<any[]> {
    this.ensureConnected();
    const res = await this.site.forum.getCategories();
    if (!res.isOk()) {
      throw new Error(`Failed to get forum categories: ${res.error}`);
    }
    return Array.from(res.value);
  }

  async delay(): Promise<void> {
    if (this.delayMs > 0) await sleep(this.delayMs);
  }

  private ensureConnected(): void {
    if (!this.client || !this.site) {
      throw new Error('[ForumClient] Not connected. Call connect() first.');
    }
  }
}
