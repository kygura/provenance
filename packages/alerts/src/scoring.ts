/**
 * The composite score.
 *
 * The thesis (see SPEC.md) is that a recycled narrative is a tradeable edge: a meme
 * that has already been monetised once carries its own proof, and the marginal
 * participant cannot tell a revival from an invention. So `recycling` is the heaviest
 * single component, and the on-chain components exist mostly to stop a beautiful
 * story from carrying a token that is structurally a trap.
 *
 * Every component function here is pure, exported, individually testable and returns
 * a finite number in [0, 100]. Missing inputs never produce NaN: each component
 * documents a neutral fallback, and "unmeasured" is deliberately neutral-to-low
 * rather than neutral-to-high — an unknown is not a clean bill of health.
 */

import {
  clamp,
  nowIso,
  ratio,
  type ChainAnalysis,
  type MarketMetrics,
  type ProvenanceReport,
  type ProvenanceScore,
  type RecycleVerdict,
  type RiskFlag,
  type ScoreComponents,
  type ScoreTier,
  type Scorer,
  type ScoringInput,
  type TokenSnapshot,
  type TxnCounts,
} from '@provenance/core';

// ---------------------------------------------------------------------------
// weights
// ---------------------------------------------------------------------------

export type ScoreWeights = Record<keyof ScoreComponents, number>;

/**
 * Component weights. They must sum to exactly 1 (see `assertWeights`).
 *
 * - recycling    0.30 — the thesis component. Proven, dormant, repeatedly-monetised
 *                       narratives are the whole reason this project exists.
 * - memetic      0.20 — durability x reach. A meme that survived several attention
 *                       cycles is the raw material a revival needs.
 * - authenticity 0.15 — being the canonical carrier is what converts a good meme
 *                       into a good token; an impostor captures none of the audience.
 * - distribution 0.15 — concentration is the single most common way a good story
 *                       ends badly for everyone who is not the deployer.
 * - liquidity    0.10 — a gate more than an edge: thin pools make everything moot.
 * - momentum     0.10 — deliberately the smallest. Momentum is the one input an
 *                       adversary can manufacture cheaply, so it never dominates.
 */
export const DEFAULT_WEIGHTS: ScoreWeights = {
  recycling: 0.3,
  memetic: 0.2,
  authenticity: 0.15,
  distribution: 0.15,
  liquidity: 0.1,
  momentum: 0.1,
};

/** Weights are a probability distribution over components; anything else is a bug. */
export function assertWeights(weights: ScoreWeights): void {
  const keys: (keyof ScoreComponents)[] = [
    'recycling',
    'memetic',
    'distribution',
    'liquidity',
    'momentum',
    'authenticity',
  ];
  let sum = 0;
  for (const key of keys) {
    const value = weights[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`invalid scoring weight for "${key}": ${String(value)}`);
    }
    sum += value;
  }
  // Floating point: 0.3 + 0.2 + 0.15 + 0.15 + 0.1 + 0.1 does not land exactly on 1.
  if (Math.abs(sum - 1) > 1e-9) {
    throw new Error(`scoring weights must sum to 1, got ${sum.toFixed(6)}`);
  }
}

/**
 * Neutral values used when an input is missing entirely. All of them sit below 50 on
 * purpose: an unmeasured token is not a good token, it is an unknown one, and the
 * pipeline should prefer the token it could actually verify.
 */
export const NEUTRAL: ScoreComponents = {
  recycling: 35,
  memetic: 40,
  distribution: 35,
  liquidity: 30,
  momentum: 45,
  authenticity: 40,
};

// ---------------------------------------------------------------------------
// small numeric helpers (local: they encode scoring policy, not general utility)
// ---------------------------------------------------------------------------

/** Clamp to the 0-100 component range and never let NaN/Infinity escape. */
function pct(value: number, fallback = 50): number {
  return Number.isFinite(value) ? clamp(value, 0, 100) : clamp(fallback, 0, 100);
}

