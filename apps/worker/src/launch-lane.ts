/**
 * The launch lane, and where it meets the trending lane.
 *
 * Provenance started from demand: what is trending, and where did its meme
 * come from. Dexscanner started from supply: what just launched, and does its
 * name point at anything real. Both were looking at the same tokens from
 * opposite ends of their lives, so the merged pipeline runs both and records
 * the moment they agree — a token catalogued at launch that later shows up on
 * a trending list. That transition, and the hours it took, is measured rather
 * than inferred, which makes the watchlist a labelled dataset over time.
 *
 * Three steps, called from `runPipeline`:
 *   reconcile  a watchlisted token seen trending this run → `expressed`
 *   catalogue  launch-only tokens → market gate → chain → chain gate →
 *              referent check → watchlist
 *   sweep      `active` entries past `dormantAfterHours` → `dormant`
 *
 * Every per-token step is isolated the same way the trending lane's is: one
 * launch failing is a recorded error, never a failed run.
 */
import {
  type Alert,
  type AnalyzerContext,
  type AppConfig,
  type ChainAnalysis,
  type LaunchStats,
  type Logger,
  type ProvenanceStore,
  type ReferentChecker,
  type ResearchContext,
  type TokenSnapshot,
  type WatchEntry,
  TRENDING_SOURCES,
  hoursBetween,
  mapLimit,
  nowIso,
} from '@provenance/core';
import type { PipelineDeps } from './deps';

/** Shared with the trending lane so both draw on one per-run ceiling. */
export interface LlmBudget {
  spent: number;
  readonly limit: number;
  exhausted: boolean;
}

