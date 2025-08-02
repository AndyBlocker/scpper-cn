// src/utils/Logger.js
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const CURRENT = LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LEVELS.INFO;

function log(level, prefix, msg) {
  if (LEVELS[level] < CURRENT) return;
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${prefix} ${msg}`);
}

export const Logger = {
  debug: (msg, extra) => {
    if (extra) {
      log('DEBUG', '⇢', `${msg} ${JSON.stringify(extra, null, 2)}`);
    } else {
      log('DEBUG', '⇢', msg);
    }
  },
  info:  (msg, extra) => {
    if (extra) {
      log('INFO', 'ℹ︎', `${msg} ${JSON.stringify(extra, null, 2)}`);
    } else {
      log('INFO', 'ℹ︎', msg);
    }
  },
  warn:  (msg, extra) => {
    if (extra) {
      log('WARN', '⚠︎', `${msg} ${JSON.stringify(extra, null, 2)}`);
    } else {
      log('WARN', '⚠︎', msg);
    }
  },
  error: (msg, extra) => {
    if (extra instanceof Error) {
      log('ERROR', '✖', `${msg}\n${extra.stack || extra.message}`);
    } else if (extra) {
      log('ERROR', '✖', `${msg}\n${JSON.stringify(extra, null, 2)}`);
    } else {
      log('ERROR', '✖', msg instanceof Error ? msg.stack : msg);
    }
  }
};
