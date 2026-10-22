/**
 * Source-verification check against the Etherscan V2 multichain API.
 *
 * The one EVM read in this package that needs a key, so it is strictly
 * optional: without `ETHERSCAN_API_KEY` the field stays undefined and a note
 * says why. Unverified source matters because it hides exactly the logic the
 * bytecode scan can only approximate by selector name.
 *
 * Never throws. Every failure — no key, unsupported chain, HTTP error, an
 * Etherscan `status: "0"` body, timeout — becomes `undefined` plus a note,
 * because "we could not ask" must not read as "unverified".
 */

import type { AppConfig, Chain } from '@provenance/core';
import { RateLimiter } from '@provenance/core';
import { isAddress } from './abi';
import type { Budget } from './rpc';

export const ETHERSCAN_V2_URL = 'https://api.etherscan.io/v2/api';

/** Etherscan V2 `chainid` per EVM chain. These are the chains' EIP-155 ids. */
export const ETHERSCAN_CHAIN_IDS: Partial<Record<Chain, number>> = {
  ethereum: 1,
  base: 8453,
  bsc: 56,
  arbitrum: 42161,
  polygon: 137,
  avalanche: 43114,
  blast: 81457,
};

export interface VerificationInput {
  app: AppConfig;
  chain: Chain;
  address: string;
  /** Receives the reason whenever the result is undefined. */
  notes: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  budget?: Budget;
  signal?: AbortSignal;
}

interface SourceCodeEntry {
  SourceCode?: unknown;
  ABI?: unknown;
}

