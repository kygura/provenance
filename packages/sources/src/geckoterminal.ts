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

import { compactEnrichment, type EnrichedTrendingEntry, type TokenEnrichment } from './enrichment';
import { readJsonFixtures } from './fixtures';
import { JsonClient } from './http';
import {
  ageHoursFrom,
  asArray,
  classifySocial,
  cleanText,
  compactMetrics,
  isRecord,
  toIso,
  toNumber,
  toTxnCounts,
} from './normalize';

export const GECKOTERMINAL_BASE_URL = 'https://api.geckoterminal.com/api/v2';

/** GeckoTerminal pins its response schema to a date in the Accept header. */
export const GECKOTERMINAL_ACCEPT = 'application/json;version=20230302';

/** Our canonical chain -> GeckoTerminal network slug. Inverse lives in core's CHAIN_ALIASES. */
export const GECKOTERMINAL_NETWORKS: Partial<Record<Chain, string>> = {
  ethereum: 'eth',
  solana: 'solana',
  base: 'base',
  bsc: 'bsc',
  arbitrum: 'arbitrum',
  polygon: 'polygon_pos',
  avalanche: 'avax',
  sui: 'sui-network',
  ton: 'ton',
  blast: 'blast',
  hyperliquid: 'hyperliquid',
};

export function geckoNetworkFor(chain: Chain): string | undefined {
  return GECKOTERMINAL_NETWORKS[chain];
}

/**
 * Pool ids are `"{network}_{poolAddress}"`, and some network slugs themselves
 * contain an underscore (`polygon_pos`). Splitting on the FIRST underscore is
 * therefore wrong; we strip the known address suffix when we have it and fall
 * back to the LAST underscore otherwise (addresses never contain one).
 */
export function splitGeckoId(id: unknown, knownAddress?: string): { network: string; address: string } | undefined {
  if (typeof id !== 'string' || id.trim() === '') return undefined;
  const value = id.trim();
  if (knownAddress && value.toLowerCase().endsWith(`_${knownAddress.toLowerCase()}`)) {
    return { network: value.slice(0, value.length - knownAddress.length - 1), address: knownAddress };
  }
  const idx = value.lastIndexOf('_');
  if (idx <= 0 || idx === value.length - 1) return undefined;
  return { network: value.slice(0, idx), address: value.slice(idx + 1) };
}

interface IncludedToken {
  address: string;
  name?: string;
  symbol?: string;
  imageUrl?: string;
}

function indexIncluded(payload: unknown): Map<string, IncludedToken> {
  const map = new Map<string, IncludedToken>();
  if (!isRecord(payload)) return map;
  for (const raw of asArray(payload.included)) {
    if (!isRecord(raw)) continue;
    if (raw.type !== 'token') continue;
    const id = typeof raw.id === 'string' ? raw.id : undefined;
    const attributes = isRecord(raw.attributes) ? raw.attributes : {};
    const address = typeof attributes.address === 'string' ? attributes.address : splitGeckoId(id)?.address;
    if (!id || !address) continue;
    map.set(id, {
      address,
      name: cleanText(attributes.name, 120),
      symbol: cleanText(attributes.symbol, 40),
      imageUrl: typeof attributes.image_url === 'string' && attributes.image_url !== 'missing.png'
        ? attributes.image_url
        : undefined,
    });
  }
  return map;
}

function relationshipId(relationships: unknown, key: string): string | undefined {
  if (!isRecord(relationships)) return undefined;
  const entry = relationships[key];
  if (!isRecord(entry)) return undefined;
  const data = entry.data;
  if (!isRecord(data)) return undefined;
  return typeof data.id === 'string' ? data.id : undefined;
}

