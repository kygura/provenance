import type { Chain } from '@provenance/core';

import { DEXTOOLS_CHAIN_SLUGS, looksLikeDexToolsPayload, parseDexToolsHtml, parseDexToolsXhr } from './dextools-parse';
import type { EnrichedTrendingEntry } from './enrichment';
import type { DexScreenerPairRow } from './dexscreener';
import { compactEnrichment } from './enrichment';

/**
 * Browserless DexTools extraction. Whatever a plain GET returns (a JSON body,
 * an SSR page with its state embedded, or a bare HTML shell) is searched as
 * text rather than rendered: structured rows when the body holds them, and
 * failing that every `pair-explorer/<address>` link, which DexTools prints for
 * each pair in every form of the page.
 */

export interface DexToolsPairHit {
  chain: Chain;
  pairAddress: string;
  /** 1-based order of first appearance on the page. */
  rank: number;
}

export interface DexToolsRawResult {
  /** Full rows, when the body carried structured data. */
  entries: EnrichedTrendingEntry[];
  /** Pair addresses only; they need a lookup before they name a token. */
  pairs: DexToolsPairHit[];
}

export interface DexToolsRawOptions {
  capturedAt: string;
  /** Chain of the page fetched; used when a link's slug is not recognised. */
  chain?: Chain;
  startRank?: number;
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

/** Angular's TransferState escapes its JSON this way inside the page. */
function unescapeTransferState(text: string): string {
  return text.replace(/&q;/g, '"').replace(/&s;/g, "'").replace(/&l;/g, '<').replace(/&g;/g, '>').replace(/&a;/g, '&');
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** JSON blobs a server-rendered page carries: TransferState, __NEXT_DATA__, any application/json script. */
function embeddedJson(body: string): unknown[] {
  const out: unknown[] = [];
  const scripts = /<script\b[^>]*type=["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of body.matchAll(scripts)) {
    const text = match[1]?.trim();
    if (!text) continue;
    const parsed = tryJson(text) ?? tryJson(unescapeTransferState(text));
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

export function extractPairLinks(body: string, fallbackChain?: Chain): DexToolsPairHit[] {
  // JSON-escaped URLs (`\/app\/ether\/…`) are common in embedded state.
  const text = body.replace(/\\\//g, '/');
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

/** Pure: one fetched body in, whatever rows or pair links it holds out. Never throws. */
export function extractDexToolsRaw(body: string, options: DexToolsRawOptions): DexToolsRawResult {
  const parseOptions = { capturedAt: options.capturedAt, chain: options.chain, startRank: options.startRank };

  const candidates = [tryJson(body), ...embeddedJson(body)].filter((value) => value !== undefined);
  for (const payload of candidates) {
    if (!looksLikeDexToolsPayload(payload)) continue;
    const entries = parseDexToolsXhr(payload, parseOptions);
    if (entries.length > 0) return { entries, pairs: [] };
  }

  if (/<table\b/i.test(body)) {
    const entries = parseDexToolsHtml(body, parseOptions);
    if (entries.length > 0) return { entries, pairs: [] };
  }

  return { entries: [], pairs: extractPairLinks(body, options.chain) };
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
