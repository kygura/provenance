import { describe, expect, test } from 'bun:test';
import { type OutcomeCandidate, silentLogger } from '@provenance/core';
import { parseDexScreenerPairs } from '@provenance/sources';
import { collectOutcomes, labelOutcome, onePerTokenDay, OUTCOMES_SOURCE, type PairFetcher } from './outcomes';
import { runPipeline } from './pipeline';
import { FakeStore, makeConfig, makeHarness, makeSnapshot } from './test-fakes';

const A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const NOW = new Date('2026-10-22T12:00:00.000Z');

function candidate(address: string, scoredAt: string, over: Partial<OutcomeCandidate> = {}): OutcomeCandidate {
  return {
    tokenId: `solana:${address}`,
    chain: 'solana',
    address,
    runId: `run-${scoredAt}`,
    scoredAt,
    liqAtScore: 100_000,
    priceAtScore: 0.01,
    ...over,
  };
}

function pair(address: string, liquidityUsd: number, priceUsd = 0.02, chainId = 'solana'): Record<string, unknown> {
  return {
    chainId,
    pairAddress: `${address.slice(0, 8)}-${liquidityUsd}`,
    baseToken: { address, symbol: 'T', name: 'T' },
    quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
    priceUsd: String(priceUsd),
    liquidity: { usd: liquidityUsd },
  };
}

describe('labelOutcome', () => {
  const at = '2026-10-18T06:00:00.000Z';

  test('survived at half the liquidity at score, on the deepest pair', () => {
    const rows = parseDexScreenerPairs({ pairs: [pair(A, 10_000, 0.5), pair(A, 50_000, 0.03)] });
    const label = labelOutcome(candidate(A, at), rows, 72, NOW.toISOString());
    expect(label).toMatchObject({ pairFound: true, survived: true, liqNow: 50_000, priceNow: 0.03, priceAtScore: 0.01, horizonH: 72 });
    const below = parseDexScreenerPairs({ pairs: [pair(A, 49_999)] });
    expect(labelOutcome(candidate(A, at), below, 72, NOW.toISOString()).survived).toBe(false);
  });

  test('no pair for the token (or only on another chain) is not survived, and says so', () => {
    const rows = parseDexScreenerPairs({ pairs: [pair(B, 900_000), pair(A, 900_000, 1, 'base')] });
    const label = labelOutcome(candidate(A, at), rows, 72, NOW.toISOString());
    expect(label.pairFound).toBe(false);
    expect(label.survived).toBe(false);
    expect(label.liqNow).toBeUndefined();
  });
});

describe('onePerTokenDay', () => {
  test('keeps the latest scored run per token per UTC day, newest first', () => {
    const picked = onePerTokenDay([
      candidate(A, '2026-10-18T06:00:00.000Z'),
      candidate(A, '2026-10-18T23:00:00.000Z'),
      candidate(A, '2026-10-19T01:00:00.000Z'),
      candidate(B, '2026-10-18T12:00:00.000Z'),
    ]);
    expect(picked.map((c) => `${c.address[0]}@${c.scoredAt}`)).toEqual([
      'A@2026-10-19T01:00:00.000Z',
      'A@2026-10-18T23:00:00.000Z',
      'B@2026-10-18T12:00:00.000Z',
    ]);
  });
});

