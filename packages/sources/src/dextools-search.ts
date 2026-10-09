import type { Chain } from '@provenance/core';

import type { DexScreenerPairRow } from './dexscreener';
import { DEXTOOLS_CHAIN_SLUGS } from './dextools-parse';
import { compactEnrichment, type EnrichedTrendingEntry } from './enrichment';

/**
 * DexTools via web search. DexTools sits behind Cloudflare and has no free
 * API, but search engines index its `pair-explorer/<address>` pages, and a
 * result page restricted to the past day is a fair proxy for what is being
 * looked at now. Only the result URLs are read: chain slug and pair address,
 * which DexScreener then resolves to a token.
 */

export interface DexToolsPairHit {
  chain: Chain;
  pairAddress: string;
  /** 1-based order of first appearance on the page. */
  rank: number;
}

const SLUG_TO_CHAIN: Record<string, Chain> = {
  ...Object.fromEntries(Object.entries(DEXTOOLS_CHAIN_SLUGS).map(([chain, slug]) => [slug, chain as Chain])),
  ethereum: 'ethereum',
  bsc: 'bsc',
};

export function chainFromDexToolsSlug(slug: string): Chain | undefined {
  return SLUG_TO_CHAIN[slug.toLowerCase()];
}

/** EVM hex, Solana base58, TON user-friendly. The same shapes `looksLikeAddress` accepts. */
const PAIR_LINK =
  /\/app\/(?:[a-z]{2}\/)?([a-z0-9-]+)\/pair-explorer\/(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}|[A-Za-z0-9_-]{48})(?![0-9A-Za-z_-])/g;

/**
 * Every DexTools pair link in a result page, deduped, in page order. Engines
 * wrap result URLs in redirects with the target percent-encoded, and some
 * JSON-escape slashes, so both are undone before matching.
 */
export function extractPairLinks(body: string, fallbackChain?: Chain): DexToolsPairHit[] {
  const text = body
    .replace(/\\\//g, '/')
    .replace(/%([0-9A-F]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  const seen = new Set<string>();
  const hits: DexToolsPairHit[] = [];
  for (const match of text.matchAll(PAIR_LINK)) {
    const chain = chainFromDexToolsSlug(match[1] ?? '') ?? fallbackChain;
    const pairAddress = match[2];
    if (!chain || !pairAddress) continue;
    const key = `${chain}:${pairAddress.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({ chain, pairAddress, rank: hits.length + 1 });
  }
  return hits;
}

/** A pair link resolved through DexScreener, kept under DexTools' name and rank. */
export function entryFromHydratedPair(
  hit: DexToolsPairHit,
  row: DexScreenerPairRow,
  capturedAt: string,
): EnrichedTrendingEntry {
  const slug = DEXTOOLS_CHAIN_SLUGS[hit.chain];
  const url = slug ? `https://www.dextools.io/app/en/${slug}/pair-explorer/${hit.pairAddress}` : row.url;
  const entry: EnrichedTrendingEntry = {
    source: 'dextools',
    rank: hit.rank,
    chain: row.chain === 'unknown' ? hit.chain : row.chain,
    tokenAddress: row.tokenAddress,
    pairAddress: hit.pairAddress,
    symbol: row.symbol,
    name: row.name,
    capturedAt,
    metrics: row.metrics,
    url,
    raw: row.raw,
  };
  const enrichment = compactEnrichment({ imageUrl: row.imageUrl, socials: row.socials, pairs: [row.pair] });
  if (enrichment) entry.enrichment = enrichment;
  return entry;
}
