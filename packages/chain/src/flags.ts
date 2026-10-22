/**
 * Risk flags derived from a finished on-chain analysis. Pure and side-effect
 * free so every threshold can be pinned by a boundary test.
 *
 * Codes are a stable API: the store persists them, alert rules match on them
 * and the dashboard renders them. Rename one and you break history.
 */

import type { ChainAnalysis, MarketMetrics, PrivilegedFunction, RiskFlag, RiskSeverity } from '@provenance/core';

/**
 * Every tunable number in one place. Percentages are 0-100, matching the repo
 * convention. Comparisons are documented per flag below and pinned by tests at
 * the exact boundary value.
 */
export const RISK_THRESHOLDS = {
  /** `top10-concentration-high` fires at warn when top10Pct >= this. */
  top10WarnPct: 50,
  /** ...and escalates to critical when top10Pct >= this. */
  top10CriticalPct: 80,
  /** `single-holder-dominant` fires when one non-excluded holder exceeds this. */
  singleHolderCriticalPct: 30,
  /** `creator-holds-large` fires when the creator/authority holds >= this. */
  creatorWarnPct: 5,
  /** `lp-not-burned` fires when burned (or locked) LP is below this. */
  lpBurnedMinPct: 50,
  /** `low-liquidity-ratio` fires when liquidity / market cap is below this. */
  lowLiquidityRatioPct: 2,
  /** `sniped-launch` fires at warn when early-block buying took >= this share of supply. */
  snipedWarnPct: 15,
  /** ...and escalates to critical at >= this. */
  snipedCriticalPct: 30,
  /** `bundled-launch` fires when at least this many wallets bought in the opening block. */
  bundledMinBuyers: 3,
  /** `funded-cluster` fires at warn when early buyers sharing a funder bought >= this share of supply. */
  fundedClusterWarnPct: 10,
  /** ...and escalates to critical at >= this. */
  fundedClusterCriticalPct: 25,
} as const;

export type RiskThresholds = typeof RISK_THRESHOLDS;

/** The subset of a `ChainAnalysis` the rules read. */
export type FlagAnalysis = Pick<
  ChainAnalysis,
  | 'method'
  | 'mintAuthorityActive'
  | 'freezeAuthorityActive'
  | 'ownerRenounced'
  | 'top10Pct'
  | 'holderCount'
  | 'creatorAddress'
  | 'creatorHoldingPct'
  | 'lpBurnedPct'
  | 'lpLockedPct'
  | 'contractVerified'
  | 'privilegedFunctions'
  | 'sniping'
  | 'funding'
>;

/**
 * Severity of each `privileged-<kind>` flag while an owner may still call it.
 * Mint, blacklist and pause can each trap or dilute holders outright; fee and
 * max-tx setters are usually bounded nuisances until proven otherwise.
 */
export const PRIVILEGED_SEVERITY: Readonly<Record<PrivilegedFunction, RiskSeverity>> = {
  mint: 'critical',
  blacklist: 'critical',
  pause: 'critical',
  fee: 'warn',
  'max-tx': 'warn',
};

const PRIVILEGED_DESCRIPTION: Readonly<Record<PrivilegedFunction, string>> = {
  mint: 'a mint function (supply can be inflated)',
  blacklist: 'a blacklist/bot-list function (holders can be blocked from selling)',
  pause: 'a pause function (transfers can be halted)',
  fee: 'a fee/tax setter (sell tax can be raised)',
  'max-tx': 'a max-transaction/max-wallet setter (sells can be capped)',
};

export interface FlagInput {
  analysis: FlagAnalysis;
  /**
   * Largest single non-excluded holder as a percentage of the concentration
   * basis. Passed separately because `HolderRow.pct` is a share of *total*
   * supply, which is a different denominator.
   */
  largestHolderPct?: number;
  /** Market side, used only by `low-liquidity-ratio`. */
  metrics?: MarketMetrics;
  thresholds?: RiskThresholds;
}

const SEVERITY_ORDER: Record<RiskSeverity, number> = { critical: 0, warn: 1, info: 2 };

function pct(value: number): string {
  return `${value.toFixed(2)}%`;
}

