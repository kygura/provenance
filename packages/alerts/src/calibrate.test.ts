import { describe, expect, test } from 'bun:test';
import type { CalibrationRow, OrganicVerdict } from '@provenance/core';
import {
  auc,
  calibrate,
  formatCalibration,
  generationTable,
  memeCurves,
  suggestGenerationBonus,
  suggestWeights,
} from './calibrate';
import { assertWeights, DEFAULT_WEIGHTS } from './scoring';

/** Deterministic noise in [0, 100): a fixed LCG, so the synthetic set never changes. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 2 ** 32) * 100;
  };
}

function row(over: Partial<CalibrationRow> = {}): CalibrationRow {
  return {
    tokenId: 'solana:x',
    runId: 'r',
    scoredAt: '2026-10-01T06:00:00.000Z',
    total: 60,
    tier: 'B',
    components: { recycling: 50, memetic: 50, distribution: 50, liquidity: 50, momentum: 50, authenticity: 50 },
    survived: false,
    ...over,
  };
}

/** `n` rows where distribution > 50 is exactly survival and everything else is noise. */
function separable(n: number): CalibrationRow[] {
  const rand = lcg(7);
  return Array.from({ length: n }, (_, i) => {
    const distribution = rand();
    return row({
      tokenId: `solana:t${i}`,
      components: {
        recycling: rand(),
        memetic: rand(),
        distribution,
        liquidity: rand(),
        momentum: rand(),
        authenticity: rand(),
      },
      survived: distribution > 50,
    });
  });
}

describe('auc', () => {
  test('perfect, inverted and tied', () => {
    expect(auc([1, 2, 3, 4], [false, false, true, true])).toBe(1);
    expect(auc([1, 2, 3, 4], [true, true, false, false])).toBe(0);
    expect(auc([5, 5, 5, 5], [true, false, true, false])).toBe(0.5);
    expect(auc([1, 2], [true, true])).toBe(0.5);
  });
});

describe('suggestWeights', () => {
  test('negative coefficients get nothing; the rest normalise to a valid weight set in hundredths', () => {
    const weights = suggestWeights({ recycling: 1, memetic: 1, distribution: 1, liquidity: 1, momentum: 1, authenticity: 1 })!;
    expect(() => assertWeights(weights)).not.toThrow();
    for (const value of Object.values(weights)) expect(Math.round(value * 100)).toBeCloseTo(value * 100, 9);

    const skewed = suggestWeights({ recycling: 3, memetic: -2, distribution: 1, liquidity: 0, momentum: 0, authenticity: 0 })!;
    expect(skewed).toEqual({ recycling: 0.75, memetic: 0, distribution: 0.25, liquidity: 0, momentum: 0, authenticity: 0 });
    expect(suggestWeights({ recycling: -1, memetic: 0, distribution: 0, liquidity: 0, momentum: 0, authenticity: 0 })).toBeUndefined();
  });
});

describe('calibrate', () => {
  test('a component that perfectly predicts survival has the top AUC and the largest suggested weight', () => {
    const report = calibrate(separable(300));
    expect(report.status).toBe('ok');
    expect(report.components[0]?.component).toBe('distribution');
    expect(report.components[0]?.auc).toBe(1);
    for (const fit of report.components.slice(1)) expect(fit.auc).toBeLessThan(0.7);
    const suggested = report.weights.suggested!;
    expect(() => assertWeights(suggested)).not.toThrow();
    const largest = Object.entries(suggested).sort((a, b) => b[1] - a[1])[0]![0];
    expect(largest).toBe('distribution');
    expect(suggested.distribution).toBeGreaterThan(0.5);
    expect(report.weights.current).toEqual(DEFAULT_WEIGHTS);
  });

  test('deterministic: the same rows give the same report', () => {
    expect(calibrate(separable(250))).toEqual(calibrate(separable(250)));
  });

  test('below the gate it reports counts and suggests nothing', () => {
    const few = calibrate(separable(120));
    expect(few.status).toBe('insufficient');
    expect(few.n).toBe(120);
    expect(few.components).toEqual([]);
    expect(few.weights.suggested).toBeUndefined();
    expect(few.generation.suggested).toBeUndefined();
    expect(few.notes[0]).toMatch(/insufficient: 120 labelled \(need 200\)/);

    // Enough rows, but one class too thin.
    const lopsided = separable(300).map((r, i) => ({ ...r, survived: i < 20 }));
    const thin = calibrate(lopsided);
    expect(thin.status).toBe('insufficient');
    expect(thin.survived).toBe(20);
    expect(thin.weights.suggested).toBeUndefined();
    expect(formatCalibration(thin)).toContain('insufficient');
  });

  test('survival by organic verdict and tier, with counts', () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => row({ organicVerdict: 'organic', tier: 'A', survived: i < 8 })),
      ...Array.from({ length: 10 }, (_, i) => row({ organicVerdict: 'manufactured', tier: 'C', survived: i < 2 })),
      row({ tier: 'B', survived: true }),
    ];
    const report = calibrate(rows);
    expect(report.byOrganic).toEqual([
      { key: 'organic', n: 10, survived: 8, rate: 0.8 },
      { key: 'manufactured', n: 10, survived: 2, rate: 0.2 },
      { key: 'unread', n: 1, survived: 1, rate: 1 },
    ]);
    expect(report.byTier.map((cell) => cell.key)).toEqual(['A', 'B', 'C']);
    expect(formatCalibration(report)).toContain('manufactured survives less than organic: 2/10 vs 8/10');
  });
});

