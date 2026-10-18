import { describe, expect, test } from 'bun:test';
import type { Setup } from '@provenance/core';
import {
  DEFAULT_SETUP_KILL,
  fetchDexScreenerMarket,
  pickDexScreenerPair,
  rMultiple,
  setupStats,
  updateSetup,
  type SetupObservation,
} from './ledger';

const NOW = '2026-10-18T07:00:00.000Z';

function setup(overrides: Partial<Setup> = {}): Setup {
  return {
    id: 'PEPE-20261017-1',
    tokenId: 'solana:Pepe1111111111111111111111111111',
    chain: 'solana',
    address: 'Pepe1111111111111111111111111111',
    symbol: 'PEPE',
    thesis: 't',
    trigger: 'g',
    conviction: 'medium',
    regime: {},
    // mid 1.1M, invalidation 0.88M → 1R = 0.22M; first target 1.65M = 2.5R
    entryMcapLow: 1_000_000,
    entryMcapHigh: 1_200_000,
    invalidationMcap: 880_000,
    targets: [1_650_000, 2_200_000],
    kill: { ...DEFAULT_SETUP_KILL, liquidityUsdAtCreation: 200_000 },
    status: 'watching',
    createdAt: '2026-10-17T07:00:00.000Z',
    updatedAt: '2026-10-17T07:00:00.000Z',
    expiresAt: '2026-10-22T07:00:00.000Z',
    ...overrides,
  };
}

function obs(overrides: Partial<SetupObservation> = {}): SetupObservation {
  return { source: 'snapshot', mcapUsd: 1_300_000, liquidityUsd: 180_000, top10Pct: 30, largestHolderPct: 5, severeAlerts: [], ...overrides };
}

describe('rMultiple', () => {
  test('measures from the entry midpoint with the invalidation distance as 1R', () => {
    expect(rMultiple(setup(), 1_650_000)).toBe(2.5);
    expect(rMultiple(setup(), 880_000)).toBe(-1);
    expect(rMultiple(setup(), 1_100_000)).toBe(0);
  });
  test('levels with no risk give no R', () => {
    expect(rMultiple(setup({ invalidationMcap: 1_200_000 }), 2_000_000)).toBeUndefined();
  });
});

describe('updateSetup transitions', () => {
  test('watching stays watching above the zone and with no market data', () => {
    const s = setup();
    expect(updateSetup(s, obs(), NOW)).toBe(s);
    expect(updateSetup(s, obs({ mcapUsd: undefined, source: 'none' }), NOW)).toBe(s);
  });

  test('watching → triggered inside the entry zone', () => {
    const next = updateSetup(setup(), obs({ mcapUsd: 1_100_000 }), NOW);
    expect(next.status).toBe('triggered');
    expect(next.updatedAt).toBe(NOW);
    expect(next.rResult).toBeUndefined();
  });

  test('watching → invalidated below the invalidation level, with no R (never entered)', () => {
    const next = updateSetup(setup(), obs({ mcapUsd: 800_000 }), NOW);
    expect(next.status).toBe('invalidated');
    expect(next.rResult).toBeUndefined();
  });

  test('triggered → target_hit at the first target records target R', () => {
    const next = updateSetup(setup({ status: 'triggered' }), obs({ mcapUsd: 1_700_000 }), NOW);
    expect(next.status).toBe('target_hit');
    expect(next.rResult).toBe(2.5);
  });

  test('triggered → invalidated at the level is −1R', () => {
    const next = updateSetup(setup({ status: 'triggered' }), obs({ mcapUsd: 880_000 }), NOW);
    expect(next.status).toBe('invalidated');
    expect(next.rResult).toBe(-1);
  });

  test('triggered between levels stays triggered', () => {
    const s = setup({ status: 'triggered' });
    expect(updateSetup(s, obs({ mcapUsd: 1_400_000 }), NOW)).toBe(s);
  });

  test('past expiry → expired, ahead of any level check; a triggered one is marked to market', () => {
    const late = '2026-10-23T07:00:00.000Z';
    const watching = updateSetup(setup(), obs({ mcapUsd: 1_100_000 }), late);
    expect(watching.status).toBe('expired');
    expect(watching.rResult).toBeUndefined();
    const triggered = updateSetup(setup({ status: 'triggered' }), obs({ mcapUsd: 1_320_000 }), late);
    expect(triggered.status).toBe('expired');
    expect(triggered.rResult).toBe(1);
  });

  test('a triggered setup at its target after expiry is a hit, not an expiry', () => {
    const late = '2026-10-23T07:00:00.000Z';
    const next = updateSetup(setup({ status: 'triggered' }), obs({ mcapUsd: 1_800_000 }), late);
    expect(next.status).toBe('target_hit');
    expect(next.rResult).toBe(2.5);
    // A watching setup that skipped the zone does not get the same treatment.
    expect(updateSetup(setup(), obs({ mcapUsd: 1_800_000 }), late).status).toBe('expired');
    // Nor does a triggered one whose kill condition holds.
    expect(updateSetup(setup({ status: 'triggered' }), obs({ mcapUsd: 1_800_000, mintActive: true }), NOW).status).toBe('invalidated');
  });

  test('closed setups never move', () => {
    for (const status of ['invalidated', 'target_hit', 'expired', 'cancelled'] as const) {
      const s = setup({ status });
      expect(updateSetup(s, obs({ mcapUsd: 1_100_000 }), NOW)).toBe(s);
    }
  });
});

