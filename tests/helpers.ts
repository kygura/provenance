import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  newDossier,
  type ProvenanceVerdict,
  type TokenDossier,
} from "../src/models.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

/**
 * The same fixture with its pool-creation timestamp moved to `ageHours` ago.
 *
 * The recorded payloads carry the absolute timestamps the APIs returned. Any
 * test that runs them through the age filters has to rewrite those, or the
 * suite quietly changes meaning as the fixtures age - a token that was "12
 * hours old" when recorded starts getting dropped as stale, and the test keeps
 * passing while covering less.
 */
export function freshFixture(name: string, ageHours: number): Record<string, unknown> {
  const data = fixture(name);
  const created = Date.now() - ageHours * 3_600_000;

  if ("pairCreatedAt" in data) data.pairCreatedAt = created;

  const attrs = data.attributes;
  if (typeof attrs === "object" && attrs !== null && "pool_created_at" in attrs) {
    (attrs as Record<string, unknown>).pool_created_at = new Date(created).toISOString();
  }
  return data;
}

/** A plausible mid-sized token, 12 hours old, with room to be made worse. */
export function makeDossier(overrides: Partial<TokenDossier> = {}): TokenDossier {
  const dossier = newDossier(
    {
      chain: "solana",
      address: "TOKEN111111111111111111111111111111111111111",
      symbol: "WIF2",
      name: "dogwifhat 2.0",
      pairAddress: "PAIR1",
      dex: "raydium",
    },
    {
      sources: ["dexscreener", "geckoterminal"],
      trendingRank: 2,
      ...overrides,
    },
  );

  dossier.market = {
    priceUsd: 0.001,
    fdvUsd: 5_000_000,
    liquidityUsd: 250_000,
    volume24hUsd: 1_000_000,
    priceChange24hPct: 40,
    buys24h: 1000,
    sells24h: 900,
    pairCreatedAt: Date.now() - 12 * 3_600_000,
    ...overrides.market,
  };
  dossier.holders = {
    holderCount: 2000,
    top10Pct: 25,
    excludedAddresses: [],
    source: "goplus",
    ...overrides.holders,
  };
  dossier.security = { flags: [], source: "goplus", ...overrides.security };
  dossier.socials = {
    twitter: "https://x.com/x",
    description: "the hat is back",
    other: [],
    ...overrides.socials,
  };
  return dossier;
}

export function sampleVerdict(confidence = 80): ProvenanceVerdict {
  return {
    one_liner: "A 2023 dog meme relaunched with a new contract.",
    archetype: "dog coin",
    origin_story: "Re-uses the 2023 dogwifhat image and naming.",
    lineage: [
      {
        name: "dogwifhat",
        ticker: "WIF",
        era: "2023-24",
        peak_context: "Reached roughly $4B FDV on the hat image alone.",
        what_happened_next: "Drew down heavily through 2025.",
        resemblance: "Same image, same naming convention, new mint.",
        evidence_urls: ["https://example.invalid/wif"],
      },
    ],
    novelty: "pure-rerun",
    cycle_distance_years: 2,
    recycle_confidence: confidence,
    audience_read: "Holder base is young and mostly new wallets.",
    what_would_confirm: ["holder count keeps climbing without the price stalling"],
    what_would_kill_it: ["the original community publicly disavows it"],
    red_flags: ["freeze authority is still live"],
    open_questions: ["deployer identity is unestablished"],
  };
}