/**
 * Evaluates every rule. Rules only fire on evidence: an undefined field means
 * "not determined" and never produces a reassuring absence of a flag, which is
 * why `holder-count-unknown` and `analysis-partial` exist as explicit info
 * flags rather than being left silent.
 */
export function evaluateFlags(input: FlagInput): RiskFlag[] {
  const t = input.thresholds ?? RISK_THRESHOLDS;
  const a = input.analysis;
  const flags: RiskFlag[] = [];

  // Solana: the mint authority can print unlimited new supply at will.
  if (a.mintAuthorityActive === true) {
    flags.push({
      code: 'mint-authority-active',
      severity: 'critical',
      detail: 'Mint authority is still set: supply can be inflated arbitrarily at any time.',
    });
  }

  // Solana: the freeze authority can freeze any holder's token account, which
  // is a complete honeypot primitive.
  if (a.freezeAuthorityActive === true) {
    flags.push({
      code: 'freeze-authority-active',
      severity: 'critical',
      detail: 'Freeze authority is still set: holder accounts can be frozen, blocking sells.',
    });
  }

  // EVM: `owner()` returned a non-zero address. Undefined means the contract has
  // no owner function at all, which is not the same thing and is not flagged.
  if (a.ownerRenounced === false) {
    flags.push({
      code: 'owner-not-renounced',
      severity: 'warn',
      detail: 'Contract ownership is not renounced; privileged functions remain callable.',
    });
  }

  // Bytecode-detected privileged entry points. Renounced ownership downgrades
  // to info rather than silencing: `owner()` being zero neutralises Ownable
  // gates but not role-based ones, and the reader should still see the finding.
  for (const kind of new Set(a.privilegedFunctions ?? [])) {
    const renounced = a.ownerRenounced === true;
    flags.push({
      code: `privileged-${kind}`,
      severity: renounced ? 'info' : PRIVILEGED_SEVERITY[kind],
      detail: renounced
        ? `Bytecode exposes ${PRIVILEGED_DESCRIPTION[kind]}; ownership is renounced, so it is inert if owner-gated.`
        : `Bytecode exposes ${PRIVILEGED_DESCRIPTION[kind]} and ownership is ${
            a.ownerRenounced === false ? 'not renounced' : 'undetermined'
          }.`,
    });
  }

  // Only an explicit "not verified" answer; undefined means nobody asked.
  if (a.contractVerified === false) {
    flags.push({
      code: 'contract-unverified',
      severity: 'warn',
      detail: 'Contract source is not verified on the explorer; its logic cannot be reviewed.',
    });
  }

  // Concentration after LP/burn/protocol exclusion. >= 50% warn, >= 80% critical.
  if (a.top10Pct !== undefined) {
    if (a.top10Pct >= t.top10CriticalPct) {
      flags.push({
        code: 'top10-concentration-high',
        severity: 'critical',
        detail: `Top 10 non-LP holders control ${pct(a.top10Pct)} of non-excluded supply (>= ${t.top10CriticalPct}%).`,
      });
    } else if (a.top10Pct >= t.top10WarnPct) {
      flags.push({
        code: 'top10-concentration-high',
        severity: 'warn',
        detail: `Top 10 non-LP holders control ${pct(a.top10Pct)} of non-excluded supply (>= ${t.top10WarnPct}%).`,
      });
    }
  }

  // A single wallet that can singlehandedly round-trip the float. Strictly
  // greater than the threshold, per the rule as specified.
  if (input.largestHolderPct !== undefined && input.largestHolderPct > t.singleHolderCriticalPct) {
    flags.push({
      code: 'single-holder-dominant',
      severity: 'critical',
      detail: `One non-LP address holds ${pct(input.largestHolderPct)} of non-excluded supply (> ${t.singleHolderCriticalPct}%).`,
    });
  }

  // Only fires when LP burn was actually measured. Locked LP counts as burned
  // for this purpose, since both remove the rug primitive.
  if (a.lpBurnedPct !== undefined) {
    const secured = Math.max(a.lpBurnedPct, a.lpLockedPct ?? 0);
    if (secured < t.lpBurnedMinPct) {
      flags.push({
        code: 'lp-not-burned',
        severity: 'warn',
        detail: `Only ${pct(secured)} of LP tokens are burned or locked (< ${t.lpBurnedMinPct}%); liquidity can be pulled.`,
      });
    }
  }

  // Thin liquidity relative to the cap it supports: exit slippage is the risk.
  const cap = input.metrics?.marketCapUsd ?? input.metrics?.fdvUsd;
  const liquidity = input.metrics?.liquidityUsd;
  if (cap !== undefined && liquidity !== undefined && cap > 0 && Number.isFinite(liquidity)) {
    const ratioPct = (liquidity / cap) * 100;
    if (ratioPct < t.lowLiquidityRatioPct) {
      flags.push({
        code: 'low-liquidity-ratio',
        severity: 'warn',
        detail: `Liquidity is ${pct(ratioPct)} of market cap (< ${t.lowLiquidityRatioPct}%); the book cannot absorb the float.`,
      });
    }
  }

  // Creator/authority stack. On Solana this address is the mint authority used
  // as a creator proxy, which the analyser records in its notes.
  if (a.creatorHoldingPct !== undefined && a.creatorHoldingPct >= t.creatorWarnPct) {
    flags.push({
      code: 'creator-holds-large',
      severity: 'warn',
      detail: `Creator/authority address holds ${pct(a.creatorHoldingPct)} of supply (>= ${t.creatorWarnPct}%).`,
    });
  }

  // Supply taken in the first blocks of trading, before anyone outside the
  // launch could see the pool. Spread across wallets, it evades top-10.
  const snipe = a.sniping;
  if (snipe !== undefined && snipe.earlyBuyPct >= t.snipedWarnPct) {
    const held = snipe.stillHeldPct !== undefined ? `; they still hold ${pct(snipe.stillHeldPct)}` : '';
    const critical = snipe.earlyBuyPct >= t.snipedCriticalPct;
    flags.push({
      code: 'sniped-launch',
      severity: critical ? 'critical' : 'warn',
      detail: `${snipe.earlyBuyers} wallet(s) bought ${pct(snipe.earlyBuyPct)} of supply in the first ${snipe.windowBlocks} block(s) of trading (>= ${critical ? t.snipedCriticalPct : t.snipedWarnPct}%)${held}.`,
    });
  }
  if (snipe !== undefined && snipe.sameBlockBuyers >= t.bundledMinBuyers) {
    flags.push({
      code: 'bundled-launch',
      severity: 'warn',
      detail: `${snipe.sameBlockBuyers} wallets bought in the block trading opened (>= ${t.bundledMinBuyers}): a bundle, or bots watching the deploy.`,
    });
  }

  // The same cabal, caught by who paid for the wallets rather than when they
  // bought: fresh wallets funded from one source over the first half hour.
  const funding = a.funding;
  if (funding !== undefined && funding.clusteredPct >= t.fundedClusterWarnPct) {
    const top = funding.clusters[0];
    const critical = funding.clusteredPct >= t.fundedClusterCriticalPct;
    const wallets = funding.clusters.reduce((sum, c) => sum + c.wallets, 0);
    flags.push({
      code: 'funded-cluster',
      severity: critical ? 'critical' : 'warn',
      detail:
        `${wallets} early buyer(s) in ${funding.clusters.length} funding cluster(s) bought ${pct(funding.clusteredPct)} of supply ` +
        `(>= ${critical ? t.fundedClusterCriticalPct : t.fundedClusterWarnPct}%)` +
        (top ? `; largest: ${top.wallets} wallets funded by ${top.funder}` : '') +
        '.',
    });
  }

  // Not a risk in itself — a statement that a headline number is missing, so a
  // downstream score does not treat "unknown" as "fine".
  if (a.holderCount === undefined) {
    flags.push({
      code: 'holder-count-unknown',
      severity: 'info',
      detail: 'Total holder count could not be determined from free RPC endpoints.',
    });
  }

  if (a.method === 'partial' || a.method === 'unavailable') {
    flags.push({
      code: 'analysis-partial',
      severity: 'info',
      detail:
        a.method === 'unavailable'
          ? 'On-chain analysis was unavailable; no chain data informed this token.'
          : 'On-chain analysis is partial; some queries were bounded or failed.',
    });
  }

  return flags.sort(
    (a1, b1) => SEVERITY_ORDER[a1.severity] - SEVERITY_ORDER[b1.severity] || a1.code.localeCompare(b1.code),
  );
}
