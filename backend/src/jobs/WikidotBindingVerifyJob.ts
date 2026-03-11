import { PrismaClient } from '@prisma/client';

const USER_BACKEND_URL = process.env.USER_BACKEND_BASE_URL || 'http://127.0.0.1:4455';
const TARGET_PAGE_URL = '/andyblocker'; // The page where users add verification code (must end with /andyblocker)
const USER_BACKEND_FETCH_TIMEOUT_MS = Math.max(
  1000,
  Math.floor(Number(process.env.USER_BACKEND_FETCH_TIMEOUT_MS ?? '5000') || 5000)
);
const NO_MATCH_LOG_EVERY_N_CHECKS = Math.max(
  1,
  Math.floor(Number(process.env.WIKIDOT_BINDING_NO_MATCH_LOG_EVERY ?? '12') || 12)
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

      // 2. Find the target page
      const targetPage = await this.findTargetPage();
      if (!targetPage) {
        console.log(`⚠️ Target page "${TARGET_PAGE_URL}" not found in database.`);
        return;
      }

      // 3. Process each task
      for (const task of tasks) {
        await this.processTask(task, targetPage.id);
      }

      console.log('✅ Wikidot binding verification job completed.');
    } catch (error) {
      console.error('❌ Wikidot binding verification job failed:', error);
      throw error;
    }
  }

  private async fetchPendingTasks(): Promise<PendingTask[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), USER_BACKEND_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${USER_BACKEND_URL}/internal/wikidot-binding/pending`, {
        method: 'GET',
        signal: controller.signal
      });

      if (!response.ok) {
        let bodyPreview = '';
        try {
          const raw = await response.text();
          bodyPreview = raw ? ` ${raw.slice(0, 180)}` : '';
        } catch {
          bodyPreview = '';
        }
        throw new Error(`pending API returned ${response.status}.${bodyPreview}`.trim());
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

  private async findTargetPage(): Promise<{ id: number } | null> {
    const page = await this.prisma.page.findFirst({
      where: {
        currentUrl: { endsWith: TARGET_PAGE_URL }
      },
      select: { id: true }
    });
    return page;
  }

  private async processTask(task: PendingTask, pageId: number): Promise<void> {
    console.log(`🔍 Checking task ${task.id} for user ${task.wikidotUserId}...`);

    try {
      // Check if task is expired
      if (new Date(task.expiresAt) < new Date()) {
        console.log(`⏰ Task ${task.id} has expired, marking as expired.`);
        await this.expireTask(task.id);
        return;
      }

      // Find the user in backend database
      const user = await this.prisma.user.findUnique({
        where: { wikidotId: task.wikidotUserId },
        select: { id: true }
      });

      if (!user) {
        console.log(`⚠️ User with wikidotId ${task.wikidotUserId} not found in database.`);
        await this.updateTaskCheck(task.id);
        return;
      }

      // Query revisions on the target page made by this user after task creation
      const revisions = await this.prisma.revision.findMany({
        where: {
          pageVersion: { pageId },
          userId: user.id,
          timestamp: { gte: new Date(task.createdAt) }
        },
        select: {
          id: true,
          comment: true,
          timestamp: true
        },
        orderBy: { timestamp: 'desc' }
      });

      // Check if any revision comment contains the verification code
      const matchingRevision = revisions.find(rev =>
        rev.comment?.includes(task.verificationCode)
      );

      if (matchingRevision) {
        console.log(`✅ Verification code found in revision ${matchingRevision.id} for task ${task.id}`);
        await this.completeTask(task.id, matchingRevision.id, matchingRevision.timestamp);
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
        await this.updateTaskCheck(task.id);
      }
    } catch (error) {
      console.error(`⚠️ Error processing task ${task.id}:`, error);
      await this.updateTaskCheck(task.id);
    }
  }

  private async completeTask(taskId: string, revisionId: number, timestamp: Date): Promise<void> {
    try {
      await fetch(`${USER_BACKEND_URL}/internal/wikidot-binding/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId,
          revisionId,
          timestamp: timestamp.toISOString()
        })
      });
    } catch (error) {
      console.warn(`⚠️ Failed to complete task ${taskId}:`, error);
    }
  }

  private async updateTaskCheck(taskId: string): Promise<void> {
    try {
      await fetch(`${USER_BACKEND_URL}/internal/wikidot-binding/update-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId })
      });
    } catch (error) {
      console.warn(`⚠️ Failed to update task check for ${taskId}:`, error);
    }
  }

  private async expireTask(taskId: string): Promise<void> {
    try {
      await fetch(`${USER_BACKEND_URL}/internal/wikidot-binding/expire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId })
      });
    } catch (error) {
      console.warn(`⚠️ Failed to expire task ${taskId}:`, error);
    }
  }
}
