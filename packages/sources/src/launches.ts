import {
  type AppConfig,
  type Chain,
  type PairInfo,
  type SourceConfig,
  type SourceContext,
  type TrendingEntry,
  type TrendingSource,
  normalizeChain,
  nowIso,
} from '@provenance/core';

import {
  DEXSCREENER_BASE_URL,
  DEXSCREENER_BATCH_SIZE,
  type DexScreenerCandidate,
  type DexScreenerPairRow,
  buildDexScreenerEntries,
  chunk,
  parseDexScreenerPairs,
} from './dexscreener';
import { compactEnrichment, type EnrichedTrendingEntry } from './enrichment';
import { readJsonFixtures } from './fixtures';
import { JsonClient } from './http';
import { ageHoursFrom, asArray, isRecord } from './normalize';
import { JsonRpcClient, type RpcCaller, hexToNumber, numberToHex } from './rpc';

/** keccak256("PairCreated(address,address,address,uint256)") — Uniswap V2 factory. */
export const PAIR_CREATED_TOPIC = '0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9';

/** keccak256("PoolCreated(address,address,uint24,int24,address)") — Uniswap V3 factory. */
export const POOL_CREATED_TOPIC = '0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118';

/**
 * keccak256("PoolCreated(address,address,bool,address,uint256)") — Aerodrome
 * (Base). Same data layout as V2 `PairCreated` (pool, then a counter), with the
 * stable flag as topic 3, and Aerodrome pools are fungible-LP pairs, so it
 * decodes and measures as `v2`.
 */
export const AERODROME_POOL_CREATED_TOPIC = '0x2128d88d14c80cb081c1252a5acff7a264671bf199ce226b53788fb26065005e';

export type FactoryVersion = 'v2' | 'v3';

export interface LaunchFactory {
  dexId: string;
  version: FactoryVersion;
  /** Lowercase. A creation event from any other address is a forgery. */
  address: string;
  topic0: string;
}

export interface LaunchChainSpec {
  chain: Chain;
  /** Average block time; converts the lookback into a block span and back. */
  blockSeconds: number;
  factories: readonly LaunchFactory[];
  /** Lowercase address -> symbol. The side of a new pool that is *not* launching. */
  quoteTokens: Readonly<Record<string, string>>;
}

/**
 * One row per chain. Pool-creation events are read instead of dexscanner's
 * Transfer-from-zero scan because a mint is not a launch: every rebasing token,
 * bridge and airdrop mints, while a token only becomes tradeable when someone
 * opens a pool against a real quote asset.
 */
export const LAUNCH_FACTORIES: readonly LaunchChainSpec[] = [
  {
    chain: 'ethereum',
    blockSeconds: 12,
    factories: [
      { dexId: 'uniswap', version: 'v2', address: '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f', topic0: PAIR_CREATED_TOPIC },
      { dexId: 'uniswap', version: 'v3', address: '0x1f98431c8ad98523631ae4a59f267346ea31f984', topic0: POOL_CREATED_TOPIC },
    ],
    quoteTokens: {
      '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
      '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT',
      '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI',
    },
  },
  {
    // Factory addresses and topics checked against live Base logs, Oct 2026.
    chain: 'base',
    blockSeconds: 2,
    factories: [
      { dexId: 'uniswap', version: 'v2', address: '0x8909dc15e40173ff4699343b6eb8132c65e18ec6', topic0: PAIR_CREATED_TOPIC },
      { dexId: 'uniswap', version: 'v3', address: '0x33128a8fc17869897dce68ed026d694621f6fdfd', topic0: POOL_CREATED_TOPIC },
      { dexId: 'aerodrome', version: 'v2', address: '0x420dd381b31aef6683db6b902084cb0ffece40da', topic0: AERODROME_POOL_CREATED_TOPIC },
    ],
    quoteTokens: {
      '0x4200000000000000000000000000000000000006': 'WETH',
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC',
      // Virtuals agent tokens launch against VIRTUAL rather than WETH.
      '0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b': 'VIRTUAL',
    },
  },
];

