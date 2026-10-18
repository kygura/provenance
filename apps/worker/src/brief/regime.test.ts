import { describe, expect, test } from 'bun:test';
import { fetchBtcRegime, labelMemeRegime, parseBtcRegime, type MemeRegimeInputs } from './regime';

const NEUTRAL: MemeRegimeInputs = {
  saTokens7d: 10,
  saTokensPrev7d: 10,
  meanScore7d: 60,
  meanScorePrev7d: 60,
  alerts7d: 14,
  alertsPrev7d: 14,
  anchored30d: { expressed: 2, dormant: 6, active: 3 }, // 25%: no signal
  hottestCluster: 3,
};

describe('labelMemeRegime', () => {
  test('flat inputs are warm with no reasons', () => {
    const read = labelMemeRegime(NEUTRAL);
    expect(read.label).toBe('warm');
    expect(read.score).toBe(0);
    expect(read.reasons).toEqual([]);
  });

  test('broad expansion is hot', () => {
    const read = labelMemeRegime({
      ...NEUTRAL,
      saTokens7d: 15,
      meanScore7d: 66,
      alerts7d: 28,
      anchored30d: { expressed: 4, dormant: 4, active: 0 },
      hottestCluster: 5,
    });
    expect(read.label).toBe('hot');
    expect(read.score).toBe(5);
    expect(read.reasons).toHaveLength(5);
  });

  test('contraction is cold', () => {
    const read = labelMemeRegime({
      ...NEUTRAL,
      saTokens7d: 4,
      meanScore7d: 52,
      alerts7d: 5,
      anchored30d: { expressed: 0, dormant: 9, active: 0 },
      hottestCluster: 0,
    });
    expect(read.label).toBe('cold');
    expect(read.score).toBe(-5);
  });

  test('exactly ±2 is the boundary', () => {
    expect(labelMemeRegime({ ...NEUTRAL, saTokens7d: 12, hottestCluster: 4 }).label).toBe('hot');
    expect(labelMemeRegime({ ...NEUTRAL, saTokens7d: 8, hottestCluster: 1 }).label).toBe('cold');
    expect(labelMemeRegime({ ...NEUTRAL, saTokens7d: 12 }).label).toBe('warm');
  });

  test('a conversion rate on fewer than 5 resolved entries is ignored', () => {
    const read = labelMemeRegime({ ...NEUTRAL, anchored30d: { expressed: 0, dormant: 4, active: 0 } });
    expect(read.score).toBe(0);
  });

  test('growth from an empty prior week counts as expansion; empty both weeks counts as nothing', () => {
    expect(labelMemeRegime({ ...NEUTRAL, saTokensPrev7d: 0, saTokens7d: 3 }).score).toBe(1);
    expect(labelMemeRegime({ ...NEUTRAL, saTokensPrev7d: 0, saTokens7d: 0 }).score).toBe(0);
  });

  test('missing means skip the quality signal', () => {
    const read = labelMemeRegime({ ...NEUTRAL, meanScore7d: undefined, meanScorePrev7d: 40 });
    expect(read.score).toBe(0);
  });
});

describe('BTC regime', () => {
  test('parses state, since and asOf from vector.json', () => {
    const regime = parseBtcRegime({
      asOf: Date.parse('2026-10-15T00:00:00Z'),
      stale: false,
      regime: { state: 'mild_risk_off', since: Date.parse('2026-10-01T00:00:00Z') },
    });
    expect(regime).toEqual({ state: 'mild_risk_off', since: '2026-10-01', asOf: '2026-10-15', stale: false, riskOff: true });
    expect(parseBtcRegime({ regime: { state: 'strong_risk_on' } }).riskOff).toBe(false);
  });

  test('missing state, HTTP errors and network errors are gaps, not throws', async () => {
    expect(parseBtcRegime({}).gap).toContain('no regime.state');
    const http = await fetchBtcRegime(async () => new Response('nope', { status: 503 }));
    expect(http).toEqual({ riskOff: false, gap: 'hl-cycles: HTTP 503' });
    const down = await fetchBtcRegime(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(down.gap).toContain('ECONNREFUSED');
    expect(down.riskOff).toBe(false);
  });
});
