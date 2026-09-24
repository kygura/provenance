/**
 * The launch lane: where a meme is judged, at its token's first pool.
 *
 * Provenance exists to answer one question — is this meme anchored in
 * something real (an old meme, a cultural artifact, an inciting event), or is
 * it being forced? — and the answer is only useful early. Waiting for a token
 * to trend before asking is backwards: by then the question has been answered
 * by the market. So every launch that clears the hard gate gets the fast
 * anchor check, an anchored launch gets the full provenance research straight
 * away, and trending lists become the outcome recorded against a verdict that
 * came first.
 *
 * Three steps, called from `runPipeline`:
 *   reconcile  a judged token seen trending this run → `expressed`
 *   judge      launch-only tokens → market gate → chain → chain gate →
 *              anchor check → (anchored) full research → watchlist
 *   sweep      `active` entries past `dormantAfterHours` → `dormant`
 *
 * Every verdict is stored, `dismissed` ones included: a token is judged once,
 * not re-paid-for every 30 minutes, and a forced meme that trends anyway is on
 * record as exactly that.
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
  type AnchorCheck,
  type AnchorChecker,
  type ProvenanceReport,
  type ProvenanceResearcher,
  type ProvenanceStore,
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
  return { discovered: 0, rejected: 0, dismissed: 0, catalogued: 0, researched: 0, expressed: 0, dormant: 0 };
}

/** Marker recorded in `stats.sourceErrors` when the LLM budget cut a run short. */
export const BUDGET_SOURCE = 'llm-budget';

/**
 * Records spend against the shared ceiling. Crossing it is recorded once, as a
 * source error, whichever lane crosses it — a run that stopped researching
 * part-way is `partial`, and says why.
 */
export function spend(
  budget: LlmBudget,
  usd: number,
  sourceErrors: { source: string; error: string }[],
  log: Logger,
): void {
  budget.spent += usd;
  if (budget.spent < budget.limit || budget.exhausted) return;
  budget.exhausted = true;
  const detail = `LLM cost ceiling reached: $${budget.spent.toFixed(4)} of $${budget.limit}; remaining tokens get no LLM work`;
  sourceErrors.push({ source: BUDGET_SOURCE, error: detail });
  log.warn(detail, { spentUsd: budget.spent, ceilingUsd: budget.limit });
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
 * Marks judged tokens that appear in this run's trending set. Runs over every
 * trending snapshot, before the trending filter: reaching a list is the
 * outcome, whether or not the token then clears the research thresholds.
 *
 * Dormant and dismissed entries can still express. A late expression is a real
 * outcome, and a forced meme that trends anyway is the case the verdict most
 * needs to be checked against. The verdict itself is kept on the entry.
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
 * Judges launch-only tokens. Gate rejections are logged with the rule that
 * fired and counted, but not stored: a launch that fails early (too few
 * holders yet) is retried on the next run while it is inside the lookback
 * window. Anything that reaches the anchor check is stored whatever the
 * verdict, so it is judged once.
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
  // the ones worth the RPC and the anchor check.
  const selected = candidates
    .sort((a, b) => (b.metrics.liquidityUsd ?? 0) - (a.metrics.liquidityUsd ?? 0))
    .slice(0, Math.max(0, app.launches.maxCatalogPerRun));
  if (selected.length === 0) return [];

  let checker: AnchorChecker | undefined;
  let researcher: ProvenanceResearcher | undefined;
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

      // Not judged, so not stored: the next run retries it with budget.
      if (ctx.skipLlm || ctx.budget.exhausted) {
        tokenLog.info('anchor check skipped', { reason: ctx.skipLlm ? 'llm disabled' : 'llm budget exhausted' });
        return null;
      }

      // ---- fast verdict --------------------------------------------------------
      checker ??= deps.createAnchorChecker(app, log);
      const fast = await checker.check(snapshot, ctx.researchCtx);
      spend(ctx.budget, fast.usage?.costUsd ?? 0, ctx.sourceErrors, log);
      tokenLog.info('[VERDICT] launch', {
        tokenId: snapshot.tokenId,
        verdict: fast.verdict,
        type: fast.type,
        subject: fast.subject,
        precedesLaunch: fast.precedesLaunch,
        confidence: fast.confidence,
      });
      const anchored = fast.verdict === 'anchored' && fast.confidence !== 'low';

      // ---- full research, now, for an anchored meme ------------------------------
      let report: ProvenanceReport | undefined;
      if (anchored && app.launches.researchAnchored && !ctx.budget.exhausted) {
        try {
          researcher ??= deps.createResearcher(app, log);
          const evidence = await deps.collectEvidence(snapshot, ctx.researchCtx);
          report = await researcher.research(snapshot, chain, evidence, ctx.researchCtx);
          spend(ctx.budget, report.usage?.costUsd ?? 0, ctx.sourceErrors, log);
          stats.researched += 1;
        } catch (error) {
          tokenLog.warn('full research failed; keeping the fast verdict', { error: errorMessage(error) });
        }
      }

      // The deeper answer wins whenever it is confident: a disagreement
      // overturns the fast check, an agreement replaces it with the better-
      // sourced version. A degraded or low-confidence report changes nothing.
      const deep = report?.anchor;
      const confidentDeep = deep !== undefined && deep.confidence !== 'low';
      const overturned = confidentDeep && deep.verdict !== 'anchored';
      const verdict: AnchorCheck = confidentDeep ? { ...fast, ...deep } : fast;
      const kept = anchored && !overturned;

      const at = nowIso();
      const entry: WatchEntry = {
        tokenId: snapshot.tokenId,
        chain: snapshot.chain,
        tokenAddress: snapshot.tokenAddress,
        symbol: snapshot.symbol,
        name: snapshot.name,
        status: kept ? 'active' : 'dismissed',
        firstSeenAt: at,
        anchor: verdict,
        gate,
        updatedAt: at,
      };
      if (report) entry.researched = true;
      if (snapshot.metrics.poolCreatedAt) entry.launchedAt = snapshot.metrics.poolCreatedAt;
      if (snapshot.metrics.liquidityUsd !== undefined) entry.liquidityUsdAtCatalog = snapshot.metrics.liquidityUsd;

      if (!kept) {
        await store.saveWatch(entry);
        stats.dismissed += 1;
        if (overturned) tokenLog.info('full research overturned the fast verdict', { verdict: deep?.verdict });
        return null;
      }

      // Snapshot, chain, report and score go into the run as well, so an
      // anchored launch has a full dossier the dashboard can open.
      await store.saveSnapshot(ctx.runId, snapshot);
      if (chain) await store.saveChainAnalysis(ctx.runId, chain);
      if (report) await store.saveProvenance(ctx.runId, report);
      await store.saveScore(ctx.runId, deps.scoreToken({ snapshot, chain, provenance: report }));
      await store.saveWatch(entry);
      stats.catalogued += 1;
      return deps.launchAnchoredAlert(ctx.runId, entry, snapshot, chain, report);
    } catch (error) {
      const message = errorMessage(error);
      tokenLog.error('launch failed', { error: message });
      ctx.sourceErrors.push({ source: `launch:${snapshot.tokenId}`, error: message });
      return null;
    }
  });

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
