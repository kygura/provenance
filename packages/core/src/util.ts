import { createHash, randomUUID } from 'node:crypto';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function runId(date = new Date()): string {
  return `run_${date.toISOString().replace(/[-:.]/g, '').slice(0, 15)}_${randomUUID().slice(0, 8)}`;
}

export function hashKey(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Safe division that yields undefined instead of Infinity/NaN. */
export function ratio(numerator?: number, denominator?: number): number | undefined {
  if (numerator === undefined || denominator === undefined) return undefined;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) return undefined;
  return numerator / denominator;
}

export function hoursBetween(a: string | Date, b: string | Date = new Date()): number {
  const t1 = typeof a === 'string' ? Date.parse(a) : a.getTime();
  const t2 = typeof b === 'string' ? Date.parse(b) : b.getTime();
  if (!Number.isFinite(t1) || !Number.isFinite(t2)) return Number.NaN;
  return Math.abs(t2 - t1) / 3_600_000;
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Return false to stop retrying and rethrow immediately. */
  retryable?: (error: unknown) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Minimum wait before the next attempt for this error (e.g. a 429's Retry-After). */
  minDelayMs?: (error: unknown) => number;
}

/** Exponential backoff with jitter. */
export async function retry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const base = options.baseDelayMs ?? 500;
  const max = options.maxDelayMs ?? 15_000;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (options.retryable && !options.retryable(error)) throw error;
      if (attempt === attempts) break;
      const backoff = Math.min(max, base * 2 ** (attempt - 1)) * (0.5 + Math.random() * 0.5);
      const delay = Math.max(backoff, options.minDelayMs?.(error) ?? 0);
      options.onRetry?.(error, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

/** Serialises calls and keeps a minimum gap between them. One per host. */
export class RateLimiter {
  private last = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly minGapMs: number) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      const wait = this.minGapMs - (Date.now() - this.last);
      if (wait > 0) await sleep(wait);
      try {
        return await fn();
      } finally {
        this.last = Date.now();
      }
    });
    this.queue = task.catch(() => undefined);
    return task as Promise<T>;
  }
}

/** Runs tasks with bounded concurrency, preserving input order in the result. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = cursor++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await fn(item, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function formatUsd(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return 'n/a';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  if (abs >= 1) return `$${value.toFixed(2)}`;
  return `$${value.toPrecision(3)}`;
}

export function formatPct(value?: number, digits = 1): string {
  if (value === undefined || !Number.isFinite(value)) return 'n/a';
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`;
}

export function shortAddress(address: string, lead = 4, tail = 4): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/** Errors that should abort rather than be retried (auth, bad request). */
export class FatalSourceError extends Error {
  constructor(message: string, readonly source: string) {
    super(message);
    this.name = 'FatalSourceError';
  }
}
