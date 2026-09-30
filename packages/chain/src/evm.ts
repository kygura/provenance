/**
 * EVM holder-distribution analyser over plain JSON-RPC.
 *
 * Deriving a holder set on an EVM chain without a paid indexer means replaying
 * `Transfer` logs into a balance map. That is unbounded work on a busy token,
 * so every scan runs against a hard budget: a maximum block span, a maximum
 * number of chunks, and the wall clock. Hitting any of them is normal and
 * yields `method: 'partial'` with a note saying what was covered — never a
 * throw, and never a number presented as if the whole history had been read.
 */

import {
  isEvm,
  nowIso,
  tokenId as makeTokenId,
  type AnalyzerContext,
  type AppConfig,
  type ChainAnalysis,
  type ChainAnalyzer,
  type Chain,
  type HolderRow,
  type Logger,
  type TokenSnapshot,
} from '@provenance/core';
import {
  decodeAddress,
  decodeUint256,
  encodeBalanceOf,
  encodeCall,
  formatUnits,
  isAddress,
  isZeroAddress,
  normalizeAddress,
  quantityToBigInt,
  quantityToNumber,
  SELECTORS,
  toQuantity,
  topicToAddress,
  TRANSFER_TOPIC0,
} from './abi';
import { readPrivilegedFunctions } from './bytecode';
import { checkContractVerified } from './explorer';
import { evaluateFlags } from './flags';
import { measureLp } from './lp';
import { concentration } from './metrics';
import { isEvmBurnAddress, lookupEvmAddress } from './labels';
import { Budget, RpcClient, type TransportProvider } from './rpc';

export interface EvmAnalyzerOptions {
  /** Wall-clock ceiling for one token's analysis. */
  budgetMs?: number;
  callTimeoutMs?: number;
  /** Blocks per `eth_getLogs` request. Public nodes commonly cap near 10k. */
  chunkBlocks?: number;
  /** Maximum chunks per token, so a long-lived token cannot run forever. */
  maxChunks?: number;
  rateLimitMs?: number;
  /** Top holders retained on the report. */
  topN?: number;
}

const DEFAULTS: Required<EvmAnalyzerOptions> = {
  budgetMs: 45_000,
  callTimeoutMs: 12_000,
  chunkBlocks: 9_000,
  maxChunks: 12,
  rateLimitMs: 120,
  topN: 20,
};

/** Rough seconds per block, used only to guess a starting block from pool age. */
const BLOCK_SECONDS: Partial<Record<Chain, number>> = {
  ethereum: 12,
  base: 2,
  bsc: 3,
  arbitrum: 0.25,
  polygon: 2,
  avalanche: 2,
};

function endpointsFor(app: AppConfig, chain: Chain): readonly string[] {
  const table = app.rpc as unknown as Record<string, string[] | undefined>;
  return table[chain] ?? [];
}

