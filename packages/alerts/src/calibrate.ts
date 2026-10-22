/**
 * Calibration: fit the score to outcomes instead of to belief.
 *
 * Every number in scoring.ts was set by hand. This module takes labelled
 * scores (`CalibrationRow`: the components a token was scored with, the report
 * behind them, and whether its pool survived the horizon, see
 * docs/calibration.md) and reports what the labels say:
 *
 *  - which component, on its own, separates survivors from the rest (AUC);
 *  - what a joint logistic fit would weigh them at, as a suggested
 *    `SCORE_WEIGHTS`;
 *  - whether `manufactured` tokens actually survive less than `organic` ones,
 *    which is what the manufactured penalty claims;
 *  - how survival moves with recycle generation (generation decay), as a
 *    suggested `GENERATION_BONUS`.
 *
 * Pure and deterministic: no I/O, no randomness, no dependencies, so the same
 * rows always give the same report. It only ever suggests. Applying a
 * suggestion is a person setting an env var.
 */

import type { CalibrationRow, OrganicVerdict, ScoreComponents, ScoreTier } from '@provenance/core';
import {
  assertWeights,
  DEFAULT_GENERATION_BONUS,
  DEFAULT_WEIGHTS,
  generationBucket,
  MAX_GENERATION_BONUS,
  type ScoreWeights,
} from './scoring';

export const COMPONENT_KEYS: readonly (keyof ScoreComponents)[] = [
  'recycling',
  'memetic',
  'distribution',
  'liquidity',
  'momentum',
  'authenticity',
];

export const GENERATION_LABELS = ['0', '1', '2', '3', '4+'] as const;

/** Distinct tokens. Below either, a fit says more about the sample than about the score. */
export const DEFAULT_MIN_ROWS = 200;
export const DEFAULT_MIN_PER_CLASS = 30;
/**
 * A generation bucket needs this many tokens before its rate may move the
 * bonus table. At 100 a bucket's 95% interval is still about ±10 points wide,
 * so anything thinner cannot tell a real decay from a run of luck.
 */
export const MIN_GENERATION_BUCKET = 100;
/**
 * Bonus points per unit of survival-rate difference from the overall rate: a
 * bucket surviving 10 points better than average earns 2.5 more. Absolute,
 * not min-max: rescaling the spread to 0..10 turns any noise into the full
 * range, while a fixed slope keeps a small effect small.
 */
export const GENERATION_BONUS_SLOPE = 25;
/** z for the Wilson 95% interval. */
const Z95 = 1.96;
/** A meme's generation point needs this many labels to count toward its curve. */
export const MIN_MEME_BUCKET = 5;
/** And a meme needs this many such points to have a curve at all. */
export const MIN_MEME_GENERATIONS = 3;

/** L2 strength on the mean log-loss. Enough to keep collinear components finite, small enough not to flatten them. */
const L2 = 0.01;
const LEARNING_RATE = 0.5;
const ITERATIONS = 3000;

export interface CalibrationOptions {
  minRows?: number;
  minPerClass?: number;
  /** What the score uses today; shown beside the suggestion. Defaults to `DEFAULT_WEIGHTS`. */
  currentWeights?: ScoreWeights;
  /** Defaults to `DEFAULT_GENERATION_BONUS`. */
  currentGenerationBonus?: readonly number[];
  horizonHours?: number;
}

export interface RateCell {
  key: string;
  n: number;
  survived: number;
  /** survived / n. */
  rate: number;
}

export interface GenerationCell {
  generation: (typeof GENERATION_LABELS)[number];
  n: number;
  survived: number;
  /** Laplace-smoothed: (survived + 1) / (n + 2), so an empty bucket reads 0.5, not 0 or NaN. */
  rate: number;
}

export interface ComponentFit {
  component: keyof ScoreComponents;
  /** Set when the component cannot be fitted, e.g. every token has the same value. */
  note?: string;
  /** Univariate logistic coefficient per standard deviation of the component. */
  coefPerSd: number;
  /** P(a survivor's value > a non-survivor's). 0.5 is no signal; below 0.5 the component points the wrong way. */
  auc: number;
  mean: number;
  sd: number;
}

