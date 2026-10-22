import { describe, expect, test } from 'bun:test';
import {
  clusterFunding,
  fundingWindowBlocks,
  selectEarlyBuyers,
  type EarlyBuyer,
} from './funding';
import type { PoolTransfer } from './sniping';

const POOL = '0xpool';
const SUPPLY = 1_000_000n;

function t(block: number, from: string, to: string, value: bigint): PoolTransfer {
  return { block, from, to, value };
}

function buyers(...pairs: [string, bigint][]): EarlyBuyer[] {
  return pairs.map(([address, boughtRaw]) => ({ address, boughtRaw }));
}

function cluster(b: EarlyBuyer[], f: Record<string, string | undefined>, extra: object = {}) {
  return clusterFunding({
    buyers: b,
    funders: new Map(Object.entries(f)),
    totalRaw: SUPPLY,
    windowBlocks: 150,
    ...extra,
  });
}

describe('fundingWindowBlocks', () => {
  test('30 minutes of blocks, at least one', () => {
    expect(fundingWindowBlocks(12)).toBe(150);
    expect(fundingWindowBlocks(2)).toBe(900);
    expect(fundingWindowBlocks(3600)).toBe(1);
  });
});

describe('selectEarlyBuyers', () => {
  const transfers = [
    t(100, POOL, '0xa', 100n),
    t(105, POOL, '0xa', 50n), // summed with the first
    t(101, POOL, '0xb', 120n),
    t(109, POOL, '0xc', 10n), // last block in window
    t(110, POOL, '0xd', 999n), // past the window
    t(99, POOL, '0xe', 999n), // before trading start
    t(102, POOL, '0xrouter', 999n), // excluded
    t(103, '0xa', POOL, 80n), // a sell
  ];
  const base = { transfers, pools: new Set([POOL]), tradingStartBlock: 100, windowBlocks: 10 };
  const isExcluded = (a: string) => a === '0xrouter';

  test('window bounds, exclusions, sells, per-wallet sums, largest first', () => {
    expect(selectEarlyBuyers({ ...base, isExcluded })).toEqual(buyers(['0xa', 150n], ['0xb', 120n], ['0xc', 10n]));
  });

  test('cap keeps the largest', () => {
    expect(selectEarlyBuyers({ ...base, isExcluded, max: 2 })).toEqual(buyers(['0xa', 150n], ['0xb', 120n]));
  });
});

describe('clusterFunding', () => {
  test('one funder fanning out to three wallets is one cluster', () => {
    const b = buyers(['0xa', 100_000n], ['0xb', 50_000n], ['0xc', 50_000n], ['0xd', 10_000n]);
    const r = cluster(b, { '0xa': '0xf', '0xb': '0xf', '0xc': '0xf', '0xd': '0xg' }, {
      balances: new Map([['0xa', 40_000n], ['0xb', 0n], ['0xc', 10_000n]]),
    });
    expect(r.traced).toBe(4);
    expect(r.untraced).toBe(0);
    expect(r.clusters).toEqual([{ funder: '0xf', wallets: 3, boughtPct: 20, stillHeldPct: 5 }]);
    expect(r.clusteredPct).toBe(20);
    expect(r.windowBlocks).toBe(150);
  });

  test('stillHeldPct is absent without balances', () => {
    const r = cluster(buyers(['0xa', 1n], ['0xb', 1n]), { '0xa': '0xf', '0xb': '0xf' });
    expect(r.clusters[0]).toEqual({ funder: '0xf', wallets: 2, boughtPct: 0.0002 });
  });

  test('a hub funder never links wallets', () => {
    const b = buyers(['0xa', 100_000n], ['0xb', 100_000n]);
    const r = cluster(b, { '0xa': '0xbinance', '0xb': '0xbinance' }, { isHub: (a: string) => a === '0xbinance' });
    expect(r.traced).toBe(2);
    expect(r.clusters).toEqual([]);
    expect(r.clusteredPct).toBe(0);
  });

  test('chained funding merges into one component', () => {
    // X funds A and B; A funds C
    const b = buyers(['0xa', 10_000n], ['0xb', 10_000n], ['0xc', 10_000n]);
    const r = cluster(b, { '0xa': '0xx', '0xb': '0xx', '0xc': '0xa' });
    expect(r.clusters).toEqual([{ funder: '0xx', wallets: 3, boughtPct: 3 }]);
  });

  test('funder tie breaks to the smallest address', () => {
    // votes: 0xx2 x1, 0xx1 x1, 0xa x1 (c bought via buyer a); one component
    const b = buyers(['0xa', 1n], ['0xb', 1n], ['0xc', 1n]);
    const r = cluster(b, { '0xa': '0xx2', '0xb': '0xx2', '0xc': '0xa' });
    expect(r.clusters[0]!.funder).toBe('0xx2'); // 2 votes beat the tie
    const tie = cluster(b, { '0xa': '0xx2', '0xb': '0xx1', '0xc': '0xa' });
    expect(tie.clusters).toEqual([{ funder: '0xa', wallets: 2, boughtPct: 0.0002 }]);
  });

  test('untraced buyers are counted, missing keys are ignored', () => {
    const b = buyers(['0xa', 10_000n], ['0xb', 10_000n], ['0xc', 10_000n], ['0xd', 10_000n]);
    const r = cluster(b, { '0xa': '0xf', '0xb': '0xf', '0xc': undefined });
    expect(r.traced).toBe(2);
    expect(r.untraced).toBe(1); // 0xd was never looked up
    expect(r.clusters).toEqual([{ funder: '0xf', wallets: 2, boughtPct: 2 }]);
  });

  test('self-funded buyer adds no edge', () => {
    const r = cluster(buyers(['0xa', 1n], ['0xb', 1n]), { '0xa': '0xa', '0xb': '0xb' });
    expect(r.traced).toBe(2);
    expect(r.clusters).toEqual([]);
  });

  test('two clusters sort by boughtPct, largest first', () => {
    const b = buyers(['0xa', 10_000n], ['0xb', 10_000n], ['0xc', 60_000n], ['0xd', 60_000n]);
    const r = cluster(b, { '0xa': '0xf1', '0xb': '0xf1', '0xc': '0xf2', '0xd': '0xf2' });
    expect(r.clusters.map((c) => [c.funder, c.boughtPct])).toEqual([['0xf2', 12], ['0xf1', 2]]);
    expect(r.clusteredPct).toBe(14);
  });

  test('one wallet per funder gives no clusters', () => {
    const b = buyers(['0xa', 10_000n], ['0xb', 10_000n]);
    const r = cluster(b, { '0xa': '0xf1', '0xb': '0xf2' });
    expect(r.traced).toBe(2);
    expect(r.clusters).toEqual([]);
    expect(r.clusteredPct).toBe(0);
  });
});
