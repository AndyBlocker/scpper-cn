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

function requestTimeoutMs(): number {
  const configured = Number.parseInt(
    String(process.env.COLLECTION_CLAIM_TIMEOUT_MS || ''),
    10
  );
  if (!Number.isFinite(configured)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, configured));
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
  const normalizedAccountId = String(accountId || '').trim();
  if (
    !normalizedAccountId
    || !Number.isInteger(wikidotId)
    || wikidotId <= 0
  ) {
    return false;
  }

  const internalKey = (process.env.BFF_INTERNAL_API_KEY || '').trim();
  const configuredBase = process.env.USER_BACKEND_BASE_URL || USER_BACKEND_DEFAULT;
  if (!internalKey || configuredBase === 'disable') return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs());
  timeout.unref?.();

  try {
    const base = configuredBase.replace(/\/$/, '');
    const response = await fetch(
      `${base}/internal/account-identity/${encodeURIComponent(normalizedAccountId)}`,
      {
        headers: {
          'x-internal-key': internalKey
        },
        redirect: 'error',
        signal: controller.signal
      }
    );
    if (!response.ok) return false;

    const payload = await response.json() as AccountIdentityResponse;
    const account = payload?.account;
    const linkedWikidotId = Number(account?.linkedWikidotId);
    return Boolean(
      payload?.ok === true
      && account?.id === normalizedAccountId
      && account?.status === 'ACTIVE'
      && Number.isInteger(linkedWikidotId)
      && linkedWikidotId === wikidotId
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
