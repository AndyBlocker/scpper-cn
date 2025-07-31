// src/utils/Logger.js
const LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const CURRENT = LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LEVELS.INFO;

function log(level, prefix, msg) {
  if (LEVELS[level] < CURRENT) return;
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${prefix} ${msg}`);
}

export const Logger = {
  debug: (msg) => log('DEBUG', '⇢', msg),
  info:  (msg) => log('INFO',  'ℹ︎', msg),
  warn:  (msg) => log('WARN',  '⚠︎', msg),
  error: (err) => log('ERROR', '✖', err instanceof Error ? err.stack : err)
};
