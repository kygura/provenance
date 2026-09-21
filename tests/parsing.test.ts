/**
 * Parsing third-party payloads. These shapes drift, so the tests assert the
 * tolerant behaviour as much as the happy path.
 */

import { describe, expect, it } from "vitest";

import * as goplus from "../src/enrich/goplus.js";
import { ageHours, liquidityToFdv, volumeToLiquidity } from "../src/models.js";
import * as dexscreener from "../src/sources/dexscreener.js";
import * as geckoterminal from "../src/sources/geckoterminal.js";
import { fixture } from "./helpers.js";

describe("dexscreener", () => {
  const pair = fixture("dexscreener_pair");

  it("reads the token identity", () => {
    const ref = dexscreener.refFromPair(pair);
    expect(ref).not.toBeNull();
    expect(ref!.chain).toBe("solana");
    expect(ref!.symbol).toBe("PEPE2");
    expect(ref!.dex).toBe("raydium");
  });

  it("reads the market snapshot and its derived ratios", () => {
    const market = dexscreener.marketFromPair(pair);
    expect(market.liquidityUsd).toBe(310_000);
    expect(market.volume24hUsd).toBe(1_850_000);
    expect(market.priceUsd).toBe(0.00042);
    expect(market.pairCreatedAt).toBeTypeOf("number");
    // 1.85M traded against a 310K pool.
    expect(volumeToLiquidity(market)!).toBeCloseTo(5.97, 2);
    expect(liquidityToFdv(market)!).toBeCloseTo(0.0738, 4);
  });

  it("reads socials and keeps unrecognised platforms", () => {
    const socials = dexscreener.socialsFromPair(pair);
    expect(socials.twitter).toBe("https://x.com/example");
    expect(socials.telegram).toBe("https://t.me/example");
    expect(socials.website).toBe("https://example.invalid");
    expect(socials.other.some((line) => line.includes("github"))).toBe(true);
  });

  it("does not throw on a payload missing everything", () => {
    const market = dexscreener.marketFromPair({ baseToken: {} });
    expect(market.liquidityUsd).toBeNull();
    expect(ageHours(market)).toBeNull();
    expect(volumeToLiquidity(market)).toBeNull();
  });

  it("yields no ref for an unknown chain", () => {
    expect(dexscreener.refFromPair({ ...pair, chainId: "nonesuch" })).toBeNull();
  });
});

describe("geckoterminal", () => {
  const pool = fixture("geckoterminal_pool");

  it("reads the token identity out of the composite id", () => {
    const ref = geckoterminal.refFromPool(pool, "solana");
    expect(ref).not.toBeNull();
    expect(ref!.address).toBe("TOKEN222");
    expect(ref!.symbol).toBe("WIF2");
    expect(ref!.dex).toBe("meteora");
  });

  it("reads the market snapshot", () => {
    const market = geckoterminal.marketFromPool(pool);
    expect(market.liquidityUsd).toBe(890_000.12);
    expect(market.marketCapUsd).toBeNull();
    expect(market.pairCreatedAt).toBe(Date.parse("2026-09-18T12:00:00Z"));
  });

  it("returns null for a malformed token id", () => {
    const broken = { ...pool, relationships: { base_token: { data: { id: "nounderscore" } } } };
    expect(geckoterminal.refFromPool(broken, "solana")).toBeNull();
  });
});

describe("goplus", () => {
  it("excludes locked and burned holders from EVM concentration", () => {
    const holders = goplus.holdersFromEvm(fixture("goplus_evm"));
    expect(holders.holderCount).toBe(4821);
    // 21% + 9% + 5% circulating; the 40% lock and 12% burn are excluded.
    expect(holders.top10Pct).toBe(35);
    expect(holders.excludedAddresses).toHaveLength(2);
    expect(holders.creatorPct).toBeCloseTo(3.1, 5);
  });

  it("reads EVM contract risk", () => {
    const security = goplus.securityFromEvm(fixture("goplus_evm"));
    expect(security.isHoneypot).toBe(false);
    expect(security.buyTaxPct).toBeCloseTo(3, 5);
    expect(security.sellTaxPct).toBeCloseTo(5, 5);
    expect(security.flags).toContain("hidden owner");
    expect(security.flags).not.toContain("mintable");
    // 95% of LP sits at the null address.
    expect(security.lpBurned).toBe(true);
    expect(security.lpLockedPct).toBe(95);
  });

  it("reads the Solana shape", () => {
    const data = fixture("goplus_solana");
    const holders = goplus.holdersFromSolana(data);
    const security = goplus.securityFromSolana(data);
    expect(holders.top10Pct).toBe(33);
    expect(holders.creatorPct).toBe(2);
    expect(security.mintAuthorityActive).toBe(false);
    expect(security.freezeAuthorityActive).toBe(true);
    expect(security.flags).toContain("freeze authority live");
    expect(security.flags).toContain("metadata mutable");
  });

  it("keeps gini inside its bounds", () => {
    expect(goplus.gini([5, 5, 5, 5])).toBe(0);
    expect(goplus.gini([1])).toBeNull();
    expect(goplus.gini([])).toBeNull();
    expect(goplus.gini([99, 1, 1, 1])!).toBeGreaterThan(0.5);
  });

  it("decodes GoPlus string booleans", () => {
    expect(goplus.truthy("1")).toBe(true);
    expect(goplus.truthy("0")).toBe(false);
    expect(goplus.truthy("")).toBeNull();
    expect(goplus.truthy(undefined)).toBeNull();
  });
});
