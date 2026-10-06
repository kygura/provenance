import { describe, expect, test } from 'bun:test';
import { type AppConfig, type SocialSighting, type WatchEntry, silentLogger } from '@provenance/core';
import { runPipeline } from './pipeline';
import { FakeStore, makeAnchor, makeConfig, makeHarness, makeLaunchSnapshot } from './test-fakes';

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function keyed(overrides: Partial<AppConfig['social']> = {}): AppConfig {
  const base = makeConfig();
  return makeConfig({ social: { ...base.social, elfaApiKey: 'elfa_test', ...overrides } });
}

function sighting(tokenId: string, seenAt: string, platform: SocialSighting['platform'] = 'twitter'): SocialSighting {
  const [chain = 'ethereum', address = tokenId] = tokenId.split(':');
  return { tokenId, chain: chain as SocialSighting['chain'], tokenAddress: address, platform, mentionCount: 9, seenAt };
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

/** A finished run whose social step fetched `hours` ago. */
function priorFetch(store: FakeStore, hours: number): void {
  store.runs.set('run_prior', {
    id: 'run_prior',
    startedAt: hoursAgo(hours),
    status: 'ok',
    stats: {
      discovered: 0,
      afterFilter: 0,
      analysed: 0,
      reused: 0,
      alertsFired: 0,
      llmCostUsd: 0,
      sourceErrors: [],
      social: { fetchedAt: hoursAgo(hours), sightings: 3, newTokens: 3, matched: 0 },
    },
  });
}

describe('social step', () => {
  test('without a key nothing is fetched and the run is untouched', async () => {
    const harness = makeHarness({ snapshots: [] });
    const record = await runPipeline(makeConfig(), silentLogger, harness.deps, { runId: 'run_nokey' });
    expect(harness.stages).not.toContain('social');
    expect(harness.store.calls).not.toContain('socialFirstSeen');
    expect(record.stats.social).toEqual({ skipped: 'no-key', sightings: 0, newTokens: 0, matched: 0 });
    expect(record.status).toBe('ok');
  });

  test('a keyed run records sightings and counts the tokens never seen before', async () => {
    const store = new FakeStore();
    store.sightings.push(sighting('ethereum:0xold', hoursAgo(48)));
    const harness = makeHarness({
      snapshots: [],
      store,
      social: () => ({
        sightings: [
          sighting('ethereum:0xold', hoursAgo(0)),
          sighting('ethereum:0xnew', hoursAgo(0)),
          sighting('ethereum:0xnew', hoursAgo(0), 'telegram'),
        ],
        errors: [],
      }),
    });
    const record = await runPipeline(keyed(), silentLogger, harness.deps, { runId: 'run_keyed' });
    expect(harness.stages.indexOf('social')).toBeLessThan(harness.stages.indexOf('filter'));
    expect(store.sightings).toHaveLength(4);
    expect(record.stats.social).toMatchObject({ sightings: 3, newTokens: 1 });
    expect(record.stats.social?.fetchedAt).toBeDefined();
    expect(record.status).toBe('ok');
  });

  test('the interval is measured from the last run that fetched', async () => {
    const recent = makeHarness({ snapshots: [], store: new FakeStore() });
    priorFetch(recent.store, 1);
    const throttled = await runPipeline(keyed(), silentLogger, recent.deps, { runId: 'run_throttled' });
    expect(recent.stages).not.toContain('social');
    expect(throttled.stats.social?.skipped).toBe('throttled');

    const stale = makeHarness({ snapshots: [], store: new FakeStore() });
    priorFetch(stale.store, 7);
    await runPipeline(keyed(), silentLogger, stale.deps, { runId: 'run_due' });
    expect(stale.stages).toContain('social');

    const unthrottled = makeHarness({ snapshots: [], store: new FakeStore() });
    priorFetch(unthrottled.store, 1);
    await runPipeline(keyed({ minIntervalHours: 0 }), silentLogger, unthrottled.deps, { runId: 'run_every' });
    expect(unthrottled.stages).toContain('social');
  });

  test('when every feed fails, no fetch is recorded so the next run retries', async () => {
    const harness = makeHarness({
      snapshots: [],
      social: () => ({
        sightings: [],
        errors: [
          { source: 'elfa:twitter', error: '401' },
          { source: 'elfa:telegram', error: '401' },
        ],
      }),
    });
    const record = await runPipeline(keyed(), silentLogger, harness.deps, { runId: 'run_fail' });
    expect(record.stats.social?.fetchedAt).toBeUndefined();
    expect(record.stats.sourceErrors.map((e) => e.source)).toEqual(['elfa:twitter', 'elfa:telegram']);
    // An optional yardstick failing degrades a quiet run; it does not fail it.
    expect(record.status).toBe('partial');
  });

  test('one feed failing still records the other and the fetch', async () => {
    const harness = makeHarness({
      snapshots: [],
      social: () => ({ sightings: [sighting('ethereum:0xa', hoursAgo(0))], errors: [{ source: 'elfa:telegram', error: '500' }] }),
    });
    const record = await runPipeline(keyed(), silentLogger, harness.deps, { runId: 'run_half' });
    expect(record.stats.social?.fetchedAt).toBeDefined();
    expect(harness.store.sightings).toHaveLength(1);
    expect(record.status).toBe('partial');
  });

  test('a store failure in the social step is recorded, not fatal', async () => {
    const store = new FakeStore();
    store.failOn = { method: 'recordSocialSightings' };
    const harness = makeHarness({ store, social: () => ({ sightings: [sighting('ethereum:0xa', hoursAgo(0))], errors: [] }) });
    const record = await runPipeline(keyed(), silentLogger, harness.deps, { runId: 'run_storefail' });
    expect(record.stats.sourceErrors.map((e) => e.source)).toContain('social');
    expect(record.stats.analysed).toBe(2);
    expect(record.status).toBe('partial');
  });
});

describe('social lead', () => {
  test('a watched token sighted after cataloguing gets a positive lead', async () => {
    const store = new FakeStore();
    await store.saveWatch(watchEntry('ethereum:0xearly', { firstSeenAt: hoursAgo(30) }));
    const harness = makeHarness({ snapshots: [], store, social: () => ({ sightings: [sighting('ethereum:0xearly', hoursAgo(0))], errors: [] }) });
    const record = await runPipeline(keyed(), silentLogger, harness.deps, { runId: 'run_lead' });

    const entry = store.watch.get('ethereum:0xearly');
    expect(entry?.socialLeadHours).toBeGreaterThan(29.9);
    expect(entry?.socialLeadHours).toBeLessThan(30.1);
    expect(entry?.socialOn).toEqual(['twitter']);
    expect(record.stats.social?.matched).toBe(1);
  });

  test('a launch judged this run after the crowd found it gets a negative lead', async () => {
    const store = new FakeStore();
    store.sightings.push(sighting('ethereum:0xlate', hoursAgo(10), 'telegram'));
    priorFetch(store, 1);
    const harness = makeHarness({
      snapshots: [makeLaunchSnapshot('ethereum:0xlate', { metrics: { liquidityUsd: 60_000 } })],
      store,
    });
    const record = await runPipeline(keyed(), silentLogger, harness.deps, { runId: 'run_late' });

    // Throttled, yet still reconciled against the sightings already stored.
    expect(record.stats.social?.skipped).toBe('throttled');
    const entry = store.watch.get('ethereum:0xlate');
    expect(entry?.socialLeadHours).toBeLessThan(-9.9);
    expect(entry?.socialLeadHours).toBeGreaterThan(-10.1);
    expect(entry?.socialOn).toEqual(['telegram']);
  });

  test('dismissed entries are matched too, and a first sighting is never moved', async () => {
    const store = new FakeStore();
    await store.saveWatch(watchEntry('ethereum:0xforced', { status: 'dismissed', anchor: makeAnchor({ verdict: 'forced' }) }));
    await store.saveWatch(
      watchEntry('ethereum:0xdone', { socialAt: hoursAgo(20), socialLeadHours: 10, socialOn: ['twitter'] }),
    );
    store.sightings.push(sighting('ethereum:0xforced', hoursAgo(2)), sighting('ethereum:0xdone', hoursAgo(25)));
    priorFetch(store, 1);
    const harness = makeHarness({ snapshots: [], store });
    const record = await runPipeline(keyed(), silentLogger, harness.deps, { runId: 'run_mixed' });

    expect(store.watch.get('ethereum:0xforced')?.socialLeadHours).toBeCloseTo(28, 0);
    expect(store.watch.get('ethereum:0xdone')?.socialLeadHours).toBe(10);
    expect(record.stats.social?.matched).toBe(1);
  });
});
