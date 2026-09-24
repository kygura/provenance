import { describe, expect, test } from 'bun:test';
import { silentLogger, type PairInfo } from '@provenance/core';
import { encodeBalanceOf, SELECTORS } from './abi';
import { aggregateLp, measureLp, measurePair, MAX_LP_PAIRS } from './lp';
import { EVM_LP_LOCKERS } from './labels';
import { MockRpcTransport } from './mock';
import { Budget, RpcClient, type JsonRpcResult } from './rpc';

const ZERO = '0x0000000000000000000000000000000000000000';
const DEAD = '0x000000000000000000000000000000000000dead';
const UNICRYPT = EVM_LP_LOCKERS[0]?.address ?? '';
const TEAM = EVM_LP_LOCKERS[1]?.address ?? '';

const PAIR_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PAIR_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PAIR_V3 = '0xcccccccccccccccccccccccccccccccccccccccc';

function word(value: bigint): string {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

type PairState = { total?: bigint; revertTotal?: boolean; balances?: Record<string, bigint>; revertBalance?: boolean };

/** Serves V2-pair reads from a per-pair table keyed by `to`. */
function pairTransport(pairs: Record<string, PairState>): MockRpcTransport {
  return new MockRpcTransport({
    handlers: {
      eth_call: ({ call }): JsonRpcResult => {
        const { to, data } = call.params[0] as { to: string; data: string };
        const state = pairs[to];
        if (!state) return { error: { code: 3, message: 'execution reverted' } };
        if (data === SELECTORS.totalSupply) {
          return state.revertTotal ? { error: { code: 3, message: 'execution reverted' } } : { result: word(state.total ?? 0n) };
        }
        if (state.revertBalance) return { error: { code: 3, message: 'execution reverted' } };
        for (const [holder, amount] of Object.entries(state.balances ?? {})) {
          if (data === encodeBalanceOf(holder)) return { result: word(amount) };
        }
        return { result: word(0n) };
      },
    },
  });
}

function client(transport: MockRpcTransport, budget?: Budget): RpcClient {
  return new RpcClient({
    endpoints: ['mock://evm'],
    transport,
    logger: silentLogger,
    attempts: 1,
    ...(budget ? { budget } : {}),
  });
}

const E18 = 10n ** 18n;

describe('measurePair', () => {
  test('burned counts both burn sinks; locked counts both lockers; all as % of LP supply', async () => {
    const transport = pairTransport({
      [PAIR_A]: { total: 100n * E18, balances: { [ZERO]: 1000n, [DEAD]: 40n * E18, [UNICRYPT]: 25n * E18, [TEAM]: 5n * E18 } },
    });
    const result = await measurePair(client(transport), { pairAddress: PAIR_A });
    expect(result.status).toBe('measured');
    if (result.status !== 'measured') return;
    expect(result.burnedPct).toBeCloseTo(40, 6);
    expect(result.lockedPct).toBeCloseTo(30, 6);
    // One batched round trip: totalSupply + 2 burn sinks + 2 lockers.
    expect(transport.requests).toHaveLength(1);
    expect(transport.callsTo('eth_call')).toHaveLength(5);
  });

  test('a reverting totalSupply is a concentrated-liquidity pool, not an unlocked one', async () => {
    const transport = pairTransport({ [PAIR_V3]: { revertTotal: true } });
    expect((await measurePair(client(transport), { pairAddress: PAIR_V3 })).status).toBe('concentrated');
  });

  test('a zero totalSupply is treated the same way', async () => {
    const transport = pairTransport({ [PAIR_V3]: { total: 0n } });
    expect((await measurePair(client(transport), { pairAddress: PAIR_V3 })).status).toBe('concentrated');
  });

  test('a bytes32 pool id (Uniswap V4) is never sent as an address', async () => {
    const transport = pairTransport({});
    const result = await measurePair(client(transport), { pairAddress: `0x${'ab'.repeat(32)}` });
    expect(result.status).toBe('concentrated');
    expect(transport.calls).toHaveLength(0);
  });

  test('an unreadable balance fails the pair rather than counting as zero', async () => {
    const transport = pairTransport({ [PAIR_A]: { total: 100n * E18, revertBalance: true } });
    expect((await measurePair(client(transport), { pairAddress: PAIR_A })).status).toBe('failed');
  });
});

describe('aggregateLp', () => {
  test('weights by pair liquidity when every measured pair has it', () => {
    const result = aggregateLp([
      { status: 'measured', pairAddress: PAIR_A, liquidityUsd: 300, burnedPct: 100, lockedPct: 0 },
      { status: 'measured', pairAddress: PAIR_B, liquidityUsd: 100, burnedPct: 0, lockedPct: 80 },
    ]);
    expect(result.lpBurnedPct).toBeCloseTo(75, 6);
    expect(result.lpLockedPct).toBeCloseTo(20, 6);
  });

  test('falls back to the deepest pair when any weight is missing', () => {
    const result = aggregateLp([
      { status: 'measured', pairAddress: PAIR_A, burnedPct: 10, lockedPct: 0 },
      { status: 'measured', pairAddress: PAIR_B, liquidityUsd: 5, burnedPct: 90, lockedPct: 0 },
    ]);
    expect(result.lpBurnedPct).toBe(90);
    expect(result.notes.join(' ')).toContain(PAIR_B);
  });

  test('with no liquidity figures at all, the first pair stands in', () => {
    const result = aggregateLp([
      { status: 'measured', pairAddress: PAIR_A, burnedPct: 10, lockedPct: 0 },
      { status: 'measured', pairAddress: PAIR_B, burnedPct: 90, lockedPct: 0 },
    ]);
    expect(result.lpBurnedPct).toBe(10);
  });

  test('only concentrated pools: both undefined, with the reason', () => {
    const result = aggregateLp([{ status: 'concentrated', pairAddress: PAIR_V3 }]);
    expect(result.lpBurnedPct).toBeUndefined();
    expect(result.lpLockedPct).toBeUndefined();
    expect(result.notes.join(' ')).toContain('concentrated-liquidity');
  });

  test('a partially measured set says what it covers', () => {
    const result = aggregateLp([
      { status: 'measured', pairAddress: PAIR_A, liquidityUsd: 1, burnedPct: 100, lockedPct: 0 },
      { status: 'concentrated', pairAddress: PAIR_V3 },
    ]);
    expect(result.lpBurnedPct).toBe(100);
    expect(result.notes.join(' ')).toContain('1 of 2 pair(s)');
  });
});

describe('measureLp', () => {
  test('measures the deepest pairs first and caps the count', async () => {
    const transport = pairTransport({});
    const pairs: PairInfo[] = Array.from({ length: MAX_LP_PAIRS + 2 }, (_, index) => ({
      pairAddress: `0x${String(index + 1).repeat(40)}`,
      liquidityUsd: index,
    }));
    await measureLp(client(transport), pairs);
    const targets = [...new Set(transport.callsTo('eth_call').map((call) => (call.params[0] as { to: string }).to))];
    expect(targets).toHaveLength(MAX_LP_PAIRS);
    expect(targets[0]).toBe(`0x${'5'.repeat(40)}`);
  });

  test('no pairs is a note, not a zero', async () => {
    const result = await measureLp(client(pairTransport({})), []);
    expect(result.lpBurnedPct).toBeUndefined();
    expect(result.notes.join(' ')).toContain('No pairs');
  });

  test('an exhausted budget stops before calling anything', async () => {
    const transport = pairTransport({ [PAIR_A]: { total: 1n } });
    const budget = new Budget(0);
    const result = await measureLp(client(transport, budget), [{ pairAddress: PAIR_A }], budget);
    expect(transport.calls).toHaveLength(0);
    expect(result.notes.join(' ')).toContain('budget');
  });

  test('a dead endpoint degrades to a note', async () => {
    const transport = new MockRpcTransport({ failing: ['mock://evm'] });
    const result = await measureLp(client(transport), [{ pairAddress: PAIR_A }]);
    expect(result.lpBurnedPct).toBeUndefined();
    expect(result.notes.join(' ')).toContain('LP read failed');
  });
});
