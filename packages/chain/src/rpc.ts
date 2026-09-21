/**
 * JSON-RPC plumbing shared by the Solana and EVM analysers.
 *
 * The public free RPCs this package targets are flaky, rate-limited and
 * inconsistent about batching, so the client is built around three ideas:
 *
 *  1. Everything goes through an injectable `RpcTransport`. Tests and fixture
 *     mode never open a socket; there is no code path that "falls back" to the
 *     network when a fixture is missing.
 *  2. Endpoint failover is first-class. `AppConfig.rpc.<chain>` is an array and
 *     we walk it, sticking to whichever endpoint last worked.
 *  3. Nothing is unbounded. Every call carries a timeout, every analyser
 *     carries a wall-clock `Budget`, and exhausting either degrades the result
 *     instead of hanging the pipeline.
 */

import { RateLimiter, retry, type Logger } from '@provenance/core';

export interface JsonRpcCall {
  method: string;
  params: readonly unknown[];
}

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

/** One call's outcome. Exactly one of `result` / `error` is meaningful. */
export interface JsonRpcResult<T = unknown> {
  result?: T;
  error?: JsonRpcErrorBody;
}

export interface TransportRequest {
  endpoint: string;
  calls: readonly JsonRpcCall[];
  signal?: AbortSignal;
}

/**
 * The single seam between this package and the outside world. `send` resolves
 * with one entry per call, in request order, or rejects for an endpoint-level
 * failure (network, HTTP status, malformed body).
 */
export interface RpcTransport {
  send(request: TransportRequest): Promise<JsonRpcResult[]>;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly detail: { endpoint?: string; method?: string; code?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export class RpcTimeoutError extends RpcError {
  constructor(message: string, detail: { endpoint?: string; method?: string } = {}) {
    super(message, detail);
    this.name = 'RpcTimeoutError';
  }
}

/** Thrown by a transport whose endpoint rejected an array-form request. */
export class BatchUnsupportedError extends RpcError {
  readonly batchUnsupported = true;
  constructor(endpoint: string) {
    super(`endpoint does not support JSON-RPC batching: ${endpoint}`, { endpoint });
    this.name = 'BatchUnsupportedError';
  }
}

function isBatchUnsupported(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'batchUnsupported' in error;
}

// ---------------------------------------------------------------- budget

/** Wall-clock allowance shared by every step of one token's analysis. */
export class Budget {
  private readonly startedAt: number;

  constructor(readonly totalMs: number, now: () => number = Date.now) {
    this.now = now;
    this.startedAt = now();
  }

  private readonly now: () => number;

  elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  remainingMs(): number {
    return Math.max(0, this.totalMs - this.elapsedMs());
  }

  expired(): boolean {
    return this.remainingMs() <= 0;
  }

  /** The smaller of the caller's wish and what is left. Never below 1ms. */
  clampMs(wanted: number): number {
    return Math.max(1, Math.min(wanted, this.remainingMs()));
  }
}

// ---------------------------------------------------------------- http transport

export interface HttpTransportOptions {
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

/**
 * The only thing in this package that touches the network. Posts a single
 * object for one call and an array for several, which is what every public RPC
 * that supports batching expects.
 */
export class HttpRpcTransport implements RpcTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;

  constructor(options: HttpTransportOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? 'provenance/0.1 (+https://github.com/provenance)';
  }

  async send(request: TransportRequest): Promise<JsonRpcResult[]> {
    const payload = request.calls.map((call, index) => ({
      jsonrpc: '2.0',
      id: index + 1,
      method: call.method,
      params: call.params,
    }));
    const body = JSON.stringify(payload.length === 1 ? payload[0] : payload);

    const response = await this.fetchImpl(request.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': this.userAgent },
      body,
      ...(request.signal ? { signal: request.signal } : {}),
    });

    if (!response.ok) {
      throw new RpcError(`HTTP ${response.status} from ${request.endpoint}`, {
        endpoint: request.endpoint,
        code: response.status,
      });
    }

    const parsed: unknown = await response.json();

    if (payload.length === 1) {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new RpcError(`malformed JSON-RPC response from ${request.endpoint}`, { endpoint: request.endpoint });
      }
      return [parsed as JsonRpcResult];
    }

    // Some endpoints answer a batch with a single error object rather than an
    // array. Treat that as "no batching here" and let the client re-send.
    if (!Array.isArray(parsed)) throw new BatchUnsupportedError(request.endpoint);
    if (parsed.length !== payload.length) throw new BatchUnsupportedError(request.endpoint);

    const byId = new Map<unknown, JsonRpcResult>();
    for (const entry of parsed as Array<JsonRpcResult & { id?: unknown }>) byId.set(entry?.id, entry);
    return payload.map((sent, index) => byId.get(sent.id) ?? (parsed[index] as JsonRpcResult));
  }
}

