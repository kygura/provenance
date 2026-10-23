import { describe, expect, test } from 'bun:test';
import { loadConfig, silentLogger, type AppConfig, type TokenSnapshot } from '@provenance/core';
import { analyzeEvm } from './evm';
import { createFixtureTransport } from './fixtures';
import { MemoryCache } from '@provenance/core/cache';
import { MockRpcTransport } from './mock';

const NYAN = '0x9f2c4b1ea7d0ab3e6c5f81d2a94b7e03cd15a8fe';
const NYAN_PAIR = '0x31d8a77bc4e2059f6a0c8d17b3e94f2051ca7d60';

function app(): AppConfig {
  const base = loadConfig({});
  return {
    ...base,
    rpc: { ...base.rpc, ethereum: ['fixture://ethereum'] },
    pipeline: { ...base.pipeline, useFixtures: true },
  };
}

function nyan(): TokenSnapshot {
  return {
    tokenId: `ethereum:${NYAN}`,
    chain: 'ethereum',
    tokenAddress: NYAN,
    symbol: 'NYAN',
    name: 'Nyan Cat',
    socials: {},
    metrics: {},
    pairs: [{ pairAddress: NYAN_PAIR, liquidityUsd: 1_240_000 }],
    appearances: [],
    bestRank: 2,
    sourceCount: 1,
    capturedAt: new Date().toISOString(),
  };
}

