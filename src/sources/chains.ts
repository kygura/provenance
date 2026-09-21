/**
 * Chain-name normalisation and the trending-source interface.
 *
 * Every provider spells the same chain differently - DEXTools says "ether",
 * GeckoTerminal says "eth", DexScreener says "ethereum". Everything inside this
 * project uses the DexScreener spelling as canonical, and each adapter
 * translates at its own edge.
 */

import type { Fetcher } from "../http.js";
import type { TokenRef } from "../models.js";

const CANONICAL: Record<string, string> = {
  eth: "ethereum",
  ether: "ethereum",
  ethereum: "ethereum",
  sol: "solana",
  solana: "solana",
  base: "base",
  bsc: "bsc",
  bnb: "bsc",
  "binance-smart-chain": "bsc",
  arbitrum: "arbitrum",
  arb: "arbitrum",
  polygon: "polygon",
  polygon_pos: "polygon",
  matic: "polygon",
  avalanche: "avalanche",
  avax: "avalanche",
  blast: "blast",
  sui: "sui",
  ton: "ton",
  hyperliquid: "hyperevm",
  hyperevm: "hyperevm",
};

/** canonical -> per-provider spelling */
export const GECKOTERMINAL_SLUGS: Record<string, string> = {
  ethereum: "eth",
  solana: "solana",
  base: "base",
  bsc: "bsc",
  arbitrum: "arbitrum",
  polygon: "polygon_pos",
  avalanche: "avax",
  blast: "blast",
  sui: "sui",
  ton: "ton",
  hyperevm: "hyperevm",
};

export const DEXTOOLS_SLUGS: Record<string, string> = {
  ethereum: "ether",
  solana: "solana",
  base: "base",
  bsc: "bsc",
  arbitrum: "arbitrum",
  polygon: "polygon",
  avalanche: "avalanche",
  blast: "blast",
  ton: "ton",
};

export const EVM_CHAINS: Record<string, number> = {
  ethereum: 1,
  bsc: 56,
  polygon: 137,
  base: 8453,
  arbitrum: 42161,
  avalanche: 43114,
  blast: 81457,
};

export function canonicalChain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  return CANONICAL[raw.trim().toLowerCase()] ?? null;
}

/** Anything that can name tokens currently getting attention. */
export interface TrendingSource {
  readonly name: string;
  fetch(fetcher: Fetcher, chains: string[], limit: number): Promise<TokenRef[]>;
}
