/**
 * One polite HTTP path for every collector. Rate limiting, retry, caching and
 * the user agent live here so a collector cannot accidentally skip them, and so
 * the whole network surface can be swapped out in tests with one `fetch` stub.
 */
import { RateLimiter, hashKey, retry } from '@provenance/core';
import type { ResearchContext } from '@provenance/core';

/**
 * Identifiable-but-ordinary, per SPEC.md's etiquette rule. Reddit hard-429s the
 * default runtime UA, so this is load-bearing and not decoration.
 */
export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36 provenance-research/0.1';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface HttpClientOptions {
  /** Minimum gap between requests to this host. */
  rateLimitMs?: number;
  attempts?: number;
  timeoutMs?: number;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: FetchLike;
  accept?: string;
}

/** Status codes where retrying is pointless — the request itself is the problem. */
function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
  }
  /** Retry only when the far end said "later", not "no". */
  get retryable(): boolean {
    return retryableStatus(this.status);
  }
}

/**
 * A per-host fetcher. Callers construct one per collector so each upstream gets
 * its own rate limit rather than sharing a global one.
 */
export class HttpClient {
  private readonly limiter: RateLimiter;
  private readonly attempts: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly accept: string;

  constructor(options: HttpClientOptions = {}) {
    this.limiter = new RateLimiter(options.rateLimitMs ?? 1500);
    this.attempts = options.attempts ?? 3;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.accept = options.accept ?? 'text/html,application/json;q=0.9,*/*;q=0.8';
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  }

  /**
   * Cache-then-network. The cache key is `hashKey(url)` so the store can hold
   * pages from every collector in one table without collisions.
   */
  async text(url: string, ctx: ResearchContext): Promise<string> {
    const key = hashKey(url);
    if (ctx.cacheGet) {
      try {
        const hit = await ctx.cacheGet(key);
        if (hit !== null && hit !== undefined && hit.length > 0) return hit;
      } catch (error) {
        // A broken cache must never stop a fetch.
        ctx.logger.debug('evidence cache read failed', { url, error: String(error) });
      }
    }

    const body = await retry(
      () =>
        this.limiter.run(async () => {
          const response = await this.fetchImpl(url, {
            headers: {
              'user-agent': USER_AGENT,
              accept: this.accept,
              'accept-language': 'en-US,en;q=0.9',
            },
            redirect: 'follow',
            signal: ctx.signal ?? AbortSignal.timeout(this.timeoutMs),
          });
          if (!response.ok) throw new HttpError(response.status, url);
          return await response.text();
        }),
      {
        attempts: this.attempts,
        baseDelayMs: 800,
        retryable: (error) => !(error instanceof HttpError) || error.retryable,
        onRetry: (error, attempt) =>
          ctx.logger.debug('evidence fetch retry', { url, attempt, error: String(error) }),
      },
    );

    if (ctx.cachePut) {
      try {
        await ctx.cachePut(key, url, body);
      } catch (error) {
        ctx.logger.debug('evidence cache write failed', { url, error: String(error) });
      }
    }
    return body;
  }

  async json<T = unknown>(url: string, ctx: ResearchContext): Promise<T> {
    return JSON.parse(await this.text(url, ctx)) as T;
  }
}