describe('analyzeEvm contract surface, against the NYAN fixture', () => {
  test('reads bytecode, LP and ownership into a clean report', async () => {
    const transport = await createFixtureTransport();
    const config = app();
    const analysis = await analyzeEvm(nyan(), { app: config, logger: silentLogger }, async () => transport, {}, config, silentLogger);

    // The fixture code hides mint's selector inside a PUSH32; it must not count.
    expect(analysis.privilegedFunctions).toEqual([]);
    expect(analysis.lpBurnedPct).toBeCloseTo(100, 6);
    expect(analysis.lpLockedPct).toBe(0);
    // Token burn is still reported, on the field that describes it. (Its value
    // is not pinned: the fixture's unpinned eth_getLogs entry answers every
    // chunk of the scan, so the replayed balances are multiplied.)
    expect(analysis.supply?.burnedPct).toBeGreaterThan(0);
    expect(analysis.contractVerified).toBeUndefined();

    const codes = analysis.flags.map((flag) => flag.code);
    expect(codes).not.toContain('lp-not-burned');
    expect(codes.some((code) => code.startsWith('privileged-'))).toBe(false);
    expect(transport.missedCalls).toEqual([]);
  });

  test('token supply at 0x…dead is no longer reported as LP burn', async () => {
    // Regression: lpBurnedPct used to be the token share at burn addresses.
    const transport = await createFixtureTransport();
    const config = app();
    const snapshot = { ...nyan(), pairs: [] };
    const analysis = await analyzeEvm(snapshot, { app: config, logger: silentLogger }, async () => transport, {}, config, silentLogger);
    expect(analysis.supply?.burnedPct).toBeGreaterThan(0);
    expect(analysis.lpBurnedPct).toBeUndefined();
    expect(analysis.notes.join(' ')).toContain('No pairs');
  });

  test('bytecode, LP and explorer failures degrade to notes', async () => {
    const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;
    const transport = new MockRpcTransport({
      handlers: {
        eth_call: ({ call }) => {
          const { to, data } = call.params[0] as { to: string; data: string };
          if (to === NYAN_PAIR) return { error: { code: 3, message: 'execution reverted' } };
          if (data === '0x313ce567') return { result: word(18n) };
          if (data === '0x18160ddd') return { result: word(10n ** 24n) };
          return { error: { code: 3, message: 'execution reverted' } };
        },
        eth_getCode: () => ({ error: { code: -32000, message: 'method not allowed' } }),
        eth_blockNumber: () => ({ error: { code: -32000, message: 'down' } }),
      },
    });
    const config = { ...app(), pipeline: { ...app().pipeline, useFixtures: false } };
    const analysis = await analyzeEvm(nyan(), { app: config, logger: silentLogger }, async () => transport, {}, config, silentLogger);

    expect(analysis.method).toBe('partial');
    expect(analysis.privilegedFunctions).toBeUndefined();
    expect(analysis.lpBurnedPct).toBeUndefined();
    const notes = analysis.notes.join(' ');
    expect(notes).toContain('Could not read token bytecode');
    expect(notes).toContain('concentrated-liquidity');
    expect(notes).toContain('ETHERSCAN_API_KEY');
  });

  test('a Uniswap v4 pool id does not abort holder analysis', async () => {
    // Regression: v4 pairs carry a 32-byte pool id, which normalizeAddress threw on.
    const transport = await createFixtureTransport();
    const config = app();
    const poolId = `0x${'ab'.repeat(32)}`;
    const snapshot = { ...nyan(), pairs: [{ pairAddress: poolId, liquidityUsd: 50_000 }] };
    const analysis = await analyzeEvm(snapshot, { app: config, logger: silentLogger }, async () => transport, {}, config, silentLogger);
    expect(analysis.supply?.burnedPct).toBeGreaterThan(0);
    expect(analysis.topHolders?.length ?? 0).toBeGreaterThan(0);
  });

  test('a refused log range is retried with a narrower window', async () => {
    const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;
    const ranges: number[] = [];
    const transport = new MockRpcTransport({
      handlers: {
        eth_call: ({ call }) => {
          const { data } = call.params[0] as { data: string };
          if (data === '0x313ce567') return { result: word(18n) };
          if (data === '0x18160ddd') return { result: word(10n ** 24n) };
          return { error: { code: 3, message: 'execution reverted' } };
        },
        eth_getCode: () => ({ result: '0x' }),
        // One block below a multiple of 9000, so the head chunk is a full cell.
        eth_blockNumber: () => ({ result: `0x${(9_000 * 1_866 - 1).toString(16)}` }),
        eth_getLogs: ({ call }) => {
          const { fromBlock, toBlock } = call.params[0] as { fromBlock: string; toBlock: string };
          const span = Number(BigInt(toBlock) - BigInt(fromBlock)) + 1;
          ranges.push(span);
          if (span > 2_000) return { error: { code: -32005, message: 'block range too large' } };
          return { result: [] };
        },
      },
    });
    const config = { ...app(), pipeline: { ...app().pipeline, useFixtures: false } };
    const analysis = await analyzeEvm(nyan(), { app: config, logger: silentLogger }, async () => transport, { maxChunks: 3 }, config, silentLogger);
    expect(ranges[0]).toBe(9_000);
    expect(ranges.slice(1).every((span) => span <= 2_000)).toBe(true);
    expect(ranges.length).toBe(4);
    expect(analysis.notes.join(' ')).not.toContain('Log scan stopped');
  });

  test('finalized Transfer-log chunks come from the cache on the next analysis', async () => {
    const word = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`;
    let head = 9_000 * 1_866 + 4_000;
    const ranges: Array<[number, number]> = [];
    const transport = new MockRpcTransport({
      handlers: {
        eth_call: ({ call }) => {
          const { data } = call.params[0] as { data: string };
          if (data === '0x313ce567') return { result: word(18n) };
          if (data === '0x18160ddd') return { result: word(10n ** 24n) };
          return { error: { code: 3, message: 'execution reverted' } };
        },
        eth_getCode: () => ({ result: '0x' }),
        eth_blockNumber: () => ({ result: `0x${head.toString(16)}` }),
        eth_getLogs: ({ call }) => {
          const { fromBlock, toBlock } = call.params[0] as { fromBlock: string; toBlock: string };
          ranges.push([Number(BigInt(fromBlock)), Number(BigInt(toBlock))]);
          const holder = `0x${'0'.repeat(24)}${'ab'.repeat(20)}`;
          // One mint per chunk, so the scan has balances and reaches its notes.
          return {
            result: [
              {
                topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', `0x${'0'.repeat(64)}`, holder],
                data: word(10n ** 18n),
                blockNumber: toBlock,
                transactionHash: `0x${'1'.repeat(64)}`,
                logIndex: '0x0',
              },
            ],
          };
        },
      },
    });
    const config = { ...app(), pipeline: { ...app().pipeline, useFixtures: false } };
    const cache = new MemoryCache();
    const run = () =>
      analyzeEvm(nyan(), { app: config, logger: silentLogger }, async () => transport, { maxChunks: 3, cache }, config, silentLogger);

    await run();
    const first = ranges.splice(0);
    // Head chunk plus three full cells; the oldest is clipped by the span, so two are cached.
    expect(first.length).toBe(4);
    expect(cache.entries.size).toBe(2);

    head += 100;
    const analysis = await run();
    expect(ranges[0]).toEqual([9_000 * 1_866, head]);
    expect(ranges.length).toBe(2);
    expect(analysis.notes.join(' ')).toContain('2 finalized log chunk(s) read from the cross-run cache');
  });
});
