import { describe, expect, test } from 'bun:test';
import type { ChainAnalysis, HolderRow } from '@provenance/core';
import {
  DEFAULT_GENERATION_BONUS,
  DEFAULT_WEIGHTS,
  EXTREME_CONCENTRATION_PCT,
  FORCED_PENALTY,
  MANUFACTURED_PENALTY,
  MIXED_PENALTY,
  SINGLE_HOLDER_DOMINANCE_PCT,
  assertWeights,
  assessRisk,
  generationBucket,
  resolveScoringOverrides,
  scoreAuthenticity,
  scoreRecycling,
  scoreToken,
} from './scoring';
import { manufacturedCarrierRule, cleanRevivalRule } from './rules';
import type { OrganicRead } from '@provenance/core';
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

describe('organic verdict', () => {
  const read = (over: Partial<OrganicRead> = {}): OrganicRead => ({
    verdict: 'manufactured',
    outsideTraction: 50,
    signals: [{ kind: 'sniped-launch', organic: false, detail: 'Most of supply bought in the first block, per an analytics firm.' }],
    rivals: [{ name: 'Earlier same-name token', chain: 'ethereum', note: 'community takeover, spot listed' }],
    summary: 'Sniped twin of an organic token.',
    ...over,
  });
  const withOrganic = (organic: OrganicRead | undefined, confidence = 0.82) => {
    const input = strongInput();
    return { ...input, provenance: { ...input.provenance!, organic, confidence } };
  };

  test('a confidently manufactured token is penalised and capped at C, however real the meme', () => {
    const clean = scoreToken(strongInput(), { now: NOW });
    const staged = scoreToken(withOrganic(read()), { now: NOW });
    expect(staged.total).toBeCloseTo(clean.total - MANUFACTURED_PENALTY, 1);
    expect(['C', 'D']).toContain(staged.tier);
    expect(staged.penalties.some((p) => p.reason.startsWith('Manufactured token'))).toBe(true);
  });

  test('a low-confidence manufactured verdict only caps at B', () => {
    const staged = scoreToken(withOrganic(read(), 0.4), { now: NOW });
    expect(staged.penalties.some((p) => p.reason.startsWith('Manufactured token'))).toBe(false);
    expect(['B', 'C', 'D']).toContain(staged.tier);
  });

  test('mixed costs a little and caps at A; unclear and missing change nothing', () => {
    const clean = scoreToken(strongInput(), { now: NOW });
    const mixed = scoreToken(withOrganic(read({ verdict: 'mixed' })), { now: NOW });
    expect(mixed.total).toBeCloseTo(clean.total - MIXED_PENALTY, 1);
    expect(mixed.tier).not.toBe('S');
    expect(scoreToken(withOrganic(read({ verdict: 'unclear', outsideTraction: 95 })), { now: NOW })).toEqual(clean);
    expect(scoreToken(withOrganic(undefined), { now: NOW })).toEqual(clean);
  });

  test('outside traction moves authenticity by at most 10 either way', () => {
    const input = withOrganic(read({ verdict: 'organic', signals: [] }));
    const at = (outsideTraction: number) =>
      scoreAuthenticity({ ...input.provenance!, authenticityScore: 50, organic: read({ verdict: 'organic', outsideTraction }) });
    expect(at(100) - at(50)).toBeCloseTo(10, 5);
    expect(at(50) - at(0)).toBeCloseTo(10, 5);
  });

  test('the manufactured-carrier rule fires on a real meme with a staged token, and clean-revival stands down', () => {
    const input = withOrganic(read());
    const score = scoreToken(input, { now: NOW });
    const fired = manufacturedCarrierRule.evaluate({ ...input, score });
    expect(fired?.rule).toBe('manufactured-carrier');
    expect(fired?.body).toContain('sniped-launch');
    expect(fired?.body).toContain('Earlier same-name token');
    expect(cleanRevivalRule.evaluate({ ...input, score: { ...score, total: 99 } })).toBeNull();
  });

  test('the rule stays quiet on a forced meme, a thin report, or an organic token', () => {
    const score = scoreToken(strongInput(), { now: NOW });
    const forced = withOrganic(read());
    forced.provenance.anchor = { verdict: 'forced', type: 'none', subject: '', summary: 'x', confidence: 'high' };
    expect(manufacturedCarrierRule.evaluate({ ...forced, score })).toBeNull();
    expect(manufacturedCarrierRule.evaluate({ ...withOrganic(read(), 0.3), score })).toBeNull();
    expect(manufacturedCarrierRule.evaluate({ ...withOrganic(read({ verdict: 'organic' })), score })).toBeNull();
  });
});

describe('opt-in overrides (SCORE_WEIGHTS, GENERATION_BONUS)', () => {
  const weights = { recycling: 0.2, memetic: 0.2, distribution: 0.2, liquidity: 0.2, momentum: 0.1, authenticity: 0.1 };

  test('nothing set: no options, no warnings, and the score is the default one', () => {
    const resolved = resolveScoringOverrides({});
    expect(resolved).toEqual({ options: {}, warnings: [] });
    expect(scoreToken(strongInput(), { now: NOW, ...resolved.options })).toEqual(scoreToken(strongInput(), { now: NOW }));
  });

  test('valid weights and bonus table are applied', () => {
    const resolved = resolveScoringOverrides({ weights: JSON.stringify(weights), generationBonus: '[0, 2, 4, 6, 8]' });
    expect(resolved.warnings).toEqual([]);
    expect(resolved.options).toEqual({ weights, generationBonus: [0, 2, 4, 6, 8] });
    const custom = scoreToken(strongInput(), { now: NOW, ...resolved.options });
    expect(custom.total).not.toBe(scoreToken(strongInput(), { now: NOW }).total);
  });

  test('invalid values are refused whole, with a warning, and the defaults score', () => {
    const cases = [
      { weights: '{not json' },
      { weights: JSON.stringify({ ...weights, recycling: 0.9 }) },
      { weights: JSON.stringify({ ...weights, vibes: 0 }) },
      { weights: JSON.stringify({ recycling: 1 }) },
      { generationBonus: '[0, 7, 10, 10]' },
      { generationBonus: '[0, 7, 10, 10, 20]' },
      { generationBonus: '{"0": 1}' },
    ];
    for (const config of cases) {
      const resolved = resolveScoringOverrides(config);
      expect(resolved.options).toEqual({});
      expect(resolved.warnings).toHaveLength(1);
      expect(resolved.warnings[0]).toMatch(/ignored, using the defaults/);
    }
  });

  test('the default table reproduces the old generation cut points', () => {
    expect(DEFAULT_GENERATION_BONUS).toEqual([0, 7, 10, 10, 6]);
    expect([undefined, -1, 0, 0.5, 1, 1.9, 2, 3.5, 4, 9].map(generationBucket)).toEqual([0, 0, 0, 1, 1, 1, 2, 3, 4, 4]);
  });

  test('a bonus table moves recycling through the generation only', () => {
    const report = strongInput().provenance!;
    const flat = scoreRecycling({ ...report, recycleGeneration: 2 }, NOW.getUTCFullYear(), [0, 0, 0, 0, 0]);
    const base = scoreRecycling({ ...report, recycleGeneration: 2 }, NOW.getUTCFullYear());
    expect(base - flat).toBeCloseTo(10 * 1, 5); // revival multiplier 1 x the default gen-2 bonus of 10
  });
});
