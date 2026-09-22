/**
 * Concentration maths. Pure, synchronous, no I/O — everything here is a
 * function of a `HolderRow[]` plus an optional total supply.
 *
 * ## The sampling caveat, stated once and enforced everywhere below
 *
 * Free RPCs hand out the top N token accounts (Solana: 20) or a bounded window
 * of `Transfer` logs (EVM). That is a **sample of the largest holders**, not the
 * holder population. Three consequences are baked into this module:
 *
 *  - `topNPct` is only returned when the sample actually contains N included
 *    holders, or when the caller states the set is complete. Summing 20 rows
 *    and calling it "top 50" would understate concentration and read as fact.
 *  - `herfindahl` is computed over share-of-basis, so a partial sample yields a
 *    strict **lower bound** on the population HHI (unsampled holders can only
 *    add positive squares).
 *  - `gini` is computed over the sampled rows alone and is therefore **biased
 *    low** in an almost useless way: the top 20 holders of a token look
 *    relatively equal to each other even when they own everything. It is
 *    reported because it is asked for, always with the caveat attached.
 *
 * ## Basis
 *
 * Concentration is measured against *non-excluded* supply: total supply minus
 * the balances of LP, burn and known-protocol addresses. Measuring against raw
 * total supply would make a token with 95% of its float in a pool look
 * beautifully distributed. `basisIsSupply: false` means even that denominator
 * is a guess (the sampled sum), which weakens every number in the result.
 */

import type { HolderRow } from '@provenance/core';

export interface ConcentrationInput {
  rows: readonly HolderRow[];
  /** Total supply in UI units (not raw base units). Omit when unknown. */
  totalSupply?: number;
  /** True when `rows` is a top-N sample rather than every holder. */
  sampled: boolean;
}

