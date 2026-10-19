/**
 * The seven-stage run described in SPEC.md, plus the launch lane merged in
 * from dexscanner (see launch-lane.ts), and the only place the stages are
 * wired together. Everything it touches arrives through `PipelineDeps`, so the
 * orchestration can be exercised without a database, a browser or an API key.
 *
 * Two invariants drive most of the shape of this file:
 *   - one token's failure must never take the run with it, so every per-token
 *     step is caught and recorded;
 *   - a crash mid-run must leave the database readable, so rows are written as
 *     they are produced and `finishRun` happens in a `finally`.
 */
import {
  type Alert,
  type AlertChannelSink,
  type AlertRuleInput,
  type AnalyzerContext,
  type AppConfig,
  type ChainAnalysis,
  type DeliveryResult,
  type Logger,
  type ProvenanceReport,
  type ProvenanceResearcher,
  type ProvenanceScore,
  type ProvenanceStore,
  type ResearchContext,
  type RunRecord,
  type RunStats,
  type RunStatus,
  type TokenSnapshot,
  hoursBetween,
  mapLimit,
  runId as newRunId,
  nowIso,
} from '@provenance/core';
import { type PipelineDeps, loadRuntimeDeps } from './deps';
import {
  BUDGET_SOURCE,
  type LlmBudget,
  emptyLaunchStats,
  llmFailed,
  reconcileWatchlist,
  runLaunchLane,
  spend,
  sweepDormant,
} from './launch-lane';
import { collectSocial, emptySocialStats, isSocialSource, reconcileSocial } from './social';

export interface RunOptions {
  /** `--no-llm`: run discovery, chain analysis and scoring, skip the model. */
  skipLlm?: boolean;
  /**
   * Public RPCs and scraped sites punish parallelism, and the LLM step is the
   * expensive one anyway. Three is the ceiling; two is the polite default.
   */
  concurrency?: number;
  /** Injected in tests so run ids are predictable. */
  runId?: string;
  /** Recorded in the run's stats so the cadence gate can tell the lanes apart. */
  lane?: 'full' | 'launches';
}

/** Re-exported: callers and tests already import it from here. */
export { BUDGET_SOURCE };

type TokenStatus = 'analysed' | 'reused' | 'failed';

