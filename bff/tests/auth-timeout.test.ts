import type { Request } from 'express';
import { fetchFreshAuthUser } from '../src/web/utils/auth';

const originalFetch = global.fetch;
const originalTimeout = process.env.USER_BACKEND_AUTH_TIMEOUT_MS;

function hangingFetch() {
  let signal: AbortSignal | undefined;
  const mock = jest.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      const rejectAsAborted = () => {
        const error = new Error('This operation was aborted');
        error.name = 'AbortError';
        reject(error);
      };

      if (!signal) {
        reject(new Error('fetch was called without an abort signal'));
      } else if (signal.aborted) {
        rejectAsAborted();
      } else {
        signal.addEventListener('abort', rejectAsAborted, { once: true });
      }
    });
  });
  global.fetch = mock as unknown as typeof fetch;
  return {
    mock,
    signal: () => signal
  };
}

describe('user-backend auth timeout', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    global.fetch = originalFetch;
    if (originalTimeout === undefined) {
      delete process.env.USER_BACKEND_AUTH_TIMEOUT_MS;
    } else {
      process.env.USER_BACKEND_AUTH_TIMEOUT_MS = originalTimeout;
    }
  });

  test('aborts a hanging auth fetch and fails closed within the minimum bound', async () => {
    process.env.USER_BACKEND_AUTH_TIMEOUT_MS = '1';
    const pendingFetch = hangingFetch();
    const pendingAuth = fetchFreshAuthUser({
      headers: { cookie: 'session=account-a' }
    } as Request);

    await jest.advanceTimersByTimeAsync(99);
    expect(pendingFetch.signal()?.aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    await expect(pendingAuth).resolves.toBeNull();
    expect(pendingFetch.signal()?.aborted).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(
      '[fetchAuthUser] user-backend timed out after 100ms'
    );
  });

  test('caps an excessive timeout so auth cannot hold callers indefinitely', async () => {
    process.env.USER_BACKEND_AUTH_TIMEOUT_MS = '60000';
    const pendingFetch = hangingFetch();
    const pendingAuth = fetchFreshAuthUser({
      headers: {}
    } as Request);

    await jest.advanceTimersByTimeAsync(4_999);
    expect(pendingFetch.signal()?.aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    await expect(pendingAuth).resolves.toBeNull();
    expect(pendingFetch.signal()?.aborted).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(
      '[fetchAuthUser] user-backend timed out after 5000ms'
    );
  });
});
