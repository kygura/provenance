/**
 * Solana holder-distribution analyser over plain JSON-RPC.
 *
 * The one thing that is easy to get wrong here, and that silently corrupts
 * every downstream number when you do: `getTokenLargestAccounts` returns
 * **token accounts**, not holders. A token account is an SPL account owned by
 * a wallet (or a pool PDA); one wallet routinely holds several for the same
 * mint, and a pool's vault address has nothing to do with the pool's identity.
 * So every top account is resolved to its owner via `getMultipleAccounts`, and
 * balances are aggregated per owner before any concentration maths happens.
 */

import { nowIso, type AnalyzerContext, type ChainAnalysis, type ChainAnalyzer, type HolderRow, type Logger, type TokenSnapshot, type AppConfig } from '@provenance/core';
import { formatUnits, pctOf } from './abi';
import { evaluateFlags } from './flags';
import { concentration } from './metrics';
import { labelIsExcluded, lookupSolanaAddress, SOLANA_INCINERATOR } from './labels';
import { Budget, RpcClient, describe, type RpcTransport, type TransportProvider } from './rpc';

export const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SPL_TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
/** Every SPL token account is exactly 165 bytes; the filter is what makes gPA viable at all. */
export const SPL_TOKEN_ACCOUNT_SIZE = 165;
/** Byte offset of the u64 `amount` field inside an SPL token account. */
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;

export interface SolanaAnalyzerOptions {
  /** Wall-clock ceiling for one token's analysis. */
  budgetMs?: number;
  /** Per-RPC-call timeout. */
  callTimeoutMs?: number;
  /** Separate, shorter timeout for the optional `getProgramAccounts` sweep. */
  holderCountTimeoutMs?: number;
  /** Set false to skip the heavy holder-count sweep entirely. */
  attemptHolderCount?: boolean;
  /** Minimum gap between calls to one endpoint. */
  rateLimitMs?: number;
}

const DEFAULTS: Required<SolanaAnalyzerOptions> = {
  budgetMs: 30_000,
  callTimeoutMs: 10_000,
  holderCountTimeoutMs: 6_000,
  attemptHolderCount: true,
  rateLimitMs: 120,
};

interface RpcEnvelope<T> {
  context?: { slot?: number };
  value: T;
}

interface ParsedMintInfo {
  decimals?: number;
  supply?: string;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  isInitialized?: boolean;
}

interface ParsedAccount {
  owner?: string;
  data?: { parsed?: { info?: Record<string, unknown>; type?: string }; program?: string };
}

interface TokenAmount {
  amount?: string;
  decimals?: number;
  uiAmount?: number | null;
}

interface LargestAccount extends TokenAmount {
  address?: string;
}

interface ProgramAccount {
  pubkey?: string;
  account?: { data?: [string, string] | string };
}

/** Aggregate of every token account that resolved to one owner. */
interface OwnerBucket {
  owner: string;
  raw: bigint;
  tokenAccounts: string[];
  /** True when we could not resolve the owner and fell back to the account address. */
  unresolved: boolean;
}

export function createSolanaAnalyzer(
  app: AppConfig,
  logger: Logger,
  transport: TransportProvider,
  options: SolanaAnalyzerOptions = {},
): ChainAnalyzer {
  return {
    chains: ['solana'],
    analyze: (snapshot, ctx) => analyzeSolana(snapshot, ctx, transport, options, app, logger),
  };
}

