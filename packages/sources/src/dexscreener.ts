import {
  type Chain,
  type MarketMetrics,
  type PairInfo,
  type SocialLinks,
  type SourceConfig,
  type SourceContext,
  type TrendingEntry,
  type TrendingSource,
  normalizeChain,
  nowIso,
  tokenId,
} from '@provenance/core';

import { compactEnrichment, type EnrichedTrendingEntry } from './enrichment';
import { readJsonFixtures } from './fixtures';
import { JsonClient } from './http';
import {
  ageHoursFrom,
  asArray,
  classifySocial,
  cleanText,
  compactMetrics,
  isRecord,
  mergeSocials,
  toIso,
  toNumber,
  toTxnCounts,
} from './normalize';

export const DEXSCREENER_BASE_URL = 'https://api.dexscreener.com';

/** `/latest/dex/tokens/{addresses}` accepts at most 30 comma-separated addresses. */
export const DEXSCREENER_BATCH_SIZE = 30;

/**
 * A candidate token from the boost / profile feeds. DexScreener has no public
 * "trending" endpoint, but the paid-promotion feed is the closest keyless proxy
 * for what is being pushed right now, and the profile feed carries the
 * descriptions and socials the research package wants.
 */
export interface DexScreenerCandidate {
  chain: Chain;
  tokenAddress: string;
  /** 1-based position in the feed it came from. */
  rank: number;
  url?: string;
  imageUrl?: string;
  description?: string;
  socials: SocialLinks;
  boostAmount?: number;
  boostTotal?: number;
  raw?: unknown;
}

/** One hydrated pair row from `/latest/dex/tokens/`. */
export interface DexScreenerPairRow {
  chain: Chain;
  tokenAddress: string;
  symbol: string;
  name: string;
  pair: PairInfo;
  metrics: MarketMetrics;
  url?: string;
  imageUrl?: string;
  socials: SocialLinks;
  raw?: unknown;
}

function socialsFrom(value: unknown): SocialLinks {
  let socials: SocialLinks = {};
  if (!isRecord(value)) return socials;
  for (const link of asArray(value.links)) {
    if (!isRecord(link)) continue;
    socials = classifySocial(
      socials,
      typeof link.url === 'string' ? link.url : undefined,
      typeof link.type === 'string' ? link.type : undefined,
      typeof link.label === 'string' ? link.label : undefined,
    );
  }
  for (const site of asArray(value.websites)) {
    if (isRecord(site)) socials = classifySocial(socials, typeof site.url === 'string' ? site.url : undefined, 'website', typeof site.label === 'string' ? site.label : undefined);
    else if (typeof site === 'string') socials = classifySocial(socials, site, 'website');
  }
  for (const social of asArray(value.socials)) {
    if (!isRecord(social)) continue;
    socials = classifySocial(
      socials,
      typeof social.url === 'string' ? social.url : undefined,
      typeof social.type === 'string' ? social.type : undefined,
      typeof social.label === 'string' ? social.label : undefined,
    );
  }
  return socials;
}

/**
 * Pure parser for `/token-boosts/{top,latest}/v1` and `/token-profiles/latest/v1`
 * — all three return the same array shape. Never throws.
 */
export function parseDexScreenerProfiles(payload: unknown, startRank = 1): DexScreenerCandidate[] {
  // Some deployments wrap the array; accept both.
  const rows = Array.isArray(payload)
    ? payload
    : isRecord(payload)
      ? asArray(payload.data ?? payload.profiles ?? payload.boosts)
      : [];

  const out: DexScreenerCandidate[] = [];
  let rank = startRank;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const tokenAddress = typeof row.tokenAddress === 'string' ? row.tokenAddress.trim() : undefined;
    if (!tokenAddress) continue;
    const chain = normalizeChain(typeof row.chainId === 'string' ? row.chainId : undefined);

    out.push({
      chain,
      tokenAddress,
      rank: rank++,
      url: typeof row.url === 'string' ? row.url : undefined,
      imageUrl: typeof row.icon === 'string' ? row.icon : typeof row.header === 'string' ? row.header : undefined,
      description: cleanText(row.description, 1200),
      socials: socialsFrom(row),
      boostAmount: toNumber(row.amount),
      boostTotal: toNumber(row.totalAmount),
      raw: row,
    });
  }
  return out;
}

