export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

function emit(level: LogLevel, min: LogLevel, scope: string, msg: string, meta?: Record<string, unknown>) {
  if (ORDER[level] < ORDER[min]) return;
  const time = new Date().toISOString();
  const tail = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  const line = `${time} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${tail}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export function createLogger(min: LogLevel = 'info', scope = 'provenance'): Logger {
  return {
    debug: (m, meta) => emit('debug', min, scope, m, meta),
    info: (m, meta) => emit('info', min, scope, m, meta),
    warn: (m, meta) => emit('warn', min, scope, m, meta),
    error: (m, meta) => emit('error', min, scope, m, meta),
    child: (child) => createLogger(min, `${scope}:${child}`),
  };
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silentLogger,
};