export async function analyzeSolana(
  snapshot: TokenSnapshot,
  ctx: AnalyzerContext,
  transport: TransportProvider | RpcTransport,
  options: SolanaAnalyzerOptions = {},
  app = ctx.app,
  parentLogger = ctx.logger,
): Promise<ChainAnalysis> {
  const opts = { ...DEFAULTS, ...options };
  const logger = parentLogger.child('solana');
  const budget = new Budget(opts.budgetMs);
  const startedAt = Date.now();
  const notes: string[] = [];
  const mint = snapshot.tokenAddress;

  const analysis: ChainAnalysis = {
    tokenId: snapshot.tokenId,
    chain: 'solana',
    tokenAddress: mint,
    method: 'unavailable',
    topHolders: [],
    flags: [],
    notes,
    fetchedAt: nowIso(),
  };

  const resolved = typeof transport === 'function' ? await transport() : transport;
  const client = new RpcClient({
    endpoints: app.rpc.solana,
    transport: resolved,
    logger,
    timeoutMs: opts.callTimeoutMs,
    rateLimitMs: opts.rateLimitMs,
    attempts: 2,
    budget,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });

  // One batched round-trip for the three cheap calls. `callMany` surfaces
  // per-call JSON-RPC errors as data so a missing `owner()`-style failure on
  // one call does not lose the other two.
  let mintInfo: ParsedMintInfo | undefined;
  let supplyAmount: TokenAmount | undefined;
  let largest: LargestAccount[] = [];
  let degraded = false;

  try {
    const [accountRes, supplyRes, largestRes] = await client.callMany([
      { method: 'getAccountInfo', params: [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }] },
      { method: 'getTokenSupply', params: [mint, { commitment: 'confirmed' }] },
      { method: 'getTokenLargestAccounts', params: [mint, { commitment: 'confirmed' }] },
    ]);

    if (accountRes?.error) notes.push(`getAccountInfo failed: ${accountRes.error.message}`);
    const accountValue = (accountRes?.result as RpcEnvelope<ParsedAccount | null> | undefined)?.value;
    const info = accountValue?.data?.parsed?.info as ParsedMintInfo | undefined;
    if (info && typeof info.decimals === 'number') mintInfo = info;
    else if (!accountRes?.error) notes.push('Mint account returned no parsed SPL mint data.');

    if (supplyRes?.error) notes.push(`getTokenSupply failed: ${supplyRes.error.message}`);
    supplyAmount = (supplyRes?.result as RpcEnvelope<TokenAmount> | undefined)?.value;

    if (largestRes?.error) notes.push(`getTokenLargestAccounts failed: ${largestRes.error.message}`);
    const largestValue = (largestRes?.result as RpcEnvelope<LargestAccount[]> | undefined)?.value;
    if (Array.isArray(largestValue)) largest = largestValue;
  } catch (error) {
    notes.push(`Solana RPC unreachable: ${describe(error)}`);
    logger.warn('solana base calls failed', { mint, error: describe(error) });
  }

  if (!mintInfo && !supplyAmount && largest.length === 0) {
    analysis.notes.push('No Solana RPC endpoint answered; nothing could be determined.');
    return finish(analysis, startedAt, undefined, snapshot);
  }

  // ---- supply and authorities -------------------------------------------
  const decimals = supplyAmount?.decimals ?? mintInfo?.decimals ?? 0;
  const rawSupply = safeBigInt(supplyAmount?.amount ?? mintInfo?.supply);
  const totalSupply = rawSupply === undefined ? undefined : formatUnits(rawSupply, decimals);
  if (totalSupply !== undefined) {
    analysis.supply = { total: totalSupply, decimals };
  } else {
    degraded = true;
    notes.push('Token supply could not be read; concentration falls back to a sample-relative basis.');
  }

  if (mintInfo) {
    // `null` is the on-chain representation of "revoked". Anything else is live.
    analysis.mintAuthorityActive = mintInfo.mintAuthority != null;
    analysis.freezeAuthorityActive = mintInfo.freezeAuthority != null;
    if (mintInfo.isInitialized === false) notes.push('Mint account reports isInitialized=false.');
    if (mintInfo.mintAuthority != null) {
      // Solana has no cheap "who deployed this" query. The mint authority is
      // the closest free proxy; it is frequently a launchpad program rather
      // than a person, which is why the note travels with the number.
      analysis.creatorAddress = mintInfo.mintAuthority;
      notes.push(
        `creatorAddress is the mint authority (${mintInfo.mintAuthority}) used as a creator proxy; on launchpad tokens this is a program, not a person.`,
      );
    }
  } else {
    degraded = true;
    notes.push('Mint authority and freeze authority could not be read.');
  }

  // ---- token accounts -> owners -----------------------------------------
  const accountAddresses = largest
    .map((entry) => entry.address)
    .filter((address): address is string => typeof address === 'string' && address.length > 0);

  const owners = await resolveOwners(client, accountAddresses, notes, logger);
  if (accountAddresses.length > 0 && owners.size === 0) degraded = true;

  const buckets = new Map<string, OwnerBucket>();
  for (const entry of largest) {
    const account = entry.address;
    if (!account) continue;
    const raw = safeBigInt(entry.amount);
    if (raw === undefined || raw === 0n) continue;
    const owner = owners.get(account);
    const key = owner ?? account;
    const bucket = buckets.get(key) ?? { owner: key, raw: 0n, tokenAccounts: [], unresolved: owner === undefined };
    bucket.raw += raw;
    bucket.tokenAccounts.push(account);
    buckets.set(key, bucket);
  }

  const unresolvedCount = [...buckets.values()].filter((bucket) => bucket.unresolved).length;
  if (unresolvedCount > 0) {
    degraded = true;
    notes.push(
      `${unresolvedCount} token account(s) could not be resolved to an owner; those rows are keyed by token-account address, not holder.`,
    );
  }

  // ---- labelling ---------------------------------------------------------
  const pairAddresses = new Set(
    snapshot.pairs.map((pair) => pair.pairAddress).filter((address): address is string => Boolean(address)),
  );

  const rows: HolderRow[] = [...buckets.values()]
    .sort((a, b) => (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : 0))
    .map((bucket) => {
      const label = labelFor(bucket, pairAddresses);
      const row: HolderRow = {
        address: bucket.owner,
        balance: formatUnits(bucket.raw, decimals),
        pct: rawSupply && rawSupply > 0n ? round6(pctOf(bucket.raw, rawSupply)) : 0,
      };
      if (label) {
        row.label = label;
        if (labelIsExcluded(label)) row.excludedFromConcentration = true;
      }
      return row;
    });

  analysis.topHolders = rows;

  if (rows.some((row) => row.label?.startsWith('cex:'))) {
    notes.push('A custodial exchange wallet appears in the top holders; it is labelled but NOT excluded from concentration, because the float really is pooled there.');
  }

  // Burned supply visible in the sample only — the incinerator is not
  // guaranteed to be in the top 20.
  const burnedRaw = [...buckets.values()]
    .filter((bucket) => bucket.owner === SOLANA_INCINERATOR || lookupSolanaAddress(bucket.owner)?.label === 'burn')
    .reduce((acc, bucket) => acc + bucket.raw, 0n);
  if (analysis.supply && rawSupply && rawSupply > 0n && burnedRaw > 0n) {
    analysis.supply.burnedPct = round6(pctOf(burnedRaw, rawSupply));
    notes.push('burnedPct counts only burn addresses visible in the top-20 sample; smaller burns are invisible to this method.');
  }

  // ---- concentration -----------------------------------------------------
  const conc = concentration({
    rows,
    sampled: true, // getTokenLargestAccounts is a top-20 sample, always
    ...(totalSupply !== undefined ? { totalSupply } : {}),
  });
  assignConcentration(analysis, conc);
  notes.push(...conc.caveats);

  if (analysis.creatorAddress) {
    const creatorRow = rows.find((row) => row.address === analysis.creatorAddress);
    if (creatorRow) analysis.creatorHoldingPct = creatorRow.pct;
  }

  // Solana LP burn means burning the pool's LP mint, which needs the LP mint
  // address; `PairInfo` carries the pool address, not the LP mint, so this is
  // left undetermined rather than guessed.
  notes.push('lpBurnedPct/lpLockedPct not determined: the LP mint for a Solana pool is not derivable from the pair address alone over public RPC.');

  // ---- optional holder count --------------------------------------------
  if (opts.attemptHolderCount && budget.remainingMs() > 2_000) {
    const count = await tryHolderCount(client, mint, opts.holderCountTimeoutMs, notes, logger);
    if (count !== undefined) analysis.holderCount = count;
  } else if (opts.attemptHolderCount) {
    notes.push('Holder count sweep skipped: analysis budget exhausted.');
  } else {
    notes.push('Holder count sweep disabled by configuration.');
  }
  if (analysis.holderCount === undefined) {
    notes.push('holderCount is unknown: getProgramAccounts over the SPL token program is rejected or throttled by most free RPCs.');
  }

  analysis.method = degraded ? 'partial' : 'rpc';
  return finish(analysis, startedAt, conc.largestHolderPct, snapshot);
}

