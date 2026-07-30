const USER_BACKEND_DEFAULT = 'http://127.0.0.1:4455';
const DEFAULT_TIMEOUT_MS = 1_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 5_000;

interface AccountIdentityResponse {
  ok?: unknown;
  account?: {
    id?: unknown;
    linkedWikidotId?: unknown;
    status?: unknown;
  };
}

type AccountIdentity = NonNullable<AccountIdentityResponse['account']>;

function requestTimeoutMs(): number {
  const configured = Number.parseInt(
    String(process.env.COLLECTION_CLAIM_TIMEOUT_MS || ''),
    10
  );
  if (!Number.isFinite(configured)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, configured));
}

async function fetchAccountIdentity(path: string): Promise<AccountIdentityResponse | null> {
  const internalKey = (process.env.BFF_INTERNAL_API_KEY || '').trim();
  const configuredBase = process.env.USER_BACKEND_BASE_URL || USER_BACKEND_DEFAULT;
  if (!internalKey || configuredBase === 'disable') return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs());
  timeout.unref?.();

  try {
    const base = configuredBase.replace(/\/$/, '');
    const response = await fetch(`${base}${path}`, {
      headers: {
        'x-internal-key': internalKey
      },
      redirect: 'error',
      signal: controller.signal
    });
    if (!response.ok) return null;
    return await response.json() as AccountIdentityResponse;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function isActiveWikidotClaim(
  payload: AccountIdentityResponse | null,
  wikidotId: number,
  expectedAccountId?: string
): payload is AccountIdentityResponse & { account: AccountIdentity } {
  const account = payload?.account;
  const accountId = typeof account?.id === 'string' ? account.id : '';
  const linkedWikidotId = account?.linkedWikidotId;
  return Boolean(
    payload?.ok === true
    && accountId
    && accountId === accountId.trim()
    && (expectedAccountId === undefined || accountId === expectedAccountId)
    && account?.status === 'ACTIVE'
    && typeof linkedWikidotId === 'number'
    && Number.isInteger(linkedWikidotId)
    && linkedWikidotId === wikidotId
  );
}

/**
 * Confirm that the account currently owns the requested Wikidot identity.
 *
 * The BFF mapping records which account last reconciled a collection owner,
 * while user-backend is authoritative for the live binding. Public reads are
 * allowed only when both sources agree. Every error fails closed.
 */
export async function accountCurrentlyClaimsWikidotId(
  accountId: string,
  wikidotId: number
): Promise<boolean> {
  const rawAccountId = String(accountId || '');
  const normalizedAccountId = rawAccountId.trim();
  if (
    !normalizedAccountId
    || normalizedAccountId !== rawAccountId
    || !Number.isInteger(wikidotId)
    || wikidotId <= 0
  ) {
    return false;
  }

  const payload = await fetchAccountIdentity(
    `/internal/account-identity/${encodeURIComponent(normalizedAccountId)}`
  );
  return isActiveWikidotClaim(payload, wikidotId, normalizedAccountId);
}

/**
 * Resolve a legacy canonical owner that has not been claimed in the BFF yet.
 *
 * Callers must use this only after confirming that the canonical owner has no
 * CollectionAccountOwner row. Once such a row exists, that account is the only
 * authority and a failed verification must never fall back to this lookup.
 */
export async function activeAccountClaimsWikidotId(
  wikidotId: number
): Promise<boolean> {
  if (!Number.isInteger(wikidotId) || wikidotId <= 0) return false;
  const payload = await fetchAccountIdentity(
    `/internal/account-identity/by-wikidot/${encodeURIComponent(String(wikidotId))}`
  );
  return isActiveWikidotClaim(payload, wikidotId);
}
