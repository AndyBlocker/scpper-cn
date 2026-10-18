import { Client } from 'pg';

export type TaskAdvisoryLockClient = Pick<Client, 'connect' | 'query' | 'end' | 'on'>;

export function createTaskAdvisoryLockClient(): TaskAdvisoryLockClient {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required for analysis task advisory locks');
  }
  return new Client({
    connectionString: databaseUrl,
    application_name: 'scpper-incremental-analysis-lock',
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000
  });
}

/**
 * Session advisory locks must be acquired and released by the same connection.
 * Keep this dedicated connection open while the task uses the normal Prisma pool.
 */
export async function withTaskAdvisoryLock(
  taskName: string,
  run: (assertLockHeld: () => void) => Promise<void>,
  createClient: () => TaskAdvisoryLockClient = createTaskAdvisoryLockClient
): Promise<void> {
  const client = createClient();
  const failures: unknown[] = [];
  let acquired = false;
  let closing = false;
  let sessionFailure: Error | undefined;

  const recordSessionFailure = (cause: Error) => {
    sessionFailure ??= new Error(`Advisory lock connection lost for task ${taskName}`, { cause });
  };
  const assertLockHeld = () => {
    if (sessionFailure) throw sessionFailure;
  };

  // Idle clients emit errors outside query promises. Never reconnect and silently
  // continue a task after losing its lock. An already running Prisma operation
  // cannot be cancelled here; wait for it to settle and report the lock failure.
  client.on('error', recordSessionFailure);
  client.on('end', () => {
    if (!closing) recordSessionFailure(new Error('Lock connection ended unexpectedly'));
  });

  try {
    await client.connect();
    assertLockHeld();
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
      [taskName]
    );
    acquired = result.rows[0]?.locked === true;
    assertLockHeld();
    if (!acquired) {
      console.log(`⏭️ Task ${taskName}: another worker holds the lock, skipping...`);
    } else {
      await run(assertLockHeld);
      assertLockHeld();
    }
  } catch (error) {
    failures.push(error);
  } finally {
    if (acquired && !sessionFailure) {
      try {
        const result = await client.query<{ unlocked: boolean }>(
          'SELECT pg_advisory_unlock(hashtext($1)) AS unlocked',
          [taskName]
        );
        if (result.rows[0]?.unlocked !== true) {
          throw new Error(`pg_advisory_unlock returned false for task ${taskName}`);
        }
      } catch (error) {
        failures.push(error);
      }
    }

    closing = true;
    try {
      await client.end();
    } catch (error) {
      failures.push(error);
    }
    if (sessionFailure && !failures.includes(sessionFailure)) failures.push(sessionFailure);
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, `Task ${taskName} failed while managing its advisory lock`, {
      cause: failures[0]
    });
  }
}