function bucket(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

export interface GeckoParseOptions {
  capturedAt?: string;
  /** Rank of the first row; lets per-network pages be concatenated into one list. */
  startRank?: number;
  /** Used when a pool id is malformed and carries no network prefix. */
  defaultNetwork?: string;
  now?: Date;
}

/**
 * Pure parser: JSON:API trending-pools payload -> ranked entries. Never throws;
 * a malformed row is skipped rather than failing the page.
 */
export function parseGeckoTerminalPools(payload: unknown, options: GeckoParseOptions = {}): EnrichedTrendingEntry[] {
  const capturedAt = options.capturedAt ?? nowIso();
  const now = options.now ?? new Date(capturedAt);
  const included = indexIncluded(payload);
  const rows = isRecord(payload) ? asArray(payload.data) : [];
  const entries: EnrichedTrendingEntry[] = [];
  let rank = options.startRank ?? 1;

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const attributes = isRecord(row.attributes) ? row.attributes : undefined;
    if (!attributes) continue;

    const poolAddress = typeof attributes.address === 'string' ? attributes.address : undefined;
    const split = splitGeckoId(row.id, poolAddress);
    const network = split?.network ?? options.defaultNetwork;
    const chain = normalizeChain(network);

    const baseRef = relationshipId(row.relationships, 'base_token');
    const quoteRef = relationshipId(row.relationships, 'quote_token');
    const baseToken = baseRef ? included.get(baseRef) : undefined;
    const quoteToken = quoteRef ? included.get(quoteRef) : undefined;
    const tokenAddress = baseToken?.address ?? splitGeckoId(baseRef)?.address;
    if (!tokenAddress) continue; // without an address the row cannot be keyed

    // Pool names look like "BONGO / SOL"; use them when `included` is absent.
    const poolName = cleanText(attributes.name, 120) ?? '';
    const namePartFirst = poolName.split('/')[0]?.trim();
    const symbol = baseToken?.symbol ?? (namePartFirst && namePartFirst !== '' ? namePartFirst : 'UNKNOWN');
    const name = baseToken?.name ?? symbol;

    const poolCreatedAt = toIso(attributes.pool_created_at);
    const volume = attributes.volume_usd;
    const change = attributes.price_change_percentage;
    const txns = attributes.transactions;
    const h24 = bucket(txns, 'h24');

    const metrics: MarketMetrics = compactMetrics({
      priceUsd: toNumber(attributes.base_token_price_usd),
      priceNative: toNumber(attributes.base_token_price_native_currency),
      fdvUsd: toNumber(attributes.fdv_usd),
      marketCapUsd: toNumber(attributes.market_cap_usd),
      liquidityUsd: toNumber(attributes.reserve_in_usd),
      volume5mUsd: toNumber(bucket(volume, 'm5')),
      volume1hUsd: toNumber(bucket(volume, 'h1')),
      volume6hUsd: toNumber(bucket(volume, 'h6')),
      volume24hUsd: toNumber(bucket(volume, 'h24')),
      priceChange5m: toNumber(bucket(change, 'm5')),
      priceChange1h: toNumber(bucket(change, 'h1')),
      priceChange6h: toNumber(bucket(change, 'h6')),
      priceChange24h: toNumber(bucket(change, 'h24')),
      txns5m: toTxnCounts(bucket(txns, 'm5')),
      txns1h: toTxnCounts(bucket(txns, 'h1')),
      txns6h: toTxnCounts(bucket(txns, 'h6')),
      txns24h: toTxnCounts(h24),
      uniqueBuyers24h: toNumber(bucket(h24, 'buyers')),
      uniqueSellers24h: toNumber(bucket(h24, 'sellers')),
      poolCreatedAt,
      ageHours: ageHoursFrom(poolCreatedAt, now),
    });

    const dexId = splitGeckoId(relationshipId(row.relationships, 'dex'))?.address
      ?? relationshipId(row.relationships, 'dex');

    const pair: PairInfo | undefined = poolAddress
      ? {
          pairAddress: poolAddress,
          dexId,
          quoteSymbol: quoteToken?.symbol,
          quoteAddress: quoteToken?.address,
          url: network ? `https://www.geckoterminal.com/${network}/pools/${poolAddress}` : undefined,
          liquidityUsd: metrics.liquidityUsd,
          createdAt: poolCreatedAt,
        }
      : undefined;

    const enrichment = compactEnrichment({
      imageUrl: baseToken?.imageUrl,
      pairs: pair ? [pair] : undefined,
    });

    const entry: EnrichedTrendingEntry = {
      source: 'geckoterminal',
      rank: rank++,
      chain,
      tokenAddress,
      pairAddress: poolAddress,
      symbol,
      name,
      capturedAt,
      metrics,
      url: pair?.url,
      raw: row,
    };
    if (enrichment) entry.enrichment = enrichment;
    entries.push(entry);
  }

  return entries;
}

