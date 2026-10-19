import { describe, expect, test } from 'bun:test';
import type { RunRecord, RunStats } from '@provenance/core';
import { THRESHOLDS, decideCadence, inSlot, levelFor, measureSignals, previousLevel } from './cadence';

const NOW = Date.parse('2026-10-19T06:00:00.000Z');
const H = 3_600_000;

function run(id: string, hoursAgo: number, stats: Partial<RunStats> = {}, status: RunRecord['status'] = 'ok'): RunRecord {
  return {
    id,
    startedAt: new Date(NOW - hoursAgo * H).toISOString(),
    status,
    stats: {
      discovered: 0,
      afterFilter: 0,
      analysed: 0,
      reused: 0,
      alertsFired: 0,
      llmCostUsd: 0,
      sourceErrors: [],
      ...stats,
    },
  };
}

const full = (id: string, hoursAgo: number, afterFilter: number, alertsFired = 0) =>
  run(id, hoursAgo, { lane: 'full', discovered: afterFilter + 5, afterFilter, alertsFired });
const lane = (id: string, hoursAgo: number, catalogued: number) =>
  run(id, hoursAgo, {
    lane: 'launches',
    launches: { discovered: 0, rejected: 0, dismissed: 0, catalogued, researched: 0, expressed: 0, dormant: 0 },
  });

/** A week of twice-daily full runs, each with the given trending count, alert count and launches. */
function week(trending: number, alertsPerDay: number, launchesPerDay: number): RunRecord[] {
  const runs: RunRecord[] = [];
  for (let day = 0; day < 7; day++) {
    runs.push(full(`f${day}a`, 3 + day * 24, trending, alertsPerDay / 2));
    runs.push(full(`f${day}b`, 15 + day * 24, trending, alertsPerDay / 2));
    runs.push(lane(`l${day}`, 6 + day * 24, launchesPerDay));
  }
  return runs;
}

const auto = { mode: 'auto' as const, maxCostUsdPerDay: 50, nowMs: NOW };

describe('signals', () => {
  test('averages trending over full runs and spreads launches and alerts over the week', () => {
    const signals = measureSignals(week(12, 8, 4), NOW);
    expect(signals.fullRuns).toBe(14);
    expect(signals.trendingPerRun).toBe(12);
    expect(signals.alertsPerDay).toBeCloseTo(8, 6);
    expect(signals.launchesPerDay).toBeCloseTo(4, 6);
  });

  test('ignores runs older than the window, failed runs, and tells lanes apart on old rows', () => {
    const old = full('old', 24 * 8, 99);
    const failed = run('failed', 3, { lane: 'full', afterFilter: 99 }, 'failed');
    // Pre-lane rows: a launch-lane run has no trending output.
    const legacyLane = run('legacy-lane', 2, { discovered: 0, afterFilter: 0 });
    const legacyFull = run('legacy-full', 1, { discovered: 10, afterFilter: 4 });
    const signals = measureSignals([old, failed, legacyLane, legacyFull], NOW);
    expect(signals.fullRuns).toBe(1);
    expect(signals.trendingPerRun).toBe(4);
  });
});

describe('level', () => {
  test('needs two of three signals: one hot feed alone does not move it', () => {
    expect(levelFor({ trendingPerRun: 50, launchesPerDay: 0, alertsPerDay: 0, fullRuns: 14 })).toBe('base');
    expect(
      levelFor({
        trendingPerRun: THRESHOLDS.trendingPerRun.elevated,
        launchesPerDay: 0,
        alertsPerDay: THRESHOLDS.alertsPerDay.elevated,
        fullRuns: 14,
      }),
    ).toBe('elevated');
    expect(levelFor({ trendingPerRun: 25, launchesPerDay: 20, alertsPerDay: 0, fullRuns: 14 })).toBe('peak');
  });

  test('previous level comes from the spacing of the last two full runs', () => {
    expect(previousLevel([])).toBe('base');
    expect(previousLevel([full('a', 0, 1), full('b', 1, 1)])).toBe('peak');
    expect(previousLevel([full('a', 0, 1), full('b', 4, 1)])).toBe('elevated');
    expect(previousLevel([full('a', 0, 1), full('b', 12, 1)])).toBe('base');
  });
});

