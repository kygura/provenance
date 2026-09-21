/**
 * Filtering and ranking, so the LLM only sees tokens worth paying to research.
 *
 * Two stages. `passesFilters` drops what is structurally uninteresting - too
 * thin to trade, too new to measure, too concentrated to be anything but a
 * distribution event. `score` then ranks what survives, and the top
 * `maxTokensPerRun` go to the model.
 *
 * The score is not a prediction. It orders a queue.
 */

import type { FilterConfig } from "./config.js";
import { classify, type Archetype } from "./lexicon.js";
import {
  ageHours,
  liquidityToFdv,
  socialLines,
  volumeToLiquidity,
  type TokenDossier,
} from "./models.js";

export function searchableText(dossier: TokenDossier): string {
  return [
    dossier.ref.symbol ?? "",
    dossier.ref.name ?? "",
    dossier.socials.description ?? "",
    ...socialLines(dossier.socials),
  ]
    .filter(Boolean)
    .join(" ");
}

export interface FilterResult {
  kept: boolean;
  reason?: string;
}

const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export function passesFilters(dossier: TokenDossier, filters: FilterConfig): FilterResult {
  const { market, holders, socials } = dossier;

  if (market.liquidityUsd != null && market.liquidityUsd < filters.minLiquidityUsd) {
    return { kept: false, reason: `liquidity ${usd(market.liquidityUsd)} below floor` };
  }
  if (market.volume24hUsd != null && market.volume24hUsd < filters.minVolume24hUsd) {
    return { kept: false, reason: `24h volume ${usd(market.volume24hUsd)} below floor` };
  }

  const age = ageHours(market);
  if (age != null) {
    if (age < filters.minAgeHours) {
      return { kept: false, reason: `only ${age.toFixed(1)}h old - metrics not yet meaningful` };
    }
    if (filters.maxAgeHours != null && age > filters.maxAgeHours) {
      return {
        kept: false,
        reason: `${Math.round(age / 24)} days old - no longer a new narrative`,
      };
    }
  }

  if (
    filters.maxTop10Pct != null &&
    holders.top10Pct != null &&
    holders.top10Pct > filters.maxTop10Pct
  ) {
    return { kept: false, reason: `top-10 hold ${holders.top10Pct.toFixed(0)}%` };
  }

  if (filters.requireSocials && socialLines(socials).length === 0) {
    return { kept: false, reason: "no socials published" };
  }

  return { kept: true };
}

export interface ScoreResult {
  score: number;
  notes: string[];
}

/**
 * Rank by how likely this is a recycled narrative worth a research call.
 *
 * Weighted toward narrative signal, because that is what the run is for. Market
 * quality only breaks ties and penalises the obviously fake.
 */
export function score(dossier: TokenDossier): ScoreResult {
  let points = 0;
  const notes: string[] = [];
  const { market, holders, security, socials } = dossier;

  // --- narrative signal -------------------------------------------------
  for (const { archetype, matched } of classify(searchableText(dossier))) {
    points += 12 * archetype.weight;
    notes.push(`${archetype.label}: matched ${matched.length} pattern(s)`);
  }

  // --- corroboration ----------------------------------------------------
  const distinct = new Set(
    dossier.sources.filter((s) => ["dextools", "dexscreener", "geckoterminal"].includes(s)),
  );
  if (distinct.size > 1) {
    points += 8 * (distinct.size - 1);
    notes.push(`trending on ${distinct.size} independent sources`);
  }
  if (dossier.trendingRank != null && dossier.trendingRank < 10) {
    points += 5;
    notes.push(`ranked #${dossier.trendingRank + 1} on its source`);
  }

  // --- attention shape --------------------------------------------------
  const age = ageHours(market);
  if (age != null && age >= 6 && age <= 24 * 7) {
    // The window where a narrative has formed but has not finished paying out.
    points += 10;
    notes.push(`${age.toFixed(0)}h old - inside the attention window`);
  }

  const vtl = volumeToLiquidity(market);
  if (vtl != null) {
    if (vtl >= 1 && vtl <= 20) {
      points += 6;
      notes.push(`volume/liquidity ${vtl.toFixed(1)}x - real turnover`);
    } else if (vtl > 60) {
      points -= 12;
      notes.push(`volume/liquidity ${vtl.toFixed(0)}x - wash-trade shape`);
    }
  }

  const ltf = liquidityToFdv(market);
  if (ltf != null && ltf < 0.01) {
    points -= 8;
    notes.push(`liquidity is ${(ltf * 100).toFixed(2)}% of FDV - the valuation is nominal`);
  }

  if (market.priceChange24hPct != null && market.priceChange24hPct > 50) {
    points += 4;
    notes.push(`+${market.priceChange24hPct.toFixed(0)}% on the day`);
  }

  // --- distribution and contract risk -----------------------------------
  if (holders.top10Pct != null) {
    if (holders.top10Pct > 70) {
      points -= 14;
      notes.push(
        `top-10 hold ${holders.top10Pct.toFixed(0)}% - distribution event, not a market`,
      );
    } else if (holders.top10Pct < 30) {
      points += 6;
      notes.push(`top-10 hold ${holders.top10Pct.toFixed(0)}% - genuinely distributed`);
    }
  }

  if (security.isHoneypot) {
    points -= 40;
    notes.push("flagged as a honeypot");
  }
  if (security.mintAuthorityActive) {
    points -= 10;
    notes.push("mint authority still live");
  }
  if (security.freezeAuthorityActive) {
    points -= 8;
    notes.push("freeze authority still live");
  }
  for (const flag of security.flags) {
    if (flag !== "mint authority live" && flag !== "freeze authority live") points -= 3;
  }
  if (security.flags.length > 0) {
    notes.push(`${security.flags.length} contract flag(s)`);
  }

  if (socialLines(socials).length > 0) {
    points += 3;
  } else {
    points -= 4;
    notes.push("no socials - provenance will be hard to establish");
  }

  return { score: Math.round(points * 100) / 100, notes };
}

export interface RankResult {
  kept: TokenDossier[];
  dropped: { dossier: TokenDossier; reason: string }[];
}

/** Score the survivors, highest first, alongside what was dropped and why. */
export function rank(dossiers: TokenDossier[], filters: FilterConfig): RankResult {
  const kept: TokenDossier[] = [];
  const dropped: { dossier: TokenDossier; reason: string }[] = [];

  for (const dossier of dossiers) {
    const result = passesFilters(dossier, filters);
    if (!result.kept) {
      dropped.push({ dossier, reason: result.reason ?? "filtered" });
      continue;
    }
    const scored = score(dossier);
    dossier.heuristicScore = scored.score;
    dossier.heuristicNotes = scored.notes;
    kept.push(dossier);
  }

  kept.sort((a, b) => b.heuristicScore - a.heuristicScore);
  return { kept, dropped };
}

export function topArchetype(dossier: TokenDossier): Archetype | null {
  const hits = classify(searchableText(dossier));
  if (hits.length === 0) return null;
  return hits.reduce((best, hit) =>
    hit.archetype.weight * hit.matched.length > best.archetype.weight * best.matched.length
      ? hit
      : best,
  ).archetype;
}