describe('collectOutcomes', () => {
  test('labels pending scores, one lookup per token, capped per run', async () => {
    const store = new FakeStore();
    store.candidates = [
      candidate(A, '2026-10-19T06:00:00.000Z'),
      candidate(A, '2026-10-18T06:00:00.000Z'),
      candidate(B, '2026-10-17T06:00:00.000Z'),
    ];
    const calls: string[][] = [];
    const fetch: PairFetcher = async (addresses) => {
      calls.push(addresses);
      return { pairs: [pair(A, 80_000)] };
    };
    const app = makeConfig();
    const result = await collectOutcomes({ ...app, outcomes: { ...app.outcomes, maxPerRun: 2 } }, store, fetch, silentLogger, NOW);
    expect(result.stats).toEqual({ pending: 3, measured: 2, survived: 2, notFound: 0 });
    expect(calls).toEqual([[A]]);
    expect(store.outcomes.map((o) => o.scoredAt)).toEqual(['2026-10-19T06:00:00.000Z', '2026-10-18T06:00:00.000Z']);
  });

  test('a token crowded out of a batch is asked alone before it is called dead', async () => {
    const store = new FakeStore();
    store.candidates = [candidate(A, '2026-10-18T06:00:00.000Z'), candidate(B, '2026-10-18T07:00:00.000Z')];
    const calls: string[][] = [];
    const fetch: PairFetcher = async (addresses) => {
      calls.push(addresses);
      return addresses.length > 1 ? { pairs: [pair(B, 100_000)] } : { pairs: [] };
    };
    const result = await collectOutcomes(makeConfig(), store, fetch, silentLogger, NOW);
    expect(calls).toEqual([[B, A], [A]]);
    expect(result.stats).toMatchObject({ measured: 2, survived: 1, notFound: 1 });
  });

  test('a failed lookup leaves the scores pending: a network error is not a dead token', async () => {
    const store = new FakeStore();
    store.candidates = [candidate(A, '2026-10-18T06:00:00.000Z')];
    const result = await collectOutcomes(makeConfig(), store, async () => {
      throw new Error('HTTP 503');
    }, silentLogger, NOW);
    expect(result.stats.measured).toBe(0);
    expect(store.outcomes).toEqual([]);
    expect(result.errors).toEqual([{ source: OUTCOMES_SOURCE, error: 'dexscreener batch of 1: HTTP 503' }]);
  });
});

describe('outcome step in the pipeline', () => {
  function harness(fetch: PairFetcher) {
    const store = new FakeStore();
    store.candidates = [candidate(A, '2026-10-18T06:00:00.000Z')];
    const h = makeHarness({ snapshots: [makeSnapshot('solana:aaa')], store });
    h.deps.createPairFetcher = () => fetch;
    return h;
  }

  test('runs at the end of a full run and records its stats', async () => {
    const h = harness(async () => ({ pairs: [pair(A, 60_000)] }));
    const record = await runPipeline(makeConfig(), silentLogger, h.deps, { runId: 'r', skipLlm: true });
    expect(record.status).toBe('ok');
    expect(record.stats.outcomes).toEqual({ pending: 1, measured: 1, survived: 1, notFound: 0 });
    expect(h.store.calls.indexOf('saveOutcomes')).toBeLessThan(h.store.calls.indexOf('finishRun'));
  });

  test('a failure degrades the run to partial, never failed', async () => {
    const h = harness(async () => ({ pairs: [] }));
    h.store.failOn = { method: 'outcomeCandidates' };
    const record = await runPipeline(makeConfig(), silentLogger, h.deps, { runId: 'r', skipLlm: true });
    expect(record.status).toBe('partial');
    expect(record.stats.sourceErrors.map((e) => e.source)).toContain(OUTCOMES_SOURCE);
  });

  test('skipped on the launch lane, in a dry run and when disabled', async () => {
    const base = makeConfig();
    const configs = [
      { app: base, lane: 'launches' as const },
      { app: makeConfig({ pipeline: { ...base.pipeline, dryRun: true } }), lane: 'full' as const },
      { app: { ...base, outcomes: { ...base.outcomes, enabled: false } }, lane: 'full' as const },
    ];
    for (const { app, lane } of configs) {
      const h = harness(async () => ({ pairs: [pair(A, 60_000)] }));
      const record = await runPipeline(app, silentLogger, h.deps, { runId: 'r', skipLlm: true, lane });
      expect(record.stats.outcomes).toBeUndefined();
      expect(h.store.calls).not.toContain('outcomeCandidates');
    }
  });
});
