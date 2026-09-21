import { describe, expect, it } from "vitest";

import { DEFAULTS, type FilterConfig } from "../src/config.js";
import { emptyHolders } from "../src/models.js";
import { passesFilters, rank, score } from "../src/scoring.js";
import { makeDossier } from "./helpers.js";

const filters: FilterConfig = { ...DEFAULTS.filters };

describe("filters", () => {
  it("passes a healthy token", () => {
    expect(passesFilters(makeDossier(), filters)).toEqual({ kept: true });
  });

  it("drops thin liquidity", () => {
    const d = makeDossier();
    d.market.liquidityUsd = 100;
    const result = passesFilters(d, filters);
    expect(result.kept).toBe(false);
    expect(result.reason).toContain("liquidity");
  });

  it("drops anything too new to measure", () => {
    const d = makeDossier();
    d.market.pairCreatedAt = Date.now() - 10 * 60_000;
    const result = passesFilters(d, filters);
    expect(result.kept).toBe(false);
    expect(result.reason).toContain("not yet meaningful");
  });

  it("drops anything too old to be a narrative", () => {
    const d = makeDossier();
    d.market.pairCreatedAt = Date.now() - 90 * 24 * 3_600_000;
    const result = passesFilters(d, filters);
    expect(result.kept).toBe(false);
    expect(result.reason).toContain("no longer a new narrative");
  });

  it("drops near-total insider concentration", () => {
    const d = makeDossier();
    d.holders.top10Pct = 97;
    const result = passesFilters(d, filters);
    expect(result.kept).toBe(false);
    expect(result.reason).toContain("top-10");
  });

  it("never drops a token just because a source returned nothing", () => {
    // The LLM is better placed to judge a blank than a threshold is.
    const d = makeDossier();
    d.market.liquidityUsd = null;
    d.market.volume24hUsd = null;
    d.market.pairCreatedAt = null;
    d.holders = emptyHolders();
    expect(passesFilters(d, filters).kept).toBe(true);
  });
});

describe("score", () => {
  it("ranks a revival name above a plain one", () => {
    const revival = makeDossier();
    const plain = makeDossier();
    plain.ref.symbol = "QQQ";
    plain.ref.name = "Quorum Protocol";
    plain.socials.description = "a protocol";
    expect(score(revival).score).toBeGreaterThan(score(plain).score);
  });

  it("penalises a honeypot heavily", () => {
    const d = makeDossier();
    const before = score(d).score;
    d.security = { isHoneypot: true, flags: ["flagged honeypot"] };
    expect(score(d).score).toBeLessThan(before - 30);
  });

  it("penalises the wash-trade shape", () => {
    const d = makeDossier();
    const before = score(d).score;
    d.market.volume24hUsd = d.market.liquidityUsd! * 200;
    const after = score(d);
    expect(after.score).toBeLessThan(before);
    expect(after.notes.some((n) => n.includes("wash-trade"))).toBe(true);
  });

  it("penalises a nominal valuation", () => {
    const d = makeDossier();
    const before = score(d).score;
    d.market.fdvUsd = d.market.liquidityUsd! * 500;
    const after = score(d);
    expect(after.score).toBeLessThan(before);
    expect(after.notes.some((n) => n.includes("nominal"))).toBe(true);
  });

  it("penalises concentration", () => {
    const d = makeDossier();
    const before = score(d).score;
    d.holders.top10Pct = 85;
    expect(score(d).score).toBeLessThan(before);
  });
});

describe("rank", () => {
  it("keeps survivors and reports what was dropped", () => {
    const good = makeDossier();
    const bad = makeDossier();
    bad.market.liquidityUsd = 10;
    const { kept, dropped } = rank([bad, good], filters);
    expect(kept.map((d) => d.ref.symbol)).toEqual(["WIF2"]);
    expect(dropped).toHaveLength(1);
    expect(kept[0]!.heuristicNotes.length).toBeGreaterThan(0);
  });

  it("sorts descending by score", () => {
    const strong = makeDossier();
    const weak = makeDossier();
    weak.ref.symbol = "ZZZ";
    weak.ref.name = "Zed";
    weak.socials.description = null;
    weak.socials.twitter = null;
    const { kept } = rank([weak, strong], filters);
    expect(kept[0]!.heuristicScore).toBeGreaterThanOrEqual(kept[1]!.heuristicScore);
  });
});
