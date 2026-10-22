import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type AppConfig, type Logger, type SourceConfig, loadConfig, silentLogger } from '@provenance/core';

import { readEnrichment } from './enrichment';
import { fixtureDir } from './fixtures';
import {
  LAUNCH_FACTORIES,
  LaunchSource,
  PAIR_CREATED_TOPIC,
  POOL_CREATED_TOPIC,
  type PoolCreation,
  collectLaunches,
  estimateCreatedAt,
  launchedSide,
  lookbackBlocks,
  parseFactoryLog,
  parseFactoryLogs,
  walkFactoryLogs,
} from './launches';
import { JsonRpcClient, type RpcCaller, hexToNumber } from './rpc';

const ETH = LAUNCH_FACTORIES.find((spec) => spec.chain === 'ethereum')!;

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const SHREK = '0x5b3e7f2a9c14d8e06b71a4c2f9d3e8b1a7c50d42';
const KERMIT = '0xe41d6a9b3c72f05e8d1a6b4c93f27e0d5a8c1b76';
const FRESH = '0xd7c2a85f1e39b04c6a2d8f13e5b97c40a6f21e39';
const SHREK_V2_PAIR = '0x9a4c7e21b5d83f60a2c9e14d7b3f58a06e2d1c95';
const SHREK_V3_POOL = '0x3d6e1a8f4c27b90e5d3a6c81f2b47e09a5c3d718';
const KERMIT_POOL = '0x8b2f5d19e6a40c73b8d2e5f16a9c37b04e8d2a61';
const FRESH_PAIR = '0x4e9a2c7d1b85f36e0a4c9d27b1e83f5a6c0d9b42';

interface LogsFixture {
  chain: string;
  head: string;
  headTimestamp: string;
  logs: Record<string, unknown>[];
}

const logsFixture = JSON.parse(
  readFileSync(join(fixtureDir('launches'), 'factory-logs-ethereum.json'), 'utf8'),
) as LogsFixture;
const hydrationFixture = JSON.parse(
  readFileSync(join(fixtureDir('launches'), 'dexscreener-tokens.json'), 'utf8'),
) as unknown;
const HEAD = hexToNumber(logsFixture.head)!;
const ANCHOR = new Date(logsFixture.headTimestamp);

function logFor(pool: string): Record<string, unknown> {
  const found = logsFixture.logs.find((log) => JSON.stringify(log).includes(pool.slice(2)));
  if (!found) throw new Error(`fixture has no log for ${pool}`);
  return found;
}

function makeApp(env: Record<string, string> = {}): AppConfig {
  // Fixture pools span 21h; pin the window the fixtures were written for.
  return loadConfig({ USE_FIXTURES: '1', LAUNCHES_LOOKBACK_HOURS: '24', ...env });
}

function launchConfig(app: AppConfig): SourceConfig {
  return app.pipeline.sources.find((source) => source.id === 'launches')!;
}

describe('topic0 constants', () => {
  test('are the well-known Uniswap factory event hashes', () => {
    expect(PAIR_CREATED_TOPIC).toBe('0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9');
    expect(POOL_CREATED_TOPIC).toBe('0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118');
  });
});

describe('parseFactoryLog', () => {
  test('V2 PairCreated: tokens from topics 1-2, pair from the FIRST data word', () => {
    const parsed = parseFactoryLog(logFor(SHREK_V2_PAIR), ETH);
    expect(parsed).toMatchObject({
      version: 'v2',
      dexId: 'uniswap',
      factory: '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f',
      token0: SHREK,
      token1: WETH,
      pool: SHREK_V2_PAIR,
      blockNumber: HEAD - 6300,
    });
    expect(parsed?.fee).toBeUndefined();
    expect(parsed?.logIndex).toBe(0x12);
  });

  test('V3 PoolCreated: fee from topic 3, tickSpacing then pool in data', () => {
    const parsed = parseFactoryLog(logFor(SHREK_V3_POOL), ETH);
    expect(parsed).toMatchObject({
      version: 'v3',
      factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984',
      token0: SHREK,
      token1: WETH,
      fee: 10_000,
      tickSpacing: 200,
      pool: SHREK_V3_POOL,
    });
  });

  test('V3 tickSpacing is decoded as signed', () => {
    const log = { ...logFor(KERMIT_POOL) };
    log.data = `0x${'f'.repeat(64)}${(log.data as string).slice(66)}`;
    expect(parseFactoryLog(log, ETH)?.tickSpacing).toBe(-1);
    expect(parseFactoryLog(log, ETH)?.pool).toBe(KERMIT_POOL);
  });

  test('rejects forged emitters, mismatched topic/factory, reorged and malformed logs', () => {
    const v2 = logFor(SHREK_V2_PAIR);
    expect(parseFactoryLog({ ...v2, address: '0x000000000000000000000000000000000000dead' }, ETH)).toBeUndefined();
    // A V2 topic from the V3 factory is not an event that factory emits.
    expect(parseFactoryLog({ ...v2, address: '0x1f98431c8ad98523631ae4a59f267346ea31f984' }, ETH)).toBeUndefined();
    expect(parseFactoryLog({ ...v2, removed: true }, ETH)).toBeUndefined();
    expect(parseFactoryLog({ ...v2, data: '0x1234' }, ETH)).toBeUndefined();
    expect(parseFactoryLog({ ...v2, blockNumber: 'latest' }, ETH)).toBeUndefined();
    const v3 = logFor(KERMIT_POOL);
    expect(parseFactoryLog({ ...v3, data: (v3.data as string).slice(0, 66) }, ETH)).toBeUndefined();
    expect(parseFactoryLog(null, ETH)).toBeUndefined();
  });

  test('parses every fixture log', () => {
    expect(parseFactoryLogs(logsFixture.logs, ETH)).toHaveLength(logsFixture.logs.length);
    expect(parseFactoryLogs('nope', ETH)).toEqual([]);
  });
});