interface EtherscanBody {
  status?: unknown;
  message?: unknown;
  result?: unknown;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Keeps the key out of notes, which are persisted and rendered. */
function redact(text: string, key: string): string {
  return key ? text.split(key).join('<redacted>') : text;
}

export async function checkContractVerified(input: VerificationInput): Promise<boolean | undefined> {
  const { app, chain, address, notes } = input;
  const key = app.etherscanApiKey?.trim() ?? '';

  if (!key) {
    notes.push('contractVerified not determined: ETHERSCAN_API_KEY is not set.');
    return undefined;
  }
  if (app.pipeline.useFixtures) {
    notes.push('contractVerified not determined: explorer lookups are skipped in fixture mode.');
    return undefined;
  }
  const chainId = ETHERSCAN_CHAIN_IDS[chain];
  if (chainId === undefined) {
    notes.push(`contractVerified not determined: no Etherscan V2 chain id for ${chain}.`);
    return undefined;
  }
  if (input.budget?.expired()) {
    notes.push('contractVerified not determined: analysis budget exhausted.');
    return undefined;
  }

  const url = new URL(ETHERSCAN_V2_URL);
  url.searchParams.set('chainid', String(chainId));
  url.searchParams.set('module', 'contract');
  url.searchParams.set('action', 'getsourcecode');
  url.searchParams.set('address', address);
  url.searchParams.set('apikey', key);

  const wanted = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = input.budget ? input.budget.clampMs(wanted) : wanted;
  const signals = [AbortSignal.timeout(timeoutMs), ...(input.signal ? [input.signal] : [])];

  try {
    const response = await (input.fetchImpl ?? fetch)(url.toString(), {
      headers: { accept: 'application/json' },
      signal: AbortSignal.any(signals),
    });
    if (!response.ok) {
      notes.push(`contractVerified not determined: Etherscan answered HTTP ${response.status}.`);
      return undefined;
    }
    const body = (await response.json()) as EtherscanBody;
    // Etherscan reports its own errors (bad key, rate limit, chain not on the
    // plan) as HTTP 200 with status "0" and the reason as a string result.
    if (String(body?.status) !== '1' || !Array.isArray(body.result)) {
      const reason = typeof body?.result === 'string' ? body.result : String(body?.message ?? 'unknown error');
      notes.push(`contractVerified not determined: Etherscan said "${redact(reason, key).slice(0, 160)}".`);
      return undefined;
    }
    const entry = body.result[0] as SourceCodeEntry | undefined;
    if (!entry || typeof entry.SourceCode !== 'string') {
      notes.push('contractVerified not determined: unexpected Etherscan response shape.');
      return undefined;
    }
    // Unverified contracts come back with an empty SourceCode and the ABI set to
    // the literal "Contract source code not verified".
    return entry.SourceCode.trim().length > 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notes.push(`contractVerified not determined: ${redact(message, key).slice(0, 160)}`);
    return undefined;
  }
}

export interface FunderLookupInput {
  app: AppConfig;
  chain: Chain;
  /** Lowercase wallet addresses, looked up in order. */
  addresses: readonly string[];
  notes: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  budget?: Budget;
  signal?: AbortSignal;
  /** Minimum gap between Etherscan calls, shared process-wide; free tier allows 5/s. Default 220. */
  rateLimitMs?: number;
  /**
   * Resolves the EOA that sent a tx (eth_getTransactionByHash). Funding that
   * arrived as an internal tx (disperse contracts, bridges) was sent by a
   * contract; only the parent tx's sender is a usable funder. Without it, or if
   * it fails, internal funding stays untraced (undefined).
   */
  txSender?: (hash: string) => Promise<string | undefined>;
}

interface TxEntry {
  from?: unknown;
  to?: unknown;
  value?: unknown;
  hash?: unknown;
  isError?: unknown;
  txreceipt_status?: unknown;
}

/** Etherscan refused the call itself (bad key, rate limit, chain not on plan): stop. */
class SystemicError extends Error {}
/** The analysis budget ran out mid-lookup: stop, and do not call it a failure. */
class BudgetExhausted extends Error {}

const RATE_LIMIT_BACKOFF_MS = 1_000;
const FUNDER_PAGE_SIZE = 50;

/** One limiter per Etherscan host and gap, shared by every concurrent token analysis (as rpc.ts does per endpoint). */
const ETHERSCAN_LIMITERS = new Map<string, RateLimiter>();

function etherscanLimiter(gapMs: number): RateLimiter {
  const id = `${new URL(ETHERSCAN_V2_URL).host}|${gapMs}`;
  let limiter = ETHERSCAN_LIMITERS.get(id);
  if (!limiter) {
    limiter = new RateLimiter(gapMs);
    ETHERSCAN_LIMITERS.set(id, limiter);
  }
  return limiter;
}

/** An inbound, successful, non-zero native transfer to `address`. */
function paysTo(entry: TxEntry, address: string): boolean {
  if (typeof entry?.to !== 'string' || entry.to.toLowerCase() !== address) return false;
  if (entry.isError === '1' || entry.txreceipt_status === '0') return false;
  try {
    return BigInt(String(entry.value)) > 0n;
  } catch {
    return false;
  }
}

function asFunder(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const lower = value.toLowerCase();
  return isAddress(lower) ? lower : undefined;
}

/**
 * Who sent each wallet its first native funds (its gas): the first incoming
 * value tx within the first 50 entries. Wallets funded from one source are the
 * clustering signal a timing-only sniping check misses.
 *
 * Returns wallet -> funder (lowercase). A key that is absent was not looked up
 * (no key, fixtures, budget ran out, systemic error); a value of `undefined`
 * was looked up and nothing usable was found, or the request failed. Never throws.
 */
export async function lookupFirstFunders(input: FunderLookupInput): Promise<Map<string, string | undefined>> {
  const { app, chain, notes } = input;
  const out = new Map<string, string | undefined>();
  const key = app.etherscanApiKey?.trim() ?? '';
  const chainId = ETHERSCAN_CHAIN_IDS[chain];

  const skip = (reason: string) => {
    notes.push(`funding not traced: ${reason}`);
    return out;
  };
  if (!key) return skip('ETHERSCAN_API_KEY is not set.');
  if (app.pipeline.useFixtures) return skip('explorer lookups are skipped in fixture mode.');
  if (chainId === undefined) return skip(`no Etherscan V2 chain id for ${chain}.`);

  const limiter = etherscanLimiter(input.rateLimitMs ?? 220);
  const wanted = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request(action: 'txlist' | 'txlistinternal', address: string): Promise<EtherscanBody> {
    if (input.budget?.expired()) throw new BudgetExhausted();
    const url = new URL(ETHERSCAN_V2_URL);
    for (const [k, v] of Object.entries({
      chainid: String(chainId), module: 'account', action, address,
      startblock: '0', endblock: '99999999', page: '1', offset: String(FUNDER_PAGE_SIZE), sort: 'asc', apikey: key,
    })) url.searchParams.set(k, v);
    return limiter.run(async () => {
      const timeoutMs = input.budget ? input.budget.clampMs(wanted) : wanted;
      const response = await (input.fetchImpl ?? fetch)(url.toString(), {
        headers: { accept: 'application/json' },
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(input.signal ? [input.signal] : [])]),
      });
      if (!response.ok) throw new Error(`Etherscan answered HTTP ${response.status}`);
      return (await response.json()) as EtherscanBody;
    });
  }

  async function list(action: 'txlist' | 'txlistinternal', address: string): Promise<TxEntry[]> {
    let body = await request(action, address);
    // The free tier's burst limit comes back as status "0": back off once.
    if (!Array.isArray(body?.result) && /rate limit/i.test(`${body?.result} ${body?.message}`)) {
      if (input.budget && input.budget.remainingMs() <= RATE_LIMIT_BACKOFF_MS) throw new BudgetExhausted();
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_BACKOFF_MS));
      body = await request(action, address);
    }
    // "No transactions found" is status "0" with an empty result: not an error.
    if (Array.isArray(body?.result)) return body.result as TxEntry[];
    if (/no transactions found/i.test(String(body?.message))) return [];
    throw new SystemicError(typeof body?.result === 'string' ? body.result : String(body?.message ?? 'unknown error'));
  }

  let failed = 0;
  let firstFailure = '';
  for (const address of input.addresses) {
    try {
      let funder: string | undefined;
      const first = (await list('txlist', address)).find((e) => paysTo(e, address));
      if (first) {
        funder = asFunder(first.from);
      } else {
        const internal = (await list('txlistinternal', address)).find((e) => paysTo(e, address));
        if (internal && typeof internal.hash === 'string' && input.txSender) {
          if (input.budget?.expired()) throw new BudgetExhausted();
          try {
            funder = asFunder(await input.txSender(internal.hash));
          } catch {
            // untraced: an internal sender is a contract, not a funder
          }
        }
      }
      out.set(address, funder);
    } catch (error) {
      if (error instanceof BudgetExhausted) {
        notes.push(`funding not traced past ${out.size} wallet(s): analysis budget exhausted`);
        break;
      }
      const message = redact(error instanceof Error ? error.message : String(error), key).slice(0, 160);
      if (error instanceof SystemicError) {
        notes.push(`funding not traced: Etherscan said "${message}".`);
        return out;
      }
      out.set(address, undefined);
      failed++;
      firstFailure ||= message;
    }
  }
  if (failed > 0) {
    notes.push(`funding lookup: ${failed} of ${input.addresses.length} wallet(s) failed: ${firstFailure}`);
  }
  return out;
}
