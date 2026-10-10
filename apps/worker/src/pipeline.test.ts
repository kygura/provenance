import { describe, expect, test } from 'bun:test';
import { silentLogger } from '@provenance/core';
import { BUDGET_SOURCE, resolveStatus, runPipeline } from './pipeline';
import {
  FakeStore,
  makeAlert,
  makeConfig,
  makeHarness,
  makeReport,
  makeScore,
  makeSnapshot,
} from './test-fakes';

const RUN = 'run_test';

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

describe('runPipeline stage ordering', () => {
  test('walks discover → merge → filter → triage → analyse → research → score → alerts', async () => {
    const harness = makeHarness({ snapshots: [makeSnapshot('solana:aaa')] });
    const app = makeConfig();

    const record = await runPipeline(app, silentLogger, harness.deps, {
      runId: RUN,
      concurrency: 1,
    });

    expect(harness.stages).toEqual([
      'createStore',
      'discover',
      'merge',
      'filter',
      'triage',
      'analyze:solana:aaa',
      'evidence:solana:aaa',
      'createResearcher',
      'research:solana:aaa',
      'score:solana:aaa',
      'alerts:solana:aaa',
    ]);
    expect(record.id).toBe(RUN);
    expect(record.status).toBe('ok');
  });

  test('persists in an order that survives a crash, and always finishes the run', async () => {
    const harness = makeHarness({ snapshots: [makeSnapshot('solana:aaa')] });
    await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN, concurrency: 1 });

    const calls = harness.store.calls;
    expect(calls[0]).toBe('migrate');
    expect(calls[1]).toBe('startRun');
    expect(calls.indexOf('saveSnapshot')).toBeLessThan(calls.indexOf('saveChainAnalysis'));
    expect(calls.indexOf('saveChainAnalysis')).toBeLessThan(calls.indexOf('saveProvenance'));
    expect(calls.indexOf('saveProvenance')).toBeLessThan(calls.indexOf('saveScore'));
    // scoreHistory must be read before the new score lands, so history is prior runs only.
    expect(calls.indexOf('scoreHistory')).toBeLessThan(calls.indexOf('saveScore'));
    expect(calls.indexOf('finishRun')).toBeLessThan(calls.indexOf('close'));
    expect(harness.store.closed).toBe(true);
  });

  test('finishRun runs from a finally even when a stage throws', async () => {
    const store = new FakeStore();
    store.failOn = { method: 'saveSnapshot' };
    const harness = makeHarness({ store, snapshots: [makeSnapshot('solana:aaa')] });

    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN });

    expect(record.status).toBe('failed');
    expect(record.error).toContain('saveSnapshot');
    expect(store.calls).toContain('finishRun');
    expect(store.runs.get(RUN)?.status).toBe('failed');
    expect(store.closed).toBe(true);
  });
});

describe('reanalysis skip', () => {
  test('reuses a report inside the TTL, still rescoring against fresh market data', async () => {
    const store = new FakeStore();
    store.priorReports.set('solana:aaa', makeReport('solana:aaa', { generatedAt: hoursAgo(5) }));
    const harness = makeHarness({ store, snapshots: [makeSnapshot('solana:aaa')] });

    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN });

    expect(harness.researchCalls).toEqual([]);
    expect(harness.evidenceCalls).toEqual([]);
    expect(record.stats.reused).toBe(1);
    expect(record.stats.analysed).toBe(0);
    expect(record.stats.llmCostUsd).toBe(0);
    // Chain analysis and scoring still happen: only the model call is skipped.
    expect(store.chainAnalyses).toHaveLength(1);
    expect(store.scores).toHaveLength(1);
  });

  test('re-researches once the report is older than reanalyseAfterHours', async () => {
    const store = new FakeStore();
    store.priorReports.set('solana:aaa', makeReport('solana:aaa', { generatedAt: hoursAgo(100) }));
    const harness = makeHarness({ store, snapshots: [makeSnapshot('solana:aaa')] });
    const app = makeConfig({ pipeline: { ...makeConfig().pipeline, reanalyseAfterHours: 72 } });

    const record = await runPipeline(app, silentLogger, harness.deps, { runId: RUN });

    expect(harness.researchCalls).toEqual(['solana:aaa']);
    expect(record.stats.reused).toBe(0);
    expect(record.stats.analysed).toBe(1);
  });
});