describe('kill conditions', () => {
  const cases: [string, Partial<SetupObservation>, string][] = [
    ['liquidity below half of creation', { liquidityUsd: 99_000 }, 'liquidity'],
    ['top-10 at 80%', { top10Pct: 80 }, 'top-10'],
    ['one holder at 25%', { largestHolderPct: 25 }, 'single holder'],
    ['mint authority active', { mintActive: true }, 'mint authority'],
    ['freeze authority active', { freezeActive: true }, 'freeze authority'],
    ['rug-risk alert after creation', { severeAlerts: [{ rule: 'rug-risk', createdAt: '2026-10-17T19:00:00.000Z' }] }, 'rug-risk'],
    ['impostor alert after creation', { severeAlerts: [{ rule: 'canonical-impostor', createdAt: '2026-10-18T06:00:00.000Z' }] }, 'canonical-impostor'],
  ];
  for (const [name, override, needle] of cases) {
    test(`${name}: watching → invalidated (no R), triggered → invalidated (−1R)`, () => {
      // Price is comfortably inside the zone, so only the kill can close it.
      const watching = updateSetup(setup(), obs({ mcapUsd: 1_100_000, ...override }), NOW);
      expect(watching.status).toBe('invalidated');
      expect(watching.rResult).toBeUndefined();
      expect(watching.statusNote).toContain(needle);
      const triggered = updateSetup(setup({ status: 'triggered' }), obs({ mcapUsd: 1_500_000, ...override }), NOW);
      expect(triggered.status).toBe('invalidated');
      expect(triggered.rResult).toBe(-1);
    });
  }

  test('a severe alert from before the setup existed does not kill it', () => {
    const s = setup();
    const next = updateSetup(s, obs({ severeAlerts: [{ rule: 'rug-risk', createdAt: '2026-10-16T00:00:00.000Z' }] }), NOW);
    expect(next).toBe(s);
  });

  test('liquidity at exactly half is not a kill', () => {
    const s = setup();
    expect(updateSetup(s, obs({ liquidityUsd: 100_000 }), NOW)).toBe(s);
  });
});

describe('setupStats', () => {
  test('90-day hit rate and average R over resolved setups only', () => {
    const now = Date.parse(NOW);
    const stats = setupStats(
      [
        setup({ id: 'a', status: 'target_hit', rResult: 2.5, updatedAt: '2026-10-10T00:00:00.000Z' }),
        setup({ id: 'b', status: 'invalidated', rResult: -1, updatedAt: '2026-10-11T00:00:00.000Z' }),
        setup({ id: 'c', status: 'invalidated', updatedAt: '2026-10-11T00:00:00.000Z' }), // never triggered
        setup({ id: 'd', status: 'target_hit', rResult: 3, updatedAt: '2026-06-01T00:00:00.000Z' }), // too old
        setup({ id: 'e', status: 'watching' }),
        setup({ id: 'f', status: 'triggered' }),
      ],
      now,
    );
    expect(stats).toEqual({ open: 2, resolved90d: 2, hits90d: 1, hitRate: 0.5, avgR: 0.75 });
  });
});

describe('DexScreener market read', () => {
  const payload = {
    pairs: [
      { chainId: 'solana', baseToken: { address: 'Pepe1111111111111111111111111111', symbol: 'PEPE' }, liquidity: { usd: 50_000 }, marketCap: 1_000_000, url: 'https://dexscreener.com/solana/small' },
      { chainId: 'solana', baseToken: { address: 'Pepe1111111111111111111111111111', symbol: 'PEPE' }, liquidity: { usd: 250_000 }, marketCap: 1_050_000, url: 'https://dexscreener.com/solana/big' },
      // A pair where our token is the quote side is somebody else's market.
      { chainId: 'solana', baseToken: { address: 'Other111111111111111111111111111', symbol: 'X' }, liquidity: { usd: 9_000_000 }, marketCap: 5 },
    ],
  };

  test('picks the max-liquidity pair whose base token is ours', () => {
    expect(pickDexScreenerPair(payload, 'Pepe1111111111111111111111111111', 'solana')).toEqual({
      mcapUsd: 1_050_000,
      liquidityUsd: 250_000,
    });
    expect(pickDexScreenerPair(payload, 'Pepe1111111111111111111111111111', 'base').gap).toContain('no pair');
  });

  test('fetch failures are gaps, malformed addresses are refused before the network', async () => {
    let called = false;
    const refused = await fetchDexScreenerMarket('../../etc', undefined, async () => {
      called = true;
      return new Response('{}');
    });
    expect(refused.gap).toContain('malformed');
    expect(called).toBe(false);
    const down = await fetchDexScreenerMarket('Pepe1111111111111111111111111111', 'solana', async () => new Response('', { status: 429 }));
    expect(down.gap).toBe('dexscreener: HTTP 429');
  });
});