describe('generation decay', () => {
  function gens(generation: number, n: number, survivors: number, organicVerdict?: OrganicVerdict, meme?: string): CalibrationRow[] {
    return Array.from({ length: n }, (_, i) =>
      row({ recycleGeneration: generation, survived: i < survivors, ...(organicVerdict ? { organicVerdict } : {}), ...(meme ? { meme } : {}) }),
    );
  }

  test('Laplace-smoothed buckets 0..4+, rows without a report skipped', () => {
    const table = generationTable([...gens(0, 2, 1), ...gens(5, 3, 0), ...gens(7, 1, 1), row()]);
    expect(table).toEqual([
      { generation: '0', n: 2, survived: 1, rate: 0.5 },
      { generation: '1', n: 0, survived: 0, rate: 0.5 },
      { generation: '2', n: 0, survived: 0, rate: 0.5 },
      { generation: '3', n: 0, survived: 0, rate: 0.5 },
      { generation: '4+', n: 4, survived: 1, rate: 2 / 6 },
    ]);
  });

  test('bonus table: rescaled 0..10 over buckets with 20+ labels; thinner buckets keep the current constant', () => {
    const table = generationTable([...gens(0, 40, 10), ...gens(1, 40, 30), ...gens(2, 40, 20), ...gens(3, 10, 9), ...gens(4, 30, 0)]);
    expect(suggestGenerationBonus(table)).toEqual([3, 10, 7, 10, 0]);
    // One qualifying bucket, or a flat curve, says nothing.
    expect(suggestGenerationBonus(generationTable(gens(1, 40, 20)))).toBeUndefined();
    expect(suggestGenerationBonus(generationTable([...gens(0, 30, 15), ...gens(1, 30, 15)]))).toBeUndefined();
  });

  test('split by organic verdict, and per-meme curves only where three generations have 5+ labels', () => {
    const rows = [
      ...gens(0, 6, 5, 'organic', 'neiro'),
      ...gens(1, 6, 3, 'manufactured', 'neiro'),
      ...gens(2, 6, 1, 'manufactured', 'neiro'),
      ...gens(0, 6, 3, 'organic', 'pepe'),
      ...gens(1, 6, 3, 'organic', 'pepe'),
      ...gens(2, 4, 3, 'organic', 'pepe'),
    ];
    const report = calibrate(rows);
    expect(report.generation.organic[0]?.n).toBe(12);
    expect(report.generation.manufactured.map((c) => c.n)).toEqual([0, 6, 6, 0, 0]);
    const curves = memeCurves(rows, report.generation.overall);
    expect(curves.map((c) => c.meme)).toEqual(['neiro']);
    const neiro = curves[0]!;
    expect(neiro.points.map((p) => p.generation)).toEqual(['0', '1', '2']);
    // neiro gen 0: 6/8 smoothed vs all memes at gen 0: 9/14.
    expect(neiro.points[0]!.multiplier).toBeCloseTo(6 / 8 / (9 / 14), 9);
  });
});