describe('cost ceiling', () => {
  test('stops calling the LLM once the ceiling is hit but keeps analysing', async () => {
    const snapshots = ['aaa', 'bbb', 'ccc', 'ddd'].map((id) => makeSnapshot(`solana:${id}`));
    const harness = makeHarness({ snapshots, costPerReport: 0.3 });
    const base = makeConfig();
    const app = makeConfig({ llm: { ...base.llm, maxCostUsdPerRun: 0.5 } });

    const record = await runPipeline(app, silentLogger, harness.deps, { runId: RUN, concurrency: 1 });

    expect(harness.researchCalls).toEqual(['solana:aaa', 'solana:bbb']);
    expect(record.stats.llmCostUsd).toBeCloseTo(0.6, 6);
    // Every token still gets a snapshot, chain analysis and a score.
    expect(harness.store.snapshots).toHaveLength(4);
    expect(harness.store.chainAnalyses).toHaveLength(4);
    expect(harness.store.scores).toHaveLength(4);
    expect(record.stats.analysed).toBe(4);
    expect(record.stats.sourceErrors.some((e) => e.source === BUDGET_SOURCE)).toBe(true);
    expect(record.status).toBe('partial');
  });

  test('a failed research call is not saved, and a refused provider stops research for the run', async () => {
    const snapshots = ['aaa', 'bbb'].map((id) => makeSnapshot(`solana:${id}`));
    const harness = makeHarness({
      snapshots,
      research: async (snapshot) =>
        makeReport(snapshot.tokenId, {
          anchor: {
            verdict: 'unclear',
            type: 'none',
            subject: '',
            summary: 'Anchor not established.',
            confidence: 'low',
            failed: 'openrouter /chat/completions HTTP 402: requires more credits',
          },
        }),
    });

    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN, concurrency: 1 });

    // Saved, it would be reused as a report until the TTL ran out.
    expect(harness.store.reports).toHaveLength(0);
    expect(harness.researchCalls).toEqual(['solana:aaa']);
    expect(harness.store.scores).toHaveLength(2);
    expect(record.stats.sourceErrors.map((e) => e.source)).toEqual(['research:solana:aaa', 'llm']);
    expect(record.status).toBe('partial');
  });

  test('a zero budget means market-only from the first token', async () => {
    const harness = makeHarness({ snapshots: [makeSnapshot('solana:aaa')] });
    const base = makeConfig();
    const app = makeConfig({ llm: { ...base.llm, maxCostUsdPerRun: 0 } });

    const record = await runPipeline(app, silentLogger, harness.deps, { runId: RUN });

    expect(harness.researchCalls).toEqual([]);
    expect(record.stats.llmCostUsd).toBe(0);
    expect(record.stats.analysed).toBe(1);
  });

  test('--no-llm skips the research stage entirely', async () => {
    const harness = makeHarness({ snapshots: [makeSnapshot('solana:aaa')] });
    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, {
      runId: RUN,
      skipLlm: true,
    });

    expect(harness.stages).not.toContain('createResearcher');
    expect(harness.evidenceCalls).toEqual([]);
    expect(record.stats.analysed).toBe(1);
    expect(record.status).toBe('ok');
  });
});

describe('per-token failure isolation', () => {
  test('one broken token does not abort the run', async () => {
    const snapshots = ['aaa', 'bbb', 'ccc'].map((id) => makeSnapshot(`solana:${id}`));
    const harness = makeHarness({
      snapshots,
      scoreToken: (input) => {
        if (input.snapshot.tokenId === 'solana:bbb') throw new Error('scorer exploded');
        return makeScore(input.snapshot.tokenId);
      },
    });

    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN });

    expect(record.status).toBe('partial');
    expect(record.stats.analysed).toBe(2);
    expect(record.stats.sourceErrors).toContainEqual({
      source: 'token:solana:bbb',
      error: 'scorer exploded',
    });
    expect(harness.store.scores.map((score) => score.tokenId)).toEqual(['solana:aaa', 'solana:ccc']);
  });

  test('a failing chain analyser degrades that token instead of dropping it', async () => {
    const harness = makeHarness({
      snapshots: [makeSnapshot('solana:aaa')],
      analyzeToken: async () => {
        throw new Error('rpc down');
      },
    });

    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN });

    expect(record.status).toBe('ok');
    expect(record.stats.analysed).toBe(1);
    expect(harness.store.chainAnalyses).toHaveLength(0);
    expect(harness.store.scores).toHaveLength(1);
  });
});

describe('alerts', () => {
  test('dispatches once, persists each alert with its delivery results', async () => {
    const snapshots = [makeSnapshot('solana:aaa'), makeSnapshot('solana:bbb')];
    const harness = makeHarness({
      snapshots,
      createAlerts: (runId, input) => [makeAlert(runId, input.snapshot.tokenId)],
    });

    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN });

    expect(harness.dispatched).toHaveLength(1);
    expect(harness.dispatched[0]).toHaveLength(2);
    expect(record.stats.alertsFired).toBe(2);
    expect(harness.store.alerts).toHaveLength(2);
    expect(harness.store.alerts[0]?.deliveries.map((d) => d.channel)).toEqual(['console', 'telegram']);
  });

  test('dry run keeps remote channels out of the dispatch', async () => {
    const harness = makeHarness({
      snapshots: [makeSnapshot('solana:aaa')],
      createAlerts: (runId, input) => [makeAlert(runId, input.snapshot.tokenId)],
    });
    const base = makeConfig();
    const app = makeConfig({ pipeline: { ...base.pipeline, dryRun: true } });

    await runPipeline(app, silentLogger, harness.deps, { runId: RUN });

    expect(harness.sinkFilter[0]).toEqual(['console']);
  });

  test('prior scores are passed to the rules as history', async () => {
    const store = new FakeStore();
    store.priorScores.set('solana:aaa', [makeScore('solana:aaa', 40)]);
    let seen: number[] = [];
    const harness = makeHarness({
      store,
      snapshots: [makeSnapshot('solana:aaa')],
      createAlerts: (_runId, input) => {
        seen = input.history.map((score) => score.total);
        return [];
      },
    });

    await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN });
    expect(seen).toEqual([40]);
  });
});

