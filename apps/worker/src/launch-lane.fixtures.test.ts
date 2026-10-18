import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, silentLogger, type AppConfig } from '@provenance/core';
import { loadRuntimeDeps } from './deps';
import { runPipeline } from './pipeline';

/**
 * The launch lane through the real packages, offline: fixture factory logs,
 * DexScreener hydration and RPC for SHREK, the stub anchor checker and researcher, and a
 * throwaway libSQL file. Only the launches source runs, so this stays fast.
 */
describe('launch lane against fixtures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'provenance-launch-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('catalogues the healthy launch and rejects the thin and unindexed ones', async () => {
    // The fixture pools are up to 21h old; the 30-minute cadence's 6h default window would skip them.
    const base = loadConfig({
      DATABASE_URL: `file:${join(dir, 'lane.db')}`,
      USE_FIXTURES: '1',
      DRY_RUN: '1',
      LAUNCHES_LOOKBACK_HOURS: '48',
    });
    const app: AppConfig = {
      ...base,
      pipeline: {
        ...base.pipeline,
        sources: base.pipeline.sources.map((source) => ({ ...source, enabled: source.id === 'launches' })),
      },
    };
    const deps = await loadRuntimeDeps();
    const record = await runPipeline(app, silentLogger, deps, { concurrency: 1 });

    expect(record.stats.launches).toMatchObject({ discovered: 3, rejected: 2, catalogued: 1, researched: 1 });

    const store = deps.createStore(app);
    try {
      const watch = await store.listWatch();
      expect(watch.map((entry) => entry.symbol)).toEqual(['SHREK']);
      expect(watch[0]?.gate.passed).toBe(true);
      expect(watch[0]?.anchor.verdict).toBe('anchored');
      expect(watch[0]?.anchor.model.startsWith('stub:')).toBe(true);
      expect(watch[0]?.researched).toBe(true);
      const dossier = await store.getDossier(watch[0]?.tokenId ?? '', record.id);
      expect(dossier?.chain?.privilegedFunctions).toEqual([]);
      expect(dossier?.chain?.lpBurnedPct).toBeCloseTo(55, 1);
      expect(dossier?.chain?.lpLockedPct).toBeCloseTo(45, 1);
      // An organic start: one small buy in the first three blocks of trading.
      expect(dossier?.chain?.sniping).toMatchObject({ windowBlocks: 3, earlyBuyers: 1, sameBlockBuyers: 1 });
      expect(dossier?.chain?.sniping?.earlyBuyPct).toBeLessThan(1);
      expect(dossier?.provenance?.anchor).toBeDefined();
      expect(dossier?.alerts.map((alert) => alert.rule)).toContain('launch-anchored');
    } finally {
      await store.close();
    }
    // Real packages, a libSQL file and per-host rate limiters: ~2.4s locally,
    // and a slow CI runner pushed it past bun's 5s default.
  }, 20_000);
});
