/**
 * Test-only: a migrated libSQL file database in a temp directory, and seeding
 * helpers that control timestamps (the store's own `startRun` stamps "now").
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChainAnalysis, ProvenanceReport, ProvenanceScore, TokenSnapshot } from '@provenance/core';
import { LibsqlStore } from '@provenance/store';
import { makeChainAnalysis, makeReport, makeSnapshot } from '../test-fakes';

export interface TempDb {
  store: LibsqlStore;
  url: string;
  cleanup(): Promise<void>;
}

export async function tempDb(): Promise<TempDb> {
  const dir = mkdtempSync(join(tmpdir(), 'provenance-brief-'));
  const url = `file:${join(dir, 'brief.db')}`;
  const store = new LibsqlStore({ url });
  await store.migrate();
  return {
    store,
    url,
    async cleanup() {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const hoursAgo = (hours: number, now = Date.now()): string => new Date(now - hours * 3_600_000).toISOString();

export async function seedRun(
  store: LibsqlStore,
  id: string,
  startedAt: string,
  status: 'ok' | 'partial' | 'failed' | 'running' = 'ok',
  stats: Record<string, unknown> = {},
): Promise<void> {
  await store.raw.execute({
    sql: `INSERT INTO runs (id, started_at, finished_at, status, stats_json, error) VALUES (?, ?, ?, ?, ?, NULL)`,
    args: [
      id,
      startedAt,
      startedAt,
      status,
      JSON.stringify({ discovered: 0, afterFilter: 0, analysed: 0, reused: 0, alertsFired: 0, llmCostUsd: 0, sourceErrors: [], ...stats }),
    ],
  });
}

export interface SeedToken {
  tokenId: string;
  symbol?: string;
  at: string;
  metrics?: TokenSnapshot['metrics'];
  score?: { total: number; tier: ProvenanceScore['tier']; components?: Partial<ProvenanceScore['components']> };
  chain?: Partial<ChainAnalysis>;
  report?: Partial<ProvenanceReport>;
}

/** One token's snapshot (plus optional score, chain analysis and report) in a run, all stamped `at`. */
export async function seedToken(store: LibsqlStore, runId: string, token: SeedToken): Promise<void> {
  const snapshot = makeSnapshot(token.tokenId, {
    capturedAt: token.at,
    ...(token.symbol ? { symbol: token.symbol } : {}),
    ...(token.metrics ? { metrics: token.metrics } : {}),
    pairs: [{ pairAddress: 'pair', url: `https://dexscreener.com/test/${token.tokenId}` }],
  });
  await store.saveSnapshot(runId, snapshot);
  if (token.score) {
    const base = { recycling: 50, memetic: 50, distribution: 50, liquidity: 50, momentum: 50, authenticity: 50 };
    await store.saveScore(runId, {
      tokenId: token.tokenId,
      total: token.score.total,
      tier: token.score.tier,
      components: { ...base, ...token.score.components },
      penalties: [],
      computedAt: token.at,
    });
  }
  if (token.chain) {
    await store.saveChainAnalysis(runId, { ...makeChainAnalysis(token.tokenId), fetchedAt: token.at, ...token.chain });
  }
  if (token.report) {
    await store.saveProvenance(runId, makeReport(token.tokenId, { generatedAt: token.at, ...token.report }));
  }
}
