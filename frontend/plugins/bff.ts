import type { FetchOptions } from 'ofetch';
import consola from 'consola';

type DebugMeta = {
  startAt: number;
  method: string;
  targetPath: string;
  targetDisplay: string;
  route: string;
  isServer: boolean;
  shouldLogStart: boolean;
};

export default defineNuxtPlugin((nuxtApp) => {
  const config = useRuntimeConfig();
  const publicConfig = config.public as Record<string, unknown>;
  const bffBase: string = String(publicConfig.bffBase || '/api');
  const debugFetchTimings = parseBoolean(publicConfig.debugFetchTimings, false);
  const debugFetchMinDurationMs = parseNumber(publicConfig.debugFetchMinDurationMs, 0);
  const slowFetchThresholdMs = parseNumber(publicConfig.slowFetchThresholdMs, 800);

  if (nuxtApp.ssrContext) {
    nuxtApp.hook('app:rendered', () => {
      const event = nuxtApp.ssrContext?.event;
      if (!event) return;
      const timingsRaw = (event.context as Record<string, any>).__bffTimings;
      if (Array.isArray(timingsRaw) && timingsRaw.length) {
        const timings = timingsRaw as TimingEntry[];
        const slowest = timings.reduce((acc, entry) => Math.max(acc, entry.durationMs), 0);
        const slowCount = timings.filter((entry) => entry.isSlow || entry.isError).length;
        const ssrRoute = event.path || timings[0]?.route || '';
        if (slowCount > 0 || slowest >= slowFetchThresholdMs) {
          consola.info(
            `[bff] ▲ summary ${ssrRoute} fetched ${timings.length} resources, slow/error: ${slowCount}, slowest: ${slowest.toFixed(1)}ms`
          );
        }
        nuxtApp.payload.state = nuxtApp.payload.state || {};
        (nuxtApp.payload.state as Record<string, any>).__bffTimings = timings;
      }
    });
  } else if (typeof window !== 'undefined') {
    nuxtApp.hook('app:mounted', () => {
      const payloadTimings = (nuxtApp.payload.state as any)?.__bffTimings;
      if (Array.isArray(payloadTimings) && payloadTimings.length) {
        const global = window as unknown as Record<string, any>;
        if (!Array.isArray(global.__BFF_TIMINGS__)) {
          global.__BFF_TIMINGS__ = [];
        }
        global.__BFF_TIMINGS__.push(...payloadTimings);
        try {
          console.groupCollapsed('[bff] SSR fetch timings');
          console.table(payloadTimings.map(formatTimingForTable));
          console.groupEnd();
        } catch {
          console.log('[bff] SSR fetch timings', payloadTimings);
        }
        delete (nuxtApp.payload.state as any).__bffTimings;
      }
    });
  }

  const api = $fetch.create({
    baseURL: bffBase,
    headers: { accept: 'application/json' },
    credentials: 'include',
    onRequest({ request, options }) {
      const isServer = typeof window === 'undefined';
      const clientDebugFlag = !isServer && hasClientDebugFlag();
      const shouldLogStart = debugFetchTimings || clientDebugFlag;
      const method = String(options.method || 'GET').toUpperCase();
      const targetInfo = resolveTargetInfo(request);
      const startAt = now();

      (options as any)._debugFetch = {
        startAt,
        method,
        targetPath: targetInfo.path,
        targetDisplay: targetInfo.display,
        isServer,
        route: resolveRoutePath(),
        shouldLogStart
      } satisfies DebugMeta;

      if (shouldLogStart) {
        const routeHint = (options as any)._debugFetch.route;
        consola.info(`[bff] ▶ ${method} ${targetInfo.display}${routeHint ? ` from ${routeHint}` : ''}`);
      }
    },
    onResponse({ options, response }) {
      handleResponseDebug(options, response.status);
    },
    onResponseError({ options, response }) {
      const status = response?.status ?? 0;
      handleResponseDebug(options, status, true);
    }
  });

  return {
    provide: {
      bff: api
    }
  };

  function handleResponseDebug(fetchOptions: FetchOptions, status: number, isError = false) {
    const debugMeta = (fetchOptions as any)?._debugFetch as DebugMeta | undefined;
    if (!debugMeta) return;
    const durationMs = now() - debugMeta.startAt;

    const statusLabel = status || 0;
    const target = debugMeta.targetDisplay || debugMeta.targetPath;
    const surface = debugMeta.isServer ? 'server' : 'client';
    const routeHint = debugMeta.route;
    const locationHint = routeHint ? ` from ${routeHint}` : '';
    const isSlow = slowFetchThresholdMs > 0 && durationMs >= slowFetchThresholdMs;
    recordTimingEntry({
      route: routeHint,
      method: debugMeta.method,
      status: statusLabel,
      durationMs,
      surface,
      target: debugMeta.targetPath,
      targetDisplay: target,
      isSlow,
      isError: isError || statusLabel >= 400,
      timestamp: Date.now()
    });
    const shouldLog =
      debugMeta.shouldLogStart ||
      isSlow ||
      (debugFetchMinDurationMs > 0 && durationMs >= debugFetchMinDurationMs) ||
      isError ||
      statusLabel >= 400;
    if (shouldLog) {
      const emoji = isError || statusLabel >= 400 ? '✖' : isSlow ? '⚠' : '✔';
      const prefix = isSlow && !isError && statusLabel < 400 ? ' slow fetch' : '';
      consola.info(
        `[bff] ${emoji}${prefix ? prefix : ''} ${statusLabel} ${debugMeta.method} ${target}${locationHint} in ${durationMs.toFixed(1)}ms (${surface})`
      );
    }
    delete (fetchOptions as any)._debugFetch;
  }

  function now(): number {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    if (typeof process !== 'undefined' && typeof process.hrtime === 'function') {
      const [sec, nano] = process.hrtime();
      return sec * 1000 + nano / 1e6;
    }
    return Date.now();
  }

  function hasClientDebugFlag(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }
    try {
      if ((window as any).__BFF_DEBUG__ === true) {
        return true;
      }
      const marker = window.localStorage?.getItem('debug:bff');
      return marker === '1' || marker === 'true';
    } catch {
      return false;
    }
  }

  function resolveRoutePath(): string {
    const currentRoute = (nuxtApp as any)._route;
    if (currentRoute && typeof currentRoute.fullPath === 'string') {
      return currentRoute.fullPath;
    }
    const event = nuxtApp.ssrContext?.event;
    if (event && typeof (event as any).path === 'string') {
      return String((event as any).path);
    }
    const router = (nuxtApp.$router as any) || (nuxtApp.vueApp?.config?.globalProperties as any)?.$router;
    const route = router?.currentRoute?.value;
    if (route && typeof route.fullPath === 'string') {
      return route.fullPath;
    }
    return '';
  }

  type TimingEntry = {
    route: string | undefined;
    method: string;
    status: number;
    durationMs: number;
    surface: string;
    target: string;
    targetDisplay: string;
    isSlow: boolean;
    isError: boolean;
    timestamp: number;
  };

  function recordTimingEntry(entry: TimingEntry) {
    if (nuxtApp.ssrContext?.event) {
      const context = nuxtApp.ssrContext.event.context as Record<string, any>;
      if (!context.__bffTimings) context.__bffTimings = [];
      context.__bffTimings.push(entry);
    } else if (typeof window !== 'undefined') {
      const global = window as unknown as Record<string, any>;
      if (!Array.isArray(global.__BFF_TIMINGS__)) {
        global.__BFF_TIMINGS__ = [];
      }
      global.__BFF_TIMINGS__.push(entry);
    }
  }

  function formatTimingForTable(entry: TimingEntry) {
    return {
      method: entry.method,
      status: entry.status,
      durationMs: Number(entry.durationMs.toFixed(1)),
      surface: entry.surface,
      route: entry.route || '(unknown)',
      target: entry.targetDisplay || entry.target,
      slow: entry.isSlow,
      error: entry.isError
    };
  }

  function parseBoolean(value: unknown, fallback: boolean): boolean {
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
      if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    }
    return fallback;
  }

  function parseNumber(value: unknown, fallback: number): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function resolveTargetInfo(request: string | Request | URL | any) {
    let path = '';
    if (typeof request === 'string') {
      path = request;
    } else if (request instanceof Request || request instanceof URL) {
      path = request.url;
    } else if (request && typeof request === 'object' && typeof request.url === 'string') {
      path = request.url;
    }
    if (!path) path = '/';

    const display = toAbsoluteUrl(path, bffBase) || path;
    return { path, display };
  }

  function toAbsoluteUrl(path: string, base: string): string | null {
    if (!path) return null;
    if (/^https?:\/\//i.test(path)) return path;
    if (!base) return null;

    try {
      if (/^https?:\/\//i.test(base)) {
        return new URL(path, ensureTrailingSlash(base)).toString();
      }
      if (typeof window !== 'undefined' && window.location) {
        return new URL(joinPaths(base, path), window.location.origin).toString();
      }
    } catch {
      return null;
    }
    return null;
  }

  function ensureTrailingSlash(url: string): string {
    return url.endsWith('/') ? url : `${url}/`;
  }

  function joinPaths(base: string, path: string): string {
    if (!base) return path;
    if (path.startsWith('/')) {
      return base.endsWith('/') ? `${base.slice(0, -1)}${path}` : `${base}${path}`;
    }
    return base.endsWith('/') ? `${base}${path}` : `${base}/${path}`;
  }
});