export interface ConcentrationResult {
  top10Pct?: number;
  top20Pct?: number;
  top50Pct?: number;
  /** Sum of squared shares of the basis, 0..1. Lower bound when sampled. */
  herfindahl?: number;
  /** Gini over the sampled rows only, 0..1. See the module caveat. */
  gini?: number;
  /** Largest single non-excluded holder as a percentage of the basis. */
  largestHolderPct?: number;
  /** Denominator used for every percentage above, in UI units. */
  basis: number;
  /** False when the basis is the sampled sum rather than real supply. */
  basisIsSupply: boolean;
  includedCount: number;
  excludedCount: number;
  /** Share of the basis the sampled rows actually account for, 0..100. */
  coveragePct: number;
  sampled: boolean;
  /** Human-readable limitations, meant to be copied into `ChainAnalysis.notes`. */
  caveats: string[];
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function isExcluded(row: HolderRow): boolean {
  return row.excludedFromConcentration === true;
}

/** Non-excluded rows, largest balance first. */
export function includedRows(rows: readonly HolderRow[]): HolderRow[] {
  return rows.filter((row) => !isExcluded(row)).sort((a, b) => b.balance - a.balance);
}

/**
 * Herfindahl-Hirschman index over shares expressed as fractions of the basis.
 * Shares need not sum to 1; when they do not, the result is a lower bound.
 * Empty input is 0 (no concentration measurable), a lone 100% holder is 1.
 */
export function herfindahl(shares: readonly number[]): number {
  let total = 0;
  for (const share of shares) {
    if (!Number.isFinite(share) || share <= 0) continue;
    total += share * share;
  }
  return total;
}

/**
 * Gini coefficient of a value set, 0 (all equal) .. 1 (one holder has it all,
 * in the limit). Uses the standard order-statistic form
 * `G = 2·Σ(i·x_i)/(n·Σx) − (n+1)/n` over ascending `x`.
 *
 * Edge cases worth knowing: an empty set and a *single* observation both return
 * 0, because within a one-element population there is perfect equality. That is
 * mathematically correct and analytically misleading — precisely why the
 * sampled Gini is always shipped with a caveat.
 */
export function gini(values: readonly number[]): number {
  const clean = values.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  const n = clean.length;
  if (n === 0) return 0;
  const sum = clean.reduce((acc, value) => acc + value, 0);
  if (sum <= 0) return 0;
  let weighted = 0;
  for (let i = 0; i < n; i++) weighted += (i + 1) * (clean[i] as number);
  return Math.max(0, Math.min(1, (2 * weighted) / (n * sum) - (n + 1) / n));
}

/**
 * Sum of the `n` largest included balances as a percentage of `basis`, or
 * undefined when the sample is too small for the claim to be honest.
 */
export function topNPct(sorted: readonly HolderRow[], n: number, basis: number, sampled: boolean): number | undefined {
  if (basis <= 0 || sorted.length === 0) return undefined;
  if (sampled && sorted.length < n) return undefined;
  const slice = sorted.slice(0, n);
  const total = slice.reduce((acc, row) => acc + row.balance, 0);
  return round(Math.max(0, Math.min(100, (total / basis) * 100)), 4);
}

export function concentration(input: ConcentrationInput): ConcentrationResult {
  const caveats: string[] = [];
  const included = includedRows(input.rows);
  const excluded = input.rows.filter(isExcluded);
  const excludedBalance = excluded.reduce((acc, row) => acc + row.balance, 0);
  const includedBalance = included.reduce((acc, row) => acc + row.balance, 0);

  let basis = 0;
  let basisIsSupply = false;
  if (input.totalSupply !== undefined && Number.isFinite(input.totalSupply) && input.totalSupply > 0) {
    const candidate = input.totalSupply - excludedBalance;
    if (candidate > 0) {
      basis = candidate;
      basisIsSupply = true;
    }
  }
  if (!basisIsSupply) {
    basis = includedBalance;
    caveats.push(
      'Concentration basis is the sampled holder balance, not circulating supply; percentages are relative to the sample only.',
    );
  }

  const result: ConcentrationResult = {
    basis,
    basisIsSupply,
    includedCount: included.length,
    excludedCount: excluded.length,
    coveragePct: basis > 0 ? round(Math.min(100, (includedBalance / basis) * 100), 4) : 0,
    sampled: input.sampled,
    caveats,
  };

  if (included.length === 0 || basis <= 0) {
    caveats.push('No non-excluded holders were resolved, so no concentration metrics were computed.');
    return result;
  }

  result.top10Pct = topNPct(included, 10, basis, input.sampled);
  result.top20Pct = topNPct(included, 20, basis, input.sampled);
  result.top50Pct = topNPct(included, 50, basis, input.sampled);
  result.largestHolderPct = round(Math.min(100, ((included[0] as HolderRow).balance / basis) * 100), 4);

  const shares = included.map((row) => row.balance / basis);
  result.herfindahl = round(Math.min(1, herfindahl(shares)), 6);
  result.gini = round(gini(included.map((row) => row.balance)), 6);

  if (input.sampled) {
    caveats.push(
      `Holder metrics are computed over a sample of the ${included.length} largest non-excluded holders ` +
        `(covering ${result.coveragePct}% of non-excluded supply), not the full holder set. ` +
        'Herfindahl is therefore a lower bound and Gini is biased low; neither is a population statistic.',
    );
    if (result.top50Pct === undefined && included.length < 50) {
      caveats.push(`top50Pct not reported: only ${included.length} holders were sampled.`);
    } else if (result.top20Pct === undefined && included.length < 20) {
      caveats.push(`top20Pct not reported: only ${included.length} holders were sampled.`);
    }
  }
  if (excluded.length > 0) {
    caveats.push(
      `${excluded.length} address(es) excluded from concentration (liquidity pools, burn addresses, known protocol accounts).`,
    );
  }

  return result;
}

/**
 * Recomputes `HolderRow.pct` as a share of total supply. Rows always report
 * their share of *total* supply so the table reads honestly on its own; the
 * concentration numbers above use the ex-LP basis instead.
 */
export function withSupplyPct(rows: readonly HolderRow[], totalSupply: number): HolderRow[] {
  if (!Number.isFinite(totalSupply) || totalSupply <= 0) return [...rows];
  return rows.map((row) => ({ ...row, pct: round((row.balance / totalSupply) * 100, 6) }));
}
