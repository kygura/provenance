/**
 * DEXTools hot pools. Requires a paid key; skipped silently without one.
 *
 * This is the source the project was specified around. It is kept optional
 * because the keyless sources cover the same tokens, and a run that quietly
 * degrades is better than a run that dies on a lapsed subscription.
 */

import { asObjectList, asString, dig, type Fetcher } from "../http.js";
import { log } from "../log.js";
import type { TokenRef } from "../models.js";
import { canonicalChain, DEXTOOLS_SLUGS, type TrendingSource } from "./chains.js";

const BASE = "https://public-api.dextools.io";
export const NAME = "dextools";

export function refFromRow(row: Record<string, unknown>, fallbackChain: string): TokenRef | null {
  const token = (
    typeof row.mainToken === "object" && row.mainToken !== null
      ? row.mainToken
      : typeof row.token === "object" && row.token !== null
        ? row.token
        : {}
  ) as Record<string, unknown>;

  const address = asString(token.address) ?? asString(row.address);
  if (!address) return null;

  return {
    chain: canonicalChain(row.chain) ?? fallbackChain,
    address,
    symbol: asString(token.symbol),
    name: asString(token.name),
    pairAddress: asString(dig(row, "pair", "address")) ?? asString(row.address),
    dex: asString(dig(row, "exchange", "name")),
  };
}

export class DexToolsSource implements TrendingSource {
  readonly name = NAME;

  constructor(
    private readonly apiKey: string,
    private readonly plan: string = "trial",
  ) {}

  async fetch(fetcher: Fetcher, chains: string[], limit: number): Promise<TokenRef[]> {
    const headers = { "X-API-KEY": this.apiKey, accept: "application/json" };
    const refs: TokenRef[] = [];
    const seen = new Set<string>();

    for (const chain of chains) {
      const slug = DEXTOOLS_SLUGS[chain];
      if (!slug) continue;

      for (const ranking of ["hotpools", "gainers"]) {
        const payload = await fetcher.getJson(
          `${BASE}/${this.plan}/v2/ranking/${slug}/${ranking}`,
          { headers },
        );
        const data = dig(payload, "data");
        if (!Array.isArray(data)) {
          if (payload !== null) log.info(`dextools ${slug}/${ranking}: unexpected payload`);
          continue;
        }
        for (const row of asObjectList(data)) {
          const ref = refFromRow(row, chain);
          if (!ref) continue;
          const key = `${ref.chain}:${ref.address.toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          refs.push(ref);
          if (refs.length >= limit) return refs;
        }
      }
    }
    return refs;
  }
}
