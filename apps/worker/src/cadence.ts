/**
 * The full run's cadence, decided from what the database already holds.
 *
 * The workflow fires every hour; `cli.ts cadence` answers "is this hour due?".
 * At today's volume the answer matches the old crons (06:00 and 18:00 UTC).
 * When the meme market heats up, measured over the trailing seven days, the
 * slots tighten to every four hours, then every hour. Nobody has to guess
 * when the next cycle starts.
 *
 * Three absolute signals, each compared with an elevated and a peak threshold:
 *   - trending tokens clearing the filters, mean per full run;
 *   - anchored launches catalogued per day (launch lane);
 *   - alerts fired per day (both lanes).
 * A level needs two of the three, so one noisy feed cannot move it. Stepping
 * down needs the signals to fall below 70% of the thresholds (hysteresis), so
 * a cadence near a threshold does not flap between levels day to day.
 */
import type { CadenceLevel, RunRecord } from '@provenance/core';

export const LEVELS: readonly CadenceLevel[] = ['base', 'elevated', 'peak'];

/** Hours between slots, and slots are anchored on 06:00 UTC (the brief reads that run). */
export const STEP_HOURS: Record<CadenceLevel, number> = { base: 12, elevated: 4, peak: 1 };
export const ANCHOR_HOUR_UTC = 6;

export const THRESHOLDS = {
  trendingPerRun: { elevated: 10, peak: 20 },
  launchesPerDay: { elevated: 6, peak: 15 },
  alertsPerDay: { elevated: 6, peak: 15 },
} as const;

/** Signals must stay at or above this share of a level's thresholds to hold it. */
export const HOLD_FACTOR = 0.7;
/** Two signals out of three must agree before a level counts. */
export const QUORUM = 2;

export const WINDOW_DAYS = 7;
/** A full run this recent means the slot already ran (a late cron or a manual dispatch). */
export const DEDUPE_HOURS = 0.5;
/** Enough rows for seven days at peak: 336 launch-lane runs plus 168 full ones. */
export const RUN_HISTORY_LIMIT = 600;

export interface CadenceSignals {
  trendingPerRun: number;
  launchesPerDay: number;
  alertsPerDay: number;
  fullRuns: number;
}

export interface CadenceDecision {
  due: boolean;
  level: CadenceLevel;
  /** The level the signals alone reached, before hysteresis, the pin or the interlock. */
  measured: CadenceLevel;
  /** Inferred from the gap between the last two full runs. */
  previous: CadenceLevel;
  signals: CadenceSignals;
  lastFullRunAt?: string;
  hoursSinceLast?: number;
  /** One line per thing that shaped the decision, for the workflow log. */
  reasons: string[];
}

export interface CadenceOptions {
  mode: 'auto' | CadenceLevel;
  /** `LLM_MAX_COST_USD_PER_DAY`. Auto mode stays at base without it. */
  maxCostUsdPerDay: number;
  nowMs: number;
}

const HOUR_MS = 3_600_000;

/** A full run, by its recorded lane, or for older rows by having trending output. */
export function isFullRun(run: RunRecord): boolean {
  if (run.stats.lane) return run.stats.lane === 'full';
  return run.stats.discovered > 0;
}

function finished(run: RunRecord): boolean {
  return run.status === 'ok' || run.status === 'partial';
}

export function measureSignals(runs: RunRecord[], nowMs: number): CadenceSignals {
  const since = nowMs - WINDOW_DAYS * 24 * HOUR_MS;
  const recent = runs.filter((run) => Date.parse(run.startedAt) >= since && finished(run));
  const full = recent.filter(isFullRun);
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  return {
    trendingPerRun: full.length > 0 ? sum(full.map((run) => run.stats.afterFilter)) / full.length : 0,
    // Divided by the whole window, not the days covered: a new database reads
    // low and stays at base until it has a week of history.
    launchesPerDay: sum(recent.map((run) => run.stats.launches?.catalogued ?? 0)) / WINDOW_DAYS,
    alertsPerDay: sum(recent.map((run) => run.stats.alertsFired)) / WINDOW_DAYS,
    fullRuns: full.length,
  };
}

/** The highest level at least `QUORUM` signals reach, with thresholds scaled by `factor`. */
export function levelFor(signals: CadenceSignals, factor = 1): CadenceLevel {
  const reaches = (level: 'elevated' | 'peak') =>
    [
      signals.trendingPerRun >= THRESHOLDS.trendingPerRun[level] * factor,
      signals.launchesPerDay >= THRESHOLDS.launchesPerDay[level] * factor,
      signals.alertsPerDay >= THRESHOLDS.alertsPerDay[level] * factor,
    ].filter(Boolean).length >= QUORUM;
  if (reaches('peak')) return 'peak';
  if (reaches('elevated')) return 'elevated';
  return 'base';
}