/** Public nodes commonly cap `eth_getLogs` at a few thousand blocks or 10k results. */
export const LAUNCH_CHUNK_BLOCKS = 2_000;
export const LAUNCH_MAX_CHUNKS = 30;
/** Discovery runs sources concurrently; the walk must not hold the run hostage. */
export const LAUNCH_WALK_BUDGET_MS = 45_000;
/**
 * The walk starts this far behind the reported head. `eth_blockNumber` is
 * answered by one node and the first `eth_getLogs` can land on a slower one,
 * which refuses a range ending past its own head ("block range extends beyond
 * current head block"). The skipped blocks fall inside the next run's lookback.
 */
export const LAUNCH_HEAD_LAG_SECONDS = 36;

/** A decoded factory creation event. Addresses are lowercase. */
export interface PoolCreation {
  chain: Chain;
  dexId: string;
  version: FactoryVersion;
  factory: string;
  token0: string;
  token1: string;
  pool: string;
  /** V3 only, hundredths of a basis point (3000 = 0.3%). */
  fee?: number;
  tickSpacing?: number;
  blockNumber: number;
  transactionHash?: string;
  logIndex?: number;
}

/** A pool that looks like a launch: exactly one side is a known quote asset. */
export interface LaunchCandidate {
  chain: Chain;
  tokenAddress: string;
  quoteAddress: string;
  quoteSymbol: string;
  pool: PoolCreation;
  /** Estimated from block distance; see `estimateCreatedAt`. */
  createdAt: string;
}

const WORD = /^0x[0-9a-fA-F]{64}$/;

function topicAddress(topic: unknown): string | undefined {
  if (typeof topic !== 'string' || !WORD.test(topic)) return undefined;
  return `0x${topic.slice(-40).toLowerCase()}`;
}

function dataWords(data: unknown): string[] | undefined {
  if (typeof data !== 'string' || !/^0x([0-9a-fA-F]{64})*$/.test(data)) return undefined;
  const body = data.slice(2);
  const words: string[] = [];
  for (let i = 0; i < body.length; i += 64) words.push(body.slice(i, i + 64));
  return words;
}

function wordAddress(word: string | undefined): string | undefined {
  return word === undefined ? undefined : `0x${word.slice(-40).toLowerCase()}`;
}

function wordInt(word: string | undefined, signed: boolean): number | undefined {
  if (word === undefined || !/^[0-9a-fA-F]{64}$/.test(word)) return undefined;
  const raw = BigInt(`0x${word}`);
  const value = signed ? BigInt.asIntN(256, raw) : raw;
  const out = Number(value);
  return Number.isSafeInteger(out) ? out : undefined;
}

/**
 * Pure decoder for one `eth_getLogs` row. Never throws.
 *
 * The two factories index the same two tokens but lay out the rest
 * differently: V2 `PairCreated(token0, token1, pair, allPairsLength)` puts the
 * pair in the first data word; V3 `PoolCreated(token0, token1, fee, tickSpacing,
 * pool)` indexes the fee as topic 3 and puts the pool in the SECOND data word,
 * after `tickSpacing`.
 */
export function parseFactoryLog(log: unknown, spec: LaunchChainSpec): PoolCreation | undefined {
  if (!isRecord(log) || log.removed === true) return undefined; // reorged out
  const topics = asArray(log.topics);
  const topic0 = typeof topics[0] === 'string' ? topics[0].toLowerCase() : undefined;
  const emitter = typeof log.address === 'string' ? log.address.toLowerCase() : undefined;
  const factory = spec.factories.find((row) => row.topic0 === topic0 && row.address === emitter);
  if (!factory) return undefined;

  const token0 = topicAddress(topics[1]);
  const token1 = topicAddress(topics[2]);
  const words = dataWords(log.data);
  const blockNumber = hexToNumber(log.blockNumber);
  if (!token0 || !token1 || !words || blockNumber === undefined) return undefined;

  let pool: string | undefined;
  let fee: number | undefined;
  let tickSpacing: number | undefined;
  if (factory.version === 'v2') {
    pool = words.length >= 1 ? wordAddress(words[0]) : undefined;
  } else {
    const feeTopic = topics[3];
    fee = typeof feeTopic === 'string' && WORD.test(feeTopic) ? wordInt(feeTopic.slice(2), false) : undefined;
    tickSpacing = wordInt(words[0], true);
    pool = words.length >= 2 ? wordAddress(words[1]) : undefined;
  }
  if (!pool) return undefined;

  const out: PoolCreation = {
    chain: spec.chain,
    dexId: factory.dexId,
    version: factory.version,
    factory: factory.address,
    token0,
    token1,
    pool,
    blockNumber,
  };
  if (fee !== undefined) out.fee = fee;
  if (tickSpacing !== undefined) out.tickSpacing = tickSpacing;
  if (typeof log.transactionHash === 'string') out.transactionHash = log.transactionHash;
  const logIndex = hexToNumber(log.logIndex);
  if (logIndex !== undefined) out.logIndex = logIndex;
  return out;
}

