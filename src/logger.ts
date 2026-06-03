type Level = 'info' | 'warn' | 'error' | 'debug';

function log(level: Level, msg: string, meta?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const line = meta
    ? `[${ts}] ${level.toUpperCase()} ${msg} ${JSON.stringify(meta)}`
    : `[${ts}] ${level.toUpperCase()} ${msg}`;

  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  info:  (msg: string, meta?: Record<string, unknown>) => log('info',  msg, meta),
  warn:  (msg: string, meta?: Record<string, unknown>) => log('warn',  msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log('error', msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => log('debug', msg, meta),
};