// ---------------------------------------------------------------- helpers

async function resolveOwners(
  client: RpcClient,
  accounts: readonly string[],
  notes: string[],
  logger: Logger,
): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  if (accounts.length === 0) return owners;

  // getMultipleAccounts caps at 100 keys per call; the top-20 list never hits
  // that, but chunking keeps the helper honest if the cap ever matters.
  for (let offset = 0; offset < accounts.length; offset += 100) {
    const chunk = accounts.slice(offset, offset + 100);
    const attempt = await client.tryCall<RpcEnvelope<Array<ParsedAccount | null>>>('getMultipleAccounts', [
      chunk,
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    if (!attempt.ok) {
      notes.push(`getMultipleAccounts failed: ${attempt.error.message}`);
      logger.warn('owner resolution failed', { error: attempt.error.message });
      continue;
    }
    const values = attempt.value?.value ?? [];
    chunk.forEach((address, index) => {
      const owner = values[index]?.data?.parsed?.info?.['owner'];
      if (typeof owner === 'string' && owner.length > 0) owners.set(address, owner);
    });
  }
  return owners;
}

async function tryHolderCount(
  client: RpcClient,
  mint: string,
  timeoutMs: number,
  notes: string[],
  logger: Logger,
): Promise<number | undefined> {
  // Heavy and widely disabled. One attempt, short timeout, failure is a note.
  const attempt = await client.tryCall<ProgramAccount[]>(
    'getProgramAccounts',
    [
      SPL_TOKEN_PROGRAM,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        // Only the 8-byte amount comes back, so a 100k-holder token is ~1MB
        // rather than ~20MB.
        dataSlice: { offset: TOKEN_ACCOUNT_AMOUNT_OFFSET, length: 8 },
        filters: [{ dataSize: SPL_TOKEN_ACCOUNT_SIZE }, { memcmp: { offset: 0, bytes: mint } }],
      },
    ],
    { timeoutMs, attempts: 1 },
  );

  if (!attempt.ok) {
    notes.push(`Holder count sweep unavailable: ${attempt.error.message}`);
    logger.debug('getProgramAccounts rejected', { mint, error: attempt.error.message });
    return undefined;
  }
  if (!Array.isArray(attempt.value)) {
    notes.push('Holder count sweep returned an unexpected payload.');
    return undefined;
  }

  let nonZero = 0;
  let undecodable = 0;
  for (const entry of attempt.value) {
    const raw = entry.account?.data;
    const encoded = Array.isArray(raw) ? raw[0] : raw;
    if (typeof encoded !== 'string') {
      undecodable++;
      continue;
    }
    const amount = decodeU64LE(encoded);
    if (amount === undefined) undecodable++;
    else if (amount > 0n) nonZero++;
  }
  if (undecodable > 0) {
    notes.push(`Holder count: ${undecodable} token account(s) had undecodable balances and were not counted.`);
  }
  notes.push(
    `holderCount is the number of SPL token accounts for this mint with a non-zero balance (${nonZero}); one wallet can own several, so it is an upper bound on distinct wallets.`,
  );
  return nonZero;
}

