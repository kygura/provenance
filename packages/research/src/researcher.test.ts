import { describe, expect, test } from 'bun:test';
import { loadConfig, nowIso, silentLogger, type ResearchContext, type TokenSnapshot } from '@provenance/core';
import archetypeFixture from '../../../fixtures/research/stub-archetypes.json' with { type: 'json' };
import { StubResearcher } from './researcher';

const ctx = { logger: silentLogger } as unknown as ResearchContext;

function snapshot(tokenId: string): TokenSnapshot {
  return {
    tokenId,
    chain: 'solana',
    tokenAddress: tokenId,
    symbol: 'NYAN',
    name: 'Nyan Cat',
    socials: {},
    metrics: { poolCreatedAt: '2026-09-01T12:00:00.000Z' },
    pairs: [],
    appearances: [],
    bestRank: 1,
    sourceCount: 1,
    capturedAt: nowIso(),
  };
}

describe('StubResearcher anchor', () => {
  test('every archetype yields a low-confidence anchor labelled as fixture output', async () => {
    const stub = new StubResearcher(loadConfig({}), silentLogger);
    const seen = new Set<string>();
    // Enough token ids to land on every archetype through the stable hash.
    for (let i = 0; i < 60 && seen.size < archetypeFixture.archetypes.length; i++) {
      const report = await stub.research(snapshot(`solana:t${i}`), undefined, [], ctx);
      seen.add(report.originSummary);
      expect(report.anchor).toBeDefined();
      expect(report.anchor?.confidence).toBe('low');
      expect(report.anchor?.summary.startsWith('Offline fixture output, not researched:')).toBe(true);
      expect(report.anchor?.earliestSource).toBeUndefined();
      expect(report.confidence).toBeLessThanOrEqual(0.2);
    }
    expect(seen.size).toBe(archetypeFixture.archetypes.length);
  });
});
