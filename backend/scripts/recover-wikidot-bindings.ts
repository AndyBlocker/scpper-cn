#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Client, type QueryResultRow } from 'pg';

const TASK_TIMESTAMP_SLACK_MINUTES = 5;
const MAX_TASK_IDS = 100;
const CANONICAL_TARGET_URLS = [
  'http://scp-wiki-cn.wikidot.com/andyblocker',
  'https://scp-wiki-cn.wikidot.com/andyblocker'
];
const VERIFICATION_CODE_PATTERN = /^SCPPER-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

type Args = {
  apply: boolean;
  taskIds: string[];
};

type TaskRow = QueryResultRow & {
  id: string;
  status: string;
  userId: string;
  wikidotUserId: number;
  verificationCode: string;
  createdAtWall: string;
  expiresAtWall: string;
  validWindow: boolean;
};

type TaskHistoryRow = QueryResultRow & {
  id: string;
  userId: string;
};

type AccountRow = QueryResultRow & {
  id: string;
  linkedWikidotId: number | null;
};

type BackendUserRow = QueryResultRow & {
  id: number;
};

type ProofRow = QueryResultRow & {
  found: boolean;
};

type ValidationResult = {
  taskId: string;
  eligible: boolean;
  reasons: string[];
  task?: TaskRow;
};

class UsageError extends Error {}

class BatchRejectedError extends Error {
  constructor(readonly results: ValidationResult[]) {
    super('binding recovery batch rejected');
  }
}

function usage(): string {
  return [
    'Usage:',
    '  npm run repair:wikidot-bindings -- --task-id <id> [--task-id <id> ...] [--apply]',
    '',
    'The command is dry-run by default. It writes only when --apply is present.'
  ].join('\n');
}

function parseArgs(argv: string[]): Args {
  let apply = false;
  const taskIds: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;

    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }

    if (arg === '--apply') {
      if (apply) throw new UsageError('--apply may only be provided once');
      apply = true;
      continue;
    }

    if (arg === '--task-id') {
      const value = argv[index + 1]?.trim();
      if (!value || value.startsWith('--')) {
        throw new UsageError('--task-id requires a value');
      }
      taskIds.push(value);
      index += 1;
      continue;
    }

    if (arg.startsWith('--task-id=')) {
      const value = arg.slice('--task-id='.length).trim();
      if (!value) throw new UsageError('--task-id requires a value');
      taskIds.push(value);
      continue;
    }

    throw new UsageError('unknown argument');
  }

  if (taskIds.length === 0) {
    throw new UsageError('at least one --task-id is required');
  }
  if (taskIds.length > MAX_TASK_IDS) {
    throw new UsageError(`at most ${MAX_TASK_IDS} task IDs may be recovered at once`);
  }
  if (taskIds.some((taskId) => taskId.length > 128 || /\s/.test(taskId))) {
    throw new UsageError('task IDs must be non-empty strings without whitespace');
  }

  const uniqueTaskIds = new Set(taskIds);
  if (uniqueTaskIds.size !== taskIds.length) {
    throw new UsageError('duplicate --task-id values are not allowed');
  }

  return { apply, taskIds: [...uniqueTaskIds].sort() };
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  return dotenv.parse(fs.readFileSync(filePath));
}

function loadDatabaseUrls(): { backendDatabaseUrl: string; userDatabaseUrl: string } {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const backendDir = path.resolve(scriptDir, '..');
  const repositoryDir = path.resolve(backendDir, '..');
  const backendEnv = parseEnvFile(path.join(backendDir, '.env'));
  const userEnv = parseEnvFile(path.join(repositoryDir, 'user-backend', '.env'));

  const backendDatabaseUrl = process.env.DATABASE_URL?.trim() || backendEnv.DATABASE_URL?.trim();
  const userDatabaseUrl = process.env.USER_DATABASE_URL?.trim() || userEnv.USER_DATABASE_URL?.trim();

  if (!backendDatabaseUrl) {
    throw new UsageError('DATABASE_URL is not configured');
  }
  if (!userDatabaseUrl) {
    throw new UsageError('USER_DATABASE_URL is not configured');
  }

  return { backendDatabaseUrl, userDatabaseUrl };
}