/** The level the last two full runs were spaced for. One full run or none reads as base. */
export function previousLevel(fullRuns: RunRecord[]): CadenceLevel {
  const [last, before] = fullRuns;
  if (!last || !before) return 'base';
  const gap = (Date.parse(last.startedAt) - Date.parse(before.startedAt)) / HOUR_MS;
  if (gap <= 1.5) return 'peak';
  if (gap <= 5) return 'elevated';
  return 'base';
}

const rank = (level: CadenceLevel) => LEVELS.indexOf(level);
const higher = (a: CadenceLevel, b: CadenceLevel) => (rank(a) >= rank(b) ? a : b);
const lower = (a: CadenceLevel, b: CadenceLevel) => (rank(a) <= rank(b) ? a : b);

export function inSlot(level: CadenceLevel, nowMs: number): boolean {
  const hour = new Date(nowMs).getUTCHours();
  const step = STEP_HOURS[level];
  return (((hour - ANCHOR_HOUR_UTC) % step) + step) % step === 0;
}

export function decideCadence(runs: RunRecord[], options: CadenceOptions): CadenceDecision {
  const reasons: string[] = [];
  const ordered = [...runs].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const fullRuns = ordered.filter((run) => isFullRun(run) && finished(run));
  const signals = measureSignals(ordered, options.nowMs);
  const measured = levelFor(signals);
  const previous = previousLevel(fullRuns);

  reasons.push(
    `signals (${WINDOW_DAYS}d): trending ${signals.trendingPerRun.toFixed(1)}/run over ${signals.fullRuns} full runs ` +
      `(elevated ≥ ${THRESHOLDS.trendingPerRun.elevated}, peak ≥ ${THRESHOLDS.trendingPerRun.peak}); ` +
      `launches ${signals.launchesPerDay.toFixed(1)}/day (≥ ${THRESHOLDS.launchesPerDay.elevated}, ≥ ${THRESHOLDS.launchesPerDay.peak}); ` +
      `alerts ${signals.alertsPerDay.toFixed(1)}/day (≥ ${THRESHOLDS.alertsPerDay.elevated}, ≥ ${THRESHOLDS.alertsPerDay.peak})`,
  );

  let level: CadenceLevel;
  if (options.mode !== 'auto') {
    level = options.mode;
    reasons.push(`pinned to ${level} by CADENCE_MODE (measured ${measured})`);
  } else {
    // Up as soon as the quorum says so; down only once it fails the hold bar too.
    level = higher(measured, lower(previous, levelFor(signals, HOLD_FACTOR)));
    reasons.push(
      level === measured
        ? `level ${level} (measured; previous ${previous})`
        : `level ${level}: holding ${previous}, signals still above ${HOLD_FACTOR * 100}% of its thresholds (measured ${measured})`,
    );
    if (level !== 'base' && options.maxCostUsdPerDay <= 0) {
      reasons.push(`capped at base: set LLM_MAX_COST_USD_PER_DAY before the cadence can rise above it (wanted ${level})`);
      level = 'base';
    }
  }

  // Timing counts failed runs too: a pipeline that keeps failing must not be
  // retried every hour as "overdue".
  const last = ordered.find(isFullRun);
  const decision: CadenceDecision = { due: false, level, measured, previous, signals, reasons };
  if (!last) {
    decision.due = true;
    reasons.push('due: no full run on record');
    return decision;
  }
  decision.lastFullRunAt = last.startedAt;
  const since = (options.nowMs - Date.parse(last.startedAt)) / HOUR_MS;
  decision.hoursSinceLast = Number(since.toFixed(2));
  const step = STEP_HOURS[level];

  if (since < DEDUPE_HOURS) {
    reasons.push(`not due: last full run ${since.toFixed(1)} h ago`);
  } else if (inSlot(level, options.nowMs)) {
    decision.due = true;
    reasons.push(`due: ${new Date(options.nowMs).getUTCHours()}:00 UTC is a ${level} slot (every ${step} h)`);
  } else if (since >= step + 1) {
    // GitHub fired so late the slot hour passed, or the slot run failed outright.
    decision.due = true;
    reasons.push(`due: overdue, last full run ${since.toFixed(1)} h ago against a ${step} h step`);
  } else {
    reasons.push(`not due: not a ${level} slot (every ${step} h from ${ANCHOR_HOUR_UTC}:00 UTC)`);
  }
  return decision;
}
