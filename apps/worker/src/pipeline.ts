/**
 * The seven-stage run described in SPEC.md, and the only place the stages are
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
}

/** Marker recorded in `stats.sourceErrors` when the LLM budget cut a run short. */
export const BUDGET_SOURCE = 'llm-budget';

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
  };

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

    const snapshots = resolved.mergeToSnapshots(discovery.entries);
    stats.discovered = snapshots.length;

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
    let budgetSpent = 0;
    let budgetExhausted = app.llm.maxCostUsdPerRun <= 0;
    if (budgetExhausted && !options.skipLlm) {
      log.warn('LLM budget is zero; running market-only', {
        maxCostUsdPerRun: app.llm.maxCostUsdPerRun,
      });
    }

    const analyzerCtx: AnalyzerContext = { app, logger: log.child('chain') };
    const baseResearchCtx: ResearchContext = {
      app,
      logger: log.child('research'),
      cacheGet: (key) => store.getCachedEvidence(key, app.pipeline.reanalyseAfterHours),
      cachePut: (key, url, content) => store.putCachedEvidence(key, url, content),
    };

    /**
     * Prior tokens this system watched run the same meme.
     *
     * Looked up from a provisional slug derived from the ticker and name alone,
     * because the authoritative meme name is an output of the research we are
     * about to do. A provisional miss costs nothing — the model simply works
     * without precedent, exactly as it did before this existed — while a hit
     * hands it evidence no web search can produce.
     */
    const lookUpPrecedent = async (snapshot: TokenSnapshot, tokenLog: Logger) => {
      const subject = resolved.provisionalMemeSubject(snapshot);
      if (subject === '') return [];
      const identity = resolved.resolveMemeIdentity(subject);
      if (!identity) return [];
      try {
        const sightings = await store.memeHistory(identity.id, { excludeTokenId: snapshot.tokenId });
        if (sightings.length > 0) {
          tokenLog.info('observed precedent found', { memeId: identity.id, priorTokens: sightings.length });
        }
        return sightings;
      } catch (error) {
        tokenLog.warn('precedent lookup failed', { error: errorMessage(error) });
        return [];
      }
    };

    /**
     * Link a finished report to its canonical meme. Runs after research because
     * `memeName` is what the model concluded, not what the ticker suggested —
     * a token called $NYAN2 resolves to "nyan-cat", which is the entire point.
     */
    const linkMeme = async (report: ProvenanceReport, tokenLog: Logger): Promise<ProvenanceReport> => {
      const identity = resolved.resolveMemeIdentity(report.memeName);
      if (!identity) {
        // Unidentifiable stays unlinked. A shared "unknown" row would let every
        // unresolved token become precedent for every other one.
        tokenLog.debug('meme not resolvable; report left unlinked', { memeName: report.memeName });
        return report;
      }
      try {
        const meme = await store.resolveMeme({
          id: identity.id,
          displayName: identity.displayName,
          narrativeCluster: report.narrativeCluster,
        });
        return { ...report, memeId: meme.id };
      } catch (error) {
        // A failed link must not lose the report; it just cannot be precedent.
        tokenLog.warn('meme link failed', { memeId: identity.id, error: errorMessage(error) });
        return report;
      }
    };

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
        } else if (budgetExhausted) {
          tokenLog.warn('llm budget exhausted; market-only score');
        } else if (researcherFailed) {
          tokenLog.debug('researcher unavailable; market-only score');
        } else {
          const evidence = await resolved.collectEvidence(snapshot, baseResearchCtx);
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
            const observedPrecedent = await lookUpPrecedent(snapshot, tokenLog);
            const researchCtx: ResearchContext = { ...baseResearchCtx, observedPrecedent };
            const report = await linkMeme(
              await researcher.research(snapshot, chain, evidence, researchCtx),
              tokenLog,
            );
            await store.saveProvenance(id, report);
            provenance = report;

            // ---- Stage 5: cost ceiling ---------------------------------------
            budgetSpent += report.usage?.costUsd ?? 0;
            stats.llmCostUsd = Number(budgetSpent.toFixed(6));
            if (budgetSpent >= app.llm.maxCostUsdPerRun) {
              budgetExhausted = true;
              const detail = `LLM cost ceiling reached: $${budgetSpent.toFixed(4)} of $${app.llm.maxCostUsdPerRun}; remaining tokens get a market-only score`;
              stats.sourceErrors.push({ source: BUDGET_SOURCE, error: detail });
              log.warn(detail, { spentUsd: budgetSpent, ceilingUsd: app.llm.maxCostUsdPerRun });
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

    // ---- Stage 6b: dispatch and persist -------------------------------------
    const alerts = outcomes.flatMap((outcome) => outcome.alerts);
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
 * `failed` means the run produced nothing usable; `partial` means it produced
 * something but a source, a token, the researcher or the cost ceiling degraded
 * it. A quiet market — no token clearing the filters, nothing broken — is `ok`.
 */
export function resolveStatus(selectedCount: number, stats: RunStats): RunStatus {
  const usable = stats.analysed + stats.reused;
  if (selectedCount > 0 && usable === 0) return 'failed';
  if (selectedCount === 0 && stats.sourceErrors.length > 0) return 'failed';
  if (stats.sourceErrors.length > 0) return 'partial';
  return 'ok';
}
