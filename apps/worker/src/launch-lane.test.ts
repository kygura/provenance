import { describe, expect, test } from 'bun:test';
import { silentLogger, type WatchEntry } from '@provenance/core';
import { runPipeline } from './pipeline';
import {
  FakeStore,
  makeConfig,
  makeHarness,
  makeLaunchSnapshot,
  makeReferent,
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
    referent: makeReferent(),
    gate: { passed: true, reasons: [] },
    updatedAt: hoursAgo(30),
    ...overrides,
  };
}

describe('launch lane', () => {
  test('catalogues a launch that clears the gate and the referent check', async () => {
    const harness = makeHarness({
      snapshots: [makeSnapshot('solana:aaa'), makeLaunchSnapshot('ethereum:0xlaunch', { metrics: { liquidityUsd: 60_000 } })],
    });
    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN, concurrency: 1 });

    // The trending lane is untouched by the launch token.
    expect(harness.researchCalls).toEqual(['solana:aaa']);
    expect(harness.stages).toContain('analyze:ethereum:0xlaunch');
    expect(harness.stages).toContain('referent:ethereum:0xlaunch');

    const saved = harness.store.watch.get('ethereum:0xlaunch');
    expect(saved?.status).toBe('active');
    expect(saved?.liquidityUsdAtCatalog).toBe(60_000);
    expect(record.stats.discovered).toBe(1);
    expect(record.stats.launches).toMatchObject({ discovered: 1, catalogued: 1, rejected: 0 });
    expect(harness.dispatched.flat().map((alert) => alert.rule)).toContain('launch-catalogued');
    // Launch referent spend counts against the same ceiling as research.
    expect(record.stats.llmCostUsd).toBeCloseTo(0.11, 6);
    expect(record.status).toBe('ok');
  });

  test('a thin launch is rejected before any RPC', async () => {
    const harness = makeHarness({
      snapshots: [makeLaunchSnapshot('ethereum:0xthin', { metrics: { liquidityUsd: 5_000 } })],
    });
    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN });
    expect(harness.stages).not.toContain('analyze:ethereum:0xthin');
    expect(record.stats.launches).toMatchObject({ rejected: 1, catalogued: 0 });
  });

  test('a chain-gate failure stops before the referent check', async () => {
    const harness = makeHarness({
      snapshots: [makeLaunchSnapshot('ethereum:0xrug')],
      chainGate: () => ({ passed: false, reasons: ['privileged-mint: owner can mint'] }),
    });
    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN });
    expect(harness.stages).toContain('analyze:ethereum:0xrug');
    expect(harness.stages).not.toContain('referent:ethereum:0xrug');
    expect(harness.store.watch.size).toBe(0);
    expect(record.stats.launches?.rejected).toBe(1);
  });

  test('a low-confidence or unvalidated referent is not catalogued', async () => {
    const harness = makeHarness({
      snapshots: [makeLaunchSnapshot('ethereum:0xone'), makeLaunchSnapshot('ethereum:0xtwo')],
      referent: (snapshot) =>
        snapshot.tokenId.endsWith('one') ? makeReferent({ confidence: 'low' }) : makeReferent({ validated: false }),
    });
    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN, concurrency: 1 });
    expect(harness.store.watch.size).toBe(0);
    expect(record.stats.launches?.unvalidated).toBe(2);
  });

  test('--no-llm and an exhausted budget both skip the referent check', async () => {
    const skip = makeHarness({ snapshots: [makeLaunchSnapshot('ethereum:0xabc')] });
    await runPipeline(makeConfig(), silentLogger, skip.deps, { runId: RUN, skipLlm: true });
    expect(skip.stages).not.toContain('referent:ethereum:0xabc');

    // Trending research spends the whole budget first; the launch lane runs after.
    const spent = makeHarness({
      snapshots: [makeSnapshot('solana:aaa'), makeLaunchSnapshot('ethereum:0xabc')],
      costPerReport: 1,
    });
    const record = await runPipeline(makeConfig({ llm: { ...makeConfig().llm, maxCostUsdPerRun: 1 } }), silentLogger, spent.deps, {
      runId: RUN,
    });
    expect(spent.stages).not.toContain('referent:ethereum:0xabc');
    expect(record.stats.launches?.unvalidated).toBe(1);
  });

  test('a token already on the watchlist is not catalogued again', async () => {
    const store = new FakeStore();
    await store.saveWatch(watchEntry('ethereum:0xseen', { status: 'dormant' }));
    const harness = makeHarness({ store, snapshots: [makeLaunchSnapshot('ethereum:0xseen')] });
    await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN });
    expect(harness.stages).not.toContain('analyze:ethereum:0xseen');
  });
});

describe('watchlist reconciliation', () => {
  test('a watchlisted token seen trending is expressed, with its lead time', async () => {
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

  test('active entries past the dormancy window go dormant', async () => {
    const store = new FakeStore();
    await store.saveWatch(watchEntry('ethereum:0xold', { firstSeenAt: hoursAgo(200) }));
    await store.saveWatch(watchEntry('ethereum:0xnew', { firstSeenAt: hoursAgo(2) }));
    const harness = makeHarness({ store, snapshots: [] });
    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: RUN });
    expect(store.watch.get('ethereum:0xold')?.status).toBe('dormant');
    expect(store.watch.get('ethereum:0xnew')?.status).toBe('active');
    expect(record.stats.launches?.dormant).toBe(1);
  });
});
