import type { Pool, PoolClient } from 'pg';
import type { AuthUserPayload } from './auth.js';

export interface CollectionOwnerMapping {
  userId: number;
  wikidotId: number | null;
}

interface CollectionRowForMerge {
  id: number;
  slug: string;
  isDefault: boolean;
}

type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;

// Two-key advisory locks keep account creation and canonical-owner claims
// independent while avoiding any schema change or table-wide lock.
const ACCOUNT_LOCK_NAMESPACE = 1129270341;
const OWNER_LOCK_NAMESPACE = 1129270342;
const MAX_OWNER_RESOLUTION_ATTEMPTS = 2;

function accountIdFromAuth(auth: AuthUserPayload): string | null {
  const accountId = String(auth.id || '').trim();
  return accountId || null;
}

function linkedWikidotIdFromAuth(auth: AuthUserPayload): number | null {
  const wikidotId = Number(auth.linkedWikidotId);
  return Number.isInteger(wikidotId) && wikidotId > 0 ? wikidotId : null;
}

async function findAccountMapping(
  db: Queryable,
  accountId: string,
  lock = false
): Promise<CollectionOwnerMapping | null> {
  const result = await db.query<CollectionOwnerMapping>(
    `
      SELECT
        cao."userId",
        u."wikidotId"
      FROM "CollectionAccountOwner" cao
      JOIN "User" u ON u.id = cao."userId"
      WHERE cao."accountId" = $1
      LIMIT 1
      ${lock ? 'FOR UPDATE OF cao' : ''}
    `,
    [accountId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    userId: Number(row.userId),
    wikidotId: row.wikidotId == null ? null : Number(row.wikidotId)
  };
}

async function ensureWikidotOwner(
  client: PoolClient,
  wikidotId: number
): Promise<number> {
  const existing = await client.query<{ id: number }>(
    'SELECT id FROM "User" WHERE "wikidotId" = $1 LIMIT 1 FOR UPDATE',
    [wikidotId]
  );
  if (existing.rows[0]) return Number(existing.rows[0].id);

  const inserted = await client.query<{ id: number }>(
    `
      INSERT INTO "User" ("wikidotId")
      VALUES ($1)
      ON CONFLICT ("wikidotId") DO NOTHING
      RETURNING id
    `,
    [wikidotId]
  );
  if (inserted.rows[0]) return Number(inserted.rows[0].id);

  // Another transaction may have inserted the canonical User concurrently.
  const retry = await client.query<{ id: number }>(
    'SELECT id FROM "User" WHERE "wikidotId" = $1 LIMIT 1 FOR UPDATE',
    [wikidotId]
  );
  if (!retry.rows[0]) {
    throw new Error('Unable to resolve canonical collection owner');
  }
  return Number(retry.rows[0].id);
}

async function createGuestOwner(
  client: PoolClient,
  auth: AuthUserPayload,
  accountId: string
): Promise<number> {
  const displayName = (auth.displayName && auth.displayName.trim().slice(0, 80))
    || (auth.email && auth.email.trim().slice(0, 80))
    || `账号用户 ${accountId.slice(0, 6)}`;
  const inserted = await client.query<{ id: number }>(
    `
      INSERT INTO "User" ("displayName", "isGuest")
      VALUES ($1, TRUE)
      RETURNING id
    `,
    [displayName]
  );
  const ownerId = Number(inserted.rows[0]?.id);
  if (!Number.isInteger(ownerId) || ownerId <= 0) {
    throw new Error('Unable to create collection owner');
  }
  return ownerId;
}

function mergedSlug(
  originalSlug: string,
  collectionId: number,
  usedSlugs: Set<string>
): string {
  const original = String(originalSlug || '').trim() || `collection-${collectionId}`;
  if (!usedSlugs.has(original)) return original;

  const base = `${original}-migrated-${collectionId}`;
  let candidate = base;
  let suffix = 2;
  while (usedSlugs.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * Move account-owned collections from a temporary/previous owner to the
 * Wikidot canonical User without deleting or recreating collections/items.
 *
 * Conflict policy:
 * - canonical-owner slugs win; a colliding source slug gets a deterministic
 *   `-migrated-<collectionId>` suffix (and a numeric suffix only if needed);
 * - an existing canonical default wins; otherwise the first source default is
 *   preserved;
 * - IDs, timestamps, visibility, metadata and every item remain untouched.
 * - if the merged total exceeds the normal creation limit, all existing data
 *   is still retained; the existing count guard simply blocks further creates.
 */
async function mergeCollections(
  client: PoolClient,
  sourceOwnerId: number,
  targetOwnerId: number
): Promise<void> {
  if (sourceOwnerId === targetOwnerId) return;

  const targetResult = await client.query<CollectionRowForMerge>(
    `
      SELECT id, slug, "isDefault"
      FROM "UserCollection"
      WHERE "ownerId" = $1
      ORDER BY id
      FOR UPDATE
    `,
    [targetOwnerId]
  );
  const sourceResult = await client.query<CollectionRowForMerge>(
    `
      SELECT id, slug, "isDefault"
      FROM "UserCollection"
      WHERE "ownerId" = $1
      ORDER BY id
      FOR UPDATE
    `,
    [sourceOwnerId]
  );

  const usedSlugs = new Set(targetResult.rows.map(row => String(row.slug)));
  let hasDefault = targetResult.rows.some(row => Boolean(row.isDefault));

  for (const row of sourceResult.rows) {
    const slug = mergedSlug(row.slug, Number(row.id), usedSlugs);
    const isDefault = Boolean(row.isDefault) && !hasDefault;
    if (isDefault) hasDefault = true;
    usedSlugs.add(slug);

    const migrated = await client.query(
      `
        UPDATE "UserCollection"
        SET "ownerId" = $1,
            slug = $2,
            "isDefault" = $3
        WHERE id = $4
          AND "ownerId" = $5
      `,
      [targetOwnerId, slug, isDefault, Number(row.id), sourceOwnerId]
    );
    if (migrated.rowCount !== 1) {
      throw new Error(`Unable to migrate collection ${Number(row.id)}`);
    }
  }
}

async function targetOwnerClaimedByAnotherAccount(
  client: PoolClient,
  targetOwnerId: number,
  accountId: string
): Promise<boolean> {
  const claim = await client.query<{ accountId: string }>(
    `
      SELECT "accountId"
      FROM "CollectionAccountOwner"
      WHERE "userId" = $1
        AND "accountId" <> $2
      LIMIT 1
    `,
    [targetOwnerId, accountId]
  );
  return claim.rows.length > 0;
}

async function insertAccountMapping(
  client: PoolClient,
  accountId: string,
  ownerId: number
): Promise<void> {
  await client.query(
    `
      INSERT INTO "CollectionAccountOwner" ("accountId", "userId")
      VALUES ($1, $2)
    `,
    [accountId, ownerId]
  );
}

async function lockOwners(
  client: PoolClient,
  ownerIds: Array<number | null | undefined>
): Promise<void> {
  const orderedOwnerIds = [...new Set(
    ownerIds
      .map(value => Number(value))
      .filter(value => Number.isInteger(value) && value > 0)
  )].sort((left, right) => left - right);

  // Deterministic ordering prevents opposite A→B / B→A reconciliations from
  // deadlocking while they lock both owners' collection rows.
  for (const ownerId of orderedOwnerIds) {
    await client.query(
      'SELECT pg_advisory_xact_lock($1::int, $2::int)',
      [OWNER_LOCK_NAMESPACE, ownerId]
    );
  }
}

async function resolveInTransaction(
  pool: Pool,
  auth: AuthUserPayload,
  accountId: string,
  linkedWikidotId: number | null
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock($1::int, hashtext($2))',
      [ACCOUNT_LOCK_NAMESPACE, accountId]
    );

    const mapping = await findAccountMapping(client, accountId, true);
    if (!linkedWikidotId) {
      if (mapping) {
        await client.query('COMMIT');
        return mapping.userId;
      }
      const guestOwnerId = await createGuestOwner(client, auth, accountId);
      await insertAccountMapping(client, accountId, guestOwnerId);
      await client.query('COMMIT');
      return guestOwnerId;
    }

    if (mapping?.wikidotId === linkedWikidotId) {
      await client.query('COMMIT');
      return mapping.userId;
    }

    const canonicalOwnerId = await ensureWikidotOwner(client, linkedWikidotId);
    await lockOwners(client, [mapping?.userId, canonicalOwnerId]);
    const canonicalClaimed = await targetOwnerClaimedByAnotherAccount(
      client,
      canonicalOwnerId,
      accountId
    );

    if (canonicalClaimed) {
      // A Wikidot identity takeover must never reveal another SCPper account's
      // private collections. Preserve this account's existing owner, or create
      // an isolated guest owner if it has never used collections before.
      const safeOwnerId = mapping?.userId
        ?? await createGuestOwner(client, auth, accountId);
      if (!mapping) {
        await insertAccountMapping(client, accountId, safeOwnerId);
      }
      await client.query('COMMIT');
      return safeOwnerId;
    }

    if (!mapping) {
      // Historical linked accounts already stored collections directly under
      // the Wikidot User. Claim that owner instead of creating a blank guest.
      await insertAccountMapping(client, accountId, canonicalOwnerId);
      await client.query('COMMIT');
      return canonicalOwnerId;
    }

    await mergeCollections(client, mapping.userId, canonicalOwnerId);
    const updatedMapping = await client.query(
      `
        UPDATE "CollectionAccountOwner"
        SET "userId" = $1
        WHERE "accountId" = $2
          AND "userId" = $3
      `,
      [canonicalOwnerId, accountId, mapping.userId]
    );
    if (updatedMapping.rowCount !== 1) {
      throw new Error('Collection owner mapping changed during reconciliation');
    }
    // Deliberately keep the now-unused source User row. Removing it here could
    // cascade through unrelated analytics relations and is not required for
    // stable collection ownership.
    await client.query('COMMIT');
    return canonicalOwnerId;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original error.
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Resolve a stable collection owner for an SCPper account.
 *
 * `CollectionAccountOwner` is authoritative once present. Linking Wikidot can
 * upgrade that owner to the canonical Wikidot User transactionally; unlinking
 * later keeps the same mapping, so private data never disappears merely
 * because the authentication profile changed.
 */
export async function resolveCollectionOwnerId(
  pool: Pool,
  auth: AuthUserPayload | null
): Promise<number | null> {
  if (!auth) return null;
  const accountId = accountIdFromAuth(auth);
  if (!accountId) return null;
  const linkedWikidotId = linkedWikidotIdFromAuth(auth);

  const mapping = await findAccountMapping(pool, accountId);
  if (
    mapping
    && (!linkedWikidotId || mapping.wikidotId === linkedWikidotId)
  ) {
    return mapping.userId;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_OWNER_RESOLUTION_ATTEMPTS; attempt += 1) {
    try {
      return await resolveInTransaction(pool, auth, accountId, linkedWikidotId);
    } catch (error) {
      lastError = error;
      // A unique race can occur while first claiming accountId/userId. The
      // whole transaction has rolled back, so one fresh attempt is safe.
      if ((error as { code?: string })?.code !== '23505') throw error;
    }
  }
  throw lastError;
}

/**
 * Pin an account's current collection owner for the remainder of the caller's
 * transaction. Call this only after BEGIN. Reconciliation uses the same lock,
 * so a create either commits before migration (and is migrated with the rest)
 * or observes the post-migration owner; it can never insert into an orphaned
 * source owner between resolution and write.
 */
export async function lockCollectionOwnerForWrite(
  client: PoolClient,
  auth: AuthUserPayload
): Promise<CollectionOwnerMapping | null> {
  const accountId = accountIdFromAuth(auth);
  if (!accountId) return null;

  await client.query(
    'SELECT pg_advisory_xact_lock($1::int, hashtext($2))',
    [ACCOUNT_LOCK_NAMESPACE, accountId]
  );
  return findAccountMapping(client, accountId, true);
}

export const __collectionOwnerTesting = {
  mergedSlug
};