function addReason(result: ValidationResult, reason: string): void {
  if (!result.reasons.includes(reason)) result.reasons.push(reason);
  result.eligible = false;
}

async function loadUserSideValidation(
  client: Client,
  taskIds: string[],
  lockRows: boolean
): Promise<ValidationResult[]> {
  const lockClause = lockRows ? ' FOR UPDATE' : '';
  const taskQuery = `
    SELECT t.id,
           t.status::text AS status,
           t."userId" AS "userId",
           t."wikidotUserId" AS "wikidotUserId",
           t."verificationCode" AS "verificationCode",
           to_char(t."createdAt", 'YYYY-MM-DD HH24:MI:SS.MS') AS "createdAtWall",
           to_char(t."expiresAt", 'YYYY-MM-DD HH24:MI:SS.MS') AS "expiresAtWall",
           (t."expiresAt" >= t."createdAt") AS "validWindow"
      FROM "WikidotBindingTask" t
     WHERE t.id = ANY($1::text[])
     ORDER BY t.id${lockClause}
  `;
  const taskRows = (await client.query<TaskRow>(taskQuery, [taskIds])).rows;
  const tasksById = new Map(taskRows.map((task) => [task.id, task]));
  const results = taskIds.map<ValidationResult>((taskId) => ({
    taskId,
    eligible: true,
    reasons: [],
    task: tasksById.get(taskId)
  }));

  for (const result of results) {
    if (!result.task) {
      addReason(result, 'task_not_found');
      continue;
    }
    if (result.task.status !== 'PENDING' && result.task.status !== 'EXPIRED') {
      addReason(result, 'task_status_not_recoverable');
    }
    if (!result.task.validWindow) {
      addReason(result, 'task_time_window_invalid');
    }
    if (
      typeof result.task.verificationCode !== 'string'
      || !VERIFICATION_CODE_PATTERN.test(result.task.verificationCode)
    ) {
      addReason(result, 'verification_code_invalid');
    }
  }

  if (taskRows.length === 0) return results;

  const userIds = Array.from(new Set(taskRows.map((task) => task.userId))).sort();
  const wikidotUserIds = Array.from(new Set(taskRows.map((task) => task.wikidotUserId))).sort((a, b) => a - b);

  const historyQuery = `
    SELECT t.id, t."userId" AS "userId"
      FROM "WikidotBindingTask" t
     WHERE t."userId" = ANY($1::text[])
     ORDER BY t."userId", t."createdAt" DESC, t.id DESC${lockClause}
  `;
  const historyRows = (await client.query<TaskHistoryRow>(historyQuery, [userIds])).rows;
  const latestTaskIdByUser = new Map<string, string>();
  for (const task of historyRows) {
    if (!latestTaskIdByUser.has(task.userId)) latestTaskIdByUser.set(task.userId, task.id);
  }

  const accountQuery = `
    SELECT ua.id, ua."linkedWikidotId" AS "linkedWikidotId"
      FROM "UserAccount" ua
     WHERE ua.id = ANY($1::text[])
        OR ua."linkedWikidotId" = ANY($2::int[])
     ORDER BY ua.id${lockClause}
  `;
  const accountRows = (await client.query<AccountRow>(accountQuery, [userIds, wikidotUserIds])).rows;
  const accountsById = new Map(accountRows.map((account) => [account.id, account]));
  const claimantByWikidotId = new Map<number, AccountRow>();
  for (const account of accountRows) {
    if (account.linkedWikidotId != null) claimantByWikidotId.set(account.linkedWikidotId, account);
  }

  const batchUserCounts = new Map<string, number>();
  const batchTargetCounts = new Map<number, number>();
  for (const task of taskRows) {
    batchUserCounts.set(task.userId, (batchUserCounts.get(task.userId) ?? 0) + 1);
    batchTargetCounts.set(task.wikidotUserId, (batchTargetCounts.get(task.wikidotUserId) ?? 0) + 1);
  }

  for (const result of results) {
    const task = result.task;
    if (!task) continue;

    if (latestTaskIdByUser.get(task.userId) !== task.id) {
      addReason(result, 'task_is_not_latest_for_account');
    }

    const owner = accountsById.get(task.userId);
    if (!owner) {
      addReason(result, 'account_not_found');
    } else if (owner.linkedWikidotId != null) {
      addReason(result, 'account_already_bound');
    }

    if (claimantByWikidotId.has(task.wikidotUserId)) {
      addReason(result, 'target_already_claimed');
    }
    if ((batchUserCounts.get(task.userId) ?? 0) > 1) {
      addReason(result, 'multiple_tasks_for_same_account_in_batch');
    }
    if ((batchTargetCounts.get(task.wikidotUserId) ?? 0) > 1) {
      addReason(result, 'multiple_tasks_for_same_target_in_batch');
    }
  }

  return results;
}