/** A finite number or undefined. Upstream sources have been seen emitting NaN. */
function finite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Linear map of `value` from [lo, hi] onto [0, 100], clamped at both ends. */
function lerpPct(value: number, lo: number, hi: number): number {
  if (hi === lo) return 50;
  return clamp(((value - lo) / (hi - lo)) * 100, 0, 100);
}

// ---------------------------------------------------------------------------
// recycling
// ---------------------------------------------------------------------------

/**
 * Base score per verdict, before lineage evidence moves it.
 *
 * `revival` is the setup: dormant meme, real prior run, an audience that remembers.
 * `derivative` is a live meme with a genuine twist — workable but crowded.
 * `original` sits in the middle by construction: unproven, could be anything.
 * `copycat` scores poorly — it has no independent audience, only attention parasitism.
 * `unclear` scores low by construction: an unknown provenance is not a good provenance.
 */
export const VERDICT_BASE: Record<RecycleVerdict, number> = {
  revival: 62,
  derivative: 54,
  original: 50,
  copycat: 20,
  unclear: 26,
};

/**
 * How much lineage evidence is allowed to move each verdict. Prior cycles are
 * powerful evidence *for a revival* and close to meaningless for a copycat, whose
 * prior cycles belong to somebody else's currently-running token.
 */
export const VERDICT_EVIDENCE_MULTIPLIER: Record<RecycleVerdict, number> = {
  revival: 1,
  derivative: 0.8,
  original: 0.45,
  copycat: 0.2,
  unclear: 0.3,
};

/** Generation bonus. Gen 2-3 is the sweet spot; past that the meme is fatigued. */
function generationBonus(generation: number | undefined): number {
  const gen = finite(generation);
  if (gen === undefined || gen <= 0) return 0;
  if (gen < 2) return 7;
  if (gen < 4) return 10;
  return 6;
}

/**
 * Recycling strength: how good is this token's position in the meme's lineage.
 *
 * Neutral when no report exists: `NEUTRAL.recycling` (35) — we simply do not know
 * where the meme came from, which is a reason to pass, not a reason to buy.
 */
export function scoreRecycling(
  report?: ProvenanceReport,
  nowYear: number = new Date().getUTCFullYear(),
): number {
  if (!report) return NEUTRAL.recycling;

  const verdict: RecycleVerdict = report.recycleVerdict ?? 'unclear';
  const base = VERDICT_BASE[verdict] ?? VERDICT_BASE.unclear;
  const multiplier = VERDICT_EVIDENCE_MULTIPLIER[verdict] ?? VERDICT_EVIDENCE_MULTIPLIER.unclear;

  const cycles = Array.isArray(report.priorCycles) ? report.priorCycles : [];

  // How many times the meme has already been monetised. Each real cycle is a
  // demonstration that this narrative can move a market; four is plenty of proof.
  const countBonus = clamp(cycles.length, 0, 4) * 3;

  // What happened to those cycles matters more than how many there were. A meme that
  // faded is dormant and therefore available; one still running is competition; one
  // that rugged left an audience that remembers being burned.
  let outcomeBonus = 0;
  for (const cycle of cycles) {
    switch (cycle?.outcome) {
      case 'faded':
        outcomeBonus += 4;
        break;
      case 'still-alive':
        outcomeBonus += 2;
        break;
      case 'rugged':
        outcomeBonus -= 3;
        break;
      default:
        outcomeBonus += 1;
    }
  }
  outcomeBonus = clamp(outcomeBonus, -9, 12);

  // Recency: dormancy is what makes a revival work. A "prior" cycle from this year
  // means the meme is currently running, which is copycat territory, not revival.
  let recencyBonus = 0;
  const years = cycles.map((cycle) => finite(cycle?.year)).filter((y): y is number => y !== undefined);
  if (years.length > 0) {
    const mostRecent = Math.max(...years);
    const gap = nowYear - mostRecent;
    if (gap >= 3) recencyBonus = 7;
    else if (gap === 2) recencyBonus = 5;
    else if (gap === 1) recencyBonus = 1;
    else recencyBonus = -8;
  }

  const evidence = countBonus + outcomeBonus + recencyBonus + generationBonus(report.recycleGeneration);
  return pct(base + multiplier * evidence, NEUTRAL.recycling);
}

