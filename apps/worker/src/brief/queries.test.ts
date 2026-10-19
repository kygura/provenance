import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Setup } from '@provenance/core';
import {
  queryAlerts24h,
  queryClusters,
  queryDossiers,
  queryFullRuns,
  queryRegimeCounts,
  queryRuns24h,
  queryActiveWatch,
  queryLatestFacts,
  querySevereAlerts,
  queryTrackRecord,
  queryVerdictHistory,
  queryWatchChanges,
} from './queries';
import { hoursAgo, seedRun, seedToken, tempDb, type TempDb } from './test-db';

let db: TempDb;

beforeEach(async () => {
  db = await tempDb();
});
afterEach(async () => {
  await db.cleanup();
});

const X = 'solana:XxxxTokenAddress1111111111111111';
const Y = 'solana:YyyyTokenAddress2222222222222222';

async function seedTwoFullRunsAndLaunchLane(): Promise<void> {
  const { store } = db;
  await seedRun(store, 'run_prev', hoursAgo(13));
  await seedToken(store, 'run_prev', {
    tokenId: X,
    at: hoursAgo(13),
    score: { total: 60, tier: 'B' },
    report: { anchor: { verdict: 'unclear', type: 'none', subject: '', summary: 'nothing found', confidence: 'low' } },
  });
  await seedRun(store, 'run_cur', hoursAgo(2));
  await seedToken(store, 'run_cur', {
    tokenId: X,
    symbol: 'XXX',
    at: hoursAgo(2),
    metrics: { liquidityUsd: 120_000, marketCapUsd: 2_000_000, volume24hUsd: 900_000 },
    score: { total: 76, tier: 'A', components: { recycling: 90, memetic: 80 } },
    chain: { top10Pct: 31.5, largestHolderPct: 6.2, mintAuthorityActive: false, flags: [{ code: 'lp-unlocked', severity: 'warn', detail: 'd' }] },
    report: { anchor: { verdict: 'anchored', type: 'historical-meme', subject: 'x', summary: 'dated 2013', confidence: 'high' } },
  });
  await seedToken(store, 'run_cur', { tokenId: Y, at: hoursAgo(2), score: { total: 88, tier: 'S' } });
  // Launch-lane runs: newer than both full runs, never any snapshots.
  await seedRun(store, 'run_lane_1', hoursAgo(1), 'ok', { launches: { catalogued: 1, expressed: 0 } });
  await seedRun(store, 'run_lane_2', hoursAgo(0.5), 'partial', { sourceErrors: [{ source: 'launches', error: 'rpc 429' }] });
}

describe('query A: CUR/PREV selection', () => {
  test('skips launch-lane runs (no snapshots), even when they are newer', async () => {
    await seedTwoFullRunsAndLaunchLane();
    const { cur, prev } = await queryFullRuns(db.store.raw);
    expect(cur?.id).toBe('run_cur');
    expect(prev?.id).toBe('run_prev');
  });

  test('at an hourly cadence PREV is the full run at least 11 h before CUR, not the one before it', async () => {
    await seedTwoFullRunsAndLaunchLane();
    // run_cur is 2 h ago and run_prev 13 h ago; an hourly run sits between.
    await seedRun(db.store, 'run_hourly', hoursAgo(3));
    await seedToken(db.store, 'run_hourly', { tokenId: Y, at: hoursAgo(3) });
    const { cur, prev } = await queryFullRuns(db.store.raw);
    expect(cur?.id).toBe('run_cur');
    expect(prev?.id).toBe('run_prev');
  });

  test('a failed or running run with snapshots is not CUR', async () => {
    await seedTwoFullRunsAndLaunchLane();
    await seedRun(db.store, 'run_failed', hoursAgo(0.2), 'failed');
    await seedToken(db.store, 'run_failed', { tokenId: Y, at: hoursAgo(0.2) });
    expect((await queryFullRuns(db.store.raw)).cur?.id).toBe('run_cur');
  });

  test('the 24 h list types every cell and marks which runs have snapshots', async () => {
    await seedTwoFullRunsAndLaunchLane();
    const runs = await queryRuns24h(db.store.raw);
    expect(runs.map((run) => run.id)).toEqual(['run_lane_2', 'run_lane_1', 'run_cur', 'run_prev']);
    const byId = new Map(runs.map((run) => [run.id, run]));
    expect(byId.get('run_cur')?.hasSnapshots).toBe(true);
    expect(byId.get('run_lane_1')?.hasSnapshots).toBe(false);
    expect(byId.get('run_lane_1')?.launchesCatalogued).toBe(1);
    expect(byId.get('run_lane_2')?.sourceErrors).toBe(1);
  });
});

