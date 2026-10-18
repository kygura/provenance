import { describe, expect, test } from 'bun:test';
import { evaluateFlags } from './flags';
import { measureSniping, snipeWindowBlocks, type PoolTransfer } from './sniping';

const POOL = '0xpool';
const DEPLOYER = '0xdeployer';
const ROUTER = '0xrouter';
const SUPPLY = 1_000_000n;

function t(block: number, from: string, to: string, value: bigint): PoolTransfer {
  return { block, from, to, value };
}

function measure(transfers: PoolTransfer[], balances?: Map<string, bigint>) {
  return measureSniping({
    transfers,
    pools: new Set([POOL]),
    totalRaw: SUPPLY,
    blockSeconds: 12,
    isExcluded: (address) => address === ROUTER,
    ...(balances ? { balances } : {}),
  });
}

describe('measureSniping', () => {
  test('the window is 36 seconds of blocks, at least one', () => {
    expect(snipeWindowBlocks(12)).toBe(3);
    expect(snipeWindowBlocks(2)).toBe(18);
    expect(snipeWindowBlocks(60)).toBe(1);
  });

  test('counts buys from trading start, not from the liquidity add', () => {
    const transfers = [
      t(100, DEPLOYER, POOL, SUPPLY),
      // trading enabled ten blocks later: the snipe lands here
      t(110, POOL, '0xa', 150_000n),
      t(110, POOL, '0xb', 100_000n),
      t(110, POOL, '0xc', 50_000n),
      t(112, POOL, '0xd', 20_000n),
      t(113, POOL, '0xe', 999_999n), // outside the 3-block window
      t(111, POOL, ROUTER, 5_000n), // router, not a buyer
      t(111, '0xa', POOL, 10_000n), // a sell, not a buy
    ];
    const sniping = measure(transfers, new Map([['0xa', 140_000n], ['0xb', 0n], ['0xc', 50_000n], ['0xd', 20_000n]]));
    expect(sniping).toEqual({
      tradingStartBlock: 110,
      windowBlocks: 3,
      earlyBuyers: 4,
      sameBlockBuyers: 3,
      earlyBuyPct: 32,
      stillHeldPct: 21,
    });
  });

  test('says nothing when trading has not started or the scan began mid-life', () => {
    expect(measure([t(100, DEPLOYER, POOL, SUPPLY)])).toBeUndefined();
    // a buy with no liquidity add before it: the scan missed the launch
    expect(measure([t(200, POOL, '0xa', 10n), t(201, '0xb', POOL, 10n)])).toBeUndefined();
  });

  test('stillHeldPct is absent without balances', () => {
    const sniping = measure([t(100, DEPLOYER, POOL, SUPPLY), t(100, POOL, '0xa', 10_000n)]);
    expect(sniping?.stillHeldPct).toBeUndefined();
    expect(sniping?.earlyBuyPct).toBe(1);
  });
});

describe('sniping flags', () => {
  const flagsFor = (earlyBuyPct: number, sameBlockBuyers = 0) =>
    evaluateFlags({
      analysis: {
        method: 'rpc',
        holderCount: 300,
        sniping: { tradingStartBlock: 1, windowBlocks: 3, earlyBuyers: 30, sameBlockBuyers, earlyBuyPct, stillHeldPct: 12 },
      },
    }).filter((flag) => flag.code === 'sniped-launch' || flag.code === 'bundled-launch');

  test('warn at 15%, critical at 30%, nothing below', () => {
    expect(flagsFor(14.9)).toEqual([]);
    expect(flagsFor(15)[0]).toMatchObject({ code: 'sniped-launch', severity: 'warn' });
    const critical = flagsFor(30)[0];
    expect(critical).toMatchObject({ code: 'sniped-launch', severity: 'critical' });
    expect(critical?.detail).toContain('still hold 12');
  });

  test('three or more opening-block buyers is a bundle', () => {
    expect(flagsFor(1, 2)).toEqual([]);
    expect(flagsFor(1, 3)[0]).toMatchObject({ code: 'bundled-launch', severity: 'warn' });
  });
});