// ---------------------------------------------------------------------------
// memetic
// ---------------------------------------------------------------------------

/** Durability is weighted above reach; see `scoreMemetic`. */
export const MEMETIC_DURABILITY_WEIGHT = 0.65;

/**
 * Memetic strength: `memeticDurability` and `culturalReach` combined.
 *
 * Durability carries the larger share because surviving multiple attention cycles is
 * the property the thesis actually depends on — wide reach with no durability is a
 * one-week artifact, and one-week artifacts cannot be revived.
 *
 * Neutral when the report or a field is missing: `NEUTRAL.memetic` (40).
 */
export function scoreMemetic(report?: ProvenanceReport): number {
  if (!report) return NEUTRAL.memetic;
  const durability = finite(report.memeticDurability) ?? NEUTRAL.memetic;
  const reach = finite(report.culturalReach) ?? NEUTRAL.memetic;
  const combined =
    clamp(durability, 0, 100) * MEMETIC_DURABILITY_WEIGHT +
    clamp(reach, 0, 100) * (1 - MEMETIC_DURABILITY_WEIGHT);
  return pct(combined, NEUTRAL.memetic);
}

// ---------------------------------------------------------------------------
// distribution
// ---------------------------------------------------------------------------

/**
 * Holder-distribution health: the inverse of concentration.
 *
 * Three independent measurements, each mapped to 0-100 and combined by the weights
 * below. Crucially the result is blended back toward `NEUTRAL.distribution` in
 * proportion to how much of the token we could NOT measure, so a token where only one
 * of three measurements exists cannot reach 100 on that one measurement alone.
 */
export function scoreDistribution(chain?: ChainAnalysis): number {
  if (!chain) return NEUTRAL.distribution;

  const parts: { weight: number; value: number }[] = [];

  // Top-10 share, already LP/burn-excluded upstream. 15% is a healthy float for a
  // meme token; past 70% the float is decorative.
  const top10 = finite(chain.top10Pct);
  if (top10 !== undefined) parts.push({ weight: 0.5, value: lerpPct(clamp(top10, 0, 100), 70, 15) });

  // Herfindahl over holder shares, 0..1, higher = tighter. 0.01 is a wide book,
  // 0.25 means a handful of wallets are the market.
  const hhi = finite(chain.herfindahl);
  if (hhi !== undefined) parts.push({ weight: 0.3, value: lerpPct(clamp(hhi, 0, 1), 0.25, 0.01) });

  // Holder count on a log scale: 100 holders is nothing, 20k is a real distribution.
  const holders = finite(chain.holderCount);
  if (holders !== undefined) {
    const logged = Math.log10(Math.max(holders, 1));
    parts.push({ weight: 0.2, value: lerpPct(logged, 2, Math.log10(20_000)) });
  }

  if (parts.length === 0) return NEUTRAL.distribution;

  const coverage = parts.reduce((sum, part) => sum + part.weight, 0);
  const measured = parts.reduce((sum, part) => sum + part.weight * part.value, 0) / coverage;
  // A missing measurement is not a clean bill of health: unmeasured weight pulls the
  // result toward neutral-to-low rather than being silently renormalised away.
  let value = measured * coverage + NEUTRAL.distribution * (1 - coverage);

  // The creator's own bag is concentration with a motive attached.
  const creator = finite(chain.creatorHoldingPct);
  if (creator !== undefined && creator > 5) {
    value -= Math.min(30, (clamp(creator, 0, 100) - 5) * 1.5);
  }

  return pct(value, NEUTRAL.distribution);
}

// ---------------------------------------------------------------------------
// liquidity
// ---------------------------------------------------------------------------