// ---------------------------------------------------------------- client

export interface RpcClientOptions {
  endpoints: readonly string[];
  transport: RpcTransport;
  logger: Logger;
  /** Per-call deadline. Public RPCs stall far more often than they refuse. */
  timeoutMs?: number;
  /** Minimum gap between calls to the same endpoint. */
  rateLimitMs?: number;
  /** Attempts per endpoint before failing over to the next one. */
  attempts?: number;
  /** Outer cancellation, normally `AnalyzerContext.signal`. */
  signal?: AbortSignal;
  /** Set false for endpoints known to choke on arrays. */
  batch?: boolean;
  budget?: Budget;
}

export interface CallOptions {
  timeoutMs?: number;
  attempts?: number;
  /** Skip failover; used for optional heavyweight calls we do not want to retry. */
  singleEndpoint?: boolean;
}

export type Attempt<T> = { ok: true; value: T } | { ok: false; error: Error };

interface AbortHandle {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
  whenAborted: Promise<never>;
}

/** Combines a per-call timeout with the caller's own signal. */
function makeAbort(timeoutMs: number, outer?: AbortSignal): AbortHandle {
  const controller = new AbortController();
  let expired = false;
  let settle: ((error: Error) => void) | undefined;

  const whenAborted = new Promise<never>((_resolve, reject) => {
    settle = reject;
  });
  // Nothing else awaits this promise when the call succeeds first; swallow the
  // rejection so Bun does not report an unhandled one.
  whenAborted.catch(() => undefined);

  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
    settle?.(new RpcTimeoutError(`call exceeded ${timeoutMs}ms`));
  }, timeoutMs);

  const onOuterAbort = () => {
    controller.abort();
    settle?.(new RpcError('aborted by caller'));
  };
  if (outer) {
    if (outer.aborted) onOuterAbort();
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => expired,
    whenAborted,
    dispose() {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
    },
  };
}

/**
 * Endpoint-failing-over JSON-RPC client. `callMany` surfaces per-call JSON-RPC
 * errors as data (a token without an `owner()` function is normal, not a
 * failure) and only throws when every endpoint refused to answer at all.
 */
export class RpcClient {
  private readonly endpoints: readonly string[];
  private readonly limiters = new Map<string, RateLimiter>();
  private readonly noBatch = new Set<string>();
  private preferred = 0;

  constructor(private readonly options: RpcClientOptions) {
    this.endpoints = options.endpoints.length > 0 ? options.endpoints : [];
    for (const endpoint of this.endpoints) {
      this.limiters.set(endpoint, new RateLimiter(options.rateLimitMs ?? 0));
    }
  }

  get endpointCount(): number {
    return this.endpoints.length;
  }

  /** The endpoint that answered most recently; useful in notes and logs. */
  get activeEndpoint(): string | undefined {
    return this.endpoints[this.preferred];
  }

