import {
  type Chain,
  type SourceConfig,
  type SourceContext,
  type TrendingEntry,
  type TrendingSource,
  nowIso,
} from '@provenance/core';

import { DEXSCREENER_BASE_URL, DEXSCREENER_BATCH_SIZE, chunk, parseDexScreenerPairs, type DexScreenerPairRow } from './dexscreener';
import { dextoolsSlugFor, entryFromHydratedPair, extractPairLinks, type DexToolsPairHit } from './dextools-search';
import type { EnrichedTrendingEntry } from './enrichment';
import { JsonClient } from './http';
import { dedupeByToken } from './geckoterminal';

/**
 * DexTools' trending pairs, found through Exa search rather than DexTools
 * itself: DexTools has no free API and sits behind Cloudflare, but its
 * `pair-explorer` pages are indexed. Result URLs give chain and pair address;
 * DexScreener resolves those to tokens. Needs EXA_API_KEY; without it the
 * source reports the gap and the run carries on with the other two lists.
 */

export const EXA_BASE_URL = 'https://api.exa.ai';

/**
 * `{chain}` is the chain's name (`ethereum`, `solana`, …); the cross-chain run
 * drops it. Exa ranks by meaning, so this reads as a description of the page
 * wanted rather than search-engine operators. Override with
 * PROVENANCE_DEXTOOLS_SEARCH_QUERY.
 */
export const DEXTOOLS_SEARCH_QUERY = 'trending new {chain} meme token pair on DexTools pair explorer';

export interface DexToolsSourceOptions {
  /** Where pair links are resolved to tokens. */
  dexscreenerBaseUrl?: string;
  /** Exa endpoint; a test server in tests. */
  exaBaseUrl?: string;
  /** Query template; see DEXTOOLS_SEARCH_QUERY. */
  searchQuery?: string;
  /** Results asked of Exa per chain. */
  searchResults?: number;
}

export class DexToolsSource implements TrendingSource {
  readonly id = 'dextools' as const;
  readonly label = 'DexTools';

  private readonly errors: { source: string; error: string }[] = [];

  constructor(
    private readonly config: SourceConfig,
    private readonly options: DexToolsSourceOptions = {},
  ) {}

  /**
   * DexTools is the one source allowed to come back empty — the other two carry
   * the run — so failures are collected here instead of thrown.
   */
  drainErrors(): { source: string; error: string }[] {
    return this.errors.splice(0, this.errors.length);
  }

  async fetchTrending(ctx: SourceContext): Promise<TrendingEntry[]> {
    const config = ctx.config ?? this.config;
    const logger = ctx.logger.child('dextools');
    // Search is a network call by nature; fixture runs go without DexTools.
    if (ctx.app.pipeline.useFixtures) return [];

    const apiKey = ctx.app.exaApiKey;
    if (!apiKey) {
      this.errors.push({ source: this.id, error: 'no EXA_API_KEY; DexTools pairs are found through Exa search' });
      logger.info('no EXA_API_KEY; skipping DexTools');
      return [];
    }
    try {
      const found = await this.fromExa(apiKey, ctx, config, nowIso(), logger, this.errors);
      const limited = dedupeByToken(found).slice(0, Math.max(0, config.limit));
      logger.info('hot pairs found', { count: limited.length });
      return limited;
    } catch (error) {
      // Belt and braces: fetchTrending must never reject.
      const message = error instanceof Error ? error.message : String(error);
      this.errors.push({ source: this.id, error: message });
      logger.warn('dextools failed, continuing without it', { error: message });
      return [];
    }
  }