/** Pure parser for `/latest/dex/tokens/{addresses}`. Never throws. */
export function parseDexScreenerPairs(payload: unknown, now: Date = new Date()): DexScreenerPairRow[] {
  const rows = Array.isArray(payload) ? payload : isRecord(payload) ? asArray(payload.pairs) : [];
  const out: DexScreenerPairRow[] = [];

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const base = isRecord(row.baseToken) ? row.baseToken : undefined;
    const tokenAddress = base && typeof base.address === 'string' ? base.address.trim() : undefined;
    if (!tokenAddress) continue;

    const chain = normalizeChain(typeof row.chainId === 'string' ? row.chainId : undefined);
    const quote = isRecord(row.quoteToken) ? row.quoteToken : undefined;
    const txns = row.txns;
    const volume = row.volume;
    const change = row.priceChange;
    const liquidity = isRecord(row.liquidity) ? row.liquidity : undefined;
    const createdAt = toIso(row.pairCreatedAt);
    const info = isRecord(row.info) ? row.info : undefined;

    const liquidityUsd = toNumber(liquidity?.usd);
    const pair: PairInfo = {
      pairAddress: typeof row.pairAddress === 'string' ? row.pairAddress : tokenAddress,
      dexId: typeof row.dexId === 'string' ? row.dexId : undefined,
      quoteSymbol: quote && typeof quote.symbol === 'string' ? quote.symbol : undefined,
      quoteAddress: quote && typeof quote.address === 'string' ? quote.address : undefined,
      url: typeof row.url === 'string' ? row.url : undefined,
      liquidityUsd,
      createdAt,
    };

    const metrics: MarketMetrics = compactMetrics({
      priceUsd: toNumber(row.priceUsd),
      priceNative: toNumber(row.priceNative),
      fdvUsd: toNumber(row.fdv),
      marketCapUsd: toNumber(row.marketCap),
      liquidityUsd,
      liquidityBaseTokens: toNumber(liquidity?.base),
      volume5mUsd: toNumber(isRecord(volume) ? volume.m5 : undefined),
      volume1hUsd: toNumber(isRecord(volume) ? volume.h1 : undefined),
      volume6hUsd: toNumber(isRecord(volume) ? volume.h6 : undefined),
      volume24hUsd: toNumber(isRecord(volume) ? volume.h24 : undefined),
      priceChange5m: toNumber(isRecord(change) ? change.m5 : undefined),
      priceChange1h: toNumber(isRecord(change) ? change.h1 : undefined),
      priceChange6h: toNumber(isRecord(change) ? change.h6 : undefined),
      priceChange24h: toNumber(isRecord(change) ? change.h24 : undefined),
      txns5m: toTxnCounts(isRecord(txns) ? txns.m5 : undefined),
      txns1h: toTxnCounts(isRecord(txns) ? txns.h1 : undefined),
      txns6h: toTxnCounts(isRecord(txns) ? txns.h6 : undefined),
      txns24h: toTxnCounts(isRecord(txns) ? txns.h24 : undefined),
      poolCreatedAt: createdAt,
      ageHours: ageHoursFrom(createdAt, now),
    });

    out.push({
      chain,
      tokenAddress,
      symbol: cleanText(base?.symbol, 40) ?? 'UNKNOWN',
      name: cleanText(base?.name, 120) ?? cleanText(base?.symbol, 40) ?? 'UNKNOWN',
      pair,
      metrics,
      url: typeof row.url === 'string' ? row.url : undefined,
      imageUrl: info && typeof info.imageUrl === 'string' ? info.imageUrl : undefined,
      socials: socialsFrom(info),
      raw: row,
    });
  }

  return out;
}