function pool(overrides: Partial<PoolCreation>): PoolCreation {
  return {
    chain: 'ethereum',
    dexId: 'uniswap',
    version: 'v2',
    factory: '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f',
    token0: '0x1111111111111111111111111111111111111111',
    token1: WETH,
    pool: '0x2222222222222222222222222222222222222222',
    blockNumber: 100,
    ...overrides,
  };
}

describe('Base', () => {
  const BASE = LAUNCH_FACTORIES.find((spec) => spec.chain === 'base')!;

  test('Aerodrome PoolCreated decodes like V2: pool from the first data word', () => {
    // A live Aerodrome log from Base, Oct 2026: USDC paired with a new token.
    const log = {
      address: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
      topics: [
        '0x2128d88d14c80cb081c1252a5acff7a264671bf199ce226b53788fb26065005e',
        '0x000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        '0x0000000000000000000000009044040b049568172a46caaa936daaca7c8cfefc',
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      ],
      data: '0x000000000000000000000000e4c45cb93e9895403a458847bca6bb1d7f8811c30000000000000000000000000000000000000000000000000000000000007486',
      blockNumber: '0x3280e00',
    };
    const pool = parseFactoryLog(log, BASE);
    expect(pool).toMatchObject({
      chain: 'base',
      dexId: 'aerodrome',
      version: 'v2',
      pool: '0xe4c45cb93e9895403a458847bca6bb1d7f8811c3',
    });
    expect(launchedSide(pool!, BASE)).toEqual({
      tokenAddress: '0x9044040b049568172a46caaa936daaca7c8cfefc',
      quoteAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      quoteSymbol: 'USDC',
    });
  });
});

describe('launchedSide', () => {
  test('the non-quote side launched, whichever position it sorts into', () => {
    expect(launchedSide(pool({ token0: SHREK, token1: WETH }), ETH)).toEqual({
      tokenAddress: SHREK,
      quoteAddress: WETH,
      quoteSymbol: 'WETH',
    });
    expect(launchedSide(pool({ token0: USDC, token1: KERMIT }), ETH)).toEqual({
      tokenAddress: KERMIT,
      quoteAddress: USDC,
      quoteSymbol: 'USDC',
    });
  });

  test('skips quote/quote and token/token pools', () => {
    expect(launchedSide(pool({ token0: USDC, token1: WETH }), ETH)).toBeUndefined();
    expect(launchedSide(pool({ token0: SHREK, token1: KERMIT }), ETH)).toBeUndefined();
  });
});

