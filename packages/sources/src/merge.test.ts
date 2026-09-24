import { describe, expect, test } from 'bun:test';

import { type SourceId, type TrendingEntry, loadConfig, silentLogger } from '@provenance/core';

import { createSources, discoverTrending } from './discover';
import { SOURCE_PRECEDENCE, mergeToSnapshots, splitLanes } from './merge';

function entry(source: SourceId, tokenAddress: string, overrides: Partial<TrendingEntry> = {}): TrendingEntry {
  return {
    source,
    rank: 1,
    chain: 'ethereum',
    tokenAddress,
    symbol: tokenAddress.slice(2, 6).toUpperCase(),
    name: tokenAddress,
    capturedAt: '2026-09-24T00:00:00.000Z',
    metrics: {},
    ...overrides,
  };
}

const A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C = '0xcccccccccccccccccccccccccccccccccccccccc';
const D = '0xdddddddddddddddddddddddddddddddddddddddd';

describe('SOURCE_PRECEDENCE', () => {
  test('launches sits below every trending source and above manual', () => {
    expect(SOURCE_PRECEDENCE.launches).toBeLessThan(SOURCE_PRECEDENCE.dextools);
    expect(SOURCE_PRECEDENCE.launches).toBeGreaterThan(SOURCE_PRECEDENCE.manual);
  });

  test('a trending reading wins over a launch reading for the same token', () => {
    const [snapshot] = mergeToSnapshots([
      entry('launches', A, { metrics: { liquidityUsd: 10, poolCreatedAt: '2026-09-22T00:00:00.000Z' } }),
      entry('dextools', A, { metrics: { liquidityUsd: 99 } }),
    ]);
    expect(snapshot?.metrics.liquidityUsd).toBe(99);
    // Fields only the launch row knows still fill in.
    expect(snapshot?.metrics.poolCreatedAt).toBe('2026-09-22T00:00:00.000Z');
  });
});

describe('splitLanes', () => {
  test('launch-only goes to launches; trending, manual and mixes stay trending', () => {
    const snapshots = mergeToSnapshots([
      entry('launches', A),
      entry('launches', B),
      entry('geckoterminal', B),
      entry('manual', C),
      entry('manual', D),
      entry('launches', D),
    ]);
    const lanes = splitLanes(snapshots);
    expect(lanes.launches.map((s) => s.tokenAddress)).toEqual([A]);
    expect(lanes.trending.map((s) => s.tokenAddress).sort()).toEqual([B, C, D]);
  });

  test('a snapshot with no appearances is not a launch', () => {
    const [snapshot] = mergeToSnapshots([entry('dexscreener', A)]);
    const lanes = splitLanes([{ ...snapshot!, appearances: [] }]);
    expect(lanes.trending).toHaveLength(1);
    expect(lanes.launches).toHaveLength(0);
  });
});

describe('createSources', () => {
  test('builds the launch source only when both switches are on', () => {
    const ids = (env: Record<string, string>) => createSources(loadConfig(env), silentLogger).map((s) => s.id);
    expect(ids({})).toContain('launches');
    expect(ids({ LAUNCHES_ENABLED: '0' })).not.toContain('launches');

    const laneOff = loadConfig({});
    laneOff.launches.enabled = false;
    expect(createSources(laneOff, silentLogger).map((s) => s.id)).not.toContain('launches');
  });
});

describe('fixture discovery', () => {
  // Captured from the fixture run before the launch source existed.
  const TRENDING_BEFORE: [string, number, number][] = [
    ['solana:BonG9kRThz5vQ1pXmY7wLd3cJf8sNqA4eV6uZtP1rKx', 3, 1],
    ['ethereum:0x9f2c4b1ea7d0ab3e6c5f81d2a94b7e03cd15a8fe', 1, 2],
    ['base:0x7a2b19cd4e5f60781b9c3ad2e4f5061728394ab0', 3, 2],
    ['bsc:0xb9e8d7c6a5f4321098765432109876543210fedc', 2, 3],
    ['solana:GrumPYcat9xKdWqR2sTv5mNhJ7bZuE3fA6yLpQ8nXeVd', 2, 4],
    ['solana:TurB2nQx8vKdMz5rLpY9wHcJ3sGf7aUe6tNqZ1BmXkRv', 1, 5],
    ['ethereum:0x4f3ca1b2d5e6789012abcdef3456789012345abc', 1, 3],
    ['ethereum:0x1c0de2f3a4b5c6d7e8f90123456789abcdef0123', 1, 4],
  ];

  test('launch rows do not change how the trending fixtures merge', async () => {
    const app = loadConfig({ USE_FIXTURES: '1' });
    const { entries, errors } = await discoverTrending(app, silentLogger);
    expect(errors).toEqual([]);

    const launchRows = entries.filter((row) => row.source === 'launches');
    expect(launchRows).toHaveLength(3);

    const lanes = splitLanes(mergeToSnapshots(entries));
    const trendingOnly = mergeToSnapshots(entries.filter((row) => row.source !== 'launches'));

    expect(lanes.trending).toEqual(trendingOnly);
    expect(lanes.trending.map((s) => [s.tokenId, s.sourceCount, s.bestRank])).toEqual(TRENDING_BEFORE);
    expect(lanes.launches.map((s) => s.symbol)).toEqual(['UNKNOWN', 'KERMIT', 'SHREK']);
  });
});
