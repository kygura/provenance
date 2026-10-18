/**
 * The restraint gate: every rule a setup proposal must clear, in code. The
 * model's proposal is data; anything that breaks a rule is dropped and the
 * reason logged. Zero accepted setups is the normal outcome.
 */
import type { SetupConviction } from '@provenance/core';
import type { ChainFlag } from './queries';
import type { MemeRegime } from './regime';

export const GATE = {
  minTiers: ['S', 'A', 'B'] as readonly string[],
  strictTiers: ['S', 'A'] as readonly string[],
  minLiquidityUsd: 50_000,
  maxTop10Pct: 80,
  maxSingleHolderPct: 25,
  maxZoneWidthPct: 30,
  minInvalidationDepthPct: 15,
  minRewardRisk: 2,
  maxExpiryDays: 7,
  maxOpen: 4,
  maxNewPerRun: 2,
  blockingFlagSeverities: ['high', 'critical'] as readonly string[],
} as const;

/** What the model proposes (already shape-validated by the output schema). */
export interface SetupProposal {
  token_id: string;
  direction: 'long' | 'short';
  thesis: string;
  trigger: string;
  conviction: SetupConviction;
  entry_mcap_low: number;
  entry_mcap_high: number;
  invalidation_mcap: number;
  targets: number[];
  expiry_days: number;
}

/** What code knows about the proposed token, from CUR or the latest rows. */
export interface GateCandidate {
  tokenId: string;
  inCur: boolean;
  onActiveWatchlist: boolean;
  tier?: string;
  anchorVerdict?: string;
  liquidityUsd?: number;
  top10Pct?: number;
  largestHolderPct?: number;
  mintActive?: boolean;
  freezeActive?: boolean;
  flags: ChainFlag[];
}

export interface GateContext {
  memeRegime: MemeRegime;
  btcRiskOff: boolean;
  /** Open setups' token ids, before this run's proposals. */
  openTokenIds: readonly string[];
}

export interface GateVerdict {
  proposal: SetupProposal;
  accepted: boolean;
  reasons: string[];
  /** Reward:risk to the first target from the entry midpoint, computed here. */
  rr?: number;
}

