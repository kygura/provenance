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
