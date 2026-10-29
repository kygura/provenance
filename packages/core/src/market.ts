import type { Chain } from './chains';

/**
 * Every upstream we pull tokens from. `launches` is the supply side: new pools
 * read straight off DEX factory events, before any list has noticed them.
 */
export type SourceId = 'dextools' | 'dexscreener' | 'geckoterminal' | 'launches' | 'manual';

/** Sources that measure demand. A token on one of these is trending. */
export const TRENDING_SOURCES: readonly SourceId[] = ['dextools', 'dexscreener', 'geckoterminal'];

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

/**
 * Takes `limit` snapshots from a triaged list, one chain at a time: each
 * round adds every chain's next-best token, chains in the order their best
 * token sits in `triaged`. A plain cut hands every slot to the chain with the
 * most cross-listed tokens: Solana tokens appear on DexScreener's boosts and
 * GeckoTerminal both, Ethereum ones on GeckoTerminal alone, so `sourceCount`
 * sorted every Ethereum token below the 15-token cap (Oct 2026). Order within
 * a chain is unchanged, and a chain with fewer tokens leaves its slots to the
 * rest.
 */
export function selectByChain(triaged: readonly TokenSnapshot[], limit: number): TokenSnapshot[] {
  const queues = new Map<string, TokenSnapshot[]>();
  for (const snapshot of triaged) {
    const queue = queues.get(snapshot.chain);
    if (queue) queue.push(snapshot);
    else queues.set(snapshot.chain, [snapshot]);
  }
  const out: TokenSnapshot[] = [];
  for (let i = 0; out.length < limit; i += 1) {
    const round = [...queues.values()].flatMap((queue) => (i < queue.length ? [queue[i]!] : []));
    if (round.length === 0) break;
    out.push(...round.slice(0, limit - out.length));
  }
  return out;
}