/**
 * Pure parser for `/networks/{network}/tokens/{address}/info`. Returns the
 * description/image/socials block the research package consumes.
 */
export function parseGeckoTerminalTokenInfo(payload: unknown): TokenEnrichment | undefined {
  if (!isRecord(payload)) return undefined;
  const data = isRecord(payload.data) ? payload.data : undefined;
  const attributes = data && isRecord(data.attributes) ? data.attributes : undefined;
  if (!attributes) return undefined;

  let socials: SocialLinks = {};
  for (const website of asArray(attributes.websites)) {
    if (typeof website === 'string') socials = classifySocial(socials, website, 'website');
    else if (isRecord(website) && typeof website.url === 'string') socials = classifySocial(socials, website.url, 'website');
  }
  const twitter = cleanText(attributes.twitter_handle, 80);
  if (twitter) socials = classifySocial(socials, `https://twitter.com/${twitter.replace(/^@/, '')}`, 'twitter');
  const telegram = cleanText(attributes.telegram_handle, 80);
  if (telegram) socials = classifySocial(socials, `https://t.me/${telegram.replace(/^@/, '')}`, 'telegram');
  const discord = cleanText(attributes.discord_url, 200);
  if (discord) socials = classifySocial(socials, discord, 'discord');

  const image = typeof attributes.image_url === 'string' && attributes.image_url !== 'missing.png'
    ? attributes.image_url
    : undefined;

  return compactEnrichment({
    imageUrl: image,
    description: cleanText(attributes.description, 1200),
    socials,
  });
}

/** Key used to line a token-info payload up with the pool entry it belongs to. */
export function tokenInfoKey(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const data = isRecord(payload.data) ? payload.data : undefined;
  if (!data || data.type !== 'token') return undefined;
  const attributes = isRecord(data.attributes) ? data.attributes : {};
  const address = typeof attributes.address === 'string' ? attributes.address : undefined;
  const split = splitGeckoId(data.id, address);
  if (!split) return undefined;
  return tokenId(normalizeChain(split.network), split.address);
}

export interface GeckoTerminalSourceOptions {
  /** How many of the top entries get a follow-up `/info` call. */
  infoLookups?: number;
  baseUrl?: string;
}

export class GeckoTerminalSource implements TrendingSource {
  readonly id = 'geckoterminal' as const;
  readonly label = 'GeckoTerminal';

  private readonly errors: { source: string; error: string }[] = [];

  constructor(
    private readonly config: SourceConfig,
    private readonly options: GeckoTerminalSourceOptions = {},
  ) {}

  /** Non-fatal failures surfaced to the run record without throwing. */
  drainErrors(): { source: string; error: string }[] {
    return this.errors.splice(0, this.errors.length);
  }

  async fetchTrending(ctx: SourceContext): Promise<TrendingEntry[]> {
    const config = ctx.config ?? this.config;
    const logger = ctx.logger.child('geckoterminal');
    const capturedAt = nowIso();

    try {
      const entries = ctx.app.pipeline.useFixtures
        ? await this.fromFixtures(capturedAt)
        : await this.fromNetwork(ctx, config, capturedAt);

      const limited = entries.slice(0, Math.max(0, config.limit));
      logger.info('trending pools parsed', { count: limited.length, fixtures: ctx.app.pipeline.useFixtures });
      return limited;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.errors.push({ source: this.id, error: message });
      logger.warn('geckoterminal failed, returning empty list', { error: message });
      return [];
    }
  }

  private async fromFixtures(capturedAt: string): Promise<EnrichedTrendingEntry[]> {
    const files = await readJsonFixtures('geckoterminal');
    const infoByToken = new Map<string, TokenEnrichment>();
    const entries: EnrichedTrendingEntry[] = [];

    for (const file of files) {
      const key = tokenInfoKey(file.data);
      if (key) {
        const info = parseGeckoTerminalTokenInfo(file.data);
        if (info) infoByToken.set(key, info);
        continue;
      }
      entries.push(
        ...parseGeckoTerminalPools(file.data, { capturedAt, startRank: entries.length + 1 }),
      );
    }

    return dedupeByToken(applyInfo(entries, infoByToken));
  }