describe('collectLaunches', () => {
  const launches = collectLaunches(parseFactoryLogs(logsFixture.logs, ETH), ETH, HEAD, ANCHOR);

  test('drops the no-quote pool, dedupes to the earliest pool, orders newest first', () => {
    expect(launches.map((launch) => launch.tokenAddress)).toEqual([FRESH, KERMIT, SHREK]);
    const shrek = launches.find((launch) => launch.tokenAddress === SHREK);
    expect(shrek?.pool.pool).toBe(SHREK_V2_PAIR);
    expect(shrek?.pool.version).toBe('v2');
  });

  test('dedupe does not depend on log order', () => {
    const reversed = collectLaunches([...parseFactoryLogs(logsFixture.logs, ETH)].reverse(), ETH, HEAD, ANCHOR);
    expect(reversed).toEqual(launches);
  });

  test('same-block pools tie-break on logIndex', () => {
    const a = pool({ token0: SHREK, pool: '0x3333333333333333333333333333333333333333', logIndex: 9 });
    const b = pool({ token0: SHREK, pool: '0x4444444444444444444444444444444444444444', logIndex: 2 });
    expect(collectLaunches([a, b], ETH, 200, ANCHOR)[0]?.pool.pool).toBe(b.pool);
  });

  test('creation time is head-anchored block delta times block seconds', () => {
    expect(launches.find((launch) => launch.tokenAddress === SHREK)?.createdAt).toBe('2026-09-22T11:00:00.000Z');
    expect(estimateCreatedAt(HEAD, HEAD, ANCHOR, 12)).toBe(ANCHOR.toISOString());
    expect(estimateCreatedAt(HEAD + 5, HEAD, ANCHOR, 12)).toBe(ANCHOR.toISOString());
  });
});

describe('walkFactoryLogs', () => {
  interface Call {
    method: string;
    params: unknown[];
  }

  function scripted(head: number, refuseFrom?: number): { call: RpcCaller; calls: Call[] } {
    const calls: Call[] = [];
    const call: RpcCaller = async (method, params) => {
      calls.push({ method, params });
      if (method === 'eth_blockNumber') return `0x${head.toString(16)}`;
      const filter = params[0] as { fromBlock: string };
      if (refuseFrom !== undefined && hexToNumber(filter.fromBlock)! <= refuseFrom) {
        throw new Error('block range too large');
      }
      return [{ fromBlock: filter.fromBlock }];
    };
    return { call, calls };
  }

  test('walks back from head in contiguous chunks covering the lookback', async () => {
    const { call, calls } = scripted(1_000_000);
    const walk = await walkFactoryLogs(call, ETH, { lookbackHours: 24, chunkBlocks: 2000, headLagSeconds: 0 });

    expect(lookbackBlocks(24, 12)).toBe(7200);
    expect(walk.errors).toEqual([]);
    expect(walk.head).toBe(1_000_000);
    expect(walk.windowFrom).toBe(1_000_000 - 7200 + 1);
    expect(walk.scannedFrom).toBe(walk.windowFrom);
    expect(walk.chunks).toBe(4);
    const ranges = calls
      .filter((entry) => entry.method === 'eth_getLogs')
      .map((entry) => {
        const filter = entry.params[0] as { fromBlock: string; toBlock: string; address: string[]; topics: string[][] };
        return [hexToNumber(filter.fromBlock), hexToNumber(filter.toBlock)];
      });
    expect(ranges).toEqual([
      [998_001, 1_000_000],
      [996_001, 998_000],
      [994_001, 996_000],
      [992_801, 994_000],
    ]);
    const filter = calls[1]?.params[0] as { address: string[]; topics: string[][] };
    expect(filter.address).toEqual(ETH.factories.map((factory) => factory.address));
    expect(filter.topics).toEqual([[PAIR_CREATED_TOPIC, POOL_CREATED_TOPIC]]);
  });

  test('starts a few blocks behind the head so a lagging node is not asked past its own', async () => {
    const { call, calls } = scripted(1_000_000);
    const walk = await walkFactoryLogs(call, ETH, { lookbackHours: 24, chunkBlocks: 2000 });
    const first = calls.find((entry) => entry.method === 'eth_getLogs')?.params[0] as { toBlock: string };
    // 36 s at 12 s per block
    expect(hexToNumber(first.toBlock)).toBe(999_997);
    expect(walk.head).toBe(1_000_000);
    expect(walk.errors).toEqual([]);
  });

  test('a refused range stops the walk, keeps the newer chunks and is recorded', async () => {
    const { call } = scripted(1_000_000, 995_000);
    const walk = await walkFactoryLogs(call, ETH, { lookbackHours: 24, chunkBlocks: 2000, headLagSeconds: 0 });
    expect(walk.chunks).toBe(2);
    expect(walk.logs).toHaveLength(2);
    expect(walk.scannedFrom).toBe(996_001);
    expect(walk.errors).toHaveLength(1);
    expect(walk.errors[0]).toContain('refused blocks 994001-996000');
    expect(walk.errors[0]).toContain('block range too large');
  });

  test('chunk and wall-clock budgets stop the walk without throwing', async () => {
    const byChunks = await walkFactoryLogs(scripted(1_000_000).call, ETH, { lookbackHours: 24, maxChunks: 1 });
    expect(byChunks.chunks).toBe(1);
    expect(byChunks.errors[0]).toContain('chunk budget');

    let clock = 0;
    const byTime = await walkFactoryLogs(scripted(1_000_000).call, ETH, {
      lookbackHours: 24,
      budgetMs: 100,
      now: () => (clock += 60),
    });
    expect(byTime.chunks).toBe(1);
    expect(byTime.errors[0]).toContain('time budget');
  });

  test('a dead head read is recorded, not thrown', async () => {
    const walk = await walkFactoryLogs(
      async () => {
        throw new Error('ECONNREFUSED');
      },
      ETH,
      { lookbackHours: 24 },
    );
    expect(walk.head).toBeUndefined();
    expect(walk.errors[0]).toContain('ECONNREFUSED');
  });
});

