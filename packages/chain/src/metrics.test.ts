import { describe, expect, test } from 'bun:test';
import { loadConfig, silentLogger, type AppConfig, type HolderRow, type TokenSnapshot } from '@provenance/core';
import { analyzeToken } from './analyze';
import { evaluateFlags, RISK_THRESHOLDS } from './flags';
import { concentration, gini, herfindahl, includedRows, topNPct, withSupplyPct } from './metrics';

function row(address: string, balance: number, extra: Partial<HolderRow> = {}): HolderRow {
  return { address, balance, pct: 0, ...extra };
}

describe('herfindahl', () => {
  test('a lone holder of everything is 1', () => {
    expect(herfindahl([1])).toBeCloseTo(1, 10);
  });

  test('n equal holders is 1/n', () => {
    expect(herfindahl([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(0.25, 10);
  });

  test('ignores non-positive and non-finite shares rather than propagating NaN', () => {
    expect(herfindahl([0.5, 0, -0.2, Number.NaN, 0.5])).toBeCloseTo(0.5, 10);
  });

  test('shares that sum below 1 give a lower bound, not a rescaled figure', () => {
    // Half the population sampled, evenly split: the true HHI is higher.
    expect(herfindahl([0.25, 0.25])).toBeCloseTo(0.125, 10);
  });
});

describe('gini', () => {
  test('perfect equality is 0', () => {
    expect(gini([10, 10, 10, 10])).toBeCloseTo(0, 10);
  });

  test('a single observation is 0 — correct, and exactly why it carries a caveat', () => {
    expect(gini([42])).toBe(0);
    expect(gini([])).toBe(0);
  });

  test('rises as one holder takes more', () => {
    expect(gini([97, 1, 1, 1])).toBeGreaterThan(gini([40, 30, 20, 10]));
  });

  test('stays within [0, 1]', () => {
    for (const values of [[1, 1e12], [1e-9, 1], [5, 5, 5]]) {
      const value = gini(values);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});

describe('topNPct', () => {
  const sorted = [row('a', 50), row('b', 30), row('c', 20)];

  test('withholds a top-N claim the sample cannot support', () => {
    expect(topNPct(sorted, 10, 100, true)).toBeUndefined();
  });

  test('reports it when the caller states the set is complete', () => {
    expect(topNPct(sorted, 10, 100, false)).toBeCloseTo(100, 6);
  });

  test('reports it when the sample is big enough for the claim', () => {
    expect(topNPct(sorted, 2, 100, true)).toBeCloseTo(80, 6);
  });

  test('returns undefined rather than dividing by a zero basis', () => {
    expect(topNPct(sorted, 2, 0, false)).toBeUndefined();
  });
});

describe('includedRows', () => {
  test('drops excluded rows and sorts the rest largest first', () => {
    const rows = [
      row('small', 1),
      row('pool', 900, { excludedFromConcentration: true, label: 'liquidity-pool' }),
      row('big', 10),
    ];
    expect(includedRows(rows).map((item) => item.address)).toEqual(['big', 'small']);
  });
});

describe('concentration', () => {
  test('measures against supply net of excluded balances', () => {
    const result = concentration({
      rows: [
        row('pool', 600, { excludedFromConcentration: true }),
        row('whale', 300),
        row('minnow', 100),
      ],
      totalSupply: 1000,
      sampled: false,
    });

    expect(result.basisIsSupply).toBe(true);
    expect(result.basis).toBeCloseTo(400, 6);
    // 300 of the 400 non-LP units, not 300 of 1000.
    expect(result.largestHolderPct).toBeCloseTo(75, 4);
    expect(result.excludedCount).toBe(1);
  });

  test('falls back to the sampled sum and says so when supply is unknown', () => {
    const result = concentration({ rows: [row('a', 70), row('b', 30)], sampled: true });
    expect(result.basisIsSupply).toBe(false);
    expect(result.basis).toBeCloseTo(100, 6);
    expect(result.caveats.join(' ')).toContain('not circulating supply');
  });

  test('largestHolderPct never exceeds 100, whatever the rows say', () => {
    // Reconstructed balances can overshoot supply when the scan window misses
    // the offsetting burns. A percentage over 100 is never a reportable fact.
    const result = concentration({ rows: [row('a', 2100)], totalSupply: 1000, sampled: true });
    expect(result.largestHolderPct).toBeLessThanOrEqual(100);
  });

  test('a sampled result carries the lower-bound and biased-low caveats', () => {
    const result = concentration({
      rows: [row('a', 60), row('b', 40)],
      totalSupply: 1000,
      sampled: true,
    });
    const caveats = result.caveats.join(' ');
    expect(caveats).toContain('lower bound');
    expect(caveats).toContain('biased low');
    expect(result.top50Pct).toBeUndefined();
  });

  test('no non-excluded holders yields no metrics rather than zeros', () => {
    const result = concentration({
      rows: [row('pool', 100, { excludedFromConcentration: true })],
      totalSupply: 100,
      sampled: false,
    });
    expect(result.herfindahl).toBeUndefined();
    expect(result.largestHolderPct).toBeUndefined();
    expect(result.caveats.join(' ')).toContain('No non-excluded holders');
  });
});

describe('withSupplyPct', () => {
  test('restates rows as a share of TOTAL supply, a different basis from concentration', () => {
    const rows = withSupplyPct([row('pool', 600, { excludedFromConcentration: true }), row('whale', 300)], 1000);
    expect(rows[0]?.pct).toBeCloseTo(60, 6);
    expect(rows[1]?.pct).toBeCloseTo(30, 6);
  });

  test('leaves rows untouched when supply is unusable', () => {
    expect(withSupplyPct([row('a', 5, { pct: 12 })], 0)[0]?.pct).toBe(12);
  });
});

describe('the flag basis contract', () => {
  test('single-holder-dominant reads the ex-LP figure it documents', () => {
    const analysis = { flags: [], notes: [], topHolders: [] } as never;
    const flags = evaluateFlags({
      analysis,
      largestHolderPct: RISK_THRESHOLDS.singleHolderCriticalPct + 1,
    });
    expect(flags.map((flag) => flag.code)).toContain('single-holder-dominant');
  });

  test('it does not fire at the threshold itself', () => {
    const analysis = { flags: [], notes: [], topHolders: [] } as never;
    const flags = evaluateFlags({
      analysis,
      largestHolderPct: RISK_THRESHOLDS.singleHolderCriticalPct,
    });
    expect(flags.map((flag) => flag.code)).not.toContain('single-holder-dominant');
  });
});

// --- end to end, against the committed RPC fixtures -------------------------

function fixtureConfig(): AppConfig {
  const base = loadConfig({});
  return { ...base, pipeline: { ...base.pipeline, useFixtures: true } };
}

function snapshot(tokenId: string, chain: TokenSnapshot['chain'], address: string): TokenSnapshot {
  return {
    tokenId,
    chain,
    tokenAddress: address,
    symbol: 'NYAN',
    name: 'Nyan',
    socials: {},
    metrics: {},
    pairs: [],
    appearances: [],
    bestRank: 1,
    sourceCount: 1,
    capturedAt: new Date().toISOString(),
  };
}

describe('analyzeToken against fixtures', () => {
  test('no EVM risk flag quotes a holding above 100% of supply', async () => {
    // The regression this pins: the EVM analyser passed `HolderRow.pct` (a share
    // of total supply, reconstructed from a bounded log window and unclamped)
    // into a flag whose text says "of non-excluded supply", and printed
    // "One non-LP address holds 210.00%".
    const app = fixtureConfig();
    const analysis = await analyzeToken(
      snapshot('ethereum:0x5ad…', 'ethereum', '0x5ad2c5f4c0e0a1e0a86cbbf0e5e3dd0bbd8b0000'),
      { app, logger: silentLogger },
    );

    for (const flag of analysis.flags) {
      const percentages = [...flag.detail.matchAll(/(\d+(?:\.\d+)?)%/g)].map((match) => Number(match[1]));
      for (const value of percentages) {
        expect(value).toBeLessThanOrEqual(100);
      }
    }
  });

  test('the Solana analyser reports the same ex-LP basis', async () => {
    const app = fixtureConfig();
    const analysis = await analyzeToken(
      snapshot('solana:bongo', 'solana', 'BongoNyanCatMint11111111111111111111111111'),
      { app, logger: silentLogger },
    );

    for (const flag of analysis.flags) {
      const percentages = [...flag.detail.matchAll(/(\d+(?:\.\d+)?)%/g)].map((match) => Number(match[1]));
      for (const value of percentages) {
        expect(value).toBeLessThanOrEqual(100);
      }
    }
  });
});