async function validateBackendProof(client: Client, result: ValidationResult): Promise<void> {
  const task = result.task;
  if (!task || !result.eligible) return;

  const backendUsers = (await client.query<BackendUserRow>(
    `SELECT u.id
       FROM "User" u
      WHERE u."wikidotId" = $1
      LIMIT 1`,
    [task.wikidotUserId]
  )).rows;
  const backendUser = backendUsers[0];
  if (!backendUser) {
    addReason(result, 'backend_user_not_found');
    return;
  }

  // Historical repair deliberately normalizes legacy URL case/trailing slash;
  // the online verifier uses the stricter current canonical URL set.
  const proof = (await client.query<ProofRow>(
    `SELECT EXISTS (
       SELECT 1
         FROM "Revision" r
         JOIN "PageVersion" pv ON pv.id = r."pageVersionId"
         JOIN "Page" p ON p.id = pv."pageId"
        WHERE r."userId" = $1
          AND BTRIM(COALESCE(r.comment, ''), E' \\t\\n\\r\\f\\013') = $2
          AND r.timestamp >= $3::timestamp - make_interval(mins => $4)
          AND r.timestamp <= $5::timestamp
          AND LOWER(RTRIM(p."currentUrl", '/')) = ANY($6::text[])
     ) AS found`,
    [
      backendUser.id,
      task.verificationCode,
      task.createdAtWall,
      TASK_TIMESTAMP_SLACK_MINUTES,
      task.expiresAtWall,
      CANONICAL_TARGET_URLS
    ]
  )).rows[0];

  if (!proof?.found) addReason(result, 'valid_revision_proof_not_found');
}

async function validateBatch(
  userClient: Client,
  backendClient: Client,
  taskIds: string[],
  lockRows: boolean
): Promise<ValidationResult[]> {
  const results = await loadUserSideValidation(userClient, taskIds, lockRows);
  for (const result of results) {
    await validateBackendProof(backendClient, result);
  }
  return results;
}

function printResults(mode: 'DRY-RUN' | 'APPLY', results: ValidationResult[], applied = 0): void {
  for (const result of results) {
    const state = result.eligible ? 'eligible' : `rejected(${result.reasons.join(',')})`;
    console.log(`[${mode}] taskId=${result.taskId} ${state}`);
  }
  const eligible = results.filter((result) => result.eligible).length;
  const rejected = results.length - eligible;
  console.log(
    `[${mode}] summary requested=${results.length} eligible=${eligible} rejected=${rejected} applied=${applied}`
  );
}

function allEligible(results: ValidationResult[]): boolean {
  return results.every((result) => result.eligible);
}

