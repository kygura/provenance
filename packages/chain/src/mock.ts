/**
 * Programmable transport for tests. Lives in `src` rather than a test file so
 * downstream packages (worker, store) can drive the analysers offline too.
 */

import type { JsonRpcCall, JsonRpcResult, RpcTransport, TransportRequest } from './rpc';

export interface MockHandlerArgs {
  call: JsonRpcCall;
  endpoint: string;
  /** How many times this endpoint has been asked anything, including this call. */
  endpointCallCount: number;
}

export type MockHandler = (args: MockHandlerArgs) => JsonRpcResult | Promise<JsonRpcResult>;

export interface MockTransportOptions {
  /** Per-method handlers. */
  handlers?: Record<string, MockHandler>;
  /** Endpoints that always reject, simulating a dead host. */
  failing?: readonly string[];
  /** Endpoints that never answer, so the per-call timeout has to fire. */
  hanging?: readonly string[];
  /** Reject array-form requests to force the sequential fallback. */
  rejectBatch?: boolean;
  fallback?: MockHandler;
}

export class MockRpcTransport implements RpcTransport {
  readonly requests: TransportRequest[] = [];
  readonly calls: Array<{ endpoint: string; method: string; params: readonly unknown[] }> = [];
  private readonly perEndpoint = new Map<string, number>();

  constructor(private readonly options: MockTransportOptions = {}) {}

  callsTo(method: string): Array<{ endpoint: string; method: string; params: readonly unknown[] }> {
    return this.calls.filter((call) => call.method === method);
  }

  async send(request: TransportRequest): Promise<JsonRpcResult[]> {
    this.requests.push(request);
    const count = (this.perEndpoint.get(request.endpoint) ?? 0) + 1;
    this.perEndpoint.set(request.endpoint, count);

    if (this.options.failing?.includes(request.endpoint)) {
      throw new Error(`mock endpoint down: ${request.endpoint}`);
    }
    if (this.options.hanging?.includes(request.endpoint)) {
      // Resolves only if the caller gives up first, which is the point.
      return new Promise<JsonRpcResult[]>(() => undefined);
    }
    if (this.options.rejectBatch && request.calls.length > 1) {
      const error = new Error('mock endpoint rejects batches') as Error & { batchUnsupported: boolean };
      error.batchUnsupported = true;
      throw error;
    }

    const out: JsonRpcResult[] = [];
    for (const call of request.calls) {
      this.calls.push({ endpoint: request.endpoint, method: call.method, params: call.params });
      const handler = this.options.handlers?.[call.method] ?? this.options.fallback;
      if (!handler) {
        out.push({ error: { code: -32601, message: `mock has no handler for ${call.method}` } });
        continue;
      }
      out.push(await handler({ call, endpoint: request.endpoint, endpointCallCount: count }));
    }
    return out;
  }
}
