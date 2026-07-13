import { PrismaClient } from '@prisma/client';

const USER_BACKEND_URL = process.env.USER_BACKEND_BASE_URL || 'http://127.0.0.1:4455';
const INTERNAL_API_KEY = (process.env.INTERNAL_API_KEY || '').trim();
const TARGET_PAGE_PATH = '/andyblocker';
const TARGET_PAGE_URLS = [
  `http://scp-wiki-cn.wikidot.com${TARGET_PAGE_PATH}`,
  `https://scp-wiki-cn.wikidot.com${TARGET_PAGE_PATH}`
];
const VERIFICATION_CODE_PATTERN = /^SCPPER-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
const COMMENT_EDGE_WHITESPACE_PATTERN = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g;
const USER_BACKEND_FETCH_TIMEOUT_MS = Math.max(
  1000,
  Math.floor(Number(process.env.USER_BACKEND_FETCH_TIMEOUT_MS ?? '5000') || 5000)
);
const USER_BACKEND_POST_TIMEOUT_MS = Math.max(
  1000,
  Math.floor(Number(process.env.USER_BACKEND_POST_TIMEOUT_MS ?? '5000') || 5000)
);
const NO_MATCH_LOG_EVERY_N_CHECKS = Math.max(
  1,
  Math.floor(Number(process.env.WIKIDOT_BINDING_NO_MATCH_LOG_EVERY ?? '12') || 12)
);
// Wikidot revisions reach us via Crom GraphQL with a server-side timestamp that
// can lag PostgreSQL `now()` by tens of seconds. Without slack, a user who edits
// /andyblocker right after starting a binding task gets their (correct) revision
// timestamp recorded *before* task.createdAt and is filtered out forever.
// verificationCode is already a 6-char base31 unique key, so a generous backstop
// has effectively zero forgery risk. The user-backend independently enforces the
// same five-minute maximum; clamp local tuning so the producer can never accept
// a proof that the stricter consumer will reject forever.
const MAX_TASK_TIMESTAMP_SLACK_MS = 5 * 60 * 1000;
const configuredTaskTimestampSlackMs = Number(
  process.env.WIKIDOT_BINDING_TIMESTAMP_SLACK_MS ?? MAX_TASK_TIMESTAMP_SLACK_MS
);
const TASK_TIMESTAMP_SLACK_MS = Number.isFinite(configuredTaskTimestampSlackMs)
  ? Math.min(MAX_TASK_TIMESTAMP_SLACK_MS, Math.max(0, Math.floor(configuredTaskTimestampSlackMs)))
  : MAX_TASK_TIMESTAMP_SLACK_MS;
// Surface stuck tasks so we don't silently burn 500 checks again before noticing.
const STUCK_TASK_WARN_THRESHOLD = Math.max(
  1,
  Math.floor(Number(process.env.WIKIDOT_BINDING_STUCK_WARN_THRESHOLD ?? '60') || 60)
);
const STUCK_TASK_WARN_INTERVAL = Math.max(
  1,
  Math.floor(Number(process.env.WIKIDOT_BINDING_STUCK_WARN_INTERVAL ?? '60') || 60)
);

interface PendingTask {
  id: string;
  userId: string;
  wikidotUserId: number;
  verificationCode: string;
  createdAt: string;
  expiresAt: string;
  checkCount?: number;
  lastCheckedAt?: string | null;
}

interface PendingTasksResponse {
  ok: boolean;
  tasks: PendingTask[];
}

export class WikidotBindingVerifyJob {
  private prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  async run(): Promise<void> {
    console.log('🔐 Starting Wikidot binding verification job...');

    try {
      // 1. Fetch pending tasks from user-backend
      const tasks = await this.fetchPendingTasks();

      if (tasks.length === 0) {
        console.log('ℹ️ No pending binding tasks to verify.');
        return;
      }

      console.log(`📋 Found ${tasks.length} pending binding tasks.`);

      // 2. Find every incarnation of the target page. Wikidot can delete and
      // recreate a page at the same URL, leaving multiple Page rows behind.
      const targetPages = await this.findTargetPages();
      if (targetPages.length === 0) {
        throw new Error(`Target page "${TARGET_PAGE_PATH}" not found in database.`);
      }
      if (targetPages.length > 1) {
        const activeCount = targetPages.filter(page => !page.isDeleted).length;
        console.warn(
          `⚠️ Found ${targetPages.length} target page incarnations (${activeCount} active); checking all of them.`
        );
      }
      const targetPageIds = targetPages.map(page => page.id);

      // 3. Process each task, but keep the cycle visibly failed if any internal
      // state transition could not be persisted. This prevents a broken
      // producer/consumer contract from looking healthy for months.
      let failedTasks = 0;
      for (const task of tasks) {
        if (!await this.processTask(task, targetPageIds)) failedTasks += 1;
      }
      if (failedTasks > 0) {
        throw new Error(`Failed to persist verification state for ${failedTasks}/${tasks.length} binding tasks.`);
      }

      console.log('✅ Wikidot binding verification job completed.');
    } catch (error) {
      console.error('❌ Wikidot binding verification job failed:', error);
      throw error;
    }
  }

