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
// Identity transitions are rare and touch two independently-owned mappings.
// Serializing only reconciliation keeps the lock graph acyclic without slowing
// stable private collection access.
const RECONCILE_LOCK_NAMESPACE = 1129270343;
const MAX_OWNER_RESOLUTION_ATTEMPTS = 3;

export type RefreshAuthUser = () => Promise<AuthUserPayload | null>;

async function refreshMatchesIdentity(
  refreshAuth: RefreshAuthUser | undefined,
  accountId: string,
  linkedWikidotId: number | null
): Promise<boolean> {
  if (!refreshAuth) return false;
  try {
    const freshAuth = await refreshAuth();
    return Boolean(
      freshAuth
      && accountIdFromAuth(freshAuth) === accountId
      && linkedWikidotIdFromAuth(freshAuth) === linkedWikidotId
    );
  } catch {
    return false;
  }
}

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
  auth: Pick<AuthUserPayload, 'displayName' | 'email'>,
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
 * - IDs, metadata and every item remain untouched. Normal merges preserve
 *   timestamps/visibility; identity transitions deliberately unpublish moved
 *   collections and update their `updatedAt`.
 * - if the merged total exceeds the normal creation limit, all existing data
 *   is still retained; the existing count guard simply blocks further creates.
 */
async function mergeCollections(
  client: PoolClient,
  sourceOwnerId: number,
  targetOwnerId: number,
  makePrivate = false
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
      makePrivate
        ? `
          UPDATE "UserCollection"
          SET "ownerId" = $1,
              slug = $2,
              "isDefault" = $3,
              visibility = 'PRIVATE',
              "publishedAt" = NULL,
              "updatedAt" = NOW()
          WHERE id = $4
            AND "ownerId" = $5
        `
        : `
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

async function updateAccountMapping(
  client: PoolClient,
  accountId: string,
  sourceOwnerId: number,
  targetOwnerId: number
): Promise<void> {
  const updatedMapping = await client.query(
    `
      UPDATE "CollectionAccountOwner"
      SET "userId" = $1
      WHERE "accountId" = $2
        AND "userId" = $3
    `,
    [targetOwnerId, accountId, sourceOwnerId]
  );
  if (updatedMapping.rowCount !== 1) {
    throw new Error('Collection owner mapping changed during reconciliation');
  }
}

/**
 * Release a canonical Wikidot owner without leaving account data behind.
 *
 * A canonical identity can later belong to another SCPper account. Before the
 * claim is released, every collection moves to an isolated guest owner. Public
 * collections are made private because their old Wikidot attribution is no
 * longer valid; private notes and item annotations remain attached to the same
 * collection IDs and therefore stay with the original SCPper account.
 */
async function detachCanonicalOwner(
  client: PoolClient,
  auth: AuthUserPayload,
  accountId: string,
  mapping: CollectionOwnerMapping
): Promise<CollectionOwnerMapping> {
  if (mapping.wikidotId == null) return mapping;

  const guestOwnerId = await createGuestOwner(client, auth, accountId);
  // The guest row was created in this transaction and cannot be observed by a
  // competing transaction. Locking both ids still keeps collection movement
  // consistent with every other reconciliation path.
  await lockOwners(client, [mapping.userId, guestOwnerId]);
  await mergeCollections(client, mapping.userId, guestOwnerId, true);
  await updateAccountMapping(client, accountId, mapping.userId, guestOwnerId);
  return { userId: guestOwnerId, wikidotId: null };
}

interface LockedCanonicalClaim {
  accountId: string;
  userId: number;
}

async function lockCanonicalClaim(
  client: PoolClient,
  targetOwnerId: number,
  accountId: string
): Promise<LockedCanonicalClaim | null> {
  const claim = await client.query<LockedCanonicalClaim>(
    `
      SELECT "accountId", "userId"
      FROM "CollectionAccountOwner"
      WHERE "userId" = $1
        AND "accountId" <> $2
      LIMIT 1
      FOR UPDATE
    `,
    [targetOwnerId, accountId]
  );
  const row = claim.rows[0];
  if (!row) return null;
  return {
    accountId: String(row.accountId),
    userId: Number(row.userId)
  };
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
  linkedWikidotId: number | null,
  refreshAuth: RefreshAuthUser | undefined
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Always acquire this before any account/mapping/owner lock. Two opposite
    // X→Y / Y→X rebinds can otherwise each hold its own mapping while waiting
    // for the other. Private operations never request this lock.
    await client.query(
      'SELECT pg_advisory_xact_lock($1::int, $2::int)',
      [RECONCILE_LOCK_NAMESPACE, 0]
    );
    await client.query(
      'SELECT pg_advisory_xact_lock($1::int, hashtext($2))',
      [ACCOUNT_LOCK_NAMESPACE, accountId]
    );

    let mapping = await findAccountMapping(client, accountId, true);
    if (!linkedWikidotId) {
      if (mapping) {
        if (
          mapping.wikidotId != null
          && !await refreshMatchesIdentity(refreshAuth, accountId, null)
        ) {
          // A stale in-flight unlink snapshot must not undo a newer relink.
          // Preserve the pinned mapping when freshness cannot be proven.
          await client.query('COMMIT');
          return mapping.userId;
        }
        // Unlinking must release the canonical Wikidot claim. Keeping the
        // mapping on that User forever prevents a later legitimate account
        // from using public collections for the same Wikidot identity.
        mapping = await detachCanonicalOwner(client, auth, accountId, mapping);
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
    // Lock the claimant mapping before owner advisory locks. Private collection
    // access holds the same mapping row for its whole operation, so takeover
    // waits for in-flight access and then changes ownership atomically.
    const canonicalClaim = await lockCanonicalClaim(
      client,
      canonicalOwnerId,
      accountId
    );

    // The route's first auth read may have completed before an administrator
    // transferred this Wikidot identity. Re-read /auth/me only after the
    // claimant row is pinned (or immediately before claiming an empty target).
    // If user-backend is unavailable or the identity changed, preserve this
    // account's current isolated owner and make no canonical ownership change.
    if (!await refreshMatchesIdentity(
      refreshAuth,
      accountId,
      linkedWikidotId
    )) {
      const safeOwnerId = mapping?.userId
        ?? await createGuestOwner(client, auth, accountId);
      if (!mapping) {
        await insertAccountMapping(client, accountId, safeOwnerId);
      }
      await client.query('COMMIT');
      return safeOwnerId;
    }

    if (canonicalClaim) {
      // `linkedWikidotId` is the current, uniqueness-checked identity snapshot
      // from user-backend. The new verified account may therefore take over
      // immediately; the previous SCPper account does not need to make another
      // request before the canonical Wikidot owner is released.
      const previousAccountGuestId = await createGuestOwner(
        client,
        { displayName: null, email: '' },
        canonicalClaim.accountId
      );
      await lockOwners(client, [
        mapping?.userId,
        canonicalOwnerId,
        previousAccountGuestId
      ]);

      // Move every old account collection—including private notes/items—to an
      // isolated guest and fail closed by unpublishing it. The locked claimant
      // mapping row coordinates this move with every private collection route.
      await mergeCollections(
        client,
        canonicalOwnerId,
        previousAccountGuestId,
        true
      );
      await updateAccountMapping(
        client,
        canonicalClaim.accountId,
        canonicalOwnerId,
        previousAccountGuestId
      );

      if (!mapping) {
        await insertAccountMapping(client, accountId, canonicalOwnerId);
      } else {
        await mergeCollections(client, mapping.userId, canonicalOwnerId, true);
        await updateAccountMapping(
          client,
          accountId,
          mapping.userId,
          canonicalOwnerId
        );
      }
      await client.query('COMMIT');
      return canonicalOwnerId;
    }

    await lockOwners(client, [mapping?.userId, canonicalOwnerId]);

    if (!mapping) {
      // Historical linked accounts already stored collections directly under
      // the Wikidot User. Claim that owner instead of creating a blank guest.
      await insertAccountMapping(client, accountId, canonicalOwnerId);
      await client.query('COMMIT');
      return canonicalOwnerId;
    }

    // Any owner transition changes the public identity under which collections
    // are displayed. Fail closed by unpublishing before the move; users can
    // explicitly publish again after the new Wikidot link is confirmed.
    await mergeCollections(client, mapping.userId, canonicalOwnerId, true);
    await updateAccountMapping(client, accountId, mapping.userId, canonicalOwnerId);
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
 * upgrade that owner to the canonical Wikidot User transactionally. Unlinking
 * detaches the account to a private guest owner, preserving its collection
 * IDs/data while releasing the canonical identity for a future verified owner.
 */
export async function resolveCollectionOwnerId(
  pool: Pool,
  auth: AuthUserPayload | null,
  refreshAuth?: RefreshAuthUser
): Promise<number | null> {
  if (!auth) return null;
  const accountId = accountIdFromAuth(auth);
  if (!accountId) return null;
  const linkedWikidotId = linkedWikidotIdFromAuth(auth);

  const mapping = await findAccountMapping(pool, accountId);
  if (
    mapping
    && (
      (linkedWikidotId == null && mapping.wikidotId == null)
      || (linkedWikidotId != null && mapping.wikidotId === linkedWikidotId)
    )
  ) {
    return mapping.userId;
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_OWNER_RESOLUTION_ATTEMPTS; attempt += 1) {
    try {
      return await resolveInTransaction(
        pool,
        auth,
        accountId,
        linkedWikidotId,
        refreshAuth
      );
    } catch (error) {
      lastError = error;
      // A unique race can occur while first claiming accountId/userId. The
      // whole transaction has rolled back, so one fresh attempt is safe.
      const code = (error as { code?: string })?.code;
      if (code !== '23505' && code !== '40P01' && code !== '40001') throw error;
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
export async function lockCollectionOwnerForAccess(
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

// Backward-compatible name for callers outside the collection routes.
export const lockCollectionOwnerForWrite = lockCollectionOwnerForAccess;

/**
 * Resolve any pending identity transition, then keep the account mapping pinned
 * while an owner-dependent operation runs. A bare User.id is not an
 * authorization capability: canonical ids can be released and claimed by a
 * different account, so callers must not use a resolved id after this
 * transaction has ended.
 */
export async function withLockedCollectionOwner<T>(
  pool: Pool,
  auth: AuthUserPayload,
  operation: (
    client: PoolClient,
    mapping: CollectionOwnerMapping
  ) => Promise<T>,
  refreshAuth?: RefreshAuthUser
): Promise<T | null> {
  const resolvedOwnerId = await resolveCollectionOwnerId(
    pool,
    auth,
    refreshAuth
  );
  if (resolvedOwnerId == null) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const mapping = await lockCollectionOwnerForAccess(client, auth);
    if (!mapping) {
      await client.query('ROLLBACK');
      return null;
    }
    const result = await operation(client, mapping);
    await client.query('COMMIT');
    return result;
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

export const __collectionOwnerTesting = {
  mergedSlug
};