describe('LaunchSource in fixture mode', () => {
  test('emits healthy, thin and unindexed launches newest first', async () => {
    const app = makeApp();
    const source = new LaunchSource(launchConfig(app));
    const entries = await source.fetchTrending({ config: launchConfig(app), app, logger: silentLogger });

    expect(source.drainErrors()).toEqual([]);
    expect(entries.map((entry) => entry.tokenAddress.toLowerCase())).toEqual([FRESH, KERMIT, SHREK]);
    expect(entries.map((entry) => entry.rank)).toEqual([1, 2, 3]);
    expect(entries.every((entry) => entry.source === 'launches' && entry.chain === 'ethereum')).toBe(true);

    const [fresh, kermit, shrek] = entries;

    // Not indexed: still emitted, factory pair carried, only the creation estimate known.
    expect(fresh?.symbol).toBe('UNKNOWN');
    expect(fresh?.pairAddress).toBe(FRESH_PAIR);
    expect(Object.keys(fresh?.metrics ?? {}).sort()).toEqual(['ageHours', 'poolCreatedAt']);
    expect(fresh?.metrics.poolCreatedAt).toBe(estimateCreatedAt(HEAD - 240, HEAD, ANCHOR, 12));
    expect(readEnrichment(fresh!)?.pairs).toEqual([
      {
        pairAddress: FRESH_PAIR,
        dexId: 'uniswap',
        quoteSymbol: 'WETH',
        quoteAddress: WETH,
        createdAt: estimateCreatedAt(HEAD - 240, HEAD, ANCHOR, 12),
      },
    ]);

    // Thin.
    expect(kermit?.symbol).toBe('KERMIT');
    expect(kermit?.metrics.liquidityUsd).toBeLessThan(40_000);

    // Healthy: DexScreener's highest-liquidity pair drives the metrics, both pools are kept.
    expect(shrek?.symbol).toBe('SHREK');
    expect(shrek?.name).toBe('Shrek Inu');
    expect(shrek?.metrics.liquidityUsd).toBeGreaterThanOrEqual(40_000);
    expect(shrek?.metrics.ageHours).toBeGreaterThanOrEqual(30);
    expect(shrek?.pairAddress?.toLowerCase()).toBe(SHREK_V2_PAIR);
    const shrekPairs = readEnrichment(shrek!)?.pairs?.map((pair) => pair.pairAddress.toLowerCase()).sort();
    expect(shrekPairs).toEqual([SHREK_V3_POOL, SHREK_V2_PAIR].sort());
  });

  test('caps at the configured limit, newest kept', async () => {
    const app = makeApp({ LAUNCHES_MAX_CANDIDATES: '2' });
    const entries = await new LaunchSource(launchConfig(app)).fetchTrending({
      config: launchConfig(app),
      app,
      logger: silentLogger,
    });
    expect(entries.map((entry) => entry.tokenAddress.toLowerCase())).toEqual([FRESH, KERMIT]);
  });

  test('a shorter lookback keeps the earliest pool inside the window', async () => {
    const app = makeApp({ LAUNCHES_LOOKBACK_HOURS: '10' });
    const entries = await new LaunchSource(launchConfig(app)).fetchTrending({
      config: launchConfig(app),
      app,
      logger: silentLogger,
    });
    // KERMIT (13h) and SHREK's V2 pair (21h) fall outside; SHREK's V3 pool (7h) does not.
    expect(entries.map((entry) => entry.tokenAddress.toLowerCase())).toEqual([FRESH, SHREK]);
    expect(entries[1]?.raw).toMatchObject({ candidate: { pool: { pool: SHREK_V3_POOL } } });
  });

  test('honours pipeline.chains', async () => {
    const app = makeApp({ PROVENANCE_CHAINS: 'solana' });
    const entries = await new LaunchSource(launchConfig(app)).fetchTrending({
      config: launchConfig(app),
      app,
      logger: silentLogger,
    });
    expect(entries).toEqual([]);
  });
});

