import type { Chain } from './chains';

/** Every upstream we pull trending lists from. */
export type SourceId = 'dextools' | 'dexscreener' | 'geckoterminal' | 'manual';

export interface TxnCounts {
  buys: number;
  sells: number;
}

/**
 * Normalized market statistics. Every field is optional: sources disagree on
 * what they expose, and the pipeline must survive partial data rather than
 * dropping a token because one number is missing.
 */
export interface MarketMetrics {
  priceUsd?: number;
  priceNative?: number;
  fdvUsd?: number;
  marketCapUsd?: number;
  liquidityUsd?: number;
  liquidityBaseTokens?: number;
  volume5mUsd?: number;
  volume1hUsd?: number;
  volume6hUsd?: number;
  volume24hUsd?: number;
  priceChange5m?: number;
  priceChange1h?: number;
  priceChange6h?: number;
  priceChange24h?: number;
  txns5m?: TxnCounts;
  txns1h?: TxnCounts;
  txns6h?: TxnCounts;
  txns24h?: TxnCounts;
  uniqueBuyers24h?: number;
  uniqueSellers24h?: number;
  poolCreatedAt?: string;
  ageHours?: number;
}

export interface SocialLinks {
  website?: string;
  twitter?: string;
  telegram?: string;
  discord?: string;
  github?: string;
  docs?: string;
  other?: string[];
}

export interface PairInfo {
  pairAddress: string;
  dexId?: string;
  quoteSymbol?: string;
  quoteAddress?: string;
  url?: string;
  liquidityUsd?: number;
  createdAt?: string;
}

/** A single trending-list row as captured from one source at one moment. */
export interface TrendingEntry {
  source: SourceId;
  /** 1-based position in that source's list. */
  rank: number;
  chain: Chain;
  tokenAddress: string;
  pairAddress?: string;
  symbol: string;
  name: string;
  capturedAt: string;
  metrics: MarketMetrics;
  url?: string;
  /** Source-shaped payload, retained for debugging and re-parsing. */
  raw?: unknown;
}

/** Trending rows from every source, merged into one view of a token. */
export interface TokenSnapshot {
  tokenId: string;
  chain: Chain;
  tokenAddress: string;
  symbol: string;
  name: string;
  imageUrl?: string;
  description?: string;
  socials: SocialLinks;
  metrics: MarketMetrics;
  pairs: PairInfo[];
  /** Which lists this token showed up on, and where. */
  appearances: TrendingEntry[];
  /** Best (lowest) rank across all sources; drives triage ordering. */
  bestRank: number;
  /** How many distinct sources listed it. Cross-source agreement is signal. */
  sourceCount: number;
  capturedAt: string;
}