interface TokenOutcome {
  tokenId: string;
  status: TokenStatus;
  error?: string;
  alerts: Alert[];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Remote channels stay silent in a dry run; local ones still show their work. */
function selectSinks(sinks: AlertChannelSink[], dryRun: boolean): AlertChannelSink[] {
  return sinks.filter(
    (sink) => sink.enabled && (!dryRun || sink.channel === 'console' || sink.channel === 'file'),
  );
}

export async function runPipeline(
  app: AppConfig,
  logger: Logger,
  deps?: PipelineDeps,
  options: RunOptions = {},
): Promise<RunRecord> {
  const resolved = deps ?? (await loadRuntimeDeps());
  const log = logger.child('pipeline');
  const startedMs = Date.now();
  const id = options.runId ?? newRunId();
  const concurrency = Math.max(1, Math.min(3, options.concurrency ?? 2));

  const stats: RunStats = {
    discovered: 0,
    afterFilter: 0,
    analysed: 0,
    reused: 0,
    alertsFired: 0,
    llmCostUsd: 0,
    sourceErrors: [],
    lane: options.lane ?? 'full',
    launches: emptyLaunchStats(),
    social: emptySocialStats(),
  };
  const launchStats = stats.launches ?? emptyLaunchStats();

  const store: ProvenanceStore = resolved.createStore(app);
  let startedAt = nowIso();
  try {
    // Idempotent, and it means a fresh checkout can `run` without `migrate` first.
    await store.migrate();
    startedAt = (await store.startRun(id)).startedAt;
  } catch (error) {
    await store.close().catch(() => undefined);
    throw error;
  }

  let fatal: string | undefined;
  let status: RunStatus = 'failed';
  let selected: TokenSnapshot[] = [];
  let outcomes: TokenOutcome[] = [];

  try {
    // ---- Stage 2: discover, merge, filter, triage, cap -----------------------
    const discovery = await resolved.discoverTrending(app, log);
    stats.sourceErrors.push(...discovery.errors);
    for (const failure of discovery.errors) {
      log.warn('source failed', { source: failure.source, error: failure.error });
    }

    const merged = resolved.mergeToSnapshots(discovery.entries);
    // Two lanes from one discovery: demand (trending lists) and supply (new
    // pools). `discovered` keeps meaning "trending tokens" across versions.
    const { trending: snapshots, launches } = resolved.splitLanes(merged);
    stats.discovered = snapshots.length;

    // Before the trending filter, on purpose: reaching a list is the event,
    // whether or not the token then clears the research thresholds.
    const laneAlerts: Alert[] = [];
    try {
      laneAlerts.push(...(await reconcileWatchlist(id, snapshots, store, resolved, launchStats, log.child('watchlist'))));
    } catch (error) {
      stats.sourceErrors.push({ source: 'watchlist', error: errorMessage(error) });
      log.error('watchlist reconciliation failed', { error: errorMessage(error) });
    }

    // Before the launch lane, so a launch judged this run is compared against
    // sightings that already existed: the crowd may have been there first.
    try {
      await collectSocial(app, store, resolved, stats, log.child('social'));
    } catch (error) {
      stats.sourceErrors.push({ source: 'social', error: errorMessage(error) });
      log.error('social collection failed', { error: errorMessage(error) });
    }

    // The per-run ceiling, shrunk to what the last 24 h leave under the daily one.
    const perDay = app.llm.maxCostUsdPerDay;
    const spent24h = perDay > 0 && !options.skipLlm ? await spendLast24h(store, id, log) : undefined;
    const limit =
      spent24h === undefined ? app.llm.maxCostUsdPerRun : Math.min(app.llm.maxCostUsdPerRun, Math.max(0, perDay - spent24h));
    const budget: LlmBudget = { spent: 0, limit, exhausted: limit <= 0 };
    if (budget.exhausted && !options.skipLlm) {
      if (spent24h !== undefined && app.llm.maxCostUsdPerRun > 0) {
        const detail = `daily LLM ceiling reached: $${spent24h.toFixed(4)} of $${perDay} in the last 24 h; no LLM work this run`;
        stats.sourceErrors.push({ source: BUDGET_SOURCE, error: detail });
        log.warn(detail, { spent24hUsd: spent24h, ceilingUsd: perDay });
      } else {
        log.warn('LLM budget is zero; running market-only', {
          maxCostUsdPerRun: app.llm.maxCostUsdPerRun,
        });
      }
    }

    const analyzerCtx: AnalyzerContext = { app, logger: log.child('chain') };
    const researchCtx: ResearchContext = {
      app,
      logger: log.child('research'),
      cacheGet: (key) => store.getCachedEvidence(key, app.pipeline.reanalyseAfterHours),
      cachePut: (key, url, content) => store.putCachedEvidence(key, url, content),
    };

    // ---- Launch lane: first, so the verdict at launch gets the budget first ---
    // The point of the project is judging a meme before its token trends, not
    // after; trending research only gets what the launch lane leaves.
    if (launches.length > 0) {
      try {
        laneAlerts.push(
          ...(await runLaunchLane(launches, {
            runId: id,
            app,
            store,
            deps: resolved,
            log: log.child('launches'),
            budget,
            stats: launchStats,
            sourceErrors: stats.sourceErrors,
            skipLlm: options.skipLlm === true,
            concurrency,
            analyzerCtx,
            researchCtx,
          })),
        );
      } catch (error) {
        stats.sourceErrors.push({ source: 'launches', error: errorMessage(error) });
        log.error('launch lane failed', { error: errorMessage(error) });
      }
      stats.llmCostUsd = Number(budget.spent.toFixed(6));
    }

    const filtered = resolved.filterSnapshots(snapshots, app.pipeline);
    stats.afterFilter = filtered.kept.length;
    for (const drop of filtered.dropped) {
      log.debug('dropped by filter', { tokenId: drop.tokenId, reason: drop.reason });
    }

    const triaged = resolved.triageOrder(filtered.kept);
    selected = triaged.slice(0, Math.max(0, app.pipeline.maxTokensPerRun));
    log.info('discovery complete', {
      entries: discovery.entries.length,
      merged: snapshots.length,
      kept: filtered.kept.length,
      selected: selected.length,
    });

    // Persisted up front: a crash during analysis still leaves a readable run.
    for (const snapshot of selected) {
      await store.saveSnapshot(id, snapshot);
    }

    // ---- Stage 3-5: per-token treatment, bounded and budgeted ----------------
    let researcher: ProvenanceResearcher | undefined;
    let researcherFailed = false;
    outcomes = await mapLimit(selected, concurrency, async (snapshot): Promise<TokenOutcome> => {
      const tokenLog = log.child(snapshot.symbol || snapshot.tokenId);
      try {
        let chain: ChainAnalysis | undefined;
        try {
          // Contractually never throws, but a broken analyser must not be fatal.
          chain = await resolved.analyzeToken(snapshot, analyzerCtx);
          await store.saveChainAnalysis(id, chain);
        } catch (error) {
          tokenLog.warn('chain analysis failed', { error: errorMessage(error) });
        }

        // ---- Stage 4: reuse a recent report instead of paying for it again ---
        let provenance: ProvenanceReport | undefined;
        let reused = false;
        const prior = await store.latestProvenance(snapshot.tokenId).catch(() => null);
        if (prior && hoursBetween(prior.generatedAt) < app.pipeline.reanalyseAfterHours) {
          provenance = prior;
          reused = true;
          tokenLog.info('reusing provenance report', {
            ageHours: Number(hoursBetween(prior.generatedAt).toFixed(1)),
          });
        } else if (options.skipLlm) {
          tokenLog.debug('llm disabled; market-only score');
        } else if (budget.exhausted) {
          tokenLog.warn('llm budget exhausted; market-only score');
        } else if (researcherFailed) {
          tokenLog.debug('researcher unavailable; market-only score');
        } else {
          const evidence = await resolved.collectEvidence(snapshot, researchCtx);
          if (!researcher) {
            try {
              researcher = resolved.createResearcher(app, log);
            } catch (error) {
              researcherFailed = true;
              stats.sourceErrors.push({ source: 'research', error: errorMessage(error) });
              tokenLog.error('researcher unavailable', { error: errorMessage(error) });
            }
          }
          if (researcher) {
            const report = await researcher.research(snapshot, chain, evidence, researchCtx);

            // ---- Stage 5: cost ceiling ---------------------------------------
            spend(budget, report.usage?.costUsd ?? 0, stats.sourceErrors, log);
            stats.llmCostUsd = Number(budget.spent.toFixed(6));

            // A failed call is not a report. Saving it would be reused as one
            // until the re-analysis TTL, so the token scores market-only and
            // the next run tries again.
            const failed = report.anchor?.failed;
            if (failed !== undefined) {
              tokenLog.warn('research failed; not saved', { error: failed });
              llmFailed(budget, `research:${snapshot.tokenId}`, failed, stats.sourceErrors, log);
            } else {
              await store.saveProvenance(id, report);
              provenance = report;
            }
          }
        }

        const score = resolved.scoreToken({ snapshot, chain, provenance });
        // Fetched before the new score lands so `history` is strictly prior runs.
        const history = await store.scoreHistory(snapshot.tokenId).catch(() => [] as ProvenanceScore[]);
        await store.saveScore(id, score);

        // ---- Stage 6a: rules are evaluated here, delivery is batched later ---
        const ruleInput: AlertRuleInput = {
          snapshot,
          chain,
          provenance,
          score,
          config: app,
          history,
        };
        const alerts = resolved.createAlerts(id, ruleInput, resolved.defaultRules);

        return { tokenId: snapshot.tokenId, status: reused ? 'reused' : 'analysed', alerts };
      } catch (error) {
        const message = errorMessage(error);
        tokenLog.error('token failed', { error: message });
        return { tokenId: snapshot.tokenId, status: 'failed', error: message, alerts: [] };
      }
    });

    for (const outcome of outcomes) {
      if (outcome.status === 'analysed') stats.analysed += 1;
      else if (outcome.status === 'reused') stats.reused += 1;
      else stats.sourceErrors.push({ source: `token:${outcome.tokenId}`, error: outcome.error ?? 'unknown' });
    }

    try {
      await sweepDormant(app, store, launchStats, log.child('watchlist'));
    } catch (error) {
      log.warn('dormancy sweep failed', { error: errorMessage(error) });
    }

    try {
      await reconcileSocial(store, stats, log.child('social'));
    } catch (error) {
      stats.sourceErrors.push({ source: 'social', error: errorMessage(error) });
      log.error('social reconciliation failed', { error: errorMessage(error) });
    }

    // ---- Stage 6b: dispatch and persist -------------------------------------
    const alerts = [...outcomes.flatMap((outcome) => outcome.alerts), ...laneAlerts];
    stats.alertsFired = alerts.length;
    if (alerts.length > 0) {
      const sinks = selectSinks(resolved.createSinks(app, log), app.pipeline.dryRun);
      if (app.pipeline.dryRun) {
        log.info('dry run: remote alert channels suppressed', { alerts: alerts.length });
      }
      let deliveries = new Map<string, DeliveryResult[]>();
      try {
        deliveries = await resolved.dispatchAlerts(alerts, sinks, log);
      } catch (error) {
        stats.sourceErrors.push({ source: 'alerts', error: errorMessage(error) });
        log.error('alert dispatch failed', { error: errorMessage(error) });
      }
      for (const alert of alerts) {
        try {
          await store.saveAlert(alert, deliveries.get(alert.id) ?? []);
        } catch (error) {
          log.error('failed to persist alert', { alert: alert.id, error: errorMessage(error) });
        }
      }
    }

    status = resolveStatus(selected.length, stats);
  } catch (error) {
    fatal = errorMessage(error);
    status = 'failed';
    log.error('run failed', { error: fatal });
  } finally {
    stats.durationMs = Date.now() - startedMs;
    try {
      await store.finishRun(id, status, stats, fatal);
    } catch (error) {
      log.error('failed to finish run', { error: errorMessage(error) });
    }
    await store.close().catch(() => undefined);
  }

  log.info('run complete', { id, status, ...stats, sourceErrors: stats.sourceErrors.length });

  const record: RunRecord = {
    id,
    startedAt,
    finishedAt: nowIso(),
    status,
    stats,
  };
  if (fatal) record.error = fatal;
  return record;
}

/**
 * LLM spend recorded by every other run in the trailing 24 hours. A run still
 * in flight counts with what it has recorded, which is nothing until it
 * finishes; the per-run ceiling bounds that gap. A store that cannot answer
 * returns undefined and the run keeps its per-run ceiling.
 */
async function spendLast24h(store: ProvenanceStore, currentRunId: string, log: Logger): Promise<number | undefined> {
  try {
    return dailySpend(await store.listRuns(DAILY_SPEND_RUN_LIMIT), currentRunId, Date.now());
  } catch (error) {
    log.warn('could not read the last 24 h of spend; per-run ceiling only', { error: errorMessage(error) });
    return undefined;
  }
}

/** Enough rows for 24 h at the fastest cadence: 48 launch-lane runs plus 24 full ones, with room. */
const DAILY_SPEND_RUN_LIMIT = 200;

export function dailySpend(runs: RunRecord[], excludeId: string, nowMs: number): number {
  const since = nowMs - 24 * 3_600_000;
  let total = 0;
  for (const run of runs) {
    if (run.id === excludeId || Date.parse(run.startedAt) < since) continue;
    total += run.stats.llmCostUsd ?? 0;
  }
  return total;
}

/**
 * `failed` means the run produced nothing usable; `partial` means it produced
 * something but a source, a token, the researcher or the cost ceiling degraded
 * it. A quiet market — no token clearing the filters, nothing broken — is `ok`.
 */
export function resolveStatus(selectedCount: number, stats: RunStats): RunStatus {
  // A catalogued launch is usable output too: a run whose trending sources all
  // failed but whose launch lane worked is degraded, not dead.
  const usable = stats.analysed + stats.reused + (stats.launches?.catalogued ?? 0);
  // A failed social feed degrades a run but cannot fail a quiet one.
  const fatal = stats.sourceErrors.filter((failure) => !isSocialSource(failure.source));
  if (selectedCount > 0 && usable === 0) return 'failed';
  if (selectedCount === 0 && usable === 0 && fatal.length > 0) return 'failed';
  if (stats.sourceErrors.length > 0) return 'partial';
  return 'ok';
}
