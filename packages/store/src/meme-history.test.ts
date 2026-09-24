import { describe, expect, test } from 'bun:test';
import type { ProvenanceReport, ProvenanceScore, TokenSnapshot } from '@provenance/core';
import { LibsqlStore } from './libsql-store';

/*
 * These run against real libSQL rather than a fake: the defects they pin were
 * in the SQL itself — which row counts as a token's "latest", and which tokens
 * count as "prior" — and a fake that reimplements the rule cannot catch the
 * query getting it wrong.
 */

async function freshStore(): Promise<LibsqlStore> {
  const store = new LibsqlStore({ url: ':memory:' });
  await store.migrate();
  return store;
}

function snapshot(tokenId: string, capturedAt: string): TokenSnapshot {
  const [chain = 'solana', address = tokenId] = tokenId.split(':');
  return {
    tokenId,
    chain: chain as TokenSnapshot['chain'],
    tokenAddress: address,
    symbol: address.toUpperCase(),
    name: `${address} token`,
    socials: {},
    metrics: {},
    pairs: [],
    appearances: [],
    bestRank: 1,
    sourceCount: 1,
    capturedAt,
  };
}

function report(tokenId: string, generatedAt: string, memeId?: string): ProvenanceReport {
  return {
    tokenId,
    memeName: memeId ?? 'unlinked',
    ...(memeId !== undefined ? { memeId } : {}),
    narrativeCluster: 'cat',
    originSummary: 'x',
    lineage: [],
    priorCycles: [],
    recycleVerdict: 'revival',
    recycleGeneration: 1,
    memeticDurability: 50,
    culturalReach: 50,
    authenticityScore: 50,
    speculativeSetup: 'x',
    risks: [],
    confidence: 0.5,
    evidence: [],
    model: 'test',
    promptVersion: 'test',
    generatedAt,
  };
}

function score(tokenId: string, total: number, computedAt: string): ProvenanceScore {
  return {
    tokenId,
    total,
    tier: 'B',
    components: { recycling: 0, memetic: 0, distribution: 0, liquidity: 0, momentum: 0, authenticity: 0 },
    penalties: [],
    computedAt,
  };
}

/** One run in which `tokenId` is seen, researched into `memeId`, and scored. */
async function observe(
  store: LibsqlStore,
  runId: string,
  tokenId: string,
  at: string,
  memeId: string | undefined,
  total = 60,
): Promise<void> {
  await store.startRun(runId);
  await store.saveSnapshot(runId, snapshot(tokenId, at));
  if (memeId !== undefined) {
    await store.resolveMeme({ id: memeId, displayName: memeId, narrativeCluster: 'cat' });
  }
  await store.saveProvenance(runId, report(tokenId, at, memeId));
  await store.saveScore(runId, score(tokenId, total, at));
}

describe('memeHistory', () => {
  test('returns a token that ran the meme, with its latest score', async () => {
    const store = await freshStore();
    await observe(store, 'r1', 'solana:a', '2026-01-01T00:00:00.000Z', 'nyan-cat', 40);
    await store.saveScore('r1', score('solana:a', 72, '2026-01-02T00:00:00.000Z'));

    const history = await store.memeHistory('nyan-cat');
    expect(history.map((s) => s.tokenId)).toEqual(['solana:a']);
    expect(history[0]?.score).toBe(72);
  });

  test('a token re-researched into a different meme stops being precedent for the old one', async () => {
    // The earlier query filtered by meme before picking each token's latest
    // report, so this token kept appearing under 'doge' after it had moved.
    const store = await freshStore();
    await observe(store, 'r1', 'solana:a', '2026-01-01T00:00:00.000Z', 'doge');
    await observe(store, 'r2', 'solana:a', '2026-02-01T00:00:00.000Z', 'baby-doge');

    expect(await store.memeHistory('doge')).toEqual([]);
    expect((await store.memeHistory('baby-doge')).map((s) => s.tokenId)).toEqual(['solana:a']);
  });

  test('seenBefore keeps out tokens first met in the current run', async () => {
    const store = await freshStore();
    await observe(store, 'r1', 'solana:old', '2026-01-01T00:00:00.000Z', 'nyan-cat');
    // Co-trending: first seen in the run that is doing the lookup.
    await observe(store, 'r2', 'solana:new', '2026-03-01T00:05:00.000Z', 'nyan-cat');

    const runStartedAt = '2026-03-01T00:00:00.000Z';
    const history = await store.memeHistory('nyan-cat', { seenBefore: runStartedAt });
    expect(history.map((s) => s.tokenId)).toEqual(['solana:old']);
  });

  test('a token first met earlier still counts when it trends again in this run', async () => {
    // Being seen again now does not make it any less a prior tokenisation;
    // first_seen_at is kept at its minimum by the token upsert.
    const store = await freshStore();
    await observe(store, 'r1', 'solana:old', '2026-01-01T00:00:00.000Z', 'nyan-cat');
    await observe(store, 'r2', 'solana:old', '2026-03-01T00:05:00.000Z', 'nyan-cat');

    const history = await store.memeHistory('nyan-cat', { seenBefore: '2026-03-01T00:00:00.000Z' });
    expect(history.map((s) => s.tokenId)).toEqual(['solana:old']);
  });

  test('excludeTokenId keeps a token out of its own precedent', async () => {
    const store = await freshStore();
    await observe(store, 'r1', 'solana:a', '2026-01-01T00:00:00.000Z', 'nyan-cat');
    expect(await store.memeHistory('nyan-cat', { excludeTokenId: 'solana:a' })).toEqual([]);
  });
});

describe('meme link backfill', () => {
  test('lists only each token’s latest report, and only when it is unlinked', async () => {
    const store = await freshStore();
    // a: old report unlinked, latest linked -> nothing to do.
    await observe(store, 'r1', 'solana:a', '2026-01-01T00:00:00.000Z', undefined);
    await observe(store, 'r2', 'solana:a', '2026-02-01T00:00:00.000Z', 'nyan-cat');
    // b: latest unlinked -> needs linking.
    await observe(store, 'r3', 'solana:b', '2026-02-01T00:00:00.000Z', undefined);

    const unlinked = await store.unlinkedProvenance();
    expect(unlinked.map((row) => row.tokenId)).toEqual(['solana:b']);
  });

  test('a report linked after it was written reads back linked', async () => {
    // report_json is written once and predates the link; the column must win,
    // or a backfilled report would read back as unlinked.
    const store = await freshStore();
    await observe(store, 'r1', 'solana:b', '2026-01-01T00:00:00.000Z', undefined);
    const [row] = await store.unlinkedProvenance();
    await store.resolveMeme({ id: 'nyan-cat', displayName: 'Nyan Cat', narrativeCluster: 'cat' });
    await store.linkProvenanceMeme(row!.id, 'nyan-cat');

    expect((await store.latestProvenance('solana:b'))?.memeId).toBe('nyan-cat');
    expect(await store.unlinkedProvenance()).toEqual([]);
    expect((await store.memeHistory('nyan-cat')).map((s) => s.tokenId)).toEqual(['solana:b']);
  });
});
