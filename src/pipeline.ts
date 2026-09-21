/**
 * The run.
 *
 * Order matters here and it is all about cost. Collection and market data are
 * cheap and batched, so everything trending gets them. Holder and contract data
 * is one request per token, so only the shortlist gets it. Research is an LLM
 * call with web search, so only the top of the shortlist gets that. Each stage
 * is narrower than the one before it.
 */

import { randomUUID } from "node:crypto";

import { dispatch } from "./alerts/dispatch.js";
import { resolvedStatePath, type Config } from "./config.js";
import { enrich } from "./enrich/index.js";
import { Fetcher } from "./http.js";
import { log } from "./log.js";
import { describeToken, tokenKey, type Report, type ReportEntry, type TokenDossier } from "./models.js";
import { Analyst } from "./research/analyst.js";
import { passesFilters, rank, score } from "./scoring.js";
import { collectTrending } from "./sources/index.js";
import { Store } from "./state.js";

/**
 * How many tokens get the per-token enrichment calls, as a multiple of the
 * research budget. Enough that holder data can reorder the shortlist.
 */
const ENRICH_MULTIPLE = 3;

/** Seams for tests - the two things that cost money. */
export interface Deps {
  makeFetcher: () => Fetcher;
  makeAnalyst: (config: Config) => { investigate: (d: TokenDossier) => Promise<ResearchLike> };
  dispatch: typeof dispatch;
}

export interface ResearchLike {
  notes: string;
  citations: string[];
  verdict: import("./models.js").ProvenanceVerdict | null;
  searchesRun: number;
}

export const defaultDeps: Deps = {
  makeFetcher: () => new Fetcher(),
  makeAnalyst: (config) => new Analyst(config.secrets.anthropicApiKey, config.research),
  dispatch,
};

export interface RunOptions {
  dryRun?: boolean;
  limit?: number | null;
  deps?: Partial<Deps>;
}

export async function run(config: Config, options: RunOptions = {}): Promise<Report> {
  const deps = { ...defaultDeps, ...options.deps };
  const runId = randomUUID().replace(/-/g, "").slice(0, 12);
  const report: Report = {
    runId,
    startedAt: new Date(),
    entries: [],
    skipped: 0,
    errors: [],
  };
  const budget = options.limit ?? config.research.maxTokensPerRun;

  const fetcher = deps.makeFetcher();
  const store = new Store(resolvedStatePath(config));

  try {
    // 1. Who is trending, with market data.
    const dossiers = await collectTrending(fetcher, config);
    if (dossiers.length === 0) {
      report.errors.push("no trending tokens returned by any source");
      report.finishedAt = new Date();
      return report;
    }

    // 2. Cheap filters and a first ranking.
    const { kept: shortlist, dropped } = rank(dossiers, config.filters);
    report.skipped = dropped.length;
    for (const { dossier, reason } of dropped.slice(0, 20)) {
      log.info(`dropped ${describeToken(dossier.ref)}: ${reason}`);
    }

    for (const dossier of dossiers) store.recordSighting(dossier, runId);

    // 3. Holder and contract data for the plausible ones only.
    const candidates = shortlist.slice(0, Math.max(budget * ENRICH_MULTIPLE, budget));
    for (const dossier of candidates) {
      try {
        await enrich(fetcher, dossier, config);
      } catch (error) {
        log.warn(`enrichment failed for ${describeToken(dossier.ref)}: ${String(error)}`);
      }
      const scored = score(dossier);
      dossier.heuristicScore = scored.score;
      dossier.heuristicNotes = scored.notes;
    }

    // 4. Re-filter now that distribution is known, then re-rank.
    const rescored: TokenDossier[] = [];
    for (const dossier of candidates) {
      const result = passesFilters(dossier, config.filters);
      if (result.kept) {
        rescored.push(dossier);
      } else {
        report.skipped += 1;
        log.info(`dropped after enrichment ${describeToken(dossier.ref)}: ${result.reason}`);
      }
    }
    rescored.sort((a, b) => b.heuristicScore - a.heuristicScore);

    // 5. Don't spend a research call on something alerted hours ago.
    const queue: TokenDossier[] = [];
    for (const dossier of rescored) {
      if (store.alertedRecently(tokenKey(dossier.ref), config.alerts.realertAfterHours)) {
        log.info(`skipping ${describeToken(dossier.ref)} - alerted within the re-alert window`);
        continue;
      }
      queue.push(dossier);
      if (queue.length >= budget) break;
    }

    log.info(
      `${dossiers.length} trending -> ${shortlist.length} past filters -> ` +
        `${candidates.length} enriched -> ${queue.length} queued for research`,
    );

    if (options.dryRun) {
      report.entries = queue.map((dossier) => ({ dossier, citations: [] }));
      report.finishedAt = new Date();
      return report;
    }

    // 6. Research.
    const analyst = deps.makeAnalyst(config);
    for (const dossier of queue) {
      log.info(`researching ${describeToken(dossier.ref)} (score ${dossier.heuristicScore.toFixed(0)})`);
      const entry: ReportEntry = { dossier, citations: [] };
      try {
        const result = await analyst.investigate(dossier);
        entry.researchNotes = result.notes;
        entry.citations = result.citations;
        entry.verdict = result.verdict;
        log.info(`  ${result.searchesRun} search(es), ${result.citations.length} source(s)`);
      } catch (error) {
        // One failure must not end the run.
        const name = error instanceof Error ? error.constructor.name : "Error";
        const message = error instanceof Error ? error.message : String(error);
        entry.error = `${name}: ${message}`;
        log.error(`research failed for ${describeToken(dossier.ref)}: ${entry.error}`);
        report.errors.push(`${describeToken(dossier.ref)}: ${entry.error}`);
      }
      report.entries.push(entry);
    }

    // 7. Alert on what clears the bar; the rest stays in the report.
    const alertable = report.entries.filter((entry) => shouldAlert(entry, config));
    for (const entry of alertable) {
      store.recordAlert(entry.dossier, entry.verdict!, runId);
    }

    report.finishedAt = new Date();
    const channels = await deps.dispatch(report, alertable, config, fetcher);
    log.info(`alerted ${alertable.length} token(s) via ${channels.join(", ") || "nothing"}`);

    return report;
  } finally {
    store.close();
  }
}

export function shouldAlert(entry: ReportEntry, config: Config): boolean {
  const verdict = entry.verdict;
  if (!verdict) return false;
  if (verdict.recycle_confidence < config.alerts.minRecycleConfidence) return false;
  return config.alerts.noveltyAllowlist.includes(verdict.novelty);
}
