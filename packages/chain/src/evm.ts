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
  type LaunchFunding,
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
import { checkContractVerified, lookupFirstFunders } from './explorer';
import { clusterFunding, fundingWindowBlocks, MAX_TRACED_BUYERS, selectEarlyBuyers } from './funding';
import { evaluateFlags } from './flags';
import { measureLp } from './lp';
import { concentration } from './metrics';
import { isEvmBurnAddress, labelIsExcluded, lookupEvmAddress } from './labels';
import { Budget, RpcClient, type TransportProvider } from './rpc';
import { measureSniping, snipeWindowBlocks, type PoolTransfer } from './sniping';

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

/**
 * A funder with at least this many sent transactions serves everyone: an
 * exchange hot wallet, a bridge, a faucet. Two strangers withdrawing from
 * Binance share a funder without sharing an owner.
 */
export const HUB_MIN_NONCE = 1_000;

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
  // Pool creation times are estimates; the margin keeps the liquidity add
  // inside the window so the sniping read can see trading start.
  const ageBlocks = Number.isFinite(created)
    ? Math.ceil((Date.now() - created) / 1000 / seconds) + 2 * snipeWindowBlocks(seconds) + 10
    : opts.chunkBlocks * opts.maxChunks;
  const span = Math.min(ageBlocks, opts.chunkBlocks * opts.maxChunks);
  const fromBlock = Math.max(0, latestBlock - span);

  // Uniswap v4 pairs are keyed by a 32-byte pool id, not a contract address;
  // their tokens sit in the PoolManager singleton, which labels.ts covers.
  const poolAddresses = new Set(
    snapshot.pairs.filter((pair) => isAddress(pair.pairAddress)).map((pair) => normalizeAddress(pair.pairAddress)),
  );
  const poolTransfers: PoolTransfer[] = [];
  const allTransfers: PoolTransfer[] = [];
  const seen = new Set<string>();
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
      const logs = await client.call<
        Array<{ topics: string[]; data: string; blockNumber?: string; transactionHash?: string; logIndex?: string }>
      >('eth_getLogs', [
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
        // Replaying a log twice doubles a balance. A live node returns each
        // log once; a proxy that ignores ranges, or a recorded mock, may not.
        const key = `${entry.transactionHash ?? ''}:${entry.logIndex ?? ''}:${entry.blockNumber ?? ''}:${topics.join()}:${entry.data}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const block = entry.blockNumber ? quantityToNumber(entry.blockNumber) : undefined;
        const fromTopic = topics[1];
        const toTopic = topics[2];
        if (fromTopic === undefined || toTopic === undefined) continue;
        const from = topicToAddress(fromTopic);
        const to = topicToAddress(toTopic);
        const value = quantityToBigInt(entry.data);
        if (value === undefined) continue;
        if (from) balances.set(from, (balances.get(from) ?? 0n) - value);
        if (to) balances.set(to, (balances.get(to) ?? 0n) + value);
        if (from && to && block !== undefined) {
          allTransfers.push({ block, from, to, value });
          if (poolAddresses.has(from) || poolAddresses.has(to)) poolTransfers.push({ block, from, to, value });
        }
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

  // Only a scan that covered the token's whole life can see trading start
  // and say what the early buyers still hold.
  const isExcluded = (addr: string) =>
    isZeroAddress(addr) || isEvmBurnAddress(addr) || lookupEvmAddress(addr)?.label?.startsWith('protocol:') === true;
  const sniping =
    !truncated && Number.isFinite(created)
      ? measureSniping({
          transfers: poolTransfers,
          pools: poolAddresses,
          totalRaw,
          balances,
          walletTransfers: allTransfers,
          blockSeconds: seconds,
          isExcluded,
        })
      : undefined;
  if (sniping) {
    notes.push(
      `Early buying: ${sniping.earlyBuyPct.toFixed(1)}% of supply to ${sniping.earlyBuyers} wallet(s) in the first ` +
        `${sniping.windowBlocks} block(s) of trading (${sniping.sameBlockBuyers} in the opening block).`,
    );
  } else {
    notes.push('Early buying not measured: the scan did not reach the start of trading.');
  }

  const funding = sniping
    ? await traceFunding({
        client,
        app,
        chain: snapshot.chain,
        tradingStartBlock: sniping.tradingStartBlock,
        transfers: poolTransfers,
        pools: poolAddresses,
        totalRaw,
        balances,
        blockSeconds: seconds,
        isExcluded,
        notes,
        timeoutMs: opts.callTimeoutMs,
        budget,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
    : undefined;

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
    ...(sniping ? { sniping } : {}),
    ...(funding ? { funding } : {}),
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

interface TraceFundingInput {
  client: RpcClient;
  app: AppConfig;
  chain: Chain;
  tradingStartBlock: number;
  transfers: readonly PoolTransfer[];
  pools: ReadonlySet<string>;
  totalRaw: bigint;
  balances: ReadonlyMap<string, bigint>;
  blockSeconds: number;
  isExcluded: (address: string) => boolean;
  notes: string[];
  timeoutMs: number;
  budget: Budget;
  signal?: AbortSignal;
}

/**
 * Who paid for the early buyers' wallets. Looks up the largest buyers of the
 * first half hour on the explorer, then drops funders that serve everyone
 * (known exchanges, or any address with a hub-sized nonce) before clustering.
 * Undefined when nothing could be looked up: no key, or the explorer refused.
 */
/**
 * Funders shared by 2+ buyers that serve everyone, so cannot mark a cabal: a
 * labelled protocol, any contract (bridges, exchange contract wallets; a
 * cabal's disperse call is already resolved to its sender), or an EOA with a
 * hub-sized nonce. A funder that cannot be checked is treated as a hub: one
 * unchecked exchange wallet would otherwise cluster strangers. Undefined when
 * the budget runs out first, since then nothing can be told apart.
 */
export async function findHubFunders(
  client: RpcClient,
  funders: ReadonlyMap<string, string | undefined>,
  budget: Budget,
): Promise<Set<string> | undefined> {
  const counts = new Map<string, number>();
  for (const funder of funders.values()) if (funder) counts.set(funder, (counts.get(funder) ?? 0) + 1);
  const hubs = new Set<string>();
  for (const [funder, count] of counts) {
    if (count < 2) continue;
    if (labelIsExcluded(lookupEvmAddress(funder)?.label)) {
      hubs.add(funder);
      continue;
    }
    if (budget.expired()) return undefined;
    try {
      const [nonce, code] = await client.callMany([
        { method: 'eth_getTransactionCount', params: [funder, 'latest'] },
        { method: 'eth_getCode', params: [funder, 'latest'] },
      ]);
      const sent = typeof nonce?.result === 'string' ? quantityToNumber(nonce.result) : undefined;
      const bytecode = typeof code?.result === 'string' ? code.result : undefined;
      if (sent === undefined || bytecode === undefined || bytecode !== '0x' || sent >= HUB_MIN_NONCE) hubs.add(funder);
    } catch {
      if (budget.expired()) return undefined;
      hubs.add(funder);
    }
  }
  return hubs;
}

async function traceFunding(input: TraceFundingInput): Promise<LaunchFunding | undefined> {
  const { client, notes } = input;
  const windowBlocks = fundingWindowBlocks(input.blockSeconds);
  const buyers = selectEarlyBuyers({
    transfers: input.transfers,
    pools: input.pools,
    tradingStartBlock: input.tradingStartBlock,
    windowBlocks,
    isExcluded: input.isExcluded,
    max: MAX_TRACED_BUYERS,
  });
  if (buyers.length === 0) return undefined;

  const funders = await lookupFirstFunders({
    app: input.app,
    chain: input.chain,
    addresses: buyers.map((buyer) => buyer.address),
    notes,
    timeoutMs: input.timeoutMs,
    budget: input.budget,
    ...(input.signal ? { signal: input.signal } : {}),
    txSender: async (hash) => {
      const tx = await client.call<{ from?: string } | null>('eth_getTransactionByHash', [hash]);
      return tx?.from ? normalizeAddress(tx.from) : undefined;
    },
  });
  if (funders.size === 0) return undefined;

  const hubs = await findHubFunders(client, funders, input.budget);
  if (hubs === undefined) {
    notes.push('Funding not traced: analysis budget exhausted before the hub check.');
    return undefined;
  }

  const funding = clusterFunding({
    buyers,
    funders,
    isHub: (address) => hubs.has(address),
    totalRaw: input.totalRaw,
    balances: input.balances,
    windowBlocks,
  });
  notes.push(
    `Funding: ${funding.traced} of ${buyers.length} early buyer(s) traced over the first ${windowBlocks} block(s); ` +
      `${funding.clusters.length} cluster(s) holding ${funding.clusteredPct.toFixed(1)}% of supply bought` +
      (hubs.size > 0 ? `; ${hubs.size} hub funder(s) ignored.` : '.'),
  );
  return funding;
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