/** Below this much USD in the pool, exit is theoretical regardless of the ratio. */
export const LIQUIDITY_FLOOR_USD = 5_000;
/** At or above this, absolute depth stops being the binding constraint. */
export const LIQUIDITY_DEEP_USD = 250_000;

/**
 * Liquidity depth: pool size relative to market cap, gated by an absolute floor.
 *
 * The final value is the *weaker* of the two readings on purpose. A 40% liquidity
 * ratio on a $5k pool is not liquidity, and a $2M pool against a $400M cap is not
 * depth either — neither reading alone is allowed to carry the component.
 *
 * Neutral when nothing is known: `NEUTRAL.liquidity` (30).
 */
export function scoreLiquidity(metrics?: MarketMetrics): number {
  const liquidity = finite(metrics?.liquidityUsd);
  if (liquidity === undefined || liquidity <= 0) return NEUTRAL.liquidity;

  const depthScore = lerpPct(
    Math.log10(Math.max(liquidity, 1)),
    Math.log10(LIQUIDITY_FLOOR_USD),
    Math.log10(LIQUIDITY_DEEP_USD),
  );

  // Market cap is the honest denominator; FDV is the fallback when cap is unreported.
  const cap = finite(metrics?.marketCapUsd) ?? finite(metrics?.fdvUsd);
  const depthRatio = ratio(liquidity, cap);
  if (depthRatio === undefined) {
    // Depth alone, discounted toward neutral: we cannot tell if it is deep *enough*.
    return pct(depthScore * 0.6 + NEUTRAL.liquidity * 0.4, NEUTRAL.liquidity);
  }

  const ratioScore = lerpPct(clamp(depthRatio, 0, 10), 0.01, 0.2);
  return pct(Math.min(ratioScore, depthScore), NEUTRAL.liquidity);
}

// ---------------------------------------------------------------------------
// momentum
// ---------------------------------------------------------------------------

/** Price change over one window, saturating at `fullScale` percent. */
export function priceWindowScore(change: number | undefined, fullScale: number): number {
  const value = finite(change);
  if (value === undefined) return 50;
  return pct(50 + (value / fullScale) * 50);
}

/**
 * Turnover (24h volume / liquidity) as a bump function.
 *
 * Healthy rotation peaks around 3x. Beyond ~8x the "volume" is more likely a bot
 * cycling the same inventory than an audience arriving, so the curve turns back down
 * instead of rewarding it. Volume many multiples of liquidity is suspicious, not bullish.
 */
export function turnoverScore(turnover: number | undefined): number {
  const value = finite(turnover);
  if (value === undefined) return 45;
  if (value <= 0) return 0;
  if (value < 0.25) return pct((value / 0.25) * 40);
  if (value <= 3) return pct(40 + ((value - 0.25) / 2.75) * 60);
  if (value <= 8) return pct(100 - ((value - 3) / 5) * 35);
  return pct(clamp(65 - ((value - 8) / 12) * 55, 10, 65));
}

/**
 * Buy/sell balance. Mild buy pressure is the signal; anything above ~70% buys is
 * implausible for an organic book, and a near-perfect 50/50 split over hundreds of
 * transactions is the signature of a wash bot, not of a balanced market.
 */
export function txnBalanceScore(txns: TxnCounts | undefined): number {
  const buys = finite(txns?.buys);
  const sells = finite(txns?.sells);
  if (buys === undefined || sells === undefined) return 50;
  const total = buys + sells;
  if (total <= 0) return 45;

  const buyShare = buys / total;
  let value: number;
  if (buyShare < 0.5) value = (buyShare / 0.5) * 50;
  else if (buyShare <= 0.7) value = 50 + ((buyShare - 0.5) / 0.2) * 50;
  else value = clamp(100 - ((buyShare - 0.7) / 0.25) * 70, 25, 100);

  // Near-perfect symmetry at volume: treat as suspicious rather than neutral.
  if (total >= 400 && Math.abs(buyShare - 0.5) < 0.01) value = Math.min(value, 35);

  return pct(value);
}