export interface MemeCurve {
  meme: string;
  n: number;
  points: { generation: GenerationCell['generation']; n: number; rate: number; multiplier: number }[];
}

/**
 * The generation-bonus suggestion. `no-signal` when fewer than two buckets
 * have enough tokens, or the best and worst buckets' 95% intervals overlap.
 */
export interface GenerationSuggestion {
  status: 'ok' | 'no-signal';
  reason?: string;
  table?: number[];
  /** Per generation: true where the bucket was too thin and the current value was kept, not fitted. */
  kept?: boolean[];
}

export interface CalibrationReport {
  status: 'ok' | 'insufficient';
  horizonHours?: number;
  /** Labelled rows read (token-days). */
  rows: number;
  /** Distinct tokens: the unit of everything below, one row each (its earliest labelled score). */
  tokens: number;
  survived: number;
  failed: number;
  baseRate: number;
  gate: { minRows: number; minPerClass: number };
  /** Why nothing is suggested, when nothing is. */
  notes: string[];
  /** Sorted by AUC, strongest first. Empty when insufficient. */
  components: ComponentFit[];
  weights: {
    current: ScoreWeights;
    /** Joint fit, raw-scale coefficients (per component point). */
    jointCoef?: Record<keyof ScoreComponents, number>;
    suggested?: ScoreWeights;
  };
  byOrganic: RateCell[];
  byTier: RateCell[];
  generation: {
    overall: GenerationCell[];
    organic: GenerationCell[];
    manufactured: GenerationCell[];
    /** Rows with no report, so no generation. */
    unknown: number;
    current: number[];
    suggestion: GenerationSuggestion;
    memes: MemeCurve[];
  };
}

// ---------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length;
}

function sd(values: readonly number[], m = mean(values)): number {
  if (values.length < 2) return 0;
  return Math.sqrt(values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1));
}

function sigmoid(z: number): number {
  return z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
}

/**
 * Area under the ROC curve via the Mann-Whitney rank statistic, ties given
 * their average rank. 0.5 when either class is empty.
 */
export function auc(values: readonly number[], labels: readonly boolean[]): number {
  const order = values.map((value, i) => ({ value, positive: labels[i] === true })).sort((a, b) => a.value - b.value);
  const positives = order.filter((row) => row.positive).length;
  const negatives = order.length - positives;
  if (positives === 0 || negatives === 0) return 0.5;
  let rankSum = 0;
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.value === order[i]!.value) j += 1;
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) if (order[k]!.positive) rankSum += averageRank;
    i = j + 1;
  }
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/**
 * L2-regularised logistic regression by plain batch gradient descent, from a
 * fixed start (zeros, intercept at the base rate's logit), so it is
 * deterministic. Features are expected standardised; the intercept is not
 * penalised. Returns [intercept, ...coefficients].
 */
export function fitLogistic(features: readonly (readonly number[])[], labels: readonly boolean[]): number[] {
  const n = features.length;
  const k = features[0]?.length ?? 0;
  const rate = Math.min(1 - 1e-6, Math.max(1e-6, labels.filter(Boolean).length / Math.max(1, n)));
  const w = [Math.log(rate / (1 - rate)), ...new Array<number>(k).fill(0)];
  if (n === 0) return w;
  for (let iter = 0; iter < ITERATIONS; iter += 1) {
    const grad = new Array<number>(k + 1).fill(0);
    for (let i = 0; i < n; i += 1) {
      const x = features[i]!;
      let z = w[0]!;
      for (let j = 0; j < k; j += 1) z += w[j + 1]! * x[j]!;
      const err = sigmoid(z) - (labels[i] ? 1 : 0);
      grad[0]! += err;
      for (let j = 0; j < k; j += 1) grad[j + 1]! += err * x[j]!;
    }
    w[0] = w[0]! - (LEARNING_RATE * grad[0]!) / n;
    for (let j = 1; j <= k; j += 1) w[j] = w[j]! - LEARNING_RATE * (grad[j]! / n + L2 * w[j]!);
  }
  return w;
}

