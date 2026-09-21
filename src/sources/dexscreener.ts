/**
 * DexScreener: keyless, generous rate limit, and the only free source that
 * exposes paid promotion directly.
 *
 * Boosts matter here beyond being a trending proxy: a token whose visibility
 * was bought is a different object from one that surfaced on volume, and the
 * LLM is told which it is.
 */

import { asFloat, asInt, asObjectList, asString, dig, type Fetcher } from "../http.js";
import {
  emptySocials,
  type MarketSnapshot,
  type Socials,
  type TokenRef,
} from "../models.js";
import { canonicalChain, type TrendingSource } from "./chains.js";

const BASE = "https://api.dexscreener.com";
export const NAME = "dexscreener";

/** The boosts endpoints have returned both a bare array and {"data": [...]}. */
function rows(payload: unknown): Record<string, unknown>[] {
  return asObjectList(payload, "data", "pairs", "results");
}

export class DexScreenerSource implements TrendingSource {
  readonly name = NAME;

  async fetch(fetcher: Fetcher, chains: string[], limit: number): Promise<TokenRef[]> {
    const wanted = new Set(chains);
    const seen = new Set<string>();
    const refs: TokenRef[] = [];

    for (const endpoint of ["token-boosts/top/v1", "token-boosts/latest/v1"]) {
      const payload = await fetcher.getJson(`${BASE}/${endpoint}`);
      for (const item of rows(payload)) {
        const chain = canonicalChain(dig(item, "chainId"));
        const address = asString(dig(item, "tokenAddress"));
        if (!chain || !address || !wanted.has(chain)) continue;
        const key = `${chain}:${address.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({ chain, address });
        if (refs.length >= limit) return refs;
      }
    }
    return refs;
  }
}

function liquidityOf(pair: Record<string, unknown>): number {
  return asFloat(dig(pair, "liquidity", "usd")) ?? 0;
}

function* chunks<T>(items: T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}

/**
 * Best pair per token address, keyed by lowercased address.
 *
 * "Best" is deepest liquidity: that is the pool whose price and depth actually
 * describe the token, rather than whichever pool happened to rank.
 */
export async function fetchPairs(
  fetcher: Fetcher,
  chain: string,
  addresses: string[],
): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();

  for (const batch of chunks(addresses, 30)) {
    const joined = batch.join(",");
    let pairs = rows(await fetcher.getJson(`${BASE}/tokens/v1/${chain}/${joined}`));
    if (pairs.length === 0) {
      // Older multichain route; same pair objects under "pairs".
      pairs = rows(await fetcher.getJson(`${BASE}/latest/dex/tokens/${joined}`));
    }
    for (const pair of pairs) {
      const address = asString(dig(pair, "baseToken", "address"));
      if (!address) continue;
      const key = address.toLowerCase();
      const current = out.get(key);
      if (!current || liquidityOf(pair) > liquidityOf(current)) out.set(key, pair);
    }
  }
  return out;
}

export function marketFromPair(pair: Record<string, unknown>): MarketSnapshot {
  return {
    priceUsd: asFloat(pair.priceUsd),
    fdvUsd: asFloat(pair.fdv),
    marketCapUsd: asFloat(pair.marketCap),
    liquidityUsd: asFloat(dig(pair, "liquidity", "usd")),
    volume24hUsd: asFloat(dig(pair, "volume", "h24")),
    volume6hUsd: asFloat(dig(pair, "volume", "h6")),
    volume1hUsd: asFloat(dig(pair, "volume", "h1")),
    priceChange24hPct: asFloat(dig(pair, "priceChange", "h24")),
    priceChange6hPct: asFloat(dig(pair, "priceChange", "h6")),
    priceChange1hPct: asFloat(dig(pair, "priceChange", "h1")),
    buys24h: asInt(dig(pair, "txns", "h24", "buys")),
    sells24h: asInt(dig(pair, "txns", "h24", "sells")),
    pairCreatedAt: asFloat(pair.pairCreatedAt),
  };
}

export function refFromPair(pair: Record<string, unknown>): TokenRef | null {
  const chain = canonicalChain(pair.chainId);
  const address = asString(dig(pair, "baseToken", "address"));
  if (!chain || !address) return null;
  return {
    chain,
    address,
    symbol: asString(dig(pair, "baseToken", "symbol")),
    name: asString(dig(pair, "baseToken", "name")),
    pairAddress: asString(pair.pairAddress),
    dex: asString(pair.dexId),
  };
}

export function socialsFromPair(pair: Record<string, unknown>): Socials {
  const info = (typeof pair.info === "object" && pair.info !== null ? pair.info : {}) as Record<
    string,
    unknown
  >;
  const socials = emptySocials();
  socials.description = asString(info.description);

  const websites = info.websites;
  if (Array.isArray(websites) && websites.length > 0) {
    const first = websites[0];
    socials.website =
      typeof first === "object" && first !== null
        ? asString((first as Record<string, unknown>).url)
        : asString(first);
  }

  for (const entry of asObjectList(info.socials)) {
    const kind = (asString(entry.type) ?? asString(entry.platform) ?? "").toLowerCase();
    const url = asString(entry.url);
    if (!url) continue;
    if (kind === "twitter" || kind === "x") socials.twitter ??= url;
    else if (kind === "telegram") socials.telegram ??= url;
    else if (kind === "discord") socials.discord ??= url;
    else socials.other.push(`${kind || "link"}: ${url}`);
  }
  return socials;
}
