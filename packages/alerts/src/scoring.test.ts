import { describe, expect, test } from 'bun:test';
import type { ChainAnalysis, HolderRow } from '@provenance/core';
import {
  DEFAULT_WEIGHTS,
  EXTREME_CONCENTRATION_PCT,
  FORCED_PENALTY,
  SINGLE_HOLDER_DOMINANCE_PCT,
  assertWeights,
  assessRisk,
  scoreToken,
} from './scoring';
import { NOW, strongInput } from './test-support';

function chain(overrides: Partial<ChainAnalysis> = {}): ChainAnalysis {
  return {
    tokenId: 'ethereum:0xabc',
    chain: 'ethereum',
    tokenAddress: '0xabc',
    method: 'rpc',
    topHolders: [],
    flags: [],
    notes: [],
    fetchedAt: new Date().toISOString(),
    ...overrides,
  };
}

function holder(address: string, pct: number, extra: Partial<HolderRow> = {}): HolderRow {
  return { address, balance: pct, pct, ...extra };
}

describe('weights', () => {
  test('the default set sums to 1', () => {
    expect(() => assertWeights(DEFAULT_WEIGHTS)).not.toThrow();
  });

  test('a set that does not sum to 1 is a bug, not a rescale', () => {
    expect(() => assertWeights({ ...DEFAULT_WEIGHTS, recycling: 0.9 })).toThrow(/sum to 1/);
  });

  test('a negative or non-finite weight is rejected by name', () => {
    expect(() => assertWeights({ ...DEFAULT_WEIGHTS, momentum: -0.1 })).toThrow(/momentum/);
    expect(() => assertWeights({ ...DEFAULT_WEIGHTS, liquidity: Number.NaN })).toThrow(/liquidity/);
  });

  test('recycling is the heaviest component — it is the thesis', () => {
    const others = Object.entries(DEFAULT_WEIGHTS)
      .filter(([key]) => key !== 'recycling')
      .map(([, value]) => value);
    expect(DEFAULT_WEIGHTS.recycling).toBeGreaterThan(Math.max(...others));
  });
});

describe('assessRisk holder basis', () => {
  test('prefers the analyser ex-LP figure over the raw rows', () => {
    // The rows are shares of TOTAL supply; the two bases disagree on purpose.
    const risk = assessRisk(
      chain({ largestHolderPct: 42, topHolders: [holder('0x1', 91), holder('0x2', 4)] }),
    );
    expect(risk.singleHolderPct).toBe(42);
  });

  test('never reports a holding above 100%, whatever the rows contain', () => {
    // EVM balances are reconstructed from a bounded window of Transfer logs and
    // can overshoot supply. This printed "Single holder controls 210.0%".
    const risk = assessRisk(chain({ topHolders: [holder('0x1', 210)] }));
    expect(risk.singleHolderPct).toBeLessThanOrEqual(100);
  });

  test('falls back to the rows when the analyser reported no ex-LP figure', () => {
    const risk = assessRisk(chain({ topHolders: [holder('0x1', 12), holder('0x2', 37)] }));
    expect(risk.singleHolderPct).toBe(37);
  });

  test('skips LP and burn addresses in the fallback', () => {
    const risk = assessRisk(
      chain({
        topHolders: [
          holder('pool', 80, { excludedFromConcentration: true, label: 'liquidity-pool' }),
          holder('0x2', 9),
        ],
      }),
    );
    expect(risk.singleHolderPct).toBe(9);
  });

  test('reports nothing rather than zero when no holders were resolved', () => {
    expect(assessRisk(chain()).singleHolderPct).toBeUndefined();
    expect(assessRisk(undefined).singleHolderPct).toBeUndefined();
  });
});

describe('assessRisk structural flags', () => {
  test('an active mint authority is critical', () => {
    const risk = assessRisk(chain({ mintAuthorityActive: true }));
    expect(risk.mintAuthorityActive).toBe(true);
    expect(risk.hasCritical).toBe(true);
  });

  test('extreme concentration is read off the ex-LP top-10', () => {
    expect(assessRisk(chain({ top10Pct: EXTREME_CONCENTRATION_PCT })).extremeConcentration).toBe(true);
    expect(assessRisk(chain({ top10Pct: EXTREME_CONCENTRATION_PCT - 1 })).extremeConcentration).toBe(false);
  });

  test('a clean analysis carries no critical risk', () => {
    const risk = assessRisk(chain({ top10Pct: 20, largestHolderPct: SINGLE_HOLDER_DOMINANCE_PCT - 5 }));
    expect(risk.hasCritical).toBe(false);
    expect(risk.criticalFlags).toEqual([]);
  });

  test('critical analyser flags are carried through; warnings are not', () => {
    const risk = assessRisk(
      chain({
        flags: [
          { code: 'mint-authority-active', severity: 'critical', detail: 'x' },
          { code: 'lp-not-burned', severity: 'warn', detail: 'y' },
        ],
      }),
    );
    expect(risk.criticalFlags.map((flag) => flag.code)).toEqual(['mint-authority-active']);
  });
});

describe('anchor verdict', () => {
  const anchor = {
    type: 'none' as const,
    subject: '',
    summary: 'Earliest mentions are the deployer’s own launch posts.',
  };

  test('a confidently forced meme is penalised and capped at C, whatever its lineage says', () => {
    const input = strongInput();
    const clean = scoreToken(input, { now: NOW });
    const forced = scoreToken(
      { ...input, provenance: { ...input.provenance!, anchor: { ...anchor, verdict: 'forced', confidence: 'medium' } } },
      { now: NOW },
    );
    expect(forced.total).toBeCloseTo(clean.total - FORCED_PENALTY, 1);
    expect(['C', 'D']).toContain(forced.tier);
    expect(forced.penalties.some((p) => p.reason.startsWith('Forced meme'))).toBe(true);
  });

  test('a low-confidence forced verdict only caps at B; anchored and unclear change nothing', () => {
    const input = strongInput();
    const clean = scoreToken(input, { now: NOW });
    const weak = scoreToken(
      { ...input, provenance: { ...input.provenance!, anchor: { ...anchor, verdict: 'forced', confidence: 'low' } } },
      { now: NOW },
    );
    expect(weak.total).toBe(clean.total);
    expect(['B', 'C', 'D']).toContain(weak.tier);
    for (const verdict of ['anchored', 'unclear'] as const) {
      const other = scoreToken(
        {
          ...input,
          provenance: {
            ...input.provenance!,
            anchor: { ...anchor, verdict, type: 'historical-meme', subject: 'x', confidence: 'high' },
          },
        },
        { now: NOW },
      );
      expect(other).toEqual(clean);
    }
  });
});