describe('LaunchSource over the network path', () => {
  // A local stand-in for two public nodes and DexScreener: the first node
  // refuses every call, so each one must fail over to the second.
  let server: ReturnType<typeof Bun.serve>;
  let hydrationRequests: string[] = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/latest/dex/tokens/')) {
          hydrationRequests.push(url.pathname);
          return Response.json(hydrationFixture);
        }
        const body = (await request.json()) as { id: number; method: string; params: unknown[] };
        if (url.pathname.startsWith('/v2/')) return new Response('bad range', { status: 400 });
        if (url.pathname === '/refuses') {
          return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32005, message: 'limit exceeded' } });
        }
        if (body.method === 'eth_blockNumber') return Response.json({ jsonrpc: '2.0', id: body.id, result: logsFixture.head });
        const filter = body.params[0] as { fromBlock: string; toBlock: string };
        const from = hexToNumber(filter.fromBlock)!;
        const to = hexToNumber(filter.toBlock)!;
        const result = logsFixture.logs.filter((log) => {
          const block = hexToNumber(log.blockNumber)!;
          return block >= from && block <= to;
        });
        return Response.json({ jsonrpc: '2.0', id: body.id, result });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  test('fails over across endpoints, walks, hydrates and never throws', async () => {
    hydrationRequests = [];
    const base = `http://127.0.0.1:${server.port}`;
    const app = loadConfig({ PROVENANCE_CHAINS: 'ethereum', RPC_ETHEREUM: `${base}/refuses,${base}/ok`, RPC_PUBLIC_FALLBACK: 'false', LAUNCHES_RATE_MS: '0', LAUNCHES_LOOKBACK_HOURS: '24' });
    app.pipeline.sources = app.pipeline.sources.map((source) =>
      source.id === 'dexscreener' ? { ...source, rateLimitMs: 0 } : source,
    );
    const source = new LaunchSource(launchConfig(app), { dexscreenerBaseUrl: base });
    const entries = await source.fetchTrending({ config: launchConfig(app), app, logger: silentLogger });

    expect(source.drainErrors()).toEqual([]);
    expect(entries.map((entry) => entry.tokenAddress.toLowerCase())).toEqual([FRESH, KERMIT, SHREK]);
    expect(hydrationRequests).toHaveLength(1);
    expect(hydrationRequests[0]).toContain(FRESH);
    // Live anchor is the wall clock, so ages are relative to now, not the fixture head.
    const age = entries[0]?.metrics.ageHours ?? -1;
    expect(age).toBeGreaterThan(0.7);
    expect(age).toBeLessThan(0.9);
  });

  test('no working endpoint is a recorded error and an empty list', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const app = loadConfig({ PROVENANCE_CHAINS: 'ethereum', RPC_ETHEREUM: `${base}/refuses`, RPC_PUBLIC_FALLBACK: 'false', LAUNCHES_RATE_MS: '0', LAUNCHES_LOOKBACK_HOURS: '24' });
    const source = new LaunchSource(launchConfig(app), { dexscreenerBaseUrl: base });
    const entries = await source.fetchTrending({ config: launchConfig(app), app, logger: silentLogger });

    expect(entries).toEqual([]);
    const errors = source.drainErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.source).toBe('launches:ethereum');
    expect(errors[0]?.error).toContain('limit exceeded');
  });

  test('a keyed endpoint never reaches an error message or a log line', async () => {
    const secret = 'AbCdEf0123456789AbCdEf0123456789';
    const lines: string[] = [];
    const record = (message: string, meta?: Record<string, unknown>) => lines.push(`${message} ${JSON.stringify(meta ?? {})}`);
    const logger: Logger = { debug: record, info: record, warn: record, error: record, child: () => logger };
    const base = `http://127.0.0.1:${server.port}`;
    const client = new JsonRpcClient({ endpoints: [`${base}/v2/${secret}`], rateLimitMs: 0, logger });

    const error = (await client.call('eth_getLogs', []).catch((caught: unknown) => caught)) as Error;
    expect(error.message).toContain('-> 400');
    expect(error.message).not.toContain(secret);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(secret);
  });

  test('JsonRpcClient throws the last error once every endpoint fails', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const client = new JsonRpcClient({ endpoints: [`${base}/refuses`], rateLimitMs: 0, logger: silentLogger });
    await expect(client.call('eth_blockNumber', [])).rejects.toThrow('eth_blockNumber: limit exceeded');
    const empty = new JsonRpcClient({ endpoints: [], rateLimitMs: 0, logger: silentLogger });
    await expect(empty.call('eth_blockNumber', [])).rejects.toThrow('no RPC endpoints');
  });
});