  async callMany(calls: readonly JsonRpcCall[], options: CallOptions = {}): Promise<JsonRpcResult[]> {
    if (calls.length === 0) return [];
    if (this.endpoints.length === 0) {
      throw new RpcError('no RPC endpoints configured', { method: calls[0]?.method });
    }

    const attempts = options.attempts ?? this.options.attempts ?? 2;
    const wanted = options.timeoutMs ?? this.options.timeoutMs ?? 10_000;
    const order = options.singleEndpoint ? [this.preferred] : this.rotation();
    const failures: string[] = [];

    for (const index of order) {
      const endpoint = this.endpoints[index];
      if (endpoint === undefined) continue;
      if (this.options.budget?.expired()) {
        throw new RpcTimeoutError('analysis budget exhausted', { endpoint, method: calls[0]?.method });
      }
      try {
        const results = await retry(() => this.sendTo(endpoint, calls, wanted), {
          attempts,
          baseDelayMs: 250,
          maxDelayMs: 2_000,
          retryable: (error) => !(error instanceof RpcError && error.message === 'aborted by caller'),
          onRetry: (error, attempt) => {
            this.options.logger.debug('rpc retry', {
              endpoint,
              method: calls[0]?.method,
              attempt,
              error: describe(error),
            });
          },
        });
        this.preferred = index;
        return results;
      } catch (error) {
        failures.push(`${endpoint}: ${describe(error)}`);
        this.options.logger.warn('rpc endpoint failed', {
          endpoint,
          method: calls[0]?.method,
          error: describe(error),
        });
      }
    }

    throw new RpcError(`all ${this.endpoints.length} endpoint(s) failed for ${calls[0]?.method}`, {
      method: calls[0]?.method,
      cause: failures.join(' | '),
    });
  }

  /** Single call. Throws on transport failure *and* on a JSON-RPC error body. */
  async call<T>(method: string, params: readonly unknown[], options: CallOptions = {}): Promise<T> {
    const [entry] = await this.callMany([{ method, params }], options);
    if (!entry) throw new RpcError(`empty response for ${method}`, { method });
    if (entry.error) {
      throw new RpcError(`${method} failed: ${entry.error.message}`, { method, code: entry.error.code });
    }
    return entry.result as T;
  }

  /** `call` that reports failure as a value. Analysers must never throw. */
  async tryCall<T>(method: string, params: readonly unknown[], options: CallOptions = {}): Promise<Attempt<T>> {
    try {
      return { ok: true, value: await this.call<T>(method, params, options) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  private rotation(): number[] {
    return this.endpoints.map((_, offset) => (this.preferred + offset) % this.endpoints.length);
  }

  private async sendTo(endpoint: string, calls: readonly JsonRpcCall[], timeoutMs: number): Promise<JsonRpcResult[]> {
    const limiter = this.limiters.get(endpoint) ?? new RateLimiter(0);
    const batchOk = (this.options.batch ?? true) && !this.noBatch.has(endpoint);

    if (calls.length > 1 && !batchOk) {
      const out: JsonRpcResult[] = [];
      for (const call of calls) {
        const [one] = await limiter.run(() => this.dispatch(endpoint, [call], timeoutMs));
        out.push(one ?? { error: { code: -1, message: 'missing response' } });
      }
      return out;
    }

    try {
      return await limiter.run(() => this.dispatch(endpoint, calls, timeoutMs));
    } catch (error) {
      if (calls.length > 1 && isBatchUnsupported(error)) {
        this.noBatch.add(endpoint);
        this.options.logger.debug('rpc batching disabled for endpoint', { endpoint });
        return this.sendTo(endpoint, calls, timeoutMs);
      }
      throw error;
    }
  }

  private async dispatch(endpoint: string, calls: readonly JsonRpcCall[], timeoutMs: number): Promise<JsonRpcResult[]> {
    const effective = this.options.budget ? this.options.budget.clampMs(timeoutMs) : timeoutMs;
    const abort = makeAbort(effective, this.options.signal);
    try {
      // Race rather than trusting the transport to honour the signal: a mock or
      // a stalled keep-alive socket must still hit the deadline.
      const results = await Promise.race([
        this.options.transport.send({ endpoint, calls, signal: abort.signal }),
        abort.whenAborted,
      ]);
      if (!Array.isArray(results) || results.length !== calls.length) {
        throw new RpcError(`transport returned ${Array.isArray(results) ? results.length : 'non-array'} results for ${calls.length} calls`, {
          endpoint,
          method: calls[0]?.method,
        });
      }
      return results;
    } catch (error) {
      if (abort.timedOut()) {
        throw new RpcTimeoutError(`${calls[0]?.method ?? 'rpc'} timed out after ${effective}ms`, {
          endpoint,
          method: calls[0]?.method,
        });
      }
      throw error;
    } finally {
      abort.dispose();
    }
  }
}

export function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