  private internalHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (INTERNAL_API_KEY) headers['x-internal-key'] = INTERNAL_API_KEY;
    return headers;
  }

  private async fetchPendingTasks(): Promise<PendingTask[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), USER_BACKEND_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${USER_BACKEND_URL}/internal/wikidot-binding/pending`, {
        method: 'GET',
        headers: this.internalHeaders(),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`pending API returned HTTP ${response.status}`);
      }

      const data = await response.json() as PendingTasksResponse;
      if (!data.ok || !Array.isArray(data.tasks)) {
        throw new Error('pending API returned invalid payload');
      }

      return data.tasks;
    } catch (error) {
      throw new Error('Failed to fetch pending tasks from user-backend', { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  private async findTargetPages(): Promise<Array<{ id: number; isDeleted: boolean }>> {
    return this.prisma.page.findMany({
      where: {
        currentUrl: { in: TARGET_PAGE_URLS }
      },
      select: { id: true, isDeleted: true },
      orderBy: [
        { isDeleted: 'asc' },
        { updatedAt: 'desc' },
        { id: 'desc' }
      ]
    });
  }

  private async processTask(task: PendingTask, pageIds: number[]): Promise<boolean> {
    console.log(`🔍 Checking task ${task.id}...`);

    try {
      // Check if task is expired
      if (new Date(task.expiresAt) < new Date()) {
        console.log(`⏰ Task ${task.id} has expired, marking as expired.`);
        return this.expireTask(task.id);
      }

      if (
        typeof task.verificationCode !== 'string'
        || !VERIFICATION_CODE_PATTERN.test(task.verificationCode)
      ) {
        console.warn(`⚠️ Binding task ${task.id} has an invalid verification code format.`);
        return this.updateTaskCheck(task.id);
      }

      // Find the user in backend database
      const user = await this.prisma.user.findUnique({
        where: { wikidotId: task.wikidotUserId },
        select: { id: true }
      });

      if (!user) {
        console.log(`⚠️ Wikidot user for task ${task.id} not found in database.`);
        return this.updateTaskCheck(task.id);
      }

      // Apply slack on task.createdAt to absorb wikidot↔PG clock skew.
      const lowerBound = new Date(new Date(task.createdAt).getTime() - TASK_TIMESTAMP_SLACK_MS);
      const upperBound = new Date(task.expiresAt);
      const revisions = await this.prisma.revision.findMany({
        where: {
          pageVersion: { pageId: { in: pageIds } },
          userId: user.id,
          timestamp: {
            gte: lowerBound,
            lte: upperBound
          }
        },
        select: {
          id: true,
          comment: true,
          timestamp: true
        },
        orderBy: { timestamp: 'desc' }
      });

      // Wikidot may preserve incidental surrounding whitespace in edit comments,
      // but the normalized comment must contain only the canonical task code.
      const matchingRevision = revisions.find(rev =>
        typeof rev.comment === 'string'
        && rev.comment.replace(COMMENT_EDGE_WHITESPACE_PATTERN, '') === task.verificationCode
      );

      if (matchingRevision) {
        console.log(`✅ Verification code found in revision ${matchingRevision.id} for task ${task.id}`);
        const completed = await this.completeTask(task, matchingRevision.id, matchingRevision.timestamp);
        if (!completed) await this.updateTaskCheck(task.id);
        return completed;
      } else {
        const checkCount = Number.isInteger(task.checkCount) ? Number(task.checkCount) : 0;
        const shouldLogNoMatch = (
          revisions.length > 0
          || checkCount <= 1
          || checkCount % NO_MATCH_LOG_EVERY_N_CHECKS === 0
        );
        if (shouldLogNoMatch) {
          console.log(
            `ℹ️ No matching revision for task ${task.id} (checked ${revisions.length} revisions, checkCount=${checkCount}).`
          );
        }
        if (
          checkCount >= STUCK_TASK_WARN_THRESHOLD
          && checkCount % STUCK_TASK_WARN_INTERVAL === 0
        ) {
          console.warn(
            `⚠️ Wikidot binding task ${task.id} stuck after ${checkCount} checks.`
          );
        }
        return this.updateTaskCheck(task.id);
      }
    } catch (error) {
      console.error(`⚠️ Error processing task ${task.id}:`, error);
      await this.updateTaskCheck(task.id);
      return false;
    }
  }

  private async postInternal(path: string, body: Record<string, unknown>, label: string): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), USER_BACKEND_POST_TIMEOUT_MS);
    try {
      const response = await fetch(`${USER_BACKEND_URL}${path}`, {
        method: 'POST',
        headers: this.internalHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
        signal: controller.signal
      });
      if (!response.ok) {
        console.warn(`⚠️ ${label}: HTTP ${response.status}`);
        return false;
      }
      return true;
    } catch (error) {
      console.warn(`⚠️ ${label}:`, error);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private async completeTask(task: PendingTask, revisionId: number, timestamp: Date): Promise<boolean> {
    return this.postInternal('/internal/wikidot-binding/complete', {
      taskId: task.id,
      revisionId,
      timestamp: timestamp.toISOString(),
      wikidotUserId: task.wikidotUserId,
      verificationCode: task.verificationCode,
      createdAt: task.createdAt,
      expiresAt: task.expiresAt
    }, `Failed to complete task ${task.id}`);
  }

  private async updateTaskCheck(taskId: string): Promise<boolean> {
    return this.postInternal('/internal/wikidot-binding/update-check', { taskId }, `Failed to update task check for ${taskId}`);
  }

  private async expireTask(taskId: string): Promise<boolean> {
    return this.postInternal('/internal/wikidot-binding/expire', { taskId }, `Failed to expire task ${taskId}`);
  }
}
