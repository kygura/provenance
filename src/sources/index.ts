/**
 * Fan out across the trending sources and merge what comes back.
 *
 * A token that several independent sources surface at once is more interesting
 * than one that tops a single list, so cross-source agreement is recorded on
 * the dossier and feeds the heuristic score.
 */

import type { Config } from "../config.js";
import type { Fetcher } from "../http.js";
import { log } from "../log.js";
import { newDossier, tokenKey, type TokenDossier, type TokenRef } from "../models.js";
import type { TrendingSource } from "./chains.js";
import * as dexscreener from "./dexscreener.js";
import { DexScreenerSource } from "./dexscreener.js";
import { DexToolsSource } from "./dextools.js";
import { GeckoTerminalSource } from "./geckoterminal.js";

export { canonicalChain, EVM_CHAINS } from "./chains.js";
export type { TrendingSource } from "./chains.js";

export function buildSources(config: Config): TrendingSource[] {
  const sources: TrendingSource[] = [];
  const key = config.secrets.dextoolsApiKey;

  if (config.sources.dextoolsEnabled && key) {
    sources.push(new DexToolsSource(key, config.sources.dextoolsPlan));
  } else if (config.sources.dextoolsEnabled) {
    log.info("DEXTOOLS_API_KEY not set - falling back to the keyless sources");
  }
  if (config.sources.dexscreenerEnabled) sources.push(new DexScreenerSource());
  if (config.sources.geckoterminalEnabled) sources.push(new GeckoTerminalSource());
  return sources;
}

/** One dossier per distinct trending token, market data filled in. */
export async function collectTrending(
  fetcher: Fetcher,
  config: Config,
  sources: TrendingSource[] = buildSources(config),
): Promise<TokenDossier[]> {
  const { chains, perSourceLimit } = config.sources;

  const merged = new Map<string, TokenRef>();
  const hits = new Map<string, Set<string>>();
  const firstRank = new Map<string, number>();

  for (const source of sources) {
    let refs: TokenRef[];
    try {
      refs = await source.fetch(fetcher, chains, perSourceLimit);
    } catch (error) {
      // One bad source must not end the run.
      log.warn(`source ${source.name} failed: ${String(error)}`);
      continue;
    }
    log.info(`source ${source.name} returned ${refs.length} refs`);

    refs.forEach((ref, rank) => {
      const key = tokenKey(ref);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, ref);
        firstRank.set(key, rank);
      } else {
        // Keep whichever spelling carries more identity.
        merged.set(key, {
          chain: existing.chain,
          address: existing.address,
          symbol: existing.symbol ?? ref.symbol,
          name: existing.name ?? ref.name,
          pairAddress: existing.pairAddress ?? ref.pairAddress,
          dex: existing.dex ?? ref.dex,
        });
        firstRank.set(key, Math.min(firstRank.get(key) ?? rank, rank));
      }
      const seen = hits.get(key) ?? new Set<string>();
      seen.add(source.name);
      hits.set(key, seen);
    });
  }

  return enrichMarket(fetcher, merged, hits, firstRank);
}

/**
 * One batched DexScreener lookup per chain fills price, depth and age.
 *
 * DexScreener is used for this regardless of which source surfaced the token:
 * it batches 30 addresses per call and returns the same pair shape for every
 * chain, which keeps the enrichment step to a handful of requests.
 */
async function enrichMarket(
  fetcher: Fetcher,
  merged: Map<string, TokenRef>,
  hits: Map<string, Set<string>>,
  firstRank: Map<string, number>,
): Promise<TokenDossier[]> {
  const byChain = new Map<string, string[]>();
  for (const ref of merged.values()) {
    const list = byChain.get(ref.chain) ?? [];
    list.push(ref.address);
    byChain.set(ref.chain, list);
  }

  const pairs = new Map<string, Record<string, unknown>>();
  for (const [chain, addresses] of byChain) {
    for (const [key, pair] of await dexscreener.fetchPairs(fetcher, chain, addresses)) {
      pairs.set(key, pair);
    }
  }

  const dossiers: TokenDossier[] = [];
  for (const [key, ref] of merged) {
    const dossier = newDossier(ref, {
      sources: [...(hits.get(key) ?? [])].sort(),
      trendingRank: firstRank.get(key) ?? null,
    });

    const pair = pairs.get(ref.address.toLowerCase());
    if (pair) {
      const enriched = dexscreener.refFromPair(pair);
      if (enriched) {
        dossier.ref = {
          chain: ref.chain,
          address: ref.address,
          symbol: enriched.symbol ?? ref.symbol,
          name: enriched.name ?? ref.name,
          pairAddress: enriched.pairAddress ?? ref.pairAddress,
          dex: enriched.dex ?? ref.dex,
        };
      }
      dossier.market = dexscreener.marketFromPair(pair);
      dossier.socials = dexscreener.socialsFromPair(pair);
    }
    dossiers.push(dossier);
  }

  log.info(`collected ${dossiers.length} distinct tokens`);
  return dossiers;
}