describe('query B: dossiers with the previous score', () => {
  test('joins PREV by bound argument and coerces numbers, booleans and JSON', async () => {
    await seedTwoFullRunsAndLaunchLane();
    const rows = await queryDossiers(db.store.raw, 'run_cur', 'run_prev');
    expect(rows.map((row) => row.tokenId)).toEqual([Y, X]); // score DESC
    const x = rows.find((row) => row.tokenId === X)!;
    expect(x.score).toBe(76);
    expect(x.prevScore).toBe(60);
    expect(x.prevTier).toBe('B');
    expect(x.liqUsd).toBe(120_000);
    expect(x.mcapUsd).toBe(2_000_000);
    expect(x.components.recycling).toBe(90);
    expect(x.top10Pct).toBe(31.5);
    expect(x.largestHolderPct).toBe(6.2);
    expect(x.mintActive).toBe(false);
    expect(x.flags).toEqual([{ code: 'lp-unlocked', severity: 'warn', detail: 'd' }]);
    expect(x.anchorVerdict).toBe('anchored');
    expect(x.anchorSummary).toBe('dated 2013');
    expect(x.pairUrl).toContain('dexscreener.com');
    const y = rows.find((row) => row.tokenId === Y)!;
    expect(y.prevScore).toBeUndefined();
  });

  test('no PREV (first full run) leaves prev fields empty', async () => {
    await seedTwoFullRunsAndLaunchLane();
    const rows = await queryDossiers(db.store.raw, 'run_cur', undefined);
    expect(rows.every((row) => row.prevScore === undefined)).toBe(true);
  });
});

describe('queries C–G', () => {
  test('verdict history, alerts, watchlist, track record, clusters and regime counts', async () => {
    await seedTwoFullRunsAndLaunchLane();
    const { store } = db;

    // One windowed query for the whole run; Y has no provenance and is absent.
    const histories = await queryVerdictHistory(store.raw, 'run_cur');
    expect(histories.get(X)?.map((row) => row.anchorVerdict)).toEqual(['anchored', 'unclear']);
    expect(histories.has(Y)).toBe(false);

    await store.saveAlert({ ...alert('run_cur', X, 'rug-risk'), createdAt: hoursAgo(1) }, []);
    await store.saveAlert({ ...alert('run_prev', X, 'high-score'), id: 'old', createdAt: hoursAgo(30) }, []);
    const alerts = await queryAlerts24h(store.raw);
    expect(alerts.map((a) => a.rule)).toEqual(['rug-risk']);
    expect(alerts[0]?.symbol).toBe('XXX');

    await store.saveWatch(watch('solana:W1', 'expressed', { expressedAt: hoursAgo(3), leadHours: 30 }));
    await store.saveWatch(watch('solana:W2', 'dormant', { firstSeenAt: hoursAgo(200), updatedAt: hoursAgo(1) }));
    await store.saveWatch(watch('solana:W3', 'active', { firstSeenAt: hoursAgo(100), updatedAt: hoursAgo(100) }));
    const changes = await queryWatchChanges(store.raw);
    expect(changes.map((row) => row.tokenId).sort()).toEqual(['solana:W1', 'solana:W2']);
    expect(changes.find((row) => row.tokenId === 'solana:W1')?.leadHours).toBe(30);

    const track = await queryTrackRecord(store.raw);
    expect(track.find((row) => row.status === 'expressed')?.n).toBe(1);

    await seedToken(store, 'run_cur', { tokenId: 'solana:Z1', at: hoursAgo(2), score: { total: 70, tier: 'B' }, report: { narrativeCluster: 'frog' } });
    await seedToken(store, 'run_cur', { tokenId: 'solana:Z2', at: hoursAgo(2), score: { total: 60, tier: 'B' }, report: { narrativeCluster: 'frog' } });
    const clusters = await queryClusters(store.raw);
    expect(clusters.find((c) => c.cluster === 'frog')?.tokens).toBe(2);

    const counts = await queryRegimeCounts(store.raw);
    expect(counts.saTokens7d).toBe(2); // X (A) and Y (S); the B rows do not count
    expect(counts.alerts7d).toBe(2); // the 30 h-old alert is outside D's 24 h but inside 7 d
    expect(counts.anchored30d.expressed).toBe(1);
  });
});

