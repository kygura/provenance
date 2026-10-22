import { describe, expect, test } from 'bun:test';
import type { OutcomeRecord, ProvenanceReport, ProvenanceScore, TokenSnapshot } from '@provenance/core';
import { LibsqlStore } from './libsql-store';

const NOW = '2026-10-22T12:00:00.000Z';

function snapshot(
  tokenId: string,
  liquidityUsd: number | undefined,
  capturedAt: string,
  pairLiquidity: number[] = [],
): TokenSnapshot {
  const [chain, address] = tokenId.split(':') as [TokenSnapshot['chain'], string];
  return {
    tokenId,
    chain,
    tokenAddress: address,
    symbol: address.slice(0, 4).toUpperCase(),
    name: address,
    socials: {},
    metrics: { ...(liquidityUsd !== undefined ? { liquidityUsd } : {}), priceUsd: 0.01 },
    pairs: pairLiquidity.map((liq, i) => ({ pairAddress: `p${i}`, liquidityUsd: liq })),
    appearances: [],
    bestRank: 1,
    sourceCount: 1,
    capturedAt,
  };
}

function score(tokenId: string, computedAt: string, total = 60): ProvenanceScore {
  return {
    tokenId,
    total,
    tier: 'B',
    components: { recycling: 70, memetic: 60, distribution: 50, liquidity: 40, momentum: 30, authenticity: 20 },
    penalties: [],
    computedAt,
  };
}

function report(tokenId: string, generatedAt: string): ProvenanceReport {
  return {
    tokenId,
    memeName: 'Neiro',
    narrativeCluster: 'dog',
    originSummary: 'test',
    lineage: [],
    priorCycles: [],
    recycleVerdict: 'revival',
    recycleGeneration: 2,
    memeticDurability: 60,
    culturalReach: 50,
    authenticityScore: 60,
    speculativeSetup: '',
    risks: [],
    confidence: 0.7,
    evidence: [],
    model: 'test',
    promptVersion: 'provenance-research-v4',
    generatedAt,
    organic: { verdict: 'manufactured', outsideTraction: 20, signals: [], rivals: [], summary: '' },
  };
}

/** A run that started at `startedAt`, scoring each token in it. */
async function scoredRun(
  store: LibsqlStore,
  id: string,
  startedAt: string,
  tokens: { tokenId: string; liq?: number; pairs?: number[]; withReport?: boolean }[],
  lane: 'full' | 'launches' = 'full',
): Promise<void> {
  await store.startRun(id);
  await store.raw.execute({
    sql: `UPDATE runs SET started_at = ?, stats_json = json_set(stats_json, '$.lane', ?) WHERE id = ?`,
    args: [startedAt, lane, id],
  });
  const at = new Date(Date.parse(startedAt) + 60_000).toISOString();
  for (const token of tokens) {
    await store.saveTokenBundle(id, {
      snapshot: snapshot(token.tokenId, token.liq ?? 50_000, at, token.pairs),
      ...(token.withReport ? { provenance: report(token.tokenId, at) } : {}),
      score: score(token.tokenId, new Date(Date.parse(at) + 1000).toISOString()),
    });
  }
}

async function freshStore(): Promise<LibsqlStore> {
  const store = new LibsqlStore({ url: ':memory:' });
  await store.migrate();
  return store;
}

const A = 'solana:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'solana:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

