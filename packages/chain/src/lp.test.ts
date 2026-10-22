import { describe, expect, test } from 'bun:test';
import { silentLogger, type PairInfo } from '@provenance/core';
import { encodeBalanceOf, SELECTORS } from './abi';
import {
  aggregateLp,
  ERC721_OWNER_OF_SELECTOR,
  MAX_LP_PAIRS,
  MAX_V3_MINTS,
  measureLp,
  measurePair,
  measureV3Pool,
  V3_INCREASE_LIQUIDITY_TOPIC0,
  V3_INITIALIZE_TOPIC0,
  V3_LIQUIDITY_SELECTOR,
  V3_MINT_TOPIC0,
  V3_POSITIONS_SELECTOR,
  V3_SLOT0_SELECTOR,
} from './lp';
import { EVM_LP_LOCKERS, UNISWAP_V3_POSITION_MANAGERS } from './labels';
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

// ---------------------------------------------------------------- Uniswap V3

const NPM = UNISWAP_V3_POSITION_MANAGERS.ethereum ?? '';
const EOA = '0x1111111111111111111111111111111111111111';
const HEAD = 1_000;

function topicOf(address: string): string {
  return `0x${address.slice(2).padStart(64, '0')}`;
}

function words(...values: bigint[]): string {
  return `0x${values.map((value) => value.toString(16).padStart(64, '0')).join('')}`;
}

interface V3Mint {
  owner: string;
  amount: bigint;
  tx: string;
  /** NPM token id minted in that tx; omitted for direct mints. */
  tokenId?: bigint;
  /** Defaults to full range. */
  ticks?: [number, number];
}

const FULL: [number, number] = [-887_220, 887_220];

/** int24 sign-extended into one ABI word. */
function tickWord(tick: number): bigint {
  return BigInt.asUintN(256, BigInt(tick));
}

interface V3State {
  mints: V3Mint[];
  /** tokenId → current liquidity and holder; absent = burned NFT (both revert). */
  positions?: Record<string, { liquidity: bigint; owner: string; ticks?: [number, number] }>;
  failReceipts?: boolean;
  /** The pool's Initialize happened before the scan window. */
  initializedEarlier?: boolean;
  /** Pool `liquidity()` (default 0, i.e. nothing untraced). */
  poolLiquidity?: bigint;
}

const revert = { error: { code: 3, message: 'execution reverted' } };

function v3Transport(state: V3State): MockRpcTransport {
  return new MockRpcTransport({
    handlers: {
      eth_blockNumber: () => ({ result: `0x${HEAD.toString(16)}` }),
      eth_getLogs: ({ call }): JsonRpcResult => {
        const filter = call.params[0] as { address: string; topics: string[][]; fromBlock: string };
        // Every log sits in block 0, so only the first chunk sees them.
        if (filter.address !== PAIR_V3 || filter.fromBlock !== '0x0') return { result: [] };
        expect(filter.topics[0]).toEqual([V3_MINT_TOPIC0, V3_INITIALIZE_TOPIC0]);
        const init = state.initializedEarlier
          ? []
          : [{ address: PAIR_V3, topics: [V3_INITIALIZE_TOPIC0], data: words(1n, 0n), transactionHash: `0x${'00'.repeat(32)}`, logIndex: '0x0' }];
        return {
          result: [...init, ...state.mints.map((mint, index) => ({
            address: PAIR_V3,
            topics: [V3_MINT_TOPIC0, topicOf(mint.owner), word(tickWord((mint.ticks ?? FULL)[0])), word(tickWord((mint.ticks ?? FULL)[1]))],
            data: words(BigInt(`0x${NPM.slice(2)}`), mint.amount, 1n, 1n),
            transactionHash: mint.tx,
            logIndex: `0x${(index * 2 + 2).toString(16)}`,
          }))],
        };
      },
      eth_getTransactionReceipt: ({ call }): JsonRpcResult => {
        if (state.failReceipts) return { result: null };
        const tx = call.params[0] as string;
        const logs = state.mints
          .map((mint, index) => ({ mint, index }))
          .filter(({ mint }) => mint.tx === tx && mint.tokenId !== undefined)
          .map(({ mint, index }) => ({
            address: NPM,
            topics: [V3_INCREASE_LIQUIDITY_TOPIC0, word(mint.tokenId ?? 0n)],
            data: words(mint.amount, 1n, 1n),
            logIndex: `0x${(index * 2 + 3).toString(16)}`,
          }));
        return { result: { logs } };
      },
      eth_call: ({ call }): JsonRpcResult => {
        const { to, data } = call.params[0] as { to: string; data: string };
        if (to === PAIR_V3 && data === V3_SLOT0_SELECTOR) return { result: words(1n, 0n, 0n, 0n, 0n, 0n, 1n) };
        if (to === PAIR_V3 && data === V3_LIQUIDITY_SELECTOR) return { result: word(state.poolLiquidity ?? 0n) };
        if (to !== NPM) return revert; // the pool has no totalSupply
        const id = BigInt(`0x${data.slice(10)}`).toString();
        const position = state.positions?.[id];
        if (!position) return revert;
        if (data.startsWith(V3_POSITIONS_SELECTOR)) return { result: words(0n, 0n, 0n, 0n, 3000n, tickWord((position.ticks ?? FULL)[0]), tickWord((position.ticks ?? FULL)[1]), position.liquidity, 0n, 0n, 0n, 0n) };
        if (data.startsWith(ERC721_OWNER_OF_SELECTOR)) return { result: topicOf(position.owner) };
        return revert;
      },
    },
  });
}