async function applyRecovery(
  userClient: Client,
  backendClient: Client,
  taskIds: string[]
): Promise<ValidationResult[]> {
  let transactionOpen = false;
  try {
    await userClient.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    transactionOpen = true;
    await userClient.query("SET LOCAL TIME ZONE 'UTC'");
    await userClient.query("SET LOCAL lock_timeout = '5s'");
    await userClient.query("SET LOCAL statement_timeout = '30s'");

    // Revision history lives in a separate database, so it cannot share this
    // transaction's ACID boundary. Revalidate it immediately before writes and
    // rely on the operational invariant that imported revisions are immutable.
    const results = await validateBatch(userClient, backendClient, taskIds, true);
    if (!allEligible(results)) throw new BatchRejectedError(results);

    for (const result of results) {
      const task = result.task!;
      const accountUpdate = await userClient.query(
        `UPDATE "UserAccount"
            SET "linkedWikidotId" = $1,
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE id = $2
            AND "linkedWikidotId" IS NULL`,
        [task.wikidotUserId, task.userId]
      );
      if (accountUpdate.rowCount !== 1) {
        addReason(result, 'account_changed_during_apply');
        throw new BatchRejectedError(results);
      }

      const taskUpdate = await userClient.query(
        `UPDATE "WikidotBindingTask"
            SET status = 'VERIFIED',
                "verifiedAt" = CURRENT_TIMESTAMP,
                "failureReason" = NULL,
                "updatedAt" = CURRENT_TIMESTAMP
          WHERE id = $1
            AND status IN ('PENDING', 'EXPIRED')`,
        [task.id]
      );
      if (taskUpdate.rowCount !== 1) {
        addReason(result, 'task_changed_during_apply');
        throw new BatchRejectedError(results);
      }
    }

    await userClient.query('COMMIT');
    transactionOpen = false;
    return results;
  } catch (error) {
    if (transactionOpen) await userClient.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

function sanitizedFailure(error: unknown): string {
  if (error instanceof UsageError) return error.message;
  if (error instanceof BatchRejectedError) return 'batch rejected; no changes committed';
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return `database error (${error.code})`;
  }
  return 'unexpected error';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { backendDatabaseUrl, userDatabaseUrl } = loadDatabaseUrls();
  const backendClient = new Client({ connectionString: backendDatabaseUrl, application_name: 'wikidot-binding-recovery' });
  const userClient = new Client({ connectionString: userDatabaseUrl, application_name: 'wikidot-binding-recovery' });
  let backendConnected = false;
  let userConnected = false;

  try {
    await backendClient.connect();
    backendConnected = true;
    await userClient.connect();
    userConnected = true;
    await backendClient.query("SET statement_timeout = '30s'");
    await backendClient.query('SET default_transaction_read_only = on');

    if (!args.apply) {
      await Promise.all([
        backendClient.query('BEGIN READ ONLY'),
        userClient.query('BEGIN READ ONLY')
      ]);
      try {
        const results = await validateBatch(userClient, backendClient, args.taskIds, false);
        printResults('DRY-RUN', results);
        if (!allEligible(results)) process.exitCode = 2;
      } finally {
        await Promise.allSettled([
          backendClient.query('ROLLBACK'),
          userClient.query('ROLLBACK')
        ]);
      }
      return;
    }

    const preflight = await validateBatch(userClient, backendClient, args.taskIds, false);
    if (!allEligible(preflight)) {
      throw new BatchRejectedError(preflight);
    }

    const applied = await applyRecovery(userClient, backendClient, args.taskIds);
    printResults('APPLY', applied, applied.length);
  } finally {
    await Promise.allSettled([
      backendConnected ? backendClient.end() : Promise.resolve(),
      userConnected ? userClient.end() : Promise.resolve()
    ]);
  }
}

void main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(sanitizedFailure(error));
    console.error(usage());
  } else if (error instanceof BatchRejectedError) {
    if (error.results.some((result) => !result.eligible)) printResults('APPLY', error.results);
    console.error(sanitizedFailure(error));
  } else {
    console.error(`wikidot binding recovery failed: ${sanitizedFailure(error)}`);
  }
  process.exitCode = 1;
});
