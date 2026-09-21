/**
 * GeckoTerminal: keyless trending pools, 30 requests/minute.
 *
 * Its trending ranking is computed from pool activity rather than paid
 * placement, so it and the DexScreener boosts feed disagree in a useful way - a
 * token on both is trending *and* promoted.
 */

import { asFloat, asInt, asObjectList, asString, dig, type Fetcher } from "../http.js";
import type { MarketSnapshot, TokenRef } from "../models.js";
import { canonicalChain, GECKOTERMINAL_SLUGS, type TrendingSource } from "./chains.js";

const BASE = "https://api.geckoterminal.com/api/v2";
export const NAME = "geckoterminal";

function pools(payload: unknown): Record<string, unknown>[] {
  return asObjectList(dig(payload, "data"));
}

export function refFromPool(pool: Record<string, unknown>, fallbackChain: string): TokenRef | null {
  // relationships.base_token.data.id is "<network>_<address>". Split on the
  // first underscore: network slugs can themselves contain one (polygon_pos),
  // so the canonical map resolves whatever comes out, with the sweep's chain as
  // the fallback.
  const tokenId = asString(dig(pool, "relationships", "base_token", "data", "id"));
  if (!tokenId || !tokenId.includes("_")) return null;

  const separator = tokenId.indexOf("_");
  const network = tokenId.slice(0, separator);
  const address = tokenId.slice(separator + 1);
  if (!address) return null;

  const name = asString(dig(pool, "attributes", "name")) ?? "";
  const symbol = name.includes("/") ? name.split("/")[0]?.trim() : null;

  return {
    chain: canonicalChain(network) ?? fallbackChain,
    address,
    symbol: symbol || null,
    pairAddress: asString(dig(pool, "attributes", "address")),
    dex: asString(dig(pool, "relationships", "dex", "data", "id")),
  };
}

export function marketFromPool(pool: Record<string, unknown>): MarketSnapshot {
  const attrs = (
    typeof pool.attributes === "object" && pool.attributes !== null ? pool.attributes : {}
  ) as Record<string, unknown>;

  const createdRaw = asString(attrs.pool_created_at);
  const createdMs = createdRaw ? Date.parse(createdRaw) : NaN;

  return {
    priceUsd: asFloat(attrs.base_token_price_usd),
    fdvUsd: asFloat(attrs.fdv_usd),
    marketCapUsd: asFloat(attrs.market_cap_usd),
    liquidityUsd: asFloat(attrs.reserve_in_usd),
    volume24hUsd: asFloat(dig(attrs, "volume_usd", "h24")),
    volume6hUsd: asFloat(dig(attrs, "volume_usd", "h6")),
    volume1hUsd: asFloat(dig(attrs, "volume_usd", "h1")),
    priceChange24hPct: asFloat(dig(attrs, "price_change_percentage", "h24")),
    priceChange6hPct: asFloat(dig(attrs, "price_change_percentage", "h6")),
    priceChange1hPct: asFloat(dig(attrs, "price_change_percentage", "h1")),
    buys24h: asInt(dig(attrs, "transactions", "h24", "buys")),
    sells24h: asInt(dig(attrs, "transactions", "h24", "sells")),
    pairCreatedAt: Number.isFinite(createdMs) ? createdMs : null,
  };
}

export class GeckoTerminalSource implements TrendingSource {
  readonly name = NAME;

  async fetch(fetcher: Fetcher, chains: string[], limit: number): Promise<TokenRef[]> {
    const refs: TokenRef[] = [];
    const seen = new Set<string>();
    const perChain = Math.max(1, Math.floor(limit / Math.max(1, chains.length)));

    for (const chain of chains) {
      const slug = GECKOTERMINAL_SLUGS[chain];
      if (!slug) continue;

      const payload = await fetcher.getJson(`${BASE}/networks/${slug}/trending_pools`, {
        params: { include: "base_token,dex", page: 1, duration: "24h" },
      });

      let taken = 0;
      for (const pool of pools(payload)) {
        const ref = refFromPool(pool, chain);
        if (!ref) continue;
        const key = `${ref.chain}:${ref.address.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push(ref);
        if (refs.length >= limit) return refs;
        if (++taken >= perChain) break;
      }
    }
    return refs;
  }
}