/** Every rule that one proposal breaks, ignoring the per-run caps. Empty means it passes. */
export function checkProposal(
  proposal: SetupProposal,
  candidate: GateCandidate | undefined,
  context: Pick<GateContext, 'memeRegime' | 'btcRiskOff'>,
): { reasons: string[]; rr?: number } {
  const reasons: string[] = [];

  if (!candidate || (!candidate.inCur && !candidate.onActiveWatchlist)) {
    reasons.push('token is neither in the current run nor open on the watchlist');
  }
  if (!candidate?.tier || !GATE.minTiers.includes(candidate.tier)) {
    reasons.push(`tier ${candidate?.tier ?? 'unknown'} is below B`);
  }
  if (proposal.direction !== 'long') reasons.push('long only: memecoin shorts are not tradable on these venues');

  if (candidate) {
    const blocking = candidate.flags.filter((flag) => GATE.blockingFlagSeverities.includes(flag.severity));
    if (blocking.length > 0) reasons.push(`blocking chain flag: ${blocking.map((flag) => flag.code).join(', ')}`);
    if (candidate.mintActive === true) reasons.push('mint authority active');
    if (candidate.freezeActive === true) reasons.push('freeze authority active');
    if (candidate.top10Pct === undefined) reasons.push('top-10 concentration unknown');
    else if (candidate.top10Pct >= GATE.maxTop10Pct) reasons.push(`top-10 ${candidate.top10Pct.toFixed(1)}% ≥ ${GATE.maxTop10Pct}%`);
    if (candidate.largestHolderPct !== undefined && candidate.largestHolderPct >= GATE.maxSingleHolderPct) {
      reasons.push(`largest holder ${candidate.largestHolderPct.toFixed(1)}% ≥ ${GATE.maxSingleHolderPct}%`);
    }
    if (candidate.liquidityUsd === undefined) reasons.push('liquidity unknown');
    else if (candidate.liquidityUsd < GATE.minLiquidityUsd) {
      reasons.push(`liquidity $${Math.round(candidate.liquidityUsd).toLocaleString('en-US')} < $${GATE.minLiquidityUsd.toLocaleString('en-US')}`);
    }
  }

  const low = proposal.entry_mcap_low;
  const high = proposal.entry_mcap_high;
  const inv = proposal.invalidation_mcap;
  const levels = [low, high, inv, ...proposal.targets];
  let rr: number | undefined;
  if (!levels.every((value) => Number.isFinite(value) && value > 0) || proposal.targets.length === 0) {
    reasons.push('levels must be positive numbers with at least one target');
  } else if (!(high > low)) {
    reasons.push('entry zone high must be above low');
  } else {
    const mid = (low + high) / 2;
    const widthPct = ((high - low) / mid) * 100;
    if (widthPct > GATE.maxZoneWidthPct) reasons.push(`entry zone ${widthPct.toFixed(0)}% wide > ${GATE.maxZoneWidthPct}% of its midpoint`);
    if (!(inv < low)) reasons.push('invalidation must be below the entry zone');
    const depthPct = ((mid - inv) / mid) * 100;
    if (depthPct < GATE.minInvalidationDepthPct) {
      reasons.push(`invalidation ${depthPct.toFixed(0)}% under entry mid < ${GATE.minInvalidationDepthPct}%`);
    }
    const sorted = [...proposal.targets].sort((a, b) => a - b);
    if (sorted.some((value, index) => value !== proposal.targets[index])) reasons.push('targets must be ascending');
    const first = sorted[0] as number;
    if (mid - inv > 0) {
      rr = Number(((first - mid) / (mid - inv)).toFixed(2));
      if (rr < GATE.minRewardRisk) reasons.push(`first target is ${rr}R from entry mid < ${GATE.minRewardRisk}R`);
    }
  }

  if (!Number.isFinite(proposal.expiry_days) || proposal.expiry_days <= 0 || proposal.expiry_days > GATE.maxExpiryDays) {
    reasons.push(`expiry ${proposal.expiry_days} days is outside (0, ${GATE.maxExpiryDays}]`);
  }

  if (context.memeRegime === 'cold' || context.btcRiskOff) {
    const why = context.memeRegime === 'cold' ? 'cold meme regime' : 'BTC risk-off';
    if (proposal.conviction !== 'high') reasons.push(`${why}: conviction must be high`);
    if (candidate?.anchorVerdict !== 'anchored') reasons.push(`${why}: token must be anchored`);
    if (!candidate?.tier || !GATE.strictTiers.includes(candidate.tier)) reasons.push(`${why}: tier must be S or A`);
  }

  return { reasons, ...(rr !== undefined ? { rr } : {}) };
}

/** Gates a run's proposals in order, applying the per-run and open-setup caps. */
export function gateProposals(
  proposals: readonly SetupProposal[],
  candidates: ReadonlyMap<string, GateCandidate>,
  context: GateContext,
): GateVerdict[] {
  const verdicts: GateVerdict[] = [];
  const openTokens = new Set(context.openTokenIds);
  let open = context.openTokenIds.length;
  let accepted = 0;

  for (const proposal of proposals) {
    const { reasons, rr } = checkProposal(proposal, candidates.get(proposal.token_id), context);
    if (openTokens.has(proposal.token_id)) reasons.push('one setup per token: this token already has an open setup');
    if (accepted >= GATE.maxNewPerRun) reasons.push(`at most ${GATE.maxNewPerRun} new setups per run`);
    if (open >= GATE.maxOpen) reasons.push(`at most ${GATE.maxOpen} open setups`);
    const ok = reasons.length === 0;
    if (ok) {
      accepted += 1;
      open += 1;
      openTokens.add(proposal.token_id);
    }
    verdicts.push({ proposal, accepted: ok, reasons, ...(rr !== undefined ? { rr } : {}) });
  }
  return verdicts;
}