const SCOPE = { chain: 'ethereum' as const, fromBlock: 0 };
const TX1 = `0x${'01'.repeat(32)}`;
const TX2 = `0x${'02'.repeat(32)}`;

describe('Uniswap V3 LP', () => {
  test('an NFT position held by the dead address is 100% burned', async () => {
    const transport = v3Transport({
      mints: [{ owner: NPM, amount: 500n, tx: TX1, tokenId: 7n }],
      positions: { '7': { liquidity: 500n, owner: DEAD } },
    });
    const result = await measurePair(client(transport), { pairAddress: PAIR_V3, liquidityUsd: 9 }, SCOPE);
    expect(result).toEqual({ status: 'measured', pairAddress: PAIR_V3, liquidityUsd: 9, burnedPct: 100, lockedPct: 0 });
  });

  test('an NFT held by Team Finance counts as locked', async () => {
    const transport = v3Transport({
      mints: [{ owner: NPM, amount: 500n, tx: TX1, tokenId: 7n }],
      positions: { '7': { liquidity: 800n, owner: TEAM } },
    });
    const result = await measureV3Pool(client(transport), PAIR_V3, SCOPE);
    expect(result.status === 'measured' && [result.burnedPct, result.lockedPct]).toEqual([0, 100]);
  });

  test('an NFT held by an EOA is measured as 0% secured, and the gate can reject it', async () => {
    const transport = v3Transport({
      mints: [{ owner: NPM, amount: 500n, tx: TX1, tokenId: 7n }],
      positions: { '7': { liquidity: 500n, owner: EOA } },
    });
    const result = await measureLp(client(transport), [{ pairAddress: PAIR_V3 }], undefined, SCOPE);
    expect(result.lpBurnedPct).toBe(0);
    expect(result.lpLockedPct).toBe(0);
  });

  test('a direct mint is unsecured liquidity; a withdrawn (burned) NFT drops out', async () => {
    const transport = v3Transport({
      mints: [
        { owner: NPM, amount: 100n, tx: TX1, tokenId: 7n },
        { owner: NPM, amount: 50n, tx: TX1, tokenId: 8n },
        { owner: EOA, amount: 300n, tx: TX2 },
      ],
      positions: { '7': { liquidity: 100n, owner: DEAD } }, // token 8 burned: both calls revert
    });
    const result = await measureV3Pool(client(transport), PAIR_V3, SCOPE);
    expect(result.status === 'measured' && result.burnedPct).toBeCloseTo(25, 6);
    // One receipt per distinct NPM tx, one positions+ownerOf pair per token id.
    expect(transport.callsTo('eth_getTransactionReceipt')).toHaveLength(1);
    expect(transport.callsTo('eth_call').filter((call) => (call.params[0] as { to: string }).to === NPM)).toHaveLength(4);
  });

  test('no Mint logs: concentrated, and the note reaches the measurement', async () => {
    const transport = v3Transport({ mints: [] });
    const result = await measureLp(client(transport), [{ pairAddress: PAIR_V3 }], undefined, SCOPE);
    expect(result.lpBurnedPct).toBeUndefined();
    expect(result.notes.join(' ')).toContain('no Mint logs');
  });

  test('an unavailable receipt degrades to concentrated with a note', async () => {
    const transport = v3Transport({ mints: [{ owner: NPM, amount: 1n, tx: TX1, tokenId: 1n }], failReceipts: true });
    const result = await measureV3Pool(client(transport), PAIR_V3, SCOPE);
    expect(result.status).toBe('concentrated');
    expect(result.status === 'concentrated' && result.note).toContain('receipt');
  });

  test('a pool busier than the cap is not traced', async () => {
    const mints = Array.from({ length: MAX_V3_MINTS + 1 }, () => ({ owner: EOA, amount: 1n, tx: TX2 }));
    const transport = v3Transport({ mints });
    const result = await measureV3Pool(client(transport), PAIR_V3, SCOPE);
    expect(result.status).toBe('concentrated');
    expect(transport.callsTo('eth_getTransactionReceipt')).toHaveLength(0);
  });

  test('scans in chunks to head and gives up rather than measure a partial range', async () => {
    const mints = [{ owner: EOA, amount: 1n, tx: TX2 }];
    const ok = v3Transport({ mints });
    expect((await measureV3Pool(client(ok), PAIR_V3, { ...SCOPE, chunkBlocks: 400 })).status).toBe('measured');
    expect(ok.callsTo('eth_getLogs')).toHaveLength(3); // 0-399, 400-799, 800-1000
    const short = v3Transport({ mints });
    const result = await measureV3Pool(client(short), PAIR_V3, { ...SCOPE, chunkBlocks: 400, maxChunks: 2 });
    expect(result.status === 'concentrated' && result.note).toContain('did not reach head');
  });

  test('an expired budget degrades before any log request', async () => {
    const transport = v3Transport({ mints: [{ owner: EOA, amount: 1n, tx: TX2 }] });
    const result = await measureV3Pool(client(transport), PAIR_V3, { ...SCOPE, toBlock: HEAD, budget: new Budget(0) });
    expect(result.status === 'concentrated' && result.note).toContain('budget');
    expect(transport.callsTo('eth_getLogs')).toHaveLength(0);
  });

  test('a chain with no known position manager, or no scope at all, stays concentrated', async () => {
    const transport = v3Transport({ mints: [{ owner: EOA, amount: 1n, tx: TX2 }] });
    expect((await measurePair(client(transport), { pairAddress: PAIR_V3 }, { chain: 'bsc', fromBlock: 0 })).status).toBe('concentrated');
    expect((await measurePair(client(transport), { pairAddress: PAIR_V3 })).status).toBe('concentrated');
    expect(transport.callsTo('eth_getLogs')).toHaveLength(0);
  });

  test('a pool initialized before the scan window is not measured (older positions are untraced)', async () => {
    const transport = v3Transport({
      initializedEarlier: true,
      mints: [{ owner: NPM, amount: 1n, tx: TX1, tokenId: 7n }],
      positions: { '7': { liquidity: 1n, owner: DEAD } },
    });
    const result = await measureV3Pool(client(transport), PAIR_V3, SCOPE);
    expect(result.status === 'concentrated' && result.note).toContain('initialized before');
  });

  test('pool liquidity above the traced in-range total means untraced positions', async () => {
    const transport = v3Transport({
      mints: [{ owner: NPM, amount: 100n, tx: TX1, tokenId: 7n }],
      positions: { '7': { liquidity: 100n, owner: DEAD } },
      poolLiquidity: 5_000n,
    });
    const result = await measureV3Pool(client(transport), PAIR_V3, SCOPE);
    expect(result.status === 'concentrated' && result.note).toContain('untraced');
    const exact = v3Transport({
      mints: [{ owner: NPM, amount: 100n, tx: TX1, tokenId: 7n }],
      positions: { '7': { liquidity: 100n, owner: DEAD } },
      poolLiquidity: 100n,
    });
    expect((await measureV3Pool(client(exact), PAIR_V3, SCOPE)).status).toBe('measured');
  });

  test('a narrow locked sliver cannot outweigh an unlocked full-range position', async () => {
    const transport = v3Transport({
      mints: [
        { owner: NPM, amount: 1_000_000n, tx: TX1, tokenId: 7n, ticks: [-60, 60] },
        { owner: NPM, amount: 10_000n, tx: TX2, tokenId: 8n },
      ],
      positions: {
        '7': { liquidity: 1_000_000n, owner: TEAM, ticks: [-60, 60] },
        '8': { liquidity: 10_000n, owner: EOA },
      },
    });
    const result = await measureV3Pool(client(transport), PAIR_V3, SCOPE);
    expect(result.status === 'measured' && [result.burnedPct, result.lockedPct]).toEqual([0, 0]);
  });
});