/**
 * Momentum across 1h / 6h / 24h plus the transaction book.
 *
 * Each price window contributes a fixed share and missing windows fall back to 50
 * rather than being renormalised away — that is what caps the contribution of a
 * single window, so one 400% hourly candle cannot carry the component on its own.
 *
 * Neutral when nothing is known: `NEUTRAL.momentum` (45).
 */
export function scoreMomentum(metrics?: MarketMetrics): number {
  if (!metrics) return NEUTRAL.momentum;

  const hasPrice =
    finite(metrics.priceChange1h) !== undefined ||
    finite(metrics.priceChange6h) !== undefined ||
    finite(metrics.priceChange24h) !== undefined;
  const volume = finite(metrics.volume24hUsd) ?? finite(metrics.volume6hUsd);
  const txns = metrics.txns24h ?? metrics.txns6h ?? metrics.txns1h;
  const hasTxns = finite(txns?.buys) !== undefined && finite(txns?.sells) !== undefined;
  if (!hasPrice && volume === undefined && !hasTxns) return NEUTRAL.momentum;

  const priceMean =
    (priceWindowScore(metrics.priceChange1h, 25) +
      priceWindowScore(metrics.priceChange6h, 60) +
      priceWindowScore(metrics.priceChange24h, 120)) /
    3;

  const turnover = turnoverScore(ratio(volume, finite(metrics.liquidityUsd)));
  const balance = txnBalanceScore(txns);

  return pct(priceMean * 0.4 + turnover * 0.32 + balance * 0.28, NEUTRAL.momentum);
}

// ---------------------------------------------------------------------------
// authenticity
// ---------------------------------------------------------------------------

/**
 * Is this the instance of the meme its audience would accept as canonical?
 *
 * Starts from the model's `authenticityScore`, moves it by the organic read's
 * outside traction, and adjusts for two cheap, external corroborations: whether the token has any public presence at all, and whether more
 * than one trending list independently surfaced it.
 *
 * Neutral when the report is missing: `NEUTRAL.authenticity` (40), still adjusted by
 * the snapshot, because socials and cross-source agreement are observable without the model.
 */
export function scoreAuthenticity(report?: ProvenanceReport, snapshot?: TokenSnapshot): number {
  let value = finite(report?.authenticityScore) ?? NEUTRAL.authenticity;
  value = clamp(value, 0, 100);

  const socials = snapshot?.socials;
  if (socials) {
    const present = [socials.website, socials.twitter, socials.telegram, socials.discord].filter(
      (link) => typeof link === 'string' && link.trim() !== '',
    ).length;
    // A token with no public surface has nowhere for the meme's audience to gather.
    if (present === 0) value -= 12;
    else if (present === 1) value -= 4;
    else value += 4;
    if (socials.website) value += 3;
  }

  // Outside traction is the model's read of how much unpaid, outside work is
  // carrying the token. It moves authenticity by at most 10 either way, and
  // only when the organic read reached a verdict: `unclear` says nothing.
  const organic = report?.organic;
  const traction = finite(organic?.outsideTraction);
  if (organic && organic.verdict !== 'unclear' && traction !== undefined) {
    value += (clamp(traction, 0, 100) - 50) * ORGANIC_TRACTION_WEIGHT;
  }

  // Cross-source agreement is the cheapest independent evidence we have that this is
  // the instance the market converged on rather than one of a dozen forks.
  const sources = finite(snapshot?.sourceCount);
  if (sources !== undefined) {
    if (sources >= 3) value += 10;
    else if (sources === 2) value += 6;
  }

  return pct(value, NEUTRAL.authenticity);
}

// ---------------------------------------------------------------------------
// risk assessment, penalties, tiers
// ---------------------------------------------------------------------------

export interface RiskAssessment {
  /** Every flag the analyser marked `critical`. */
  criticalFlags: RiskFlag[];
  mintAuthorityActive: boolean;
  freezeAuthorityActive: boolean;
  /** Largest single non-excluded holder, in percent, when known. */
  singleHolderPct?: number;
  /** Top-10 share at or above `EXTREME_CONCENTRATION_PCT`. */
  extremeConcentration: boolean;
  /** Any of the above. */
  hasCritical: boolean;
}

