const READ_METHODS = new Set(['GET', 'HEAD']);
const NO_BODY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const hasPathPrefix = (path: string, prefix: string) =>
  path === prefix || path.startsWith(`${prefix}/`);

/**
 * Account-private reads must carry the identity from the last trusted
 * `/auth/me` snapshot. This closes the interval where another tab has changed
 * the shared session cookie but cross-tab storage delivery is unavailable or
 * delayed.
 *
 * BFF-owned routes are checked before their handlers run. Proxied
 * user-backend routes (`/gacha` and `/admin`) carry the same snapshot through
 * the proxy and are checked by `requireAuth` there. This is intentionally an
 * allow-list: public APIs must not become authentication dependent merely
 * because a signed-in browser happens to call them.
 */
export function isExpectedUserPrivateReadPath(path: string): boolean {
  if (path === '/auth/me' || hasPathPrefix(path, '/collections/public')) {
    return false;
  }

  if (
    hasPathPrefix(path, '/alerts')
    || hasPathPrefix(path, '/follows')
    || hasPathPrefix(path, '/collections')
    || hasPathPrefix(path, '/ftml-projects')
    || hasPathPrefix(path, '/gacha')
    || hasPathPrefix(path, '/admin')
  ) {
    return true;
  }

  return path === '/qq-binding/status'
    || path === '/wikidot-binding/status'
    || path === '/wikidot-binding/resolve';
}

export function normalizeBffRequestPath(request: unknown, bffBase: string): string {
  let raw = '';
  if (typeof request === 'string') {
    raw = request;
  } else if (request instanceof URL) {
    raw = request.toString();
  } else if (typeof Request !== 'undefined' && request instanceof Request) {
    raw = request.url;
  } else if (
    request
    && typeof request === 'object'
    && 'url' in request
    && typeof request.url === 'string'
  ) {
    raw = request.url;
  }

  if (!raw) return '/';

  let path: string;
  try {
    path = new URL(raw, 'http://scpper.local').pathname;
  } catch {
    path = raw.split(/[?#]/u, 1)[0] || '/';
  }

  let basePath = '';
  try {
    basePath = new URL(bffBase || '/', 'http://scpper.local').pathname;
  } catch {
    basePath = String(bffBase || '').split(/[?#]/u, 1)[0] || '';
  }
  basePath = basePath.replace(/\/+$/u, '');

  if (basePath && basePath !== '/') {
    if (path === basePath) {
      path = '/';
    } else if (path.startsWith(`${basePath}/`)) {
      path = path.slice(basePath.length);
    }
  }

  if (!path.startsWith('/')) path = `/${path}`;
  return path.replace(/\/+$/u, '') || '/';
}

interface ExpectedUserRequest {
  method?: string;
  request: unknown;
  bffBase: string;
  authStatus: string;
  authUserId: unknown;
}

type ExpectedUserMismatchRecovery = () => Promise<unknown> | unknown;

interface ExpectedUserRecoveryState {
  handler: ExpectedUserMismatchRecovery;
  inflight: Promise<void> | null;
}

const expectedUserRecoveryStates = new WeakMap<object, ExpectedUserRecoveryState>();

/**
 * Resolve the header value for one BFF call. Missing/unknown auth state never
 * creates a header, preserving anonymous use and old-server compatibility.
 */
export function expectedUserIdForRequest(input: ExpectedUserRequest): string | null {
  if (input.authStatus !== 'authenticated') return null;
  const userId = String(input.authUserId || '').trim();
  if (!userId) return null;

  const method = String(input.method || 'GET').toUpperCase();
  if (!NO_BODY_METHODS.has(method)) return userId;
  if (!READ_METHODS.has(method)) return null;

  const path = normalizeBffRequestPath(input.request, input.bffBase);
  return isExpectedUserPrivateReadPath(path) ? userId : null;
}

/**
 * Register session recovery without making the low-level BFF plugin import the
 * auth composable (which itself depends on `$bff`). The WeakMap is scoped by
 * Nuxt app, so SSR requests cannot share recovery state.
 */
export function registerExpectedUserMismatchRecovery(
  app: object,
  handler: ExpectedUserMismatchRecovery
) {
  const existing = expectedUserRecoveryStates.get(app);
  if (existing) {
    existing.handler = handler;
    return;
  }
  expectedUserRecoveryStates.set(app, { handler, inflight: null });
}

/**
 * A page can have several private requests in flight when a cookie changes.
 * Their 409 responses must collapse into one `/auth/me` revalidation.
 */
export function requestExpectedUserMismatchRecovery(app: object): Promise<void> | null {
  const state = expectedUserRecoveryStates.get(app);
  if (!state) return null;
  if (state.inflight) return state.inflight;

  let task: Promise<void>;
  try {
    task = Promise.resolve(state.handler()).then(
      () => undefined,
      () => undefined
    );
  } catch {
    task = Promise.resolve();
  }

  const recovery = task.finally(() => {
    if (state.inflight === recovery) {
      state.inflight = null;
    }
  });
  state.inflight = recovery;
  return recovery;
}