  private searchQuery(chain: Chain | undefined): string {
    return (process.env.PROVENANCE_DEXTOOLS_SEARCH_QUERY || this.options.searchQuery || DEXTOOLS_SEARCH_QUERY)
      .replace('{chain}', chain ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async fromExa(
    apiKey: string,
    ctx: SourceContext,
    config: SourceConfig,
    capturedAt: string,
    logger: SourceContext['logger'],
    errors: { source: string; error: string }[],
  ): Promise<EnrichedTrendingEntry[]> {
    const client = new JsonClient({
      baseUrl: this.options.exaBaseUrl ?? EXA_BASE_URL,
      rateLimitMs: Math.max(0, config.rateLimitMs),
      logger,
      timeoutMs: 30_000,
      attempts: 2,
      headers: { 'x-api-key': apiKey },
    });
    const numResults = Math.min(100, this.options.searchResults ?? Math.max(10, config.limit));

    const hits: DexToolsPairHit[] = [];
    const seen = new Set<string>();

    for (const slug of this.chainSlugs(ctx.app.pipeline.chains)) {
      const chain = slug === '' ? undefined : normalizeSlug(slug);
      try {
        const reply = await client.postJson(
          '/search',
          { query: this.searchQuery(chain), type: 'auto', numResults, includeDomains: ['dextools.io'] },
          ctx.signal,
        );
        const urls = exaResultUrls(reply);
        // Exa returns pages, one link each; the same extractor reads them.
        // A chain's query can still surface other chains; keep only its own.
        const links = extractPairLinks(urls.join('\n')).filter((hit) => chain === undefined || hit.chain === chain);
        logger.info('dextools search', {
          chain: slug || 'all',
          results: urls.length,
          pairLinks: links.length,
          costUsd: exaCost(reply),
        });
        for (const hit of links) {
          const key = `${hit.chain}:${hit.pairAddress.toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push({ ...hit, rank: hits.length + 1 });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({ source: `${this.id}:search:${slug || 'all'}`, error: message });
        logger.warn('dextools search failed', { chain: slug || 'all', error: message });
      }
    }

    if (hits.length === 0) return [];
    // Hydrate a little past the limit: some pairs will not resolve.
    const wanted = hits.slice(0, Math.max(0, config.limit) + DEXSCREENER_BATCH_SIZE);
    return this.hydratePairs(wanted, ctx, capturedAt, logger, errors);
  }

  /** Pair links name a pool, not a token; DexScreener's pairs endpoint resolves them. */
  private async hydratePairs(
    hits: DexToolsPairHit[],
    ctx: SourceContext,
    capturedAt: string,
    logger: SourceContext['logger'],
    errors: { source: string; error: string }[],
  ): Promise<EnrichedTrendingEntry[]> {
    const client = new JsonClient({
      baseUrl: this.options.dexscreenerBaseUrl ?? DEXSCREENER_BASE_URL,
      rateLimitMs: 250,
      logger,
    });
    const byChain = new Map<Chain, DexToolsPairHit[]>();
    for (const hit of hits) byChain.set(hit.chain, [...(byChain.get(hit.chain) ?? []), hit]);

    const out: EnrichedTrendingEntry[] = [];
    for (const [chain, chainHits] of byChain) {
      for (const batch of chunk(chainHits, DEXSCREENER_BATCH_SIZE)) {
        const addresses = batch.map((hit) => hit.pairAddress).join(',');
        try {
          const payload = await client.getJson(`/latest/dex/pairs/${chain}/${addresses}`, ctx.signal);
          const rows = new Map<string, DexScreenerPairRow>();
          for (const row of parseDexScreenerPairs(payload, new Date(capturedAt))) {
            rows.set(row.pair.pairAddress.toLowerCase(), row);
          }
          const missed: DexToolsPairHit[] = [];
          for (const hit of batch) {
            const row = rows.get(hit.pairAddress.toLowerCase());
            if (row) out.push(entryFromHydratedPair(hit, row, capturedAt));
            else missed.push(hit);
          }
          // DexTools' pair-explorer URLs often carry the token's own address
          // (Solana mints especially), which the pairs endpoint cannot find.
          if (missed.length > 0) out.push(...(await this.hydrateAsTokens(client, chain, missed, ctx, capturedAt)));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push({ source: `${this.id}:hydrate:${chain}`, error: message });
          logger.warn('dextools pair hydration failed', { chain, size: batch.length, error: message });
        }
      }
    }
    logger.debug('dextools pair links hydrated', { links: hits.length, resolved: out.length });
    return out;
  }

  /** Looks the addresses up as tokens and keeps each one's deepest pool. */
  private async hydrateAsTokens(
    client: JsonClient,
    chain: Chain,
    hits: DexToolsPairHit[],
    ctx: SourceContext,
    capturedAt: string,
  ): Promise<EnrichedTrendingEntry[]> {
    const payload = await client.getJson(`/latest/dex/tokens/${hits.map((hit) => hit.pairAddress).join(',')}`, ctx.signal);
    const deepest = new Map<string, DexScreenerPairRow>();
    for (const row of parseDexScreenerPairs(payload, new Date(capturedAt))) {
      if (row.chain !== chain) continue;
      const key = row.tokenAddress.toLowerCase();
      const held = deepest.get(key);
      if (!held || (row.metrics.liquidityUsd ?? 0) > (held.metrics.liquidityUsd ?? 0)) deepest.set(key, row);
    }
    const out: EnrichedTrendingEntry[] = [];
    for (const hit of hits) {
      const row = deepest.get(hit.pairAddress.toLowerCase());
      if (row) out.push(entryFromHydratedPair({ ...hit, pairAddress: row.pair.pairAddress }, row, capturedAt));
    }
    return out;
  }

  /**
   * Chains to visit: explicit env override, else the configured pipeline chains
   * that DexTools has a page for, else the single cross-chain hot-pairs page.
   */
  private chainSlugs(chains: readonly Chain[]): string[] {
    const override = (process.env.PROVENANCE_DEXTOOLS_CHAINS ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (override.length > 0) return override;

    const mapped = chains.map(dextoolsSlugFor).filter((slug): slug is string => slug !== undefined);
    return mapped.length > 0 ? mapped : [''];
  }
}

function normalizeSlug(slug: string): Chain | undefined {
  // Reuse the alias table in core via the parse module's slug map, inverted.
  const entries = Object.entries({
    ether: 'ethereum',
    ethereum: 'ethereum',
    solana: 'solana',
    base: 'base',
    bnb: 'bsc',
    bsc: 'bsc',
    arbitrum: 'arbitrum',
    polygon: 'polygon',
    avalanche: 'avalanche',
    blast: 'blast',
    ton: 'ton',
    sui: 'sui',
  }) as [string, Chain][];
  return entries.find(([key]) => key === slug.toLowerCase())?.[1];
}

function exaResultUrls(reply: unknown): string[] {
  if (!reply || typeof reply !== 'object') return [];
  const results = (reply as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  return results
    .map((result) => (result && typeof result === 'object' ? (result as { url?: unknown }).url : undefined))
    .filter((url): url is string => typeof url === 'string');
}

function exaCost(reply: unknown): number | undefined {
  const total = (reply as { costDollars?: { total?: unknown } } | null)?.costDollars?.total;
  return typeof total === 'number' ? total : undefined;
}