/**
 * Non-negative coefficients normalised to a weight vector, rounded to 0.01
 * and re-normalised in whole hundredths so `assertWeights` passes. The
 * rounding residual goes to the largest weight. Undefined when no component
 * carries positive signal: there is nothing to normalise.
 */
export function suggestWeights(coef: Record<keyof ScoreComponents, number>): ScoreWeights | undefined {
  const positive = COMPONENT_KEYS.map((key) => Math.max(0, Number.isFinite(coef[key]) ? coef[key] : 0));
  const total = positive.reduce((sum, v) => sum + v, 0);
  if (total <= 0) return undefined;
  const cents = positive.map((v) => Math.round((v / total) * 100));
  const residual = 100 - cents.reduce((sum, v) => sum + v, 0);
  let largest = 0;
  for (let i = 1; i < cents.length; i += 1) if (cents[i]! > cents[largest]!) largest = i;
  cents[largest] = cents[largest]! + residual;
  const weights = Object.fromEntries(COMPONENT_KEYS.map((key, i) => [key, cents[i]! / 100])) as ScoreWeights;
  assertWeights(weights);
  return weights;
}

// ---------------------------------------------------------------------------
// tables
// ---------------------------------------------------------------------------

function rateTable(rows: readonly CalibrationRow[], keyOf: (row: CalibrationRow) => string, order: readonly string[]): RateCell[] {
  const cells = new Map<string, { n: number; survived: number }>();
  for (const row of rows) {
    const key = keyOf(row);
    const cell = cells.get(key) ?? { n: 0, survived: 0 };
    cell.n += 1;
    if (row.survived) cell.survived += 1;
    cells.set(key, cell);
  }
  const keys = [...order.filter((key) => cells.has(key)), ...[...cells.keys()].filter((key) => !order.includes(key)).sort()];
  return keys.map((key) => {
    const cell = cells.get(key)!;
    return { key, n: cell.n, survived: cell.survived, rate: cell.survived / cell.n };
  });
}

/** Survival per generation bucket 0, 1, 2, 3, 4+, Laplace-smoothed. Rows without a generation are skipped. */
export function generationTable(rows: readonly CalibrationRow[]): GenerationCell[] {
  const counts = GENERATION_LABELS.map(() => ({ n: 0, survived: 0 }));
  for (const row of rows) {
    if (row.recycleGeneration === undefined) continue;
    const cell = counts[generationBucket(row.recycleGeneration)]!;
    cell.n += 1;
    if (row.survived) cell.survived += 1;
  }
  return counts.map((cell, i) => ({
    generation: GENERATION_LABELS[i]!,
    n: cell.n,
    survived: cell.survived,
    rate: (cell.survived + 1) / (cell.n + 2),
  }));
}