describe('RunStats and status', () => {
  test('counts discovery, filtering, analysis, reuse, alerts and cost', async () => {
    const store = new FakeStore();
    store.priorReports.set('solana:bbb', makeReport('solana:bbb', { generatedAt: hoursAgo(1) }));
    const snapshots = ['aaa', 'bbb', 'ccc'].map((id) => makeSnapshot(`solana:${id}`));
    const harness = makeHarness({
      store,
      snapshots,
      dropped: [{ tokenId: 'solana:ccc', reason: 'liquidity below floor' }],
      costPerReport: 0.25,
      createAlerts: (runId, input) => [makeAlert(runId, input.snapshot.tokenId)],
    });

    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN });

    expect(record.stats.discovered).toBe(3);
    expect(record.stats.afterFilter).toBe(2);
    expect(record.stats.analysed).toBe(1);
    expect(record.stats.reused).toBe(1);
    expect(record.stats.alertsFired).toBe(2);
    expect(record.stats.llmCostUsd).toBeCloseTo(0.25, 6);
    expect(record.stats.durationMs).toBeGreaterThanOrEqual(0);
    expect(record.finishedAt).toBeTruthy();
  });

  test('maxTokensPerRun caps what gets the full treatment', async () => {
    const snapshots = ['aaa', 'bbb', 'ccc', 'ddd'].map((id) => makeSnapshot(`solana:${id}`));
    const harness = makeHarness({ snapshots });
    const base = makeConfig();
    const app = makeConfig({ pipeline: { ...base.pipeline, maxTokensPerRun: 2 } });

    const record = await runPipeline(app, silentLogger, harness.deps, { runId: RUN });

    expect(harness.store.snapshots).toHaveLength(2);
    expect(record.stats.afterFilter).toBe(4);
    expect(record.stats.analysed).toBe(2);
  });

  test('a source error with usable output is partial', async () => {
    const harness = makeHarness({
      snapshots: [makeSnapshot('solana:aaa')],
      discoveryErrors: [{ source: 'dextools', error: 'timeout' }],
    });
    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN });

    expect(record.status).toBe('partial');
    expect(record.stats.sourceErrors).toHaveLength(1);
  });

  test('every token failing is a failed run', async () => {
    const harness = makeHarness({
      snapshots: [makeSnapshot('solana:aaa')],
      scoreToken: () => {
        throw new Error('nope');
      },
    });
    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN });
    expect(record.status).toBe('failed');
  });

  test('a quiet market with nothing broken is still ok', async () => {
    const harness = makeHarness({ snapshots: [] });
    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN });
    expect(record.status).toBe('ok');
    expect(record.stats.analysed).toBe(0);
  });

  test('resolveStatus: nothing discovered plus source errors is failed', () => {
    const stats = {
      discovered: 0,
      afterFilter: 0,
      analysed: 0,
      reused: 0,
      alertsFired: 0,
      llmCostUsd: 0,
      sourceErrors: [{ source: 'dexscreener', error: '403' }],
    };
    expect(resolveStatus(0, stats)).toBe('failed');
    expect(resolveStatus(0, { ...stats, sourceErrors: [] })).toBe('ok');
    expect(resolveStatus(2, { ...stats, analysed: 1 })).toBe('partial');
    expect(resolveStatus(2, { ...stats, sourceErrors: [], reused: 2 })).toBe('ok');
    expect(resolveStatus(2, stats)).toBe('failed');
  });

  test('resolveStatus: social feed errors alone degrade a quiet run, never fail it', () => {
    const stats = {
      discovered: 0,
      afterFilter: 0,
      analysed: 0,
      reused: 0,
      alertsFired: 0,
      llmCostUsd: 0,
      sourceErrors: [
        { source: 'elfa:twitter', error: '500' },
        { source: 'social', error: 'db' },
      ],
    };
    expect(resolveStatus(0, stats)).toBe('partial');
    const withDex = { ...stats, sourceErrors: [...stats.sourceErrors, { source: 'dexscreener', error: '403' }] };
    expect(resolveStatus(0, withDex)).toBe('failed');
  });
});