/** Dedupes candidates across the boost and profile feeds, keeping the best rank. */
export function dedupeCandidates(candidates: DexScreenerCandidate[]): DexScreenerCandidate[] {
  const byToken = new Map<string, DexScreenerCandidate>();
  for (const candidate of candidates) {
    const key = tokenId(candidate.chain, candidate.tokenAddress);
    const existing = byToken.get(key);
    if (!existing) {
      byToken.set(key, candidate);
      continue;
    }
    byToken.set(key, {
      ...existing,
      rank: Math.min(existing.rank, candidate.rank),
      // A later feed often has the richer profile; fill the gaps, never overwrite.
      url: existing.url ?? candidate.url,
      imageUrl: existing.imageUrl ?? candidate.imageUrl,
      description:
        (candidate.description?.length ?? 0) > (existing.description?.length ?? 0)
          ? candidate.description
          : existing.description,
      socials: mergeSocials(existing.socials, candidate.socials),
      boostAmount: existing.boostAmount ?? candidate.boostAmount,
      boostTotal: existing.boostTotal ?? candidate.boostTotal,
    });
  }
  return [...byToken.values()]
    .sort((a, b) => a.rank - b.rank)
    .map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}

/**
 * Joins candidates to their hydrated pairs. For a token quoted on several pairs
 * the highest-liquidity one becomes the representative (its metrics drive the
 * entry) and every pair is carried in the enrichment for `TokenSnapshot.pairs`.
 */
