import { type Logger, RateLimiter, retry } from '@provenance/core';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** 4xx other than 408/425/429 will not get better on a retry. */
function isRetryable(error: unknown): boolean {
  if (error instanceof HttpError) {
    if (error.status === 408 || error.status === 425 || error.status === 429) return true;
    return error.status >= 500;
  }
  return true; // network/DNS/abort-free timeouts are worth another go
}

export interface JsonClientOptions {
  baseUrl: string;
  rateLimitMs: number;
  logger: Logger;
  headers?: Record<string, string>;
  timeoutMs?: number;
  attempts?: number;
}

/**
 * One rate-limited, retrying JSON client per upstream host. SPEC requires every
 * network call to go through `RateLimiter` + `retry`, so sources never call
 * `fetch` directly.
 */
export class JsonClient {
  private readonly limiter: RateLimiter;

  constructor(private readonly options: JsonClientOptions) {
    this.limiter = new RateLimiter(Math.max(0, options.rateLimitMs));
  }

  async getJson<T = unknown>(path: string, signal?: AbortSignal): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.options.baseUrl}${path}`;
    const attempts = this.options.attempts ?? 3;
    const timeoutMs = this.options.timeoutMs ?? 20_000;

    return retry(
      () =>
        this.limiter.run(async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          const onAbort = () => controller.abort();
          signal?.addEventListener('abort', onAbort, { once: true });
          try {
            const response = await fetch(url, {
              headers: { accept: 'application/json', ...(this.options.headers ?? {}) },
              signal: controller.signal,
            });
            if (!response.ok) {
              throw new HttpError(`GET ${url} -> ${response.status}`, response.status, url);
            }
            return (await response.json()) as T;
          } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
          }
        }),
      {
        attempts,
        baseDelayMs: 800,
        retryable: isRetryable,
        onRetry: (error, attempt, delayMs) =>
          this.options.logger.debug('http retry', {
            url,
            attempt,
            delayMs: Math.round(delayMs),
            error: error instanceof Error ? error.message : String(error),
          }),
      },
    );
  }
}
