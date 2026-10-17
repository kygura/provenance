import { type Logger, redactUrl } from '@provenance/core';

import { HttpError, JsonClient } from './http';
import { isRecord } from './normalize';

/**
 * A JSON-RPC call with the transport abstracted away. The launch walk takes one
 * of these rather than a client so tests can script node behaviour (range
 * refusals, empty chunks) without a network.
 */
export type RpcCaller = (method: string, params: unknown[], signal?: AbortSignal) => Promise<unknown>;

/** The node answered, but with an error object: usually a range or result cap. */
export class JsonRpcError extends Error {
  constructor(
    message: string,
    readonly endpoint: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

export interface JsonRpcClientOptions {
  endpoints: readonly string[];
  rateLimitMs: number;
  logger: Logger;
  timeoutMs?: number;
  /** Per endpoint. Failover to the next endpoint is the real retry. */
  attempts?: number;
}

/**
 * Minimal keyless JSON-RPC poster. It lives here rather than being imported
 * from `@provenance/chain` because sources may depend on core alone; the HTTP
 * underneath is `JsonClient`, so every POST goes through `RateLimiter` + `retry`.
 *
 * Endpoints are tried in order. Public nodes differ in their `eth_getLogs`
 * caps, so a range one node refuses is worth offering to the next.
 */
export class JsonRpcClient {
  private readonly clients: { endpoint: string; client: JsonClient }[];
  private nextId = 1;
  /** `method endpoint` pairs that answered with an HTTP 4xx; tried last from then on. */
  private readonly refused = new Set<string>();

  constructor(private readonly options: JsonRpcClientOptions) {
    this.clients = options.endpoints.map((endpoint) => ({
      endpoint,
      client: new JsonClient({
        baseUrl: endpoint,
        rateLimitMs: options.rateLimitMs,
        logger: options.logger,
        timeoutMs: options.timeoutMs ?? 20_000,
        attempts: options.attempts ?? 2,
        redact: true,
      }),
    }));
  }

  readonly call: RpcCaller = async (method, params, signal) => {
    if (this.clients.length === 0) throw new Error('no RPC endpoints configured');
    let lastError: unknown;

    // A keyed node that rate-limits or caps eth_getLogs would otherwise be
    // asked first for every chunk of the walk, and refuse every time.
    const ordered = [
      ...this.clients.filter(({ endpoint }) => !this.refused.has(`${method} ${endpoint}`)),
      ...this.clients.filter(({ endpoint }) => this.refused.has(`${method} ${endpoint}`)),
    ];

    for (const { endpoint, client } of ordered) {
      try {
        const reply = await client.postJson(endpoint, { jsonrpc: '2.0', id: this.nextId++, method, params }, signal);
        if (!isRecord(reply)) throw new JsonRpcError(`${method}: malformed reply`, endpoint);
        if (reply.error !== undefined && reply.error !== null) {
          const error = isRecord(reply.error) ? reply.error : {};
          const message = typeof error.message === 'string' ? error.message : JSON.stringify(reply.error);
          const code = typeof error.code === 'number' ? error.code : undefined;
          throw new JsonRpcError(`${method}: ${message}`, endpoint, code);
        }
        if (!('result' in reply)) throw new JsonRpcError(`${method}: reply has no result`, endpoint);
        return reply.result;
      } catch (error) {
        lastError = error;
        if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
          this.refused.add(`${method} ${endpoint}`);
        }
        this.options.logger.debug('rpc endpoint failed, trying next', {
          endpoint: redactUrl(endpoint),
          method,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    throw lastError;
  };
}

/** Quantity decoding for `0x`-prefixed hex; anything else is `undefined`. */
export function hexToNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) return undefined;
  const parsed = Number.parseInt(value.slice(2), 16);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function numberToHex(value: number): string {
  return `0x${Math.max(0, Math.floor(value)).toString(16)}`;
}