export function parseFactoryLogs(logs: unknown, spec: LaunchChainSpec): PoolCreation[] {
  const out: PoolCreation[] = [];
  for (const log of asArray(logs)) {
    const parsed = parseFactoryLog(log, spec);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Which side launched. Quote/quote pools (a new WETH/USDC fee tier) and
 * token/token pools (two unknowns, usually spam) are both skipped: neither has
 * a single token whose market this pool just opened.
 */
export function launchedSide(
  pool: PoolCreation,
  spec: LaunchChainSpec,
): { tokenAddress: string; quoteAddress: string; quoteSymbol: string } | undefined {
  const quote0 = spec.quoteTokens[pool.token0];
  const quote1 = spec.quoteTokens[pool.token1];
  if (quote0 !== undefined && quote1 === undefined) {
    return { tokenAddress: pool.token1, quoteAddress: pool.token0, quoteSymbol: quote0 };
  }
  if (quote1 !== undefined && quote0 === undefined) {
    return { tokenAddress: pool.token0, quoteAddress: pool.token1, quoteSymbol: quote1 };
  }
  return undefined;
}

/**
 * ESTIMATE, not a measurement: block distance from head times the chain's
 * average block time. Fetching each block's timestamp would cost one call per
 * pool on a public node; minutes of drift do not matter to a launch lane that
 * thinks in hours, and DexScreener's `pairCreatedAt` replaces it once indexed.
 */
export function estimateCreatedAt(blockNumber: number, head: number, anchor: Date, blockSeconds: number): string {
  const deltaMs = Math.max(0, head - blockNumber) * blockSeconds * 1000;
  return new Date(anchor.getTime() - deltaMs).toISOString();
}

/**
 * Quote-side filter, then one row per token keeping the EARLIEST pool in the
 * window (the launch itself; later pools are the market widening), then
 * newest-first.
 */
export function collectLaunches(
  pools: readonly PoolCreation[],
  spec: LaunchChainSpec,
  head: number,
  anchor: Date,
): LaunchCandidate[] {
  const byToken = new Map<string, LaunchCandidate>();
  for (const pool of pools) {
    const side = launchedSide(pool, spec);
    if (!side) continue;
    const existing = byToken.get(side.tokenAddress);
    if (existing && !isEarlier(pool, existing.pool)) continue;
    byToken.set(side.tokenAddress, {
      chain: spec.chain,
      ...side,
      pool,
      createdAt: estimateCreatedAt(pool.blockNumber, head, anchor, spec.blockSeconds),
    });
  }
  return [...byToken.values()].sort(newestFirst);
}

function isEarlier(a: PoolCreation, b: PoolCreation): boolean {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber;
  return (a.logIndex ?? Number.MAX_SAFE_INTEGER) < (b.logIndex ?? Number.MAX_SAFE_INTEGER);
}

/** Across chains block numbers are incomparable, so order by estimated time. */
function newestFirst(a: LaunchCandidate, b: LaunchCandidate): number {
  const byTime = Date.parse(b.createdAt) - Date.parse(a.createdAt);
  if (byTime !== 0) return byTime;
  if (a.pool.blockNumber !== b.pool.blockNumber) return b.pool.blockNumber - a.pool.blockNumber;
  return a.tokenAddress.localeCompare(b.tokenAddress);
}

export interface WalkOptions {
  lookbackHours: number;
  chunkBlocks?: number;
  maxChunks?: number;
  budgetMs?: number;
  /** Seconds behind the reported head at which scanning starts. Default `LAUNCH_HEAD_LAG_SECONDS`. */
  headLagSeconds?: number;
  signal?: AbortSignal;
  /** Injected clock for the wall-clock budget. */
  now?: () => number;
}

export interface WalkResult {
  head?: number;
  /** Lowest block actually covered; above the window start when the walk stopped early. */
  scannedFrom?: number;
  windowFrom?: number;
  chunks: number;
  logs: unknown[];
  /** Why the walk stopped short of the window, if it did. */
  errors: string[];
}

/** Block span covering `lookbackHours` on a chain. */
export function lookbackBlocks(lookbackHours: number, blockSeconds: number): number {
  return Math.max(1, Math.ceil((Math.max(0, lookbackHours) * 3600) / blockSeconds));
}

/**
 * Walks factory logs from head backwards in fixed chunks. Newest first, so a
 * walk cut short by a refusal or the budget still has the freshest launches,
 * which are the ones nobody else has seen yet. Never throws: a refused range
 * ends the walk and becomes an entry in `errors`.
 */
export async function walkFactoryLogs(call: RpcCaller, spec: LaunchChainSpec, options: WalkOptions): Promise<WalkResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const chunkBlocks = Math.max(1, options.chunkBlocks ?? LAUNCH_CHUNK_BLOCKS);
  const maxChunks = Math.max(1, options.maxChunks ?? LAUNCH_MAX_CHUNKS);
  const budgetMs = options.budgetMs ?? LAUNCH_WALK_BUDGET_MS;
  const result: WalkResult = { chunks: 0, logs: [], errors: [] };

  let head: number | undefined;
  try {
    head = hexToNumber(await call('eth_blockNumber', [], options.signal));
  } catch (error) {
    result.errors.push(`eth_blockNumber failed: ${message(error)}`);
    return result;
  }
  if (head === undefined) {
    result.errors.push('eth_blockNumber returned a non-quantity');
    return result;
  }

  const windowFrom = Math.max(0, head - lookbackBlocks(options.lookbackHours, spec.blockSeconds) + 1);
  result.head = head;
  result.windowFrom = windowFrom;

  const filter = {
    address: spec.factories.map((factory) => factory.address),
    // One OR-set on topic0 fetches both factories' events in a single call.
    topics: [[...new Set(spec.factories.map((factory) => factory.topic0))]],
  };

  const lagBlocks = Math.ceil(Math.max(0, options.headLagSeconds ?? LAUNCH_HEAD_LAG_SECONDS) / spec.blockSeconds);
  let to = Math.max(windowFrom, head - lagBlocks);
  while (to >= windowFrom) {
    if (options.signal?.aborted) {
      result.errors.push(`aborted with blocks ${windowFrom}-${to} unscanned`);
      break;
    }
    if (result.chunks >= maxChunks) {
      result.errors.push(`chunk budget (${maxChunks}) spent with blocks ${windowFrom}-${to} unscanned`);
      break;
    }
    if (now() - started > budgetMs) {
      result.errors.push(`time budget (${budgetMs}ms) spent with blocks ${windowFrom}-${to} unscanned`);
      break;
    }

    const from = Math.max(windowFrom, to - chunkBlocks + 1);
    try {
      const logs = await call(
        'eth_getLogs',
        [{ ...filter, fromBlock: numberToHex(from), toBlock: numberToHex(to) }],
        options.signal,
      );
      if (!Array.isArray(logs)) throw new Error('eth_getLogs result is not an array');
      result.logs.push(...logs);
    } catch (error) {
      result.errors.push(`eth_getLogs refused blocks ${from}-${to}: ${message(error)}`);
      break;
    }
    result.chunks += 1;
    result.scannedFrom = from;
    to = from - 1;
  }

  return result;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `LAUNCH_FACTORIES` rows allowed by `pipeline.chains` (empty = all). */
export function launchChainsFor(app: AppConfig): LaunchChainSpec[] {
  const allowed = new Set(app.pipeline.chains);
  return LAUNCH_FACTORIES.filter((spec) => allowed.size === 0 || allowed.has(spec.chain));
}

/**
 * Hydrates launches through the DexScreener builders, then re-labels them.
 * A token DexScreener has not indexed yet is still emitted: the factory event
 * is proof the market exists, and hiding it until an indexer catches up would
 * throw away the head start this source is for.
 */
export function buildLaunchEntries(
  launches: readonly LaunchCandidate[],
  pairRows: readonly DexScreenerPairRow[],
  capturedAt: string = nowIso(),
): EnrichedTrendingEntry[] {
  const candidates: DexScreenerCandidate[] = launches.map((launch, index) => ({
    chain: launch.chain,
    tokenAddress: launch.tokenAddress,
    rank: index + 1,
    socials: {},
    raw: launch,
  }));
  // One entry per candidate, in candidate order, so indexes line up.
  const built = buildDexScreenerEntries(candidates, [...pairRows], capturedAt);

  return built.map((entry, index) => {
    const launch = launches[index];
    if (!launch) return { ...entry, source: 'launches' };

    const factoryPair: PairInfo = {
      pairAddress: launch.pool.pool,
      dexId: launch.pool.dexId,
      quoteSymbol: launch.quoteSymbol,
      quoteAddress: launch.quoteAddress,
      createdAt: launch.createdAt,
    };
    const pairs = entry.enrichment?.pairs ?? [];
    const indexed = pairs.some((pair) => pair.pairAddress.toLowerCase() === launch.pool.pool);
    const enrichment = compactEnrichment({
      ...(entry.enrichment ?? {}),
      pairs: indexed ? pairs : [...pairs, factoryPair],
    });

    const metrics = { ...entry.metrics };
    if (metrics.poolCreatedAt === undefined) {
      metrics.poolCreatedAt = launch.createdAt;
      metrics.ageHours = ageHoursFrom(launch.createdAt, new Date(capturedAt));
    }

    const out: EnrichedTrendingEntry = {
      ...entry,
      source: 'launches',
      pairAddress: entry.pairAddress ?? launch.pool.pool,
      metrics,
    };
    if (enrichment) out.enrichment = enrichment;
    else delete out.enrichment;
    return out;
  });
}

export interface LaunchSourceOptions {
  dexscreenerBaseUrl?: string;
  /** Builds the JSON-RPC caller for a chain; tests inject a scripted node. */
  rpc?: (chain: Chain, endpoints: readonly string[]) => RpcCaller;
  chunkBlocks?: number;
  maxChunks?: number;
  budgetMs?: number;
}

interface ChainScan {
  spec: LaunchChainSpec;
  head: number;
  anchor: Date;
  logs: unknown[];
}

/**
 * Supply side: new pools read straight off DEX factory events, keyless, over
 * public JSON-RPC. Rows are shaped like any other source's so they merge, but
 * `source: 'launches'` keeps them out of the trending lane (`splitLanes`).
 */
export class LaunchSource implements TrendingSource {
  readonly id = 'launches' as const;
  readonly label = 'Launches';

  private readonly errors: { source: string; error: string }[] = [];

  constructor(
    private readonly config: SourceConfig,
    private readonly options: LaunchSourceOptions = {},
  ) {}

  drainErrors(): { source: string; error: string }[] {
    return this.errors.splice(0, this.errors.length);
  }

  async fetchTrending(ctx: SourceContext): Promise<TrendingEntry[]> {
    const config = ctx.config ?? this.config;
    const logger = ctx.logger.child('launches');
    const capturedAt = nowIso();
    const fixtures = ctx.app.pipeline.useFixtures;

    try {
      const specs = launchChainsFor(ctx.app);
      if (specs.length === 0) {
        logger.debug('no launch factories for the configured chains');
        return [];
      }

      const scans = fixtures
        ? await this.scanFixtures(specs, ctx.app, capturedAt)
        : await this.scanNetwork(specs, ctx, config);

      const launches = scans
        .flatMap((scan) => collectLaunches(parseFactoryLogs(scan.logs, scan.spec), scan.spec, scan.head, scan.anchor))
        .sort(newestFirst)
        .slice(0, Math.max(0, config.limit));

      const pairRows = fixtures
        ? await this.hydrateFromFixtures(capturedAt)
        : await this.hydrateFromNetwork(launches, ctx, capturedAt);

      const entries = buildLaunchEntries(launches, pairRows, capturedAt);
      logger.info('launches found', {
        count: entries.length,
        indexed: entries.filter((entry) => entry.metrics.liquidityUsd !== undefined).length,
        fixtures,
      });
      return entries;
    } catch (error) {
      const text = message(error);
      this.errors.push({ source: this.id, error: text });
      logger.warn('launch scan failed, returning empty list', { error: text });
      return [];
    }
  }

  private async scanNetwork(specs: LaunchChainSpec[], ctx: SourceContext, config: SourceConfig): Promise<ChainScan[]> {
    const scans: ChainScan[] = [];
    for (const spec of specs) {
      const endpoints = ctx.app.rpc[spec.chain as keyof AppConfig['rpc']] ?? [];
      const call =
        this.options.rpc?.(spec.chain, endpoints) ??
        new JsonRpcClient({ endpoints, rateLimitMs: config.rateLimitMs, logger: ctx.logger }).call;

      const walk = await walkFactoryLogs(call, spec, {
        lookbackHours: ctx.app.launches.lookbackHours,
        chunkBlocks: this.options.chunkBlocks,
        maxChunks: this.options.maxChunks,
        budgetMs: this.options.budgetMs,
        signal: ctx.signal,
      });
      for (const error of walk.errors) {
        this.errors.push({ source: `${this.id}:${spec.chain}`, error });
        ctx.logger.warn('launch walk stopped early', { chain: spec.chain, error });
      }
      if (walk.head === undefined) continue;
      // The head block is at most a slot old, so "now" is its timestamp to
      // within the precision the estimate already gives up.
      scans.push({ spec, head: walk.head, anchor: new Date(), logs: walk.logs });
    }
    return scans;
  }

  /**
   * A logs fixture is what the walk would have returned: `{ chain, head,
   * headTimestamp?, logs }`. The window is still applied, so a shorter
   * `lookbackHours` sees fewer pools exactly as it would live.
   */
  private async scanFixtures(specs: LaunchChainSpec[], app: AppConfig, capturedAt: string): Promise<ChainScan[]> {
    const files = await readJsonFixtures('launches');
    const scans: ChainScan[] = [];
    for (const file of files) {
      const data = file.data;
      if (!isRecord(data) || !Array.isArray(data.logs)) continue;
      const spec = specs.find((row) => row.chain === normalizeChain(typeof data.chain === 'string' ? data.chain : undefined));
      const head = hexToNumber(data.head);
      if (!spec || head === undefined) continue;

      const windowFrom = head - lookbackBlocks(app.launches.lookbackHours, spec.blockSeconds) + 1;
      const logs = data.logs.filter((log) => {
        const block = isRecord(log) ? hexToNumber(log.blockNumber) : undefined;
        return block !== undefined && block >= windowFrom && block <= head;
      });
      const anchorMs = typeof data.headTimestamp === 'string' ? Date.parse(data.headTimestamp) : Number.NaN;
      scans.push({ spec, head, anchor: new Date(Number.isFinite(anchorMs) ? anchorMs : Date.parse(capturedAt)), logs });
    }
    return scans;
  }

  private async hydrateFromFixtures(capturedAt: string): Promise<DexScreenerPairRow[]> {
    const rows: DexScreenerPairRow[] = [];
    for (const file of await readJsonFixtures('launches')) {
      if (isRecord(file.data) && Array.isArray(file.data.pairs)) {
        rows.push(...parseDexScreenerPairs(file.data, new Date(capturedAt)));
      }
    }
    return rows;
  }

  private async hydrateFromNetwork(
    launches: readonly LaunchCandidate[],
    ctx: SourceContext,
    capturedAt: string,
  ): Promise<DexScreenerPairRow[]> {
    if (launches.length === 0) return [];
    // Same host as DexScreenerSource, so borrow its politeness setting.
    const dexscreener = ctx.app.pipeline.sources.find((source) => source.id === 'dexscreener');
    const client = new JsonClient({
      baseUrl: this.options.dexscreenerBaseUrl ?? DEXSCREENER_BASE_URL,
      rateLimitMs: dexscreener?.rateLimitMs ?? 1200,
      logger: ctx.logger,
    });

    const rows: DexScreenerPairRow[] = [];
    for (const batch of chunk(launches, DEXSCREENER_BATCH_SIZE)) {
      const addresses = batch.map((launch) => launch.tokenAddress).join(',');
      try {
        const payload = await client.getJson(`/latest/dex/tokens/${addresses}`, ctx.signal);
        rows.push(...parseDexScreenerPairs(payload, new Date(capturedAt)));
      } catch (error) {
        const text = message(error);
        this.errors.push({ source: `${this.id}:dexscreener`, error: text });
        ctx.logger.warn('launch hydration batch failed; emitting unhydrated', { size: batch.length, error: text });
      }
    }
    return rows;
  }
}