describe('outcomes table', () => {
  test('migration 6 creates it and records the version', async () => {
    const store = await freshStore();
    const versions = await store.raw.execute('SELECT version FROM schema_migrations WHERE version = 6');
    expect(versions.rows).toHaveLength(1);
    const cols = await store.raw.execute('PRAGMA table_info(outcomes)');
    expect(cols.rows.map((row) => row.name)).toEqual([
      'token_id',
      'run_id',
      'horizon_h',
      'scored_at',
      'measured_at',
      'liq_at_score',
      'liq_now',
      'price_at_score',
      'price_now',
      'pair_found',
      'survived',
    ]);
    await store.close();
  });

  test('candidates: past the horizon, full lane, with liquidity, not yet labelled that day', async () => {
    const store = await freshStore();
    await scoredRun(store, 'r-old-1', '2026-10-18T06:00:00.000Z', [{ tokenId: A }, { tokenId: B, liq: 0 }]);
    await scoredRun(store, 'r-old-2', '2026-10-18T18:00:00.000Z', [{ tokenId: A }]);
    await scoredRun(store, 'r-launch', '2026-10-18T07:00:00.000Z', [{ tokenId: B }], 'launches');
    await scoredRun(store, 'r-new', '2026-10-21T06:00:00.000Z', [{ tokenId: A }]);

    const pending = await store.outcomeCandidates({ horizonHours: 72, now: NOW });
    // Newest first; B is out (no liquidity at score; launch lane); r-new is inside the horizon.
    expect(pending.map((c) => `${c.runId}:${c.tokenId === A ? 'A' : 'B'}`)).toEqual(['r-old-2:A', 'r-old-1:A']);
    expect(pending[0]).toMatchObject({ chain: 'solana', liqAtScore: 50_000, priceAtScore: 0.01 });

    const record: OutcomeRecord = {
      tokenId: A,
      runId: 'r-old-2',
      horizonH: 72,
      scoredAt: '2026-10-18T18:00:00.000Z',
      measuredAt: NOW,
      liqAtScore: 50_000,
      liqNow: 30_000,
      priceAtScore: 0.01,
      pairFound: true,
      survived: true,
    };
    await store.saveOutcomes([record]);
    await store.saveOutcomes([{ ...record, liqNow: 10_000, survived: false }]); // upsert, not a second row
    const stored = await store.raw.execute('SELECT * FROM outcomes');
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({ liq_now: 10_000, survived: 0, pair_found: 1, price_now: null });

    // The day is labelled, so the earlier run that day is no longer pending.
    expect(await store.outcomeCandidates({ horizonHours: 72, now: NOW })).toEqual([]);
    // A different horizon is a different label: at 24 h the 10-18 rows are
    // past the lag bound and the 10-21 day has not ended a horizon ago.
    expect(await store.outcomeCandidates({ horizonHours: 24, now: NOW })).toEqual([]);
    expect(await store.outcomeCandidates({ horizonHours: 24, now: '2026-10-23T02:00:00.000Z' })).toHaveLength(1);
    await store.close();
  });

  test('a day becomes a candidate only once all of it is past the horizon, so its latest run is there to pick', async () => {
    const store = await freshStore();
    await scoredRun(store, 'r-06', '2026-10-18T06:00:00.000Z', [{ tokenId: A }]);
    await scoredRun(store, 'r-18', '2026-10-18T18:00:00.000Z', [{ tokenId: A }]);
    // 06:00 is past 72 h here, but the day is not: nothing yet.
    expect(await store.outcomeCandidates({ horizonHours: 72, now: '2026-10-21T20:00:00.000Z' })).toEqual([]);
    const pending = await store.outcomeCandidates({ horizonHours: 72, now: '2026-10-22T01:00:00.000Z' });
    expect(pending.map((c) => c.runId)).toEqual(['r-18', 'r-06']);
    await store.close();
  });

  test('scores older than 1.5 x horizon + 24 h are never candidates: turning the step on does not label history', async () => {
    const store = await freshStore();
    await scoredRun(store, 'r-history', '2026-10-10T06:00:00.000Z', [{ tokenId: A }]);
    await scoredRun(store, 'r-edge', '2026-10-17T00:00:00.000Z', [{ tokenId: B }]); // exactly NOW - 132 h
    const pending = await store.outcomeCandidates({ horizonHours: 72, now: NOW });
    expect(pending.map((c) => c.runId)).toEqual(['r-edge']);
    await store.close();
  });

  test('liquidity at score is the deepest pair in the snapshot, matching the deepest pair now', async () => {
    const store = await freshStore();
    await scoredRun(store, 'r1', '2026-10-18T06:00:00.000Z', [{ tokenId: A, liq: 50_000, pairs: [20_000, 80_000] }]);
    const [pending] = await store.outcomeCandidates({ horizonHours: 72, now: NOW });
    expect(pending?.liqAtScore).toBe(80_000);
    await store.close();
  });

  test('calibration rows join the score and the report it was scored on', async () => {
    const store = await freshStore();
    await scoredRun(store, 'r1', '2026-10-18T06:00:00.000Z', [{ tokenId: A, withReport: true }, { tokenId: B }]);
    const base = { horizonH: 72, scoredAt: '2026-10-18T06:00:00.000Z', measuredAt: NOW, liqAtScore: 50_000, pairFound: true };
    await store.saveOutcomes([
      { ...base, tokenId: A, runId: 'r1', survived: true },
      { ...base, tokenId: B, runId: 'r1', survived: false, pairFound: false },
    ]);
    const rows = await store.calibrationRows(72);
    expect(rows).toHaveLength(2);
    const a = rows.find((row) => row.tokenId === A);
    const b = rows.find((row) => row.tokenId === B);
    expect(a).toMatchObject({
      runId: 'r1',
      total: 60,
      tier: 'B',
      recycleGeneration: 2,
      organicVerdict: 'manufactured',
      meme: 'neiro',
      narrativeCluster: 'dog',
      survived: true,
    });
    expect(a?.components.recycling).toBe(70);
    expect(b?.survived).toBe(false);
    expect(b?.recycleGeneration).toBeUndefined();
    expect(b?.organicVerdict).toBeUndefined();
    expect(await store.calibrationRows(24)).toEqual([]);

    // A label measured long after its score is not a 72 h label.
    await store.saveOutcomes([{ ...base, tokenId: A, runId: 'r1', survived: true, measuredAt: '2026-10-30T00:00:00.000Z' }]);
    expect((await store.calibrationRows(72)).map((row) => row.tokenId)).toEqual([B]);
    await store.close();
  });
});
