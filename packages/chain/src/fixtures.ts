/**
 * Fixture-backed RPC transport.
 *
 * `AppConfig.pipeline.useFixtures` swaps this in for `HttpRpcTransport`, so the
 * whole analyser stack — failover, batching, decoding, flagging — runs offline
 * against recorded payloads. Fixtures live in `fixtures/rpc/**.json`.
 *
 * A fixture file is `{ chain, note?, entries: RpcFixtureEntry[] }`. An entry
 * matches a call when the method is equal and the recorded `params` are a
 * *structural subset* of the request's params: recording `["<mint>"]` matches
 * `getAccountInfo(mint, { encoding: 'jsonParsed' })` without pinning the
 * options object, and `[{ "to": "0x…", "data": "0x18160ddd" }]` matches an
 * `eth_call` regardless of the block tag.
 */

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Logger } from '@provenance/core';
import type { JsonRpcErrorBody, JsonRpcResult, RpcTransport, TransportRequest } from './rpc';

export interface RpcFixtureEntry {
  method: string;
  /** Structural subset of the expected params. Omit to match any params. */
  params?: readonly unknown[];
  /** Restricts the entry to one endpoint; used to record failover scenarios. */
  endpoint?: string;
  result?: unknown;
  error?: JsonRpcErrorBody;
  /** Serve at most this many times, then fall through to the next entry. */
  times?: number;
}

export interface RpcFixtureFile {
  chain?: string;
  note?: string;
  entries: RpcFixtureEntry[];
}

/** Deep "the recorded shape is contained in the actual value" comparison. */
export function matchesSubset(expected: unknown, actual: unknown): boolean {
  if (expected === undefined) return true; // wildcard slot
  if (expected === null) return actual === null;
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    return expected.every((item, index) => matchesSubset(item, actual[index]));
  }
  if (typeof expected === 'object') {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false;
    const target = actual as Record<string, unknown>;
    return Object.entries(expected as Record<string, unknown>).every(([key, value]) =>
      matchesSubset(value, target[key]),
    );
  }
  if (typeof expected === 'string' && typeof actual === 'string') {
    // Addresses are case-insensitive on EVM chains and case-sensitive base58 on
    // Solana; comparing case-insensitively is safe for both because base58
    // fixtures are recorded verbatim from the same source they are matched to.
    return expected.toLowerCase() === actual.toLowerCase();
  }
  return expected === actual;
}

export interface FixtureTransportOptions {
  entries: readonly RpcFixtureEntry[];
  logger?: Logger;
  /** What to do when no entry matches. Default `error` (a JSON-RPC error body). */
  onMiss?: 'error' | 'throw';
}

export class FixtureRpcTransport implements RpcTransport {
  private readonly entries: RpcFixtureEntry[];
  private readonly served = new Map<RpcFixtureEntry, number>();
  private readonly misses: string[] = [];

  constructor(private readonly options: FixtureTransportOptions) {
    this.entries = [...options.entries];
  }

  /** Calls that found no fixture, for test assertions and fixture-gap triage. */
  get missedCalls(): readonly string[] {
    return this.misses;
  }

  async send(request: TransportRequest): Promise<JsonRpcResult[]> {
    return request.calls.map((call) => {
      const entry = this.entries.find((candidate) => {
        if (candidate.method !== call.method) return false;
        if (candidate.endpoint && candidate.endpoint !== request.endpoint) return false;
        if (candidate.times !== undefined && (this.served.get(candidate) ?? 0) >= candidate.times) return false;
        return matchesSubset(candidate.params, call.params);
      });

      if (!entry) {
        const description = `${call.method}(${JSON.stringify(call.params).slice(0, 200)})`;
        this.misses.push(description);
        this.options.logger?.warn('rpc fixture miss', { call: description, endpoint: request.endpoint });
        if (this.options.onMiss === 'throw') throw new Error(`no RPC fixture for ${description}`);
        return { error: { code: -32601, message: `no fixture for ${call.method}` } };
      }

      this.served.set(entry, (this.served.get(entry) ?? 0) + 1);
      return entry.error ? { error: entry.error } : { result: entry.result };
    });
  }
}

/** Repo-root `fixtures/rpc`, resolved relative to this file rather than cwd. */
export function defaultFixtureDir(): string {
  return fileURLToPath(new URL('../../../fixtures/rpc/', import.meta.url));
}

export async function loadRpcFixtures(dir = defaultFixtureDir()): Promise<RpcFixtureEntry[]> {
  const files = await collectJson(dir);
  const entries: RpcFixtureEntry[] = [];
  for (const file of files) {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as RpcFixtureFile;
    if (Array.isArray(parsed?.entries)) entries.push(...parsed.entries);
  }
  return entries;
}

async function collectJson(dir: string): Promise<string[]> {
  const out: string[] = [];
  let listing: Awaited<ReturnType<typeof readdir>>;
  try {
    listing = await readdir(dir, { withFileTypes: true });
  } catch {
    return out; // a missing fixture directory is an empty one
  }
  for (const item of listing) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...(await collectJson(full)));
    else if (item.name.endsWith('.json')) out.push(full);
  }
  return out.sort();
}

export async function createFixtureTransport(
  logger?: Logger,
  dir = defaultFixtureDir(),
): Promise<FixtureRpcTransport> {
  const entries = await loadRpcFixtures(dir);
  logger?.debug('loaded rpc fixtures', { dir, entries: entries.length });
  return new FixtureRpcTransport(logger ? { entries, logger } : { entries });
}