/** A single wallet at or above this share is effectively the market for the token. */
export const SINGLE_HOLDER_DOMINANCE_PCT = 25;
/** Top-10 at or above this is a closed book with a retail-facing chart. */
export const EXTREME_CONCENTRATION_PCT = 80;

/** Pure read of the hard, structural risks in a `ChainAnalysis`. */
export function assessRisk(chain?: ChainAnalysis): RiskAssessment {
  const criticalFlags = (chain?.flags ?? []).filter((flag) => flag?.severity === 'critical');
  const mintAuthorityActive = chain?.mintAuthorityActive === true;
  const freezeAuthorityActive = chain?.freezeAuthorityActive === true;

  // The analyser's own ex-LP figure, which is clamped and uses the same basis
  // as `top10Pct`. Scanning `topHolders` for the biggest `pct` instead mixed
  // bases — `HolderRow.pct` is a share of TOTAL supply — and on EVM, where
  // balances are reconstructed from a bounded log window, printed penalties
  // like "Single holder controls 210.0% of supply".
  let singleHolderPct = finite(chain?.largestHolderPct);
  if (singleHolderPct === undefined) {
    // Pre-`largestHolderPct` rows, and analysers that resolved holders without
    // a supply figure. Same mixed-basis caveat, so it is clamped here.
    for (const holder of chain?.topHolders ?? []) {
      if (!holder || holder.excludedFromConcentration) continue;
      const share = finite(holder.pct);
      if (share === undefined) continue;
      if (singleHolderPct === undefined || share > singleHolderPct) singleHolderPct = share;
    }
    if (singleHolderPct !== undefined) singleHolderPct = Math.min(100, singleHolderPct);
  }

  const top10 = finite(chain?.top10Pct);
  const extremeConcentration = top10 !== undefined && top10 >= EXTREME_CONCENTRATION_PCT;

  return {
    criticalFlags,
    mintAuthorityActive,
    freezeAuthorityActive,
    singleHolderPct,
    extremeConcentration,
    hasCritical:
      criticalFlags.length > 0 ||
      mintAuthorityActive ||
      freezeAuthorityActive ||
      extremeConcentration ||
      (singleHolderPct !== undefined && singleHolderPct >= SINGLE_HOLDER_DOMINANCE_PCT),
  };
}

/**
 * Tier cut points, applied to the post-penalty total.
 *
 * S  >= 85  the setup this project was built to find: proven dormant meme, canonical
 *           carrier, clean book. Rare by design, and unreachable with a live mint authority.
 * A  >= 72  strong. Sits just above the default `alertScoreThreshold` of 70, so the
 *           default alert feed is roughly "A and the top of B".
 * B  >= 58  interesting, with at least one thing wrong or unverified.
 * C  >= 42  watchlist at best.
 * D  <  42  no.
 */
export const TIER_CUTS: { tier: ScoreTier; min: number }[] = [
  { tier: 'S', min: 85 },
  { tier: 'A', min: 72 },
  { tier: 'B', min: 58 },
  { tier: 'C', min: 42 },
  { tier: 'D', min: 0 },
];

const TIER_ORDER: ScoreTier[] = ['S', 'A', 'B', 'C', 'D'];

export function tierFor(total: number): ScoreTier {
  const value = Number.isFinite(total) ? total : 0;
  for (const cut of TIER_CUTS) {
    if (value >= cut.min) return cut.tier;
  }
  return 'D';
}

/** Returns the lower (worse) of two tiers. */
export function capTier(tier: ScoreTier, ceiling: ScoreTier | undefined): ScoreTier {
  if (!ceiling) return tier;
  return TIER_ORDER.indexOf(tier) >= TIER_ORDER.indexOf(ceiling) ? tier : ceiling;
}