export async function analyzeEvm(
  snapshot: TokenSnapshot,
  ctx: AnalyzerContext,
  transport: TransportProvider,
  options: EvmAnalyzerOptions,
  app: AppConfig,
  logger: Logger,
): Promise<ChainAnalysis> {
  const opts = { ...DEFAULTS, ...options };
  const started = Date.now();
  const notes: string[] = [];
  const budget = new Budget(opts.budgetMs);
  const address = normalizeAddress(snapshot.tokenAddress);
  const log = logger.child('evm');

  const base: ChainAnalysis = {
    tokenId: snapshot.tokenId,
    chain: snapshot.chain,
    tokenAddress: snapshot.tokenAddress,
    method: 'unavailable',
    topHolders: [],
    flags: [],
    notes,
    fetchedAt: nowIso(),
  };

  const endpoints = endpointsFor(app, snapshot.chain);
  if (endpoints.length === 0) {
    notes.push(`No RPC endpoint configured for ${snapshot.chain}.`);
    return { ...base, durationMs: Date.now() - started };
  }

  const resolved = typeof transport === 'function' ? await transport() : transport;
  const client = new RpcClient({
    endpoints,
    transport: resolved,
    logger: log,
    timeoutMs: opts.callTimeoutMs,
    rateLimitMs: opts.rateLimitMs,
    attempts: 2,
    budget,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });

  // --- supply, decimals, ownership -----------------------------------------
  let decimals = 18;
  let totalRaw = 0n;
  let ownerRenounced: boolean | undefined;

  try {
    const [decRes, supRes] = await Promise.all([
      client.call<string>('eth_call', [{ to: address, data: encodeCall(SELECTORS.decimals) }, 'latest']),
      client.call<string>('eth_call', [{ to: address, data: encodeCall(SELECTORS.totalSupply) }, 'latest']),
    ]);
    decimals = Number(decodeUint256(decRes) ?? 18n);
    totalRaw = decodeUint256(supRes) ?? 0n;
  } catch (error) {
    notes.push(`Could not read supply/decimals: ${(error as Error).message}`);
    return { ...base, durationMs: Date.now() - started };
  }

  try {
    const ownerRes = await client.call<string>('eth_call', [
      { to: address, data: encodeCall(SELECTORS.owner) },
      'latest',
    ]);
    const owner = decodeAddress(ownerRes);
    // A revert means there is no owner() at all, which is not the same claim as
    // "ownership was renounced" — leave it undefined and say so.
    ownerRenounced = owner ? isZeroAddress(owner) : undefined;
    if (owner === undefined) notes.push('Token exposes no owner(); renouncement could not be determined.');
  } catch {
    notes.push('owner() call reverted; the token likely has no ownership function.');
  }

  const supply = { total: formatUnits(totalRaw, decimals), decimals };

  // --- contract surface: bytecode, LP, explorer ----------------------------
  // Cheap, bounded reads, done before the log scan so a long scan cannot
  // starve them of budget. Each degrades to a note and never throws.
  const [codeScan, lp, contractVerified] = await Promise.all([
    readPrivilegedFunctions(client, address),
    measureLp(client, snapshot.pairs, budget),
    checkContractVerified({
      app,
      chain: snapshot.chain,
      address,
      notes,
      timeoutMs: opts.callTimeoutMs,
      budget,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    }),
  ]);
  if (codeScan.note) notes.push(codeScan.note);
  if (codeScan.matches.length > 0) {
    notes.push(`Privileged selectors in bytecode: ${codeScan.matches.map((m) => `${m.selector} (${m.kind})`).join(', ')}.`);
  }
  notes.push(...lp.notes);

  const surface: Pick<ChainAnalysis, 'privilegedFunctions' | 'lpBurnedPct' | 'lpLockedPct' | 'contractVerified'> = {
    ...(codeScan.privilegedFunctions !== undefined ? { privilegedFunctions: codeScan.privilegedFunctions } : {}),
    ...(lp.lpBurnedPct !== undefined ? { lpBurnedPct: lp.lpBurnedPct } : {}),
    ...(lp.lpLockedPct !== undefined ? { lpLockedPct: lp.lpLockedPct } : {}),
    ...(contractVerified !== undefined ? { contractVerified } : {}),
  };

  // --- holder reconstruction from Transfer logs ----------------------------
  let latestBlock = 0;
  try {
    latestBlock = quantityToNumber(await client.call<string>('eth_blockNumber', []));
  } catch (error) {
    notes.push(`Could not read head block: ${(error as Error).message}`);
    return {
      ...base,
      method: 'partial',
      supply,
      ownerRenounced,
      ...surface,
      flags: evaluateFlags({ analysis: { method: 'partial', ownerRenounced, ...surface }, metrics: snapshot.metrics }),
      durationMs: Date.now() - started,
    };
  }

  const seconds = BLOCK_SECONDS[snapshot.chain] ?? 12;
  const created = snapshot.metrics.poolCreatedAt ? Date.parse(snapshot.metrics.poolCreatedAt) : Number.NaN;
  const ageBlocks = Number.isFinite(created)
    ? Math.ceil((Date.now() - created) / 1000 / seconds)
    : opts.chunkBlocks * opts.maxChunks;
  const span = Math.min(ageBlocks, opts.chunkBlocks * opts.maxChunks);
  const fromBlock = Math.max(0, latestBlock - span);

  const balances = new Map<string, bigint>();
  let scannedFrom = latestBlock;
  let chunks = 0;
  let truncated = false;

  // Walk backwards from the head: the most recent activity is the most
  // informative if the budget runs out before the full span is covered.
  // Nodes that refuse a wide range (403, "range too large") usually accept a
  // narrow one, so a refusal shrinks the window once before giving up.
  let chunkBlocks = opts.chunkBlocks;
  const narrowBlocks = Math.max(1, Math.floor(opts.chunkBlocks / 8));
  for (let end = latestBlock; end > fromBlock; ) {
    if (chunks >= opts.maxChunks || budget.expired()) {
      truncated = true;
      break;
    }
    const start = Math.max(fromBlock, end - chunkBlocks + 1);
    try {
      const logs = await client.call<Array<{ topics: string[]; data: string }>>('eth_getLogs', [
        {
          address,
          topics: [TRANSFER_TOPIC0],
          fromBlock: toQuantity(start),
          toBlock: toQuantity(end),
        },
      ]);
      for (const entry of logs ?? []) {
        // ERC-721 shares this topic0 but indexes tokenId as a fourth topic, so
        // its logs would otherwise be replayed as if tokenIds were balances.
        // Only the 3-topic ERC-20 shape is a transfer of fungible value.
        const topics = entry.topics ?? [];
        if (topics.length !== 3) continue;
        const fromTopic = topics[1];
        const toTopic = topics[2];
        if (fromTopic === undefined || toTopic === undefined) continue;
        const from = topicToAddress(fromTopic);
        const to = topicToAddress(toTopic);
        const value = quantityToBigInt(entry.data);
        if (value === undefined) continue;
        if (from) balances.set(from, (balances.get(from) ?? 0n) - value);
        if (to) balances.set(to, (balances.get(to) ?? 0n) + value);
      }
      scannedFrom = start;
      chunks += 1;
      end = start - 1;
    } catch (error) {
      if (chunkBlocks > narrowBlocks) {
        chunkBlocks = narrowBlocks;
        continue;
      }
      // A node refusing a range is the common case, not an exception.
      notes.push(`Log scan stopped at block ${start}: ${(error as Error).message}`);
      truncated = true;
      break;
    }
  }

  if (balances.size === 0) {
    notes.push('No Transfer logs recovered; holder distribution is unknown.');
    return {
      ...base,
      method: 'partial',
      supply,
      ownerRenounced,
      ...surface,
      flags: evaluateFlags({ analysis: { method: 'partial', ownerRenounced, ...surface }, metrics: snapshot.metrics }),
      durationMs: Date.now() - started,
    };
  }

  // Balances derived from a partial window can go negative for wallets that
  // held before the window opened. Those are not holders we measured, so drop
  // them rather than clamping to zero and inventing a distribution.
  // Uniswap v4 pairs are keyed by a 32-byte pool id, not a contract address;
  // their tokens sit in the PoolManager singleton, which labels.ts covers.
  const poolAddresses = new Set(
    snapshot.pairs.filter((pair) => isAddress(pair.pairAddress)).map((pair) => normalizeAddress(pair.pairAddress)),
  );
  const rows: HolderRow[] = [];
  for (const [holder, raw] of balances) {
    if (raw <= 0n) continue;
    const known = lookupEvmAddress(holder);
    const isPool = poolAddresses.has(holder);
    const isBurn = isEvmBurnAddress(holder);
    rows.push({
      address: holder,
      balance: formatUnits(raw, decimals),
      pct: totalRaw > 0n ? Number((raw * 1_000_000n) / totalRaw) / 10_000 : 0,
      label: isPool ? 'liquidity-pool' : isBurn ? 'burn' : known?.label,
      excludedFromConcentration: isPool || isBurn || known?.label?.startsWith('protocol:') === true,
    });
  }
  rows.sort((a, b) => b.balance - a.balance);

  const conc = concentration({ rows, totalSupply: supply.total, sampled: truncated });
  const burnedRaw = rows.filter((r) => r.label === 'burn').reduce((sum, r) => sum + r.pct, 0);

  if (truncated) {
    notes.push(
      `Partial scan: blocks ${scannedFrom}-${latestBlock} of a ${span}-block window (${chunks} chunk(s)). ` +
        'Holder counts and concentration describe this window only.',
    );
  }
  notes.push(
    `Concentration computed from ${rows.length} addresses reconstructed from Transfer logs — a sample of the ` +
      'window scanned, not a full holder census.',
  );

  const analysis: ChainAnalysis = {
    ...base,
    method: truncated ? 'partial' : 'rpc',
    supply: { ...supply, burnedPct: burnedRaw > 0 ? burnedRaw : undefined },
    holderCount: truncated ? undefined : rows.length,
    top10Pct: conc.top10Pct,
    top20Pct: conc.top20Pct,
    top50Pct: conc.top50Pct,
    ...(conc.largestHolderPct !== undefined ? { largestHolderPct: conc.largestHolderPct } : {}),
    herfindahl: conc.herfindahl,
    gini: conc.gini,
    ownerRenounced,
    ...surface,
    topHolders: rows.slice(0, opts.topN),
    fetchedAt: nowIso(),
    durationMs: Date.now() - started,
  };

  analysis.flags = evaluateFlags({
    analysis,
    metrics: snapshot.metrics,
    ...(analysis.largestHolderPct !== undefined ? { largestHolderPct: analysis.largestHolderPct } : {}),
  });

  return analysis;
}

export function createEvmAnalyzer(
  app: AppConfig,
  logger: Logger,
  transport: TransportProvider,
  options: EvmAnalyzerOptions = {},
): ChainAnalyzer {
  const chains = (['ethereum', 'base', 'bsc', 'arbitrum', 'polygon', 'avalanche', 'blast'] as Chain[]).filter(isEvm);
  return {
    chains,
    analyze: (snapshot, ctx) => analyzeEvm(snapshot, ctx, transport, options, app, logger),
  };
}

export { makeTokenId, encodeBalanceOf };