describe('per-token lookups', () => {
  test('queryVerdictHistory keeps the three newest rows per token', async () => {
    await seedTwoFullRunsAndLaunchLane();
    for (const [i, verdict] of (['forced', 'unclear', 'anchored'] as const).entries()) {
      await seedRun(db.store, `run_old_${i}`, hoursAgo(100 - i));
      await seedToken(db.store, `run_old_${i}`, {
        tokenId: X,
        at: hoursAgo(100 - i),
        report: { anchor: { verdict, type: 'none', subject: '', summary: '', confidence: 'low' } },
      });
    }
    const history = (await queryVerdictHistory(db.store.raw, 'run_cur')).get(X) ?? [];
    expect(history).toHaveLength(3);
    expect(history.map((row) => row.runId)).toEqual(['run_cur', 'run_prev', 'run_old_2']);
  });

  test('queryLatestFacts reads the newest score, chain analysis and verdict for a token outside CUR', async () => {
    await seedTwoFullRunsAndLaunchLane();
    const facts = await queryLatestFacts(db.store.raw, X);
    expect(facts).toMatchObject({
      tokenId: X,
      symbol: 'XXX',
      tier: 'A',
      score: 76,
      anchorVerdict: 'anchored',
      top10Pct: 31.5,
      largestHolderPct: 6.2,
      mintActive: false,
    });
    expect(facts.flags[0]?.code).toBe('lp-unlocked');
    const unknown = await queryLatestFacts(db.store.raw, 'solana:nothing');
    expect(unknown).toEqual({ tokenId: 'solana:nothing', flags: [] } as typeof unknown);
  });

  test('querySevereAlerts returns only rug-risk and impostor alerts, any age, for the given tokens', async () => {
    await seedTwoFullRunsAndLaunchLane();
    await db.store.saveAlert({ ...alert('run_prev', X, 'rug-risk'), createdAt: hoursAgo(200) }, []);
    await db.store.saveAlert({ ...alert('run_cur', X, 'high-score'), createdAt: hoursAgo(1) }, []);
    await db.store.saveAlert({ ...alert('run_cur', Y, 'canonical-impostor'), createdAt: hoursAgo(1) }, []);
    const forX = await querySevereAlerts(db.store.raw, [X]);
    expect(forX.map((a) => a.rule)).toEqual(['rug-risk']);
    expect((await querySevereAlerts(db.store.raw, [X, Y])).map((a) => a.rule).sort()).toEqual(['canonical-impostor', 'rug-risk']);
    expect(await querySevereAlerts(db.store.raw, [])).toEqual([]);
  });

  test('queryActiveWatch lists only active entries', async () => {
    await db.store.saveWatch(watch('solana:W1', 'active'));
    await db.store.saveWatch(watch('solana:W2', 'dormant'));
    await db.store.saveWatch(watch('solana:W3', 'expressed'));
    expect(await queryActiveWatch(db.store.raw)).toEqual([{ tokenId: 'solana:W1', anchorVerdict: 'anchored' }]);
  });
});

describe('setups store helpers', () => {
  test('upsert keeps levels and creation time, moves status; listSetups filters open or recent', async () => {
    const setup: Setup = {
      id: 'XXX-20261018-1',
      tokenId: X,
      chain: 'solana',
      address: 'XxxxTokenAddress1111111111111111',
      symbol: 'XXX',
      thesis: 't',
      trigger: 'g',
      conviction: 'medium',
      regime: { meme: 'warm' },
      entryMcapLow: 1_000_000,
      entryMcapHigh: 1_200_000,
      invalidationMcap: 850_000,
      targets: [1_700_000, 2_500_000],
      kill: { liquidityUsdAtCreation: 100_000, liquidityKillRatio: 0.5, maxTop10Pct: 80, maxSingleHolderPct: 25 },
      status: 'watching',
      createdAt: hoursAgo(10),
      updatedAt: hoursAgo(10),
      expiresAt: hoursAgo(-100),
    };
    await db.store.upsertSetups([setup]);
    expect(await db.store.listSetups({ open: true })).toEqual([setup]);

    await db.store.upsertSetups([{ ...setup, status: 'target_hit', rResult: 2.4, statusNote: 'hit', updatedAt: hoursAgo(1), entryMcapLow: 1 }]);
    expect(await db.store.listSetups({ open: true })).toEqual([]);
    const [stored] = await db.store.listSetups({ updatedSince: hoursAgo(2) });
    expect(stored?.status).toBe('target_hit');
    expect(stored?.rResult).toBe(2.4);
    expect(stored?.entryMcapLow).toBe(1_000_000);
    expect(stored?.createdAt).toBe(setup.createdAt);
  });
});

function alert(runId: string, tokenId: string, rule: string) {
  return {
    id: `${runId}:${tokenId}:${rule}`,
    runId,
    tokenId,
    rule,
    severity: 'warn' as const,
    title: 't',
    body: 'b',
    markdown: 'm',
    createdAt: hoursAgo(1),
    payload: {},
  };
}

function watch(tokenId: string, status: 'active' | 'expressed' | 'dormant' | 'dismissed', overrides: Record<string, unknown> = {}) {
  return {
    tokenId,
    chain: 'solana' as const,
    tokenAddress: tokenId.split(':')[1] ?? '',
    symbol: 'W',
    name: 'w',
    status,
    firstSeenAt: hoursAgo(40),
    anchor: {
      verdict: 'anchored' as const,
      type: 'historical-meme' as const,
      subject: 's',
      summary: 'sum',
      confidence: 'high' as const,
      model: 'm',
      checkedAt: hoursAgo(40),
      citations: [],
    },
    gate: { passed: true, reasons: [] },
    updatedAt: hoursAgo(2),
    ...overrides,
  };
}
