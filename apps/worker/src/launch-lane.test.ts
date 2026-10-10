import { describe, expect, test } from 'bun:test';
import { silentLogger, type WatchEntry } from '@provenance/core';
import { runPipeline } from './pipeline';
import {
  FakeStore,
  makeAnchor,
  makeConfig,
  makeHarness,
  makeLaunchSnapshot,
  makeReport,
  makeSnapshot,
  makeTrendingSnapshot,
} from './test-fakes';

const RUN = 'run_lane';

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function watchEntry(tokenId: string, overrides: Partial<WatchEntry> = {}): WatchEntry {
  const [chain = 'ethereum', address = tokenId] = tokenId.split(':');
  return {
    tokenId,
    chain: chain as WatchEntry['chain'],
    tokenAddress: address,
    symbol: address.toUpperCase(),
    name: address,
    status: 'active',
    firstSeenAt: hoursAgo(30),
    anchor: makeAnchor(),
    gate: { passed: true, reasons: [] },
    updatedAt: hoursAgo(30),
    ...overrides,
  };
}

describe('launch lane', () => {
  test('an anchored launch is researched at launch, stored and alerted', async () => {
    const harness = makeHarness({
      snapshots: [makeSnapshot('solana:aaa'), makeLaunchSnapshot('ethereum:0xlaunch', { metrics: { liquidityUsd: 60_000 } })],
    });
    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN, concurrency: 1 });

    // Full research runs on the launch, not once it trends.
    expect(harness.researchCalls).toEqual(['ethereum:0xlaunch', 'solana:aaa']);
    const stages = harness.stages;
    expect(stages.indexOf('anchor:ethereum:0xlaunch')).toBeLessThan(stages.indexOf('research:ethereum:0xlaunch'));
    // Launch lane before trending lane: the verdict at launch gets the budget first.
    expect(stages.indexOf('research:ethereum:0xlaunch')).toBeLessThan(stages.indexOf('filter'));

    const saved = harness.store.watch.get('ethereum:0xlaunch');
    expect(saved?.status).toBe('active');
    expect(saved?.researched).toBe(true);
    expect(saved?.liquidityUsdAtCatalog).toBe(60_000);
    expect(harness.store.reports.map((report) => report.tokenId)).toContain('ethereum:0xlaunch');
    expect(record.stats.discovered).toBe(1);
    expect(record.stats.launches).toMatchObject({ discovered: 1, catalogued: 1, researched: 1, dismissed: 0 });
    const alert = harness.dispatched.flat().find((a) => a.rule === 'launch-anchored');
    expect(alert?.payload.researched).toBe(true);
    // Anchor check + launch research + trending research, one ceiling.
    expect(record.stats.llmCostUsd).toBeCloseTo(0.21, 6);
    expect(record.status).toBe('ok');
  });

  test('a thin launch is rejected before any RPC, and is not stored so it can be retried', async () => {
    const harness = makeHarness({
      snapshots: [makeLaunchSnapshot('ethereum:0xthin', { metrics: { liquidityUsd: 5_000 } })],
    });
    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN });
    expect(harness.stages).not.toContain('analyze:ethereum:0xthin');
    expect(harness.store.watch.size).toBe(0);
    expect(record.stats.launches).toMatchObject({ rejected: 1, catalogued: 0 });
  });

  test('a chain-gate failure stops before the anchor check', async () => {
    const harness = makeHarness({
      snapshots: [makeLaunchSnapshot('ethereum:0xrug')],
      chainGate: () => ({ passed: false, reasons: ['privileged-mint: owner can mint'] }),
    });
    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN });
    expect(harness.stages).toContain('analyze:ethereum:0xrug');
    expect(harness.stages).not.toContain('anchor:ethereum:0xrug');
    expect(harness.store.watch.size).toBe(0);
    expect(record.stats.launches?.rejected).toBe(1);
  });

  test('forced, unclear and low-confidence verdicts are stored as dismissed, without full research', async () => {
    const verdicts: Record<string, ReturnType<typeof makeAnchor>> = {
      'ethereum:0xforced': makeAnchor({ verdict: 'forced', type: 'none', subject: '' }),
      'ethereum:0xunclear': makeAnchor({ verdict: 'unclear', confidence: 'medium' }),
      'ethereum:0xweak': makeAnchor({ confidence: 'low' }),
    };
    const harness = makeHarness({
      snapshots: Object.keys(verdicts).map((id) => makeLaunchSnapshot(id)),
      anchor: (snapshot) => verdicts[snapshot.tokenId] ?? makeAnchor(),
    });
    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN, concurrency: 1 });
    expect(harness.researchCalls).toEqual([]);
    expect([...harness.store.watch.values()].map((entry) => entry.status)).toEqual(['dismissed', 'dismissed', 'dismissed']);
    expect(harness.store.watch.get('ethereum:0xforced')?.anchor.verdict).toBe('forced');
    expect(record.stats.launches?.dismissed).toBe(3);
    expect(harness.dispatched.flat()).toHaveLength(0);
  });

  test('a confident deep verdict overturns the fast one; a degraded one does not', async () => {
    const harness = makeHarness({
      snapshots: [makeLaunchSnapshot('ethereum:0xdeep'), makeLaunchSnapshot('ethereum:0xthin2')],
      research: async (snapshot) =>
        makeReport(snapshot.tokenId, {
          anchor: snapshot.tokenId.endsWith('deep')
            ? { verdict: 'forced', type: 'none', subject: '', summary: 'Only the launch posts.', confidence: 'medium' }
            : { verdict: 'unclear', type: 'none', subject: '', summary: 'Research failed.', confidence: 'low' },
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.1 },
        }),
    });
    await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN, concurrency: 1 });
    expect(harness.store.watch.get('ethereum:0xdeep')?.status).toBe('dismissed');
    expect(harness.store.watch.get('ethereum:0xdeep')?.anchor.verdict).toBe('forced');
    expect(harness.store.watch.get('ethereum:0xthin2')?.status).toBe('active');
    expect(harness.store.watch.get('ethereum:0xthin2')?.anchor.verdict).toBe('anchored');
  });

  test('--no-llm skips the verdict and stores nothing, so the next run judges it', async () => {
    const skip = makeHarness({ snapshots: [makeLaunchSnapshot('ethereum:0xabc')] });
    await runPipeline(makeConfig(), silentLogger, skip.deps, { runId: RUN, skipLlm: true });
    expect(skip.stages).not.toContain('anchor:ethereum:0xabc');
    expect(skip.store.watch.size).toBe(0);
  });

  test('the launch lane spends first; trending research gets what is left', async () => {
    const harness = makeHarness({
      snapshots: [makeSnapshot('solana:aaa'), makeLaunchSnapshot('ethereum:0xabc')],
      costPerReport: 1,
    });
    const record = await runPipeline(makeConfig({ llm: { ...makeConfig().llm, maxCostUsdPerRun: 1 } }), silentLogger, harness.deps, {
      runId: RUN,
      concurrency: 1,
    });
    expect(harness.researchCalls).toEqual(['ethereum:0xabc']);
    expect(record.stats.sourceErrors.map((e) => e.source)).toContain('llm-budget');
    expect(record.status).toBe('partial');
  });

  test('a token already judged is not judged again, whatever the verdict', async () => {
    const store = new FakeStore();
    await store.saveWatch(watchEntry('ethereum:0xseen', { status: 'dismissed', anchor: makeAnchor({ verdict: 'forced' }) }));
    const harness = makeHarness({ store, snapshots: [makeLaunchSnapshot('ethereum:0xseen')] });
    await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN });
    expect(harness.stages).not.toContain('analyze:ethereum:0xseen');
  });

  test('a check that errored is not stored, and a refused provider stops LLM work for the run', async () => {
    const credits = 'openrouter /chat/completions HTTP 402: This request requires more credits';
    const harness = makeHarness({
      snapshots: [makeSnapshot('solana:aaa'), makeLaunchSnapshot('ethereum:0xa'), makeLaunchSnapshot('ethereum:0xb')],
      anchor: () => makeAnchor({ verdict: 'unclear', confidence: 'low', failed: credits }),
    });
    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN, concurrency: 1 });
    // Not judged, so the next run retries both.
    expect(harness.store.watch.size).toBe(0);
    expect(harness.stages).toContain('anchor:ethereum:0xa');
    expect(harness.stages).not.toContain('anchor:ethereum:0xb');
    expect(harness.researchCalls).toEqual([]);
    expect(record.stats.sourceErrors.map((e) => e.source)).toEqual(['anchor:ethereum:0xa', 'llm']);
    expect(record.status).toBe('partial');
  });

  test('a transient check failure skips that token only', async () => {
    const harness = makeHarness({
      snapshots: [makeLaunchSnapshot('ethereum:0xa', { metrics: { liquidityUsd: 90_000 } }), makeLaunchSnapshot('ethereum:0xb')],
      anchor: (snapshot) =>
        snapshot.tokenId === 'ethereum:0xa'
          ? makeAnchor({ verdict: 'unclear', confidence: 'low', failed: 'socket hang up' })
          : makeAnchor(),
    });
    await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN, concurrency: 1 });
    expect(harness.store.watch.has('ethereum:0xa')).toBe(false);
    expect(harness.store.watch.get('ethereum:0xb')?.status).toBe('active');
  });
});