  private async fromNetwork(
    ctx: SourceContext,
    config: SourceConfig,
    capturedAt: string,
  ): Promise<EnrichedTrendingEntry[]> {
    const client = new JsonClient({
      baseUrl: this.options.baseUrl ?? GECKOTERMINAL_BASE_URL,
      rateLimitMs: config.rateLimitMs,
      logger: ctx.logger,
      headers: { accept: GECKOTERMINAL_ACCEPT },
    });

    const networks = ctx.app.pipeline.chains
      .map(geckoNetworkFor)
      .filter((slug): slug is string => slug !== undefined);

    const entries: EnrichedTrendingEntry[] = [];
    if (networks.length === 0) {
      // No chain filter configured: one cross-network call is cheaper and broader.
      const payload = await client.getJson(
        '/networks/trending_pools?include=base_token,quote_token,dex&page=1',
        ctx.signal,
      );
      entries.push(...parseGeckoTerminalPools(payload, { capturedAt, startRank: 1 }));
    } else {
      for (const network of networks) {
        try {
          const payload = await client.getJson(
            `/networks/${network}/trending_pools?include=base_token,quote_token,dex`,
            ctx.signal,
          );
          entries.push(...parseGeckoTerminalPools(payload, { capturedAt, startRank: entries.length + 1 }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.errors.push({ source: `${this.id}:${network}`, error: message });
          ctx.logger.warn('geckoterminal network page failed', { network, error: message });
        }
      }
    }

    const deduped = dedupeByToken(entries);
    const infoBudget = this.options.infoLookups ?? 8;
    const infoByToken = new Map<string, TokenEnrichment>();

    for (const entry of deduped.slice(0, Math.min(infoBudget, config.limit))) {
      const network = geckoNetworkFor(entry.chain);
      if (!network) continue;
      try {
        const payload = await client.getJson(
          `/networks/${network}/tokens/${entry.tokenAddress}/info`,
          ctx.signal,
        );
        const info = parseGeckoTerminalTokenInfo(payload);
        if (info) infoByToken.set(tokenId(entry.chain, entry.tokenAddress), info);
      } catch (error) {
        // Info is a bonus, never a reason to lose the row.
        ctx.logger.debug('geckoterminal token info failed', {
          token: entry.tokenAddress,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return applyInfo(deduped, infoByToken);
  }
}

/** A token can hold several trending pools; keep its best-ranked one only. */
export function dedupeByToken(entries: EnrichedTrendingEntry[]): EnrichedTrendingEntry[] {
  const seen = new Map<string, EnrichedTrendingEntry>();
  for (const entry of entries) {
    const key = tokenId(entry.chain, entry.tokenAddress);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, entry);
      continue;
    }
    // Same token, second pool: keep the better rank but remember the pair.
    const pairs = [...(existing.enrichment?.pairs ?? []), ...(entry.enrichment?.pairs ?? [])];
    const winner = entry.rank < existing.rank ? { ...entry } : { ...existing };
    winner.enrichment = compactEnrichment({ ...(winner.enrichment ?? {}), pairs });
    seen.set(key, winner);
  }
  return [...seen.values()]
    .sort((a, b) => a.rank - b.rank)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

function applyInfo(
  entries: EnrichedTrendingEntry[],
  infoByToken: Map<string, TokenEnrichment>,
): EnrichedTrendingEntry[] {
  if (infoByToken.size === 0) return entries;
  return entries.map((entry) => {
    const info = infoByToken.get(tokenId(entry.chain, entry.tokenAddress));
    if (!info) return entry;
    const merged = compactEnrichment({
      imageUrl: entry.enrichment?.imageUrl ?? info.imageUrl,
      description: info.description ?? entry.enrichment?.description,
      socials: { ...(info.socials ?? {}), ...(entry.enrichment?.socials ?? {}) },
      pairs: entry.enrichment?.pairs,
    });
    return merged ? { ...entry, enrichment: merged } : entry;
  });
}
