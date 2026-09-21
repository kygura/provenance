/** Minimal leveled logger to stderr, so stdout stays the report. */

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold = ORDER.info;

export function setVerbose(verbose: boolean): void {
  threshold = verbose ? ORDER.debug : ORDER.info;
}

function emit(level: Level, message: string): void {
  if (ORDER[level] < threshold) return;
  const stamp = new Date().toISOString().slice(11, 19);
  process.stderr.write(`${stamp} ${level.toUpperCase().padEnd(5)} ${message}\n`);
}

export const log = {
  debug: (m: string) => emit("debug", m),
  info: (m: string) => emit("info", m),
  warn: (m: string) => emit("warn", m),
  error: (m: string) => emit("error", m),
};
