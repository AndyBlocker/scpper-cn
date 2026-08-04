/**
 * 日志：**一切都走 stderr**。
 *
 * 沿用 monitor-bridge 已在生产验证过的 CLI 契约（syncer/src/cli/monitor-bridge.ts:16）：
 *   stdout 只允许出现最后那一行 JSON 摘要，调度器可以直接 `JSON.parse(stdout)`。
 * 因此这里同时把 console.* 整体劫持到 stderr —— 第三方库（@ukwhatn/wikidot 的
 * connect()/setupProxy() 等）用 console.log 打进度，一旦漏到 stdout 就会污染摘要。
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentThreshold(): number {
  const raw = (process.env.SYNCER2_LOG_LEVEL ?? 'info').toLowerCase();
  return LEVEL_ORDER[raw as Level] ?? LEVEL_ORDER.info;
}

function write(level: Level, scope: string, message: string, extra?: unknown): void {
  if (LEVEL_ORDER[level] < currentThreshold()) return;
  const ts = new Date().toISOString();
  let line = `${ts} [${level}] [${scope}] ${message}`;
  if (extra !== undefined) {
    try {
      line += ' ' + JSON.stringify(extra);
    } catch {
      line += ' ' + String(extra);
    }
  }
  process.stderr.write(line + '\n');
}

export interface Logger {
  debug(message: string, extra?: unknown): void;
  info(message: string, extra?: unknown): void;
  warn(message: string, extra?: unknown): void;
  error(message: string, extra?: unknown): void;
  child(subScope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, e) => write('debug', scope, m, e),
    info: (m, e) => write('info', scope, m, e),
    warn: (m, e) => write('warn', scope, m, e),
    error: (m, e) => write('error', scope, m, e),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

/**
 * 把 console.log/info/warn/debug 全部改道 stderr。
 * 必须在 import 任何第三方库**之前**（或至少在调用它们之前）执行。
 */
export function redirectConsoleToStderr(): void {
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(
      args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ') + '\n',
    );
  };
  console.log = toStderr as typeof console.log;
  console.info = toStderr as typeof console.info;
  console.warn = toStderr as typeof console.warn;
  console.debug = toStderr as typeof console.debug;
  console.error = toStderr as typeof console.error;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** stdout 的唯一合法出口：单行 JSON 摘要。 */
export function emitSummary(summary: unknown): void {
  process.stdout.write(JSON.stringify(summary) + '\n');
}