/** Authenticity points per point of outside traction away from 50 (so ±10 at the ends). */
export const ORGANIC_TRACTION_WEIGHT = 0.2;

/** Points off a token judged `manufactured` at or above `LOW_CONFIDENCE_THRESHOLD`. */
export const MANUFACTURED_PENALTY = 20;

/** Points off a `mixed` organic read: some of the attention was staged. */
export const MIXED_PENALTY = 6;

/** Points off a meme judged `forced` at medium or high confidence. */
export const FORCED_PENALTY = 25;

/** Below this model confidence the provenance-derived components are scaled down. */
export const LOW_CONFIDENCE_THRESHOLD = 0.45;

// ---------------------------------------------------------------------------
// composition
// ---------------------------------------------------------------------------

/** All six components for an input, before weighting. Pure. */
export function scoreComponents(input: ScoringInput, nowYear?: number): ScoreComponents {
  const metrics = input.snapshot?.metrics;
  return {
    recycling: scoreRecycling(input.provenance, nowYear),
    memetic: scoreMemetic(input.provenance),
    distribution: scoreDistribution(input.chain),
    liquidity: scoreLiquidity(metrics),
    momentum: scoreMomentum(metrics),
    authenticity: scoreAuthenticity(input.provenance, input.snapshot),
  };
}

export interface ScoreOptions {
  weights?: ScoreWeights;
  /** Injectable for deterministic tests. */
  now?: Date;
}

/**
 * Full composite score: weighted components, then penalties, then tier with ceilings.
 *
 * Order matters. Penalties are subtracted from the *weighted* total rather than from
 * a component, because "an active mint authority" is a property of the token, not of
 * its holder distribution, and burying it inside `distribution` would let a 0.15
 * weight dilute it into irrelevance.
 */
