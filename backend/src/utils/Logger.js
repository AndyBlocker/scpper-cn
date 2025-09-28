// src/utils/Logger.js
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const CURRENT = LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LEVELS.INFO;
const INFO_THROTTLE_ENABLED = process.env.LOG_INFO_THROTTLE !== '0';
const INFO_MIN_INTERVAL_MS = Number.parseInt(process.env.LOG_INFO_MIN_INTERVAL_MS || '', 10) || 500;
let lastInfoLogTime = 0;

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    try {
      return String(value);
    } catch {
      return '[Unserializable]';
    }
  }
}

function log(level, prefix, msg) {
  if (LEVELS[level] < CURRENT) return;
  if (level === 'INFO' && INFO_THROTTLE_ENABLED) {
    const now = Date.now();
    if (now - lastInfoLogTime < INFO_MIN_INTERVAL_MS) return;
    lastInfoLogTime = now;
  }
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${prefix} ${msg}`;
  if (process.env.LOG_TO_STDOUT === '1') {
    // Fallback to stdout when explicitly requested
    // eslint-disable-next-line no-console
    console.log(line);
  } else {
    // Default: write logs to stderr to avoid breaking progress bars on stdout
    try {
      process.stderr.write(line + "\n");
    } catch {
      // eslint-disable-next-line no-console
      console.log(line);
    }
  }
}

export const Logger = {
  debug: (msg, extra) => {
    if (extra) {
      log('DEBUG', '⇢', `${msg} ${safeStringify(extra)}`);
    } else {
      log('DEBUG', '⇢', msg);
    }
  },
  info:  (msg, extra) => {
    if (extra) {
      log('INFO', 'ℹ︎', `${msg} ${safeStringify(extra)}`);
    } else {
      log('INFO', 'ℹ︎', msg);
    }
  },
  warn:  (msg, extra) => {
    if (extra) {
      log('WARN', '⚠︎', `${msg} ${safeStringify(extra)}`);
    } else {
      log('WARN', '⚠︎', msg);
    }
  },
  error: (msg, extra) => {
    if (extra instanceof Error) {
      log('ERROR', '✖', `${msg}\n${extra.stack || extra.message}`);
    } else if (extra) {
      log('ERROR', '✖', `${msg}\n${safeStringify(extra)}`);
    } else {
      log('ERROR', '✖', msg instanceof Error ? msg.stack : msg);
    }
  }
};