/** Little-endian u64 out of a base64 `dataSlice`. */
export function decodeU64LE(base64: string): bigint | undefined {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    return undefined;
  }
  if (binary.length < 8) return undefined;
  let value = 0n;
  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(binary.charCodeAt(i) & 0xff);
  return value;
}

function labelFor(bucket: OwnerBucket, pairAddresses: ReadonlySet<string>): string | undefined {
  // The token's own pools come from the market sources and outrank the static
  // table: they are per-token truth rather than a guess.
  if (pairAddresses.has(bucket.owner)) return 'liquidity-pool';
  if (bucket.tokenAccounts.some((account) => pairAddresses.has(account))) return 'liquidity-pool';

  const known = lookupSolanaAddress(bucket.owner);
  if (known) return known.label;
  for (const account of bucket.tokenAccounts) {
    const viaAccount = lookupSolanaAddress(account);
    if (viaAccount) return viaAccount.label;
  }
  return undefined;
}

export function safeBigInt(value: string | number | undefined | null): bigint | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === 'number' ? Math.trunc(value).toString() : value.trim();
  if (!/^\d+$/.test(text)) return undefined;
  try {
    return BigInt(text);
  } catch {
    return undefined;
  }
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function assignConcentration(
  analysis: ChainAnalysis,
  conc: { top10Pct?: number; top20Pct?: number; top50Pct?: number; herfindahl?: number; gini?: number },
): void {
  if (conc.top10Pct !== undefined) analysis.top10Pct = conc.top10Pct;
  if (conc.top20Pct !== undefined) analysis.top20Pct = conc.top20Pct;
  if (conc.top50Pct !== undefined) analysis.top50Pct = conc.top50Pct;
  if (conc.herfindahl !== undefined) analysis.herfindahl = conc.herfindahl;
  if (conc.gini !== undefined) analysis.gini = conc.gini;
}

/** Stamps timing and evaluates flags. Every exit path goes through here. */
export function finish(
  analysis: ChainAnalysis,
  startedAt: number,
  largestHolderPct: number | undefined,
  snapshot: TokenSnapshot,
): ChainAnalysis {
  analysis.durationMs = Date.now() - startedAt;
  analysis.flags = evaluateFlags({
    analysis,
    metrics: snapshot.metrics,
    ...(largestHolderPct !== undefined ? { largestHolderPct } : {}),
  });
  return analysis;
}