export function scoreToken(input: ScoringInput, options: ScoreOptions = {}): ProvenanceScore {
  const weights = options.weights ?? DEFAULT_WEIGHTS;
  assertWeights(weights);

  const now = options.now ?? new Date();
  const components = scoreComponents(input, now.getUTCFullYear());

  const weighted =
    components.recycling * weights.recycling +
    components.memetic * weights.memetic +
    components.distribution * weights.distribution +
    components.liquidity * weights.liquidity +
    components.momentum * weights.momentum +
    components.authenticity * weights.authenticity;

  const penalties: { reason: string; points: number }[] = [];
  let ceiling: ScoreTier | undefined;
  const risk = assessRisk(input.chain);

  if (risk.mintAuthorityActive) {
    penalties.push({
      reason: 'Mint authority is still active: supply can be inflated at will',
      points: 18,
    });
    // Hard ceiling, not just a subtraction. No story is good enough to make a token
    // whose supply the deployer still controls a tier-S setup.
    ceiling = capTier(ceiling ?? 'S', 'B');
  }
  if (risk.freezeAuthorityActive) {
    penalties.push({
      reason: 'Freeze authority is still active: holder accounts can be locked',
      points: 10,
    });
    ceiling = capTier(ceiling ?? 'S', 'A');
  }
  if (risk.singleHolderPct !== undefined && risk.singleHolderPct >= SINGLE_HOLDER_DOMINANCE_PCT) {
    penalties.push({
      reason: `Single holder controls ${risk.singleHolderPct.toFixed(1)}% of supply`,
      points: 14,
    });
    ceiling = capTier(ceiling ?? 'S', 'A');
  }
  if (risk.extremeConcentration) {
    penalties.push({
      reason: `Top 10 holders control ${(finite(input.chain?.top10Pct) ?? 0).toFixed(1)}% of supply`,
      points: 16,
    });
    ceiling = capTier(ceiling ?? 'S', 'B');
  }

  // Remaining critical flags the analyser raised that are not already accounted for.
  const accounted = /mint|freeze|concentration|single.?holder|top.?10/i;
  const others = risk.criticalFlags.filter((flag) => !accounted.test(flag.code ?? ''));
  if (others.length > 0) {
    const points = Math.min(15, others.length * 5);
    penalties.push({
      reason: `Critical risk flags: ${others.map((flag) => flag.code).join(', ')}`,
      points,
    });
    ceiling = capTier(ceiling ?? 'S', 'A');
  }

  // The anchor verdict is the question the project exists to answer, so a
  // `forced` meme is capped however well its lineage fields happen to score:
  // a manufactured meme with invented "prior cycles" must not read as tier A.
  const anchor = input.provenance?.anchor;
  if (anchor?.verdict === 'forced') {
    if (anchor.confidence === 'low') {
      ceiling = capTier(ceiling ?? 'S', 'B');
    } else {
      penalties.push({ reason: `Forced meme: ${anchor.summary || 'no independent anchor found'}`, points: FORCED_PENALTY });
      ceiling = capTier(ceiling ?? 'S', 'C');
    }
  }

  // The organic read is the second question, and it bites the same way: a real
  // meme on a sniped, insider-held token (the Neiro perps twin) must not read
  // as tier A on the strength of the meme. Gated on the report's own
  // confidence, since there is no per-verdict confidence for it.
  const organic = input.provenance?.organic;
  const reportConfidence = finite(input.provenance?.confidence) ?? 0;
  if (organic?.verdict === 'manufactured') {
    if (reportConfidence < LOW_CONFIDENCE_THRESHOLD) {
      ceiling = capTier(ceiling ?? 'S', 'B');
    } else {
      penalties.push({
        reason: `Manufactured token: ${organic.summary || 'attention traced to the launch, not outside it'}`,
        points: MANUFACTURED_PENALTY,
      });
      ceiling = capTier(ceiling ?? 'S', 'C');
    }
  } else if (organic?.verdict === 'mixed') {
    penalties.push({ reason: `Partly staged attention: ${organic.summary || 'organic and manufactured signals both present'}`, points: MIXED_PENALTY });
    ceiling = capTier(ceiling ?? 'S', 'A');
  }

  // Low model confidence scales the provenance-derived components down rather than
  // subtracting a flat amount: thin evidence should shrink the part of the score that
  // depends on evidence, and leave the on-chain measurements alone.
  const confidence = finite(input.provenance?.confidence);
  if (input.provenance && confidence !== undefined && confidence < LOW_CONFIDENCE_THRESHOLD) {
    const factor = clamp(0.5 + confidence, 0, 1);
    const storyWeight =
      components.recycling * weights.recycling +
      components.memetic * weights.memetic +
      components.authenticity * weights.authenticity;
    const shrink = storyWeight * (1 - factor);
    if (shrink > 0.01) {
      penalties.push({
        reason: `Model confidence ${confidence.toFixed(2)}: provenance components scaled to ${Math.round(factor * 100)}%`,
        points: Math.round(shrink * 10) / 10,
      });
    }
    if (confidence < 0.3) ceiling = capTier(ceiling ?? 'S', 'B');
  }

  const deducted = penalties.reduce((sum, penalty) => sum + penalty.points, 0);
  const total = pct(Math.round((weighted - deducted) * 10) / 10, 0);

  return {
    tokenId: input.snapshot?.tokenId ?? input.provenance?.tokenId ?? input.chain?.tokenId ?? 'unknown',
    total,
    tier: capTier(tierFor(total), ceiling),
    components,
    penalties,
    computedAt: options.now ? options.now.toISOString() : nowIso(),
  };
}

/**
 * A `Scorer` with optional weight overrides. Overrides are merged onto
 * `DEFAULT_WEIGHTS` and validated eagerly, so a bad configuration fails at wiring
 * time rather than silently skewing every score in a run.
 */
export function createScorer(weights?: Partial<ScoreWeights>): Scorer {
  const merged: ScoreWeights = { ...DEFAULT_WEIGHTS, ...(weights ?? {}) };
  assertWeights(merged);
  return {
    score: (input: ScoringInput): ProvenanceScore => scoreToken(input, { weights: merged }),
  };
}