export function emptyLaunchStats(): LaunchStats {
  return { discovered: 0, rejected: 0, unvalidated: 0, catalogued: 0, expressed: 0, dormant: 0 };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trendingSourcesOf(snapshot: TokenSnapshot): string[] {
  const seen = new Set<string>();
  for (const appearance of snapshot.appearances) {
    if ((TRENDING_SOURCES as readonly string[]).includes(appearance.source)) seen.add(appearance.source);
  }
  return [...seen].sort();
}

/**
 * Marks watchlisted tokens that appear in this run's trending set. Runs over
 * every trending snapshot, before the trending filter: a catalogued token that
 * reached a list has expressed whether or not it then clears the liquidity and
 * volume thresholds for full research.
 *
 * Dormant entries can still express. A late expression is a real outcome, and
 * dropping it would bias the lead-time record towards fast movers.
 */
export async function reconcileWatchlist(
  runId: string,
  trending: TokenSnapshot[],
  store: ProvenanceStore,
  deps: PipelineDeps,
  stats: LaunchStats,
  log: Logger,
): Promise<Alert[]> {
  if (trending.length === 0) return [];
  const watching = new Map<string, WatchEntry>();
  for (const entry of await store.listWatch({ limit: 5_000 })) {
    if (entry.status !== 'expressed') watching.set(entry.tokenId, entry);
  }
  if (watching.size === 0) return [];

  const alerts: Alert[] = [];
  const at = nowIso();
  for (const snapshot of trending) {
    const entry = watching.get(snapshot.tokenId);
    if (!entry) continue;
    const updated: WatchEntry = {
      ...entry,
      status: 'expressed',
      expressedAt: at,
      leadHours: Number(hoursBetween(entry.firstSeenAt, at).toFixed(2)),
      expressedOn: trendingSourcesOf(snapshot),
      updatedAt: at,
    };
    try {
      await store.saveWatch(updated);
      stats.expressed += 1;
      alerts.push(deps.launchExpressedAlert(runId, updated, snapshot));
      log.info('watchlisted token expressed', {
        tokenId: snapshot.tokenId,
        leadHours: updated.leadHours,
        on: updated.expressedOn,
      });
    } catch (error) {
      log.error('failed to record expression', { tokenId: snapshot.tokenId, error: errorMessage(error) });
    }
  }
  return alerts;
}

export interface LaunchLaneContext {
  runId: string;
  app: AppConfig;
  store: ProvenanceStore;
  deps: PipelineDeps;
  log: Logger;
  budget: LlmBudget;
  stats: LaunchStats;
  sourceErrors: { source: string; error: string }[];
  skipLlm: boolean;
  concurrency: number;
  analyzerCtx: AnalyzerContext;
  researchCtx: ResearchContext;
}

/**
 * Catalogues launch-only tokens that clear every hard filter and the referent
 * check. Rejections are logged with the rule that fired — dexscanner's
 * `[REJECT]` lines — and counted, but not persisted: a rejected launch that
 * later trends is picked up by the trending lane on its own merits.
 */
export async function runLaunchLane(launches: TokenSnapshot[], ctx: LaunchLaneContext): Promise<Alert[]> {
  const { app, store, deps, log, stats } = ctx;
  stats.discovered = launches.length;
  if (launches.length === 0) return [];

  const known = new Set((await store.listWatch({ limit: 5_000 })).map((entry) => entry.tokenId));
  const candidates: TokenSnapshot[] = [];
  for (const snapshot of launches) {
    if (known.has(snapshot.tokenId)) continue;
    const gate = deps.gateLaunchMarket(snapshot, app.launches);
    if (gate.passed) candidates.push(snapshot);
    else {
      stats.rejected += 1;
      log.debug('[REJECT] launch', { tokenId: snapshot.tokenId, reasons: gate.reasons });
    }
  }

  // Deepest pools first: with a per-run cap, the most tradeable launches are
  // the ones worth the RPC and the referent check.
  const selected = candidates
    .sort((a, b) => (b.metrics.liquidityUsd ?? 0) - (a.metrics.liquidityUsd ?? 0))
    .slice(0, Math.max(0, app.launches.maxCatalogPerRun));
  if (selected.length === 0) return [];

  let checker: ReferentChecker | undefined;
  const alerts = await mapLimit(selected, ctx.concurrency, async (snapshot): Promise<Alert | null> => {
    const tokenLog = log.child(`launch:${snapshot.symbol || snapshot.tokenId}`);
    try {
      let chain: ChainAnalysis | undefined;
      try {
        chain = await deps.analyzeToken(snapshot, ctx.analyzerCtx);
      } catch (error) {
        tokenLog.warn('chain analysis failed', { error: errorMessage(error) });
      }

      const gate = deps.gateLaunchChain(chain, app.launches);
      if (!gate.passed) {
        stats.rejected += 1;
        tokenLog.info('[REJECT] launch', { tokenId: snapshot.tokenId, reasons: gate.reasons });
        return null;
      }

      if (ctx.skipLlm || ctx.budget.exhausted) {
        stats.unvalidated += 1;
        tokenLog.info('referent check skipped', { reason: ctx.skipLlm ? 'llm disabled' : 'llm budget exhausted' });
        return null;
      }
      checker ??= deps.createReferentChecker(app, log);
      const referent = await checker.check(snapshot, ctx.researchCtx);
      ctx.budget.spent += referent.usage?.costUsd ?? 0;
      if (ctx.budget.spent >= ctx.budget.limit) ctx.budget.exhausted = true;
      tokenLog.info('[VALIDATE] launch', {
        tokenId: snapshot.tokenId,
        validated: referent.validated,
        confidence: referent.confidence,
        referent: referent.referent,
      });
      if (!referent.validated || referent.confidence === 'low') {
        stats.unvalidated += 1;
        return null;
      }

      const at = nowIso();
      const entry: WatchEntry = {
        tokenId: snapshot.tokenId,
        chain: snapshot.chain,
        tokenAddress: snapshot.tokenAddress,
        symbol: snapshot.symbol,
        name: snapshot.name,
        status: 'active',
        firstSeenAt: at,
        referent,
        gate,
        updatedAt: at,
      };
      if (snapshot.metrics.poolCreatedAt) entry.launchedAt = snapshot.metrics.poolCreatedAt;
      if (snapshot.metrics.liquidityUsd !== undefined) entry.liquidityUsdAtCatalog = snapshot.metrics.liquidityUsd;

      // Snapshot, chain and a market-only score go into the run as well, so a
      // catalogued launch has a dossier the dashboard can open.
      await store.saveSnapshot(ctx.runId, snapshot);
      if (chain) await store.saveChainAnalysis(ctx.runId, chain);
      await store.saveScore(ctx.runId, deps.scoreToken({ snapshot, chain }));
      await store.saveWatch(entry);
      stats.catalogued += 1;
      return deps.launchCataloguedAlert(ctx.runId, entry, snapshot, chain);
    } catch (error) {
      const message = errorMessage(error);
      tokenLog.error('launch failed', { error: message });
      ctx.sourceErrors.push({ source: `launch:${snapshot.tokenId}`, error: message });
      return null;
    }
  });

  if (ctx.budget.exhausted) log.warn('llm budget exhausted during launch lane', { spentUsd: ctx.budget.spent });
  return alerts.filter((alert): alert is Alert => alert !== null);
}

/** Ages out active entries that never reached a list. */
export async function sweepDormant(
  app: AppConfig,
  store: ProvenanceStore,
  stats: LaunchStats,
  log: Logger,
): Promise<void> {
  const at = nowIso();
  for (const entry of await store.listWatch({ status: 'active', limit: 5_000 })) {
    if (hoursBetween(entry.firstSeenAt, at) < app.launches.dormantAfterHours) continue;
    try {
      await store.saveWatch({ ...entry, status: 'dormant', updatedAt: at });
      stats.dormant += 1;
    } catch (error) {
      log.warn('failed to mark dormant', { tokenId: entry.tokenId, error: errorMessage(error) });
    }
  }
}