describe('watchlist reconciliation', () => {
  test('a judged token seen trending is expressed, with the hours since its verdict', async () => {
    const store = new FakeStore();
    await store.saveWatch(watchEntry('ethereum:0xhit'));
    const harness = makeHarness({
      store,
      snapshots: [makeTrendingSnapshot('ethereum:0xhit', 'geckoterminal')],
      // Dropped by the trending filter: expression still counts.
      dropped: [{ tokenId: 'ethereum:0xhit', reason: 'minVolume24hUsd' }],
    });
    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN });

    const entry = store.watch.get('ethereum:0xhit');
    expect(entry?.status).toBe('expressed');
    expect(entry?.expressedOn).toEqual(['geckoterminal']);
    expect(entry?.leadHours).toBeGreaterThan(29.9);
    expect(entry?.leadHours).toBeLessThan(30.1);
    expect(record.stats.launches?.expressed).toBe(1);
    expect(harness.dispatched.flat().map((alert) => alert.rule)).toEqual(['launch-expressed']);
  });

  test('a dismissed forced meme that trends anyway is recorded, verdict intact', async () => {
    const store = new FakeStore();
    await store.saveWatch(watchEntry('ethereum:0xpump', { status: 'dismissed', anchor: makeAnchor({ verdict: 'forced' }) }));
    const harness = makeHarness({ store, snapshots: [makeTrendingSnapshot('ethereum:0xpump')] });
    await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN });
    expect(store.watch.get('ethereum:0xpump')?.status).toBe('expressed');
    expect(store.watch.get('ethereum:0xpump')?.anchor.verdict).toBe('forced');
  });

  test('a dormant entry can still express; an expressed one does not re-fire', async () => {
    const store = new FakeStore();
    await store.saveWatch(watchEntry('ethereum:0xlate', { status: 'dormant', firstSeenAt: hoursAgo(400) }));
    await store.saveWatch(watchEntry('ethereum:0xdone', { status: 'expressed', expressedAt: hoursAgo(10), leadHours: 20 }));
    const harness = makeHarness({
      store,
      snapshots: [makeTrendingSnapshot('ethereum:0xlate'), makeTrendingSnapshot('ethereum:0xdone')],
    });
    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN });
    expect(store.watch.get('ethereum:0xlate')?.status).toBe('expressed');
    expect(store.watch.get('ethereum:0xdone')?.leadHours).toBe(20);
    expect(record.stats.launches?.expressed).toBe(1);
  });

  test('active entries past the dormancy window go dormant; dismissed ones are left alone', async () => {
    const store = new FakeStore();
    await store.saveWatch(watchEntry('ethereum:0xold', { firstSeenAt: hoursAgo(200) }));
    await store.saveWatch(watchEntry('ethereum:0xnew', { firstSeenAt: hoursAgo(2) }));
    await store.saveWatch(watchEntry('ethereum:0xno', { status: 'dismissed', firstSeenAt: hoursAgo(200) }));
    const harness = makeHarness({ store, snapshots: [] });
    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN });
    expect(store.watch.get('ethereum:0xold')?.status).toBe('dormant');
    expect(store.watch.get('ethereum:0xnew')?.status).toBe('active');
    expect(store.watch.get('ethereum:0xno')?.status).toBe('dismissed');
    expect(record.stats.launches?.dormant).toBe(1);
  });
});

describe('verdict reconciliation', () => {
  test('a confident deep agreement replaces the fast verdict with the better-sourced one', async () => {
    const harness = makeHarness({
      snapshots: [makeLaunchSnapshot('ethereum:0xagree')],
      research: async (snapshot) =>
        makeReport(snapshot.tokenId, {
          anchor: {
            verdict: 'anchored',
            type: 'inciting-event',
            subject: 'the viral clip',
            anchorDate: '2026-09-20',
            earliestSource: { title: 'News report', date: '2026-09-20' },
            precedesLaunch: true,
            summary: 'Reported before the pool opened.',
            confidence: 'high',
          },
        }),
    });
    await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN });
    const entry = harness.store.watch.get('ethereum:0xagree');
    expect(entry?.status).toBe('active');
    expect(entry?.anchor.type).toBe('inciting-event');
    expect(entry?.anchor.earliestSource?.title).toBe('News report');
  });
});