/** Wilson score interval for `survived` of `n`, at 95%. */
export function wilson(survived: number, n: number): [number, number] {
  if (n <= 0) return [0, 1];
  const p = survived / n;
  const z2 = Z95 * Z95;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * A bonus table from survival by generation, or `no-signal`.
 *
 * Only buckets with `minBucket`+ tokens are fitted, and only when the best
 * and worst of them are distinguishable (their Wilson 95% intervals do not
 * overlap). A fitted bucket moves from its current bonus by
 * `GENERATION_BONUS_SLOPE x (rate - overall rate)`, clamped to 0..15, so the
 * table keeps its scale and a small effect stays small. Thinner buckets keep
 * their current value and are marked `kept`. Raw rates here, not smoothed:
 * at 100+ tokens the smoothing is noise, and the intervals need the raw count.
 */
export function suggestGenerationBonus(
  cells: readonly GenerationCell[],
  current: readonly number[] = DEFAULT_GENERATION_BONUS,
  minBucket = MIN_GENERATION_BUCKET,
): GenerationSuggestion {
  const eligible = cells.filter((cell) => cell.n >= minBucket);
  if (eligible.length < 2) {
    return { status: 'no-signal', reason: `fewer than two generation buckets with ${minBucket}+ tokens` };
  }
  const raw = (cell: GenerationCell): number => cell.survived / cell.n;
  const sorted = [...eligible].sort((a, b) => raw(a) - raw(b));
  const lo = sorted[0]!;
  const hi = sorted[sorted.length - 1]!;
  const [hiLower] = wilson(hi.survived, hi.n);
  const [, loUpper] = wilson(lo.survived, lo.n);
  if (hiLower <= loUpper) {
    return {
      status: 'no-signal',
      reason: `best (gen ${hi.generation}, ${hi.survived}/${hi.n}) and worst (gen ${lo.generation}, ${lo.survived}/${lo.n}) buckets overlap at 95%`,
    };
  }
  const totalN = cells.reduce((sum, cell) => sum + cell.n, 0);
  const overall = cells.reduce((sum, cell) => sum + cell.survived, 0) / totalN;
  const kept = cells.map((cell) => cell.n < minBucket);
  const table = cells.map((cell, i) =>
    kept[i]
      ? (current[i] ?? 0)
      : Math.min(MAX_GENERATION_BONUS, Math.max(0, Math.round((current[i] ?? 0) + GENERATION_BONUS_SLOPE * (raw(cell) - overall)))),
  );
  return { status: 'ok', table, kept };
}

/** One row per token: its earliest labelled score, so a token that trended ten days counts once. */
export function onePerToken(rows: readonly CalibrationRow[]): CalibrationRow[] {
  const first = new Map<string, CalibrationRow>();
  for (const row of rows) {
    const held = first.get(row.tokenId);
    if (!held || row.scoredAt < held.scoredAt) first.set(row.tokenId, row);
  }
  return [...first.values()].sort((a, b) => (a.scoredAt < b.scoredAt ? -1 : a.scoredAt > b.scoredAt ? 1 : a.tokenId.localeCompare(b.tokenId)));
}

/**
 * Per-meme generation curves, for memes with at least `MIN_MEME_GENERATIONS`
 * generations of `MIN_MEME_BUCKET`+ labels. The multiplier is the meme's
 * smoothed rate over the overall smoothed rate at the same generation:
 * above 1, this meme decays slower than memes in general. Reported only; the
 * score does not read it.
 */
export function memeCurves(rows: readonly CalibrationRow[], overall: readonly GenerationCell[]): MemeCurve[] {
  const byMeme = new Map<string, CalibrationRow[]>();
  for (const row of rows) {
    if (!row.meme || row.recycleGeneration === undefined) continue;
    const list = byMeme.get(row.meme) ?? [];
    list.push(row);
    byMeme.set(row.meme, list);
  }
  const curves: MemeCurve[] = [];
  for (const [meme, memeRows] of byMeme) {
    const points = generationTable(memeRows)
      .map((cell, i) => ({ cell, overall: overall[i]! }))
      .filter(({ cell }) => cell.n >= MIN_MEME_BUCKET)
      .map(({ cell, overall: base }) => ({
        generation: cell.generation,
        n: cell.n,
        rate: cell.rate,
        multiplier: cell.rate / base.rate,
      }));
    if (points.length >= MIN_MEME_GENERATIONS) curves.push({ meme, n: memeRows.length, points });
  }
  return curves.sort((a, b) => b.n - a.n || a.meme.localeCompare(b.meme));
}

// ---------------------------------------------------------------------------
// the report
// ---------------------------------------------------------------------------

const ORGANIC_ORDER: readonly string[] = ['organic', 'mixed', 'manufactured', 'unclear', 'unread'];
const TIER_ORDER: readonly ScoreTier[] = ['S', 'A', 'B', 'C', 'D'];

function organicKey(verdict: OrganicVerdict | undefined): string {
  return verdict ?? 'unread';
}

/**
 * Every table, the gate and the fits count distinct tokens: a token labelled
 * on ten days is one outcome observed ten times, not ten outcomes, and would
 * otherwise weigh the fit toward whatever trends longest.
 */
export function calibrate(labelled: readonly CalibrationRow[], options: CalibrationOptions = {}): CalibrationReport {
  const minRows = options.minRows ?? DEFAULT_MIN_ROWS;
  const minPerClass = options.minPerClass ?? DEFAULT_MIN_PER_CLASS;
  const currentWeights = options.currentWeights ?? DEFAULT_WEIGHTS;
  const currentBonus = [...(options.currentGenerationBonus ?? DEFAULT_GENERATION_BONUS)];

  const rows = onePerToken(labelled);
  const n = rows.length;
  const survived = rows.filter((row) => row.survived).length;
  const failed = n - survived;
  const notes: string[] = [];

  const overall = generationTable(rows);
  const report: CalibrationReport = {
    status: 'insufficient',
    ...(options.horizonHours !== undefined ? { horizonHours: options.horizonHours } : {}),
    rows: labelled.length,
    tokens: n,
    survived,
    failed,
    baseRate: n > 0 ? survived / n : 0,
    gate: { minRows, minPerClass },
    notes,
    components: [],
    weights: { current: { ...currentWeights } },
    byOrganic: rateTable(rows, (row) => organicKey(row.organicVerdict), ORGANIC_ORDER),
    byTier: rateTable(rows, (row) => row.tier, TIER_ORDER),
    generation: {
      overall,
      organic: generationTable(rows.filter((row) => row.organicVerdict === 'organic')),
      manufactured: generationTable(rows.filter((row) => row.organicVerdict === 'manufactured')),
      unknown: rows.filter((row) => row.recycleGeneration === undefined).length,
      current: currentBonus,
      suggestion: { status: 'no-signal', reason: 'below the gate' },
      memes: memeCurves(rows, overall),
    },
  };

  if (n < minRows || survived < minPerClass || failed < minPerClass) {
    notes.push(
      `insufficient: ${n} tokens (need ${minRows}), ${survived} survived and ${failed} did not (need ${minPerClass} each); nothing suggested`,
    );
    return report;
  }
  report.status = 'ok';

  const labels = rows.map((row) => row.survived);
  const stats = COMPONENT_KEYS.map((key) => {
    const values = rows.map((row) => (Number.isFinite(row.components[key]) ? row.components[key] : 0));
    const m = mean(values);
    return { key, values, mean: m, sd: sd(values, m) };
  });
  const standardised = (s: (typeof stats)[number], i: number): number => (s.sd > 0 ? (s.values[i]! - s.mean) / s.sd : 0);

  report.components = stats
    .map((s): ComponentFit => {
      if (s.sd <= 0) {
        return { component: s.key, coefPerSd: 0, auc: 0.5, mean: s.mean, sd: 0, note: 'not measured (no variance)' };
      }
      const coef = fitLogistic(rows.map((_, i) => [standardised(s, i)]), labels)[1] ?? 0;
      return { component: s.key, coefPerSd: coef, auc: auc(s.values, labels), mean: s.mean, sd: s.sd };
    })
    .sort((a, b) => b.auc - a.auc || a.component.localeCompare(b.component));
  for (const fit of report.components) {
    if (fit.note) notes.push(`${fit.component}: ${fit.note}; it gets no weight from the fit`);
  }

  // Joint fit on standardised components, then back to per-point
  // coefficients (beta / sd): the weights multiply raw 0-100 components, so a
  // weight has to be proportional to the effect of one point, not of one SD.
  const joint = fitLogistic(
    rows.map((_, i) => stats.map((s) => standardised(s, i))),
    labels,
  );
  const jointCoef = Object.fromEntries(
    stats.map((s, j) => [s.key, s.sd > 0 ? (joint[j + 1] ?? 0) / s.sd : 0]),
  ) as Record<keyof ScoreComponents, number>;
  report.weights.jointCoef = jointCoef;
  const suggested = suggestWeights(jointCoef);
  if (suggested) report.weights.suggested = suggested;
  else notes.push('no component carries positive signal in the joint fit; no weights suggested');

  report.generation.suggestion = suggestGenerationBonus(overall, currentBonus);
  if (report.generation.suggestion.reason) {
    notes.push(`no generation bonus suggested: ${report.generation.suggestion.reason}`);
  }

  return report;
}

// ---------------------------------------------------------------------------
// text
// ---------------------------------------------------------------------------

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;
const fixed = (v: number, digits = 2): string => (Number.isFinite(v) ? v.toFixed(digits) : 'n/a');

function rateLines(cells: readonly RateCell[]): string[] {
  return cells.map((cell) => `  ${cell.key.padEnd(13)} ${String(cell.n).padStart(5)}  ${pct(cell.rate).padStart(6)} survived`);
}

function generationLine(label: string, cells: readonly GenerationCell[]): string {
  return `  ${label.padEnd(13)} ${cells.map((c) => `${c.generation}: ${pct(c.rate)} (n ${c.n})`).join(' · ')}`;
}

/** The report as plain text, for the terminal. */
export function formatCalibration(report: CalibrationReport): string {
  const out: string[] = [];
  out.push(
    `calibration · ${report.status} · ${report.tokens} tokens (${report.rows} labelled rows)` +
      `${report.horizonHours !== undefined ? ` at ${report.horizonHours} h` : ''} · ` +
      `${report.survived} survived, ${report.failed} did not (base rate ${pct(report.baseRate)})`,
  );
  out.push(`gate: ${report.gate.minRows} tokens, ${report.gate.minPerClass} per class`);
  for (const note of report.notes) out.push(`note: ${note}`);

  if (report.components.length > 0) {
    out.push('', 'components, by AUC (univariate)');
    for (const fit of report.components) {
      out.push(
        fit.note
          ? `  ${fit.component.padEnd(13)} ${fit.note}`
          : `  ${fit.component.padEnd(13)} AUC ${fixed(fit.auc, 3)}  coef/sd ${fixed(fit.coefPerSd, 3).padStart(7)}  mean ${fixed(fit.mean, 1)} sd ${fixed(fit.sd, 1)}`,
      );
    }
  }

  out.push('', 'weights          current  suggested');
  for (const key of COMPONENT_KEYS) {
    const suggested = report.weights.suggested?.[key];
    out.push(`  ${key.padEnd(13)} ${report.weights.current[key].toFixed(2).padStart(8)}  ${suggested === undefined ? '—' : suggested.toFixed(2).padStart(9)}`);
  }
  if (report.weights.suggested) out.push(`  apply: SCORE_WEIGHTS='${JSON.stringify(report.weights.suggested)}'`);

  out.push('', 'survival by organic verdict');
  out.push(...rateLines(report.byOrganic));
  const organic = report.byOrganic.find((cell) => cell.key === 'organic');
  const manufactured = report.byOrganic.find((cell) => cell.key === 'manufactured');
  if (organic && manufactured) {
    const verb = manufactured.rate < organic.rate ? 'survives less' : 'does not survive less';
    out.push(
      `  manufactured ${verb} than organic: ${manufactured.survived}/${manufactured.n} vs ${organic.survived}/${organic.n}`,
    );
  }

  out.push('', 'survival by tier');
  out.push(...rateLines(report.byTier));

  const generation = report.generation;
  out.push('', `generation decay (Laplace-smoothed; ${generation.unknown} tokens without a report)`);
  out.push(generationLine('all', generation.overall));
  out.push(generationLine('organic', generation.organic));
  out.push(generationLine('manufactured', generation.manufactured));
  out.push(`  bonus current   [${generation.current.join(', ')}]`);
  const suggestion = generation.suggestion;
  if (suggestion.table) {
    const marked = suggestion.table.map((v, i) => (suggestion.kept?.[i] ? `${v} (kept)` : String(v)));
    out.push(`  bonus suggested [${marked.join(', ')}]`);
    out.push(`  apply: GENERATION_BONUS='${JSON.stringify(suggestion.table)}'`);
  } else {
    out.push(`  bonus suggested — (${suggestion.status}: ${suggestion.reason ?? ''})`);
  }
  if (generation.memes.length > 0) {
    out.push('  per meme (multiplier vs all memes at the same generation; not used by the score):');
    for (const curve of generation.memes) {
      out.push(`    ${curve.meme} (n ${curve.n}): ${curve.points.map((p) => `${p.generation} ×${fixed(p.multiplier)}`).join(' · ')}`);
    }
  }
  return out.join('\n');
}
