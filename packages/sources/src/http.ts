import { type Logger, RateLimiter, redactUrl, retry } from '@provenance/core';

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
  /** The URL carries a credential (a keyed RPC endpoint): keep it out of errors and logs. */
  redact?: boolean;
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
    return this.request<T>('GET', path, undefined, signal);
  }

  /** GET the raw body, for pages and endpoints whose shape is not known up front. */
  async getText(path: string, signal?: AbortSignal): Promise<string> {
    return this.request<string>('GET', path, undefined, signal, 'text');
  }

  /**
   * POST a JSON body and parse a JSON reply. JSON-RPC is the only caller; it
   * rides the same limiter and retry policy as every GET so public nodes see
   * the same etiquette.
   */
  async postJson<T = unknown>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>('POST', path, body, signal);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal?: AbortSignal,
    as: 'json' | 'text' = 'json',
  ): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.options.baseUrl}${path}`;
    const shown = this.options.redact ? redactUrl(url) : url;
    const attempts = this.options.attempts ?? 3;
    const timeoutMs = this.options.timeoutMs ?? 20_000;
    const headers: Record<string, string> = {
      accept: as === 'json' ? 'application/json' : 'text/html,application/json;q=0.9,*/*;q=0.8',
      ...(this.options.headers ?? {}),
    };
    if (method === 'POST') headers['content-type'] = 'application/json';

    return retry(
      () =>
        this.limiter.run(async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          const onAbort = () => controller.abort();
          signal?.addEventListener('abort', onAbort, { once: true });
          try {
            const response = await fetch(url, {
              method,
              headers,
              body: method === 'POST' ? JSON.stringify(body) : undefined,
              signal: controller.signal,
            });
            if (!response.ok) {
              throw new HttpError(`${method} ${shown} -> ${response.status}`, response.status, shown);
            }
            return (as === 'json' ? await response.json() : await response.text()) as T;
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
            url: shown,
            attempt,
            delayMs: Math.round(delayMs),
            error: error instanceof Error ? error.message : String(error),
          }),
      },
    );
  }
}