describe('slots', () => {
  test('base is 06 and 18 UTC, elevated every 4 h from 06, peak every hour', () => {
    const at = (hour: number) => Date.parse(`2026-10-19T${String(hour).padStart(2, '0')}:00:00.000Z`);
    const hours = (level: 'base' | 'elevated' | 'peak') =>
      Array.from({ length: 24 }, (_, h) => h).filter((h) => inSlot(level, at(h)));
    expect(hours('base')).toEqual([6, 18]);
    expect(hours('elevated')).toEqual([2, 6, 10, 14, 18, 22]);
    expect(hours('peak')).toHaveLength(24);
  });
});

describe('decideCadence', () => {
  test('a quiet week stays at base and runs the 06:00 slot', () => {
    const decision = decideCadence(week(4, 1, 1), auto);
    expect(decision.level).toBe('base');
    expect(decision.due).toBe(true);
  });

  test('a quiet week skips a non-slot hour', () => {
    const decision = decideCadence(week(4, 1, 1), { ...auto, nowMs: NOW + 3 * H });
    expect(decision.due).toBe(false);
  });

  test('a hot week goes to peak and every hour is due', () => {
    const runs = week(25, 20, 20);
    const decision = decideCadence(runs, { ...auto, nowMs: NOW + 3 * H });
    expect(decision.measured).toBe('peak');
    expect(decision.level).toBe('peak');
    expect(decision.due).toBe(true);
  });

  test('stays at base without a daily LLM ceiling, whatever the signals say', () => {
    const decision = decideCadence(week(25, 20, 20), { ...auto, maxCostUsdPerDay: 0, nowMs: NOW + 3 * H });
    expect(decision.measured).toBe('peak');
    expect(decision.level).toBe('base');
    expect(decision.due).toBe(false);
    expect(decision.reasons.some((r) => r.includes('LLM_MAX_COST_USD_PER_DAY'))).toBe(true);
  });

  test('holds elevated while signals sit between 70% and 100% of its thresholds', () => {
    // Below elevated (10 trending, 6 alerts), above 70% of it (7, 4.2).
    const runs = week(8, 5, 0).filter((r) => r.id !== 'f0a');
    // The last two full runs 4 h apart: the cadence was elevated.
    runs.push(full('recent', 2, 8), full('recent-1', 6, 8));
    const decision = decideCadence(runs, { ...auto, nowMs: NOW + 4 * H });
    expect(decision.measured).toBe('base');
    expect(decision.previous).toBe('elevated');
    expect(decision.level).toBe('elevated');
  });

  test('a pin overrides the signals and the interlock', () => {
    const decision = decideCadence(week(1, 0, 0), { mode: 'peak', maxCostUsdPerDay: 0, nowMs: NOW + 3 * H });
    expect(decision.level).toBe('peak');
    expect(decision.due).toBe(true);
  });

  test('a slot that already ran is not due again', () => {
    const runs = [...week(4, 1, 1), full('just-now', 0.2, 4)];
    expect(decideCadence(runs, auto).due).toBe(false);
  });

  test('an overdue run fires off-slot, but a failing pipeline is not retried hourly', () => {
    const at = NOW + 1 * H; // 07:00, not a base slot
    // Last full run 13 h ago: the 06:00 cron never fired.
    const missed = [full('f', 13, 4)];
    expect(decideCadence(missed, { ...auto, nowMs: at }).due).toBe(true);
    // The 06:00 run fired and failed: wait for 18:00.
    const failed = [full('f', 13, 4), run('failed', 1, { lane: 'full' }, 'failed')];
    expect(decideCadence(failed, { ...auto, nowMs: at }).due).toBe(false);
  });

  test('an empty history is due', () => {
    expect(decideCadence([], { ...auto, nowMs: NOW + 3 * H }).due).toBe(true);
  });
});