export function buildDexScreenerEntries(
  candidates: DexScreenerCandidate[],
  pairRows: DexScreenerPairRow[],
  capturedAt: string = nowIso(),
): EnrichedTrendingEntry[] {
  const byToken = new Map<string, DexScreenerPairRow[]>();
  for (const row of pairRows) {
    const key = tokenId(row.chain, row.tokenAddress);
    const bucket = byToken.get(key);
    if (bucket) bucket.push(row);
    else byToken.set(key, [row]);
  }

  const entries: EnrichedTrendingEntry[] = [];
  let rank = 1;

  for (const candidate of candidates) {
    const key = tokenId(candidate.chain, candidate.tokenAddress);
    const rows = [...(byToken.get(key) ?? [])].sort(
      (a, b) => (b.metrics.liquidityUsd ?? -1) - (a.metrics.liquidityUsd ?? -1),
    );
    const representative = rows[0];

    // A boosted token with no tradeable pair is still a signal; keep it with
    // empty metrics and let `filterSnapshots` decide, per the missing-data policy.
    const socials = rows.reduce<SocialLinks>(
      (acc, row) => mergeSocials(acc, row.socials),
      candidate.socials,
    );

    const enrichment = compactEnrichment({
      imageUrl: representative?.imageUrl ?? candidate.imageUrl,
      description: candidate.description,
      socials,
      pairs: rows.map((row) => row.pair),
    });

    const entry: EnrichedTrendingEntry = {
      source: 'dexscreener',
      rank: rank++,
      chain: candidate.chain,
      tokenAddress: candidate.tokenAddress,
      pairAddress: representative?.pair.pairAddress,
      symbol: representative?.symbol ?? 'UNKNOWN',
      name: representative?.name ?? representative?.symbol ?? 'UNKNOWN',
      capturedAt,
      metrics: representative?.metrics ?? {},
      url: representative?.url ?? candidate.url,
      raw: { candidate: candidate.raw, pairs: rows.map((row) => row.raw) },
    };
    if (enrichment) entry.enrichment = enrichment;
    entries.push(entry);
  }

  return entries;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface DexScreenerSourceOptions {
  baseUrl?: string;
}

export class DexScreenerSource implements TrendingSource {
  readonly id = 'dexscreener' as const;
  readonly label = 'DexScreener';

  private readonly errors: { source: string; error: string }[] = [];

  constructor(
    private readonly config: SourceConfig,
    private readonly options: DexScreenerSourceOptions = {},
  ) {}

  drainErrors(): { source: string; error: string }[] {
    return this.errors.splice(0, this.errors.length);
  }

  async fetchTrending(ctx: SourceContext): Promise<TrendingEntry[]> {
    const config = ctx.config ?? this.config;
    const logger = ctx.logger.child('dexscreener');
    const capturedAt = nowIso();

    try {
      const entries = ctx.app.pipeline.useFixtures
        ? await this.fromFixtures(capturedAt)
        : await this.fromNetwork(ctx, config, capturedAt);
      const limited = entries.slice(0, Math.max(0, config.limit));
      logger.info('boosted/profiled tokens hydrated', {
        count: limited.length,
        fixtures: ctx.app.pipeline.useFixtures,
      });
      return limited;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.errors.push({ source: this.id, error: message });
      logger.warn('dexscreener failed, returning empty list', { error: message });
      return [];
    }
  }

  private async fromFixtures(capturedAt: string): Promise<EnrichedTrendingEntry[]> {
    const files = await readJsonFixtures('dexscreener');
    const candidates: DexScreenerCandidate[] = [];
    const pairRows: DexScreenerPairRow[] = [];

    for (const file of files) {
      // Hydration payloads are objects with `pairs`; the feeds are bare arrays.
      if (isRecord(file.data) && Array.isArray(file.data.pairs)) {
        pairRows.push(...parseDexScreenerPairs(file.data, new Date(capturedAt)));
      } else {
        candidates.push(...parseDexScreenerProfiles(file.data, candidates.length + 1));
      }
    }

    return buildDexScreenerEntries(dedupeCandidates(candidates), pairRows, capturedAt);
  }

  private async fromNetwork(
    ctx: SourceContext,
    config: SourceConfig,
    capturedAt: string,
  ): Promise<EnrichedTrendingEntry[]> {
    const client = new JsonClient({
      baseUrl: this.options.baseUrl ?? DEXSCREENER_BASE_URL,
      rateLimitMs: config.rateLimitMs,
      logger: ctx.logger,
    });

    const candidates: DexScreenerCandidate[] = [];
    for (const path of ['/token-boosts/top/v1', '/token-boosts/latest/v1', '/token-profiles/latest/v1']) {
      try {
        const payload = await client.getJson(path, ctx.signal);
        candidates.push(...parseDexScreenerProfiles(payload, candidates.length + 1));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.errors.push({ source: `${this.id}:${path}`, error: message });
        ctx.logger.warn('dexscreener feed failed', { path, error: message });
      }
    }

    const allowed = new Set(ctx.app.pipeline.chains);
    const filtered = dedupeCandidates(candidates).filter(
      (candidate) => allowed.size === 0 || allowed.has(candidate.chain),
    );
    // Hydrate a little past the limit: some candidates have no pair at all.
    const wanted = filtered.slice(0, Math.max(0, config.limit) + DEXSCREENER_BATCH_SIZE);

    const pairRows: DexScreenerPairRow[] = [];
    for (const batch of chunk(wanted, DEXSCREENER_BATCH_SIZE)) {
      const addresses = batch.map((candidate) => candidate.tokenAddress).join(',');
      try {
        const payload = await client.getJson(`/latest/dex/tokens/${addresses}`, ctx.signal);
        pairRows.push(...parseDexScreenerPairs(payload, new Date(capturedAt)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.errors.push({ source: `${this.id}:tokens`, error: message });
        ctx.logger.warn('dexscreener hydration batch failed', { size: batch.length, error: message });
      }
    }

    return buildDexScreenerEntries(wanted, pairRows, capturedAt);
  }
}
