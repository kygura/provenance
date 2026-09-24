import { describe, expect, test } from 'bun:test';
import { loadConfig, silentLogger, type AppConfig, type TokenSnapshot } from '@provenance/core';
import { analyzeEvm } from './evm';
import { createFixtureTransport } from './fixtures';
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
});
