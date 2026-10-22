/**
 * The LLM half: web research, then structured extraction.
 *
 * Two calls on purpose. The first runs with the web search server tool and no
 * output constraint, so the model can follow a lead, find it wrong and say so.
 * The second reads those notes with no tools and a forced tool call, and emits
 * the schema-validated report. Forcing both jobs into one call makes the
 * research worse, because the model starts optimising for filling fields
 * halfway through the search — and the lineage is the field that suffers.
 * The anchor verdict leads the report; whether its date precedes the launch is
 * decided here in code (`resolveAnchor`), never taken from the model.
 *
 * Search happens server-side. The alternative this replaced was scraping
 * DuckDuckGo and Know Your Meme HTML, which breaks whenever either site
 * reflows and returns nothing rather than saying it failed.
 */

import type Anthropic from '@anthropic-ai/sdk';
import {
  clamp,
  nowIso,
  type AppConfig,
  type ChainAnalysis,
  type EvidenceItem,
  type Logger,
  type ProvenanceReport,
  type ProvenanceResearcher,
  type ResearchContext,
  type TokenSnapshot,
} from '@provenance/core';
import { resolveAnchor } from './anchor';
import { CostTracker } from './cost';
import { createLlm, type CreateLlmOptions, type LlmClient, type UsageSink } from './llm';
import {
  PROMPT_VERSION,
  SPLIT_PROMPT_VERSION,
  SYSTEM_PROMPT,
  buildExtractionPrompt,
  buildGatherPrompt,
  buildJudgePrompt,
  buildResearchPrompt,
} from './prompt';
import { parseModelSpec } from './llm/spec';
import { PROVENANCE_TOOL_NAME, buildDegradedReport, provenanceTool, validateReportDraft } from './schema';

// Re-exported so existing importers keep one entry point for the analyst.
export { harvest, searchErrorCode, type Harvest } from './search';

export interface AnalystOptions {
  /** Injected Anthropic `messages` client, used when a pass runs on Anthropic. */
  client?: Pick<Anthropic, 'messages'>;
  /** Injected clients per pass; override the config's model specs. */
  researchLlm?: LlmClient;
  extractLlm?: LlmClient;
  fetch?: CreateLlmOptions['fetch'];
  tracker?: CostTracker;
  /** Attempts at a usable tool call in the extraction pass before degrading. */
  attempts?: number;
  /** Ceiling on web searches in the research pass. */
  maxWebSearches?: number;
  /** A long search turn can stop with `pause_turn`; this bounds the resumes. */
  maxPauseTurnRestarts?: number;
}

export interface ResearchNotes {
  notes: string;
  citations: string[];
  searchesRun: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Turn the search tool's citations into evidence rows, so a report carries its
 * sources the same way a collector-sourced one does and the dashboard needs no
 * special case. `sourceQuality` is deliberately middling: a search result is
 * better than recall and worse than an encyclopedia entry the model quoted.
 */
export function citationsToEvidence(citations: readonly string[], retrievedAt: string): EvidenceItem[] {
  const seen = new Set<string>();
  const items: EvidenceItem[] = [];
  for (const url of citations) {
    if (seen.has(url)) continue;
    seen.add(url);
    let title = url;
    try {
      title = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      // A malformed citation URL is still worth recording verbatim.
    }
    items.push({
      kind: 'web',
      url,
      title,
      snippet: 'Consulted by the model during the web research pass.',
      retrievedAt,
      sourceQuality: 0.5,
    });
  }
  return items;
}

export class WebSearchAnalyst implements ProvenanceResearcher {
  private readonly researchLlm: LlmClient;
  private readonly extractLlm: LlmClient;
  private readonly attempts: number;
  private readonly maxWebSearches: number;
  /** Gather/judge split: a cheap model searches, `model` judges. */
  private readonly split: boolean;
  private readonly promptVersion: string;
  private readonly onUsage: UsageSink;

  constructor(
    private readonly app: AppConfig,
    private readonly logger: Logger,
    readonly tracker: CostTracker,
    options: AnalystOptions = {},
  ) {
    const build: CreateLlmOptions = {
      anthropicClient: options.client,
      fetch: options.fetch,
      maxPauseTurnRestarts: options.maxPauseTurnRestarts,
      warn: (message) => logger.warn(message),
    };
    const searchSpec = app.llm.searchModel;
    this.split = searchSpec !== undefined && searchSpec !== app.llm.model;
    this.promptVersion = this.split ? SPLIT_PROMPT_VERSION : PROMPT_VERSION;
    if (this.split && searchSpec !== undefined) {
      // The gatherer's runtime fallback is the cheap extract role's, and only
      // under Anthropic-first, which is the one case a fallback exists for.
      const searchFallback = parseModelSpec(searchSpec).provider === 'anthropic' ? app.llm.fallbackExtractModel : undefined;
      this.researchLlm = options.researchLlm ?? createLlm(app, searchSpec, { ...build, fallback: searchFallback });
      this.extractLlm = options.extractLlm ?? createLlm(app, app.llm.model, { ...build, fallback: app.llm.fallbackModel });
    } else {
      this.researchLlm =
        options.researchLlm ?? createLlm(app, app.llm.model, { ...build, fallback: app.llm.fallbackModel });
      const extractSpec = app.llm.extractModel ?? app.llm.model;
      const extractFallback = app.llm.fallbackExtractModel;
      this.extractLlm =
        options.extractLlm ??
        (extractSpec === app.llm.model && extractFallback === app.llm.fallbackModel && !options.researchLlm
          ? this.researchLlm
          : createLlm(app, extractSpec, { ...build, fallback: extractFallback }));
    }
    this.attempts = options.attempts ?? 2;
    this.maxWebSearches = options.maxWebSearches ?? app.llm.maxWebSearches ?? 8;
    this.onUsage = (model, usage, costUsd) => {
      this.tracker.add(model, usage, costUsd);
    };
  }

  /**
   * What a degraded report carries as its spend: whatever its calls cost before
   * the failure. Without it a run whose extractions all fail reports $0 while
   * the research passes were billed, and the per-run ceiling never trips.
   */
  private spentSince(spentBefore: number): NonNullable<ProvenanceReport['usage']> {
    return { inputTokens: 0, outputTokens: 0, costUsd: Number((this.tracker.totalUsd - spentBefore).toFixed(6)) };
  }

  /**
   * Model label a report carries: the research model, plus the extractor when it
   * differs. Read when the report is built, since a provider fallback can switch
   * models mid-report.
   */
  private modelLabel(): string {
    const research = this.researchLlm.model;
    const extract = this.extractLlm.model;
    return research === extract ? research : `${research}+${extract}`;
  }

  async research(
    snapshot: TokenSnapshot,
    chain: ChainAnalysis | undefined,
    evidence: EvidenceItem[],
    _ctx: ResearchContext,
  ): Promise<ProvenanceReport> {
    const log = this.logger.child('analyst');
    // The tracker lives for the whole run; a report carries only its own spend,
    // because the pipeline sums `usage.costUsd` across reports.
    const spentBefore = this.tracker.totalUsd;

    let found: ResearchNotes;
    try {
      found = await this.runResearchPass(snapshot, chain, evidence, log);
    } catch (error) {
      const reason = errorMessage(error);
      log.error('research pass failed', { tokenId: snapshot.tokenId, error: reason });
      return withUsage(buildDegradedReport({
        tokenId: snapshot.tokenId,
        memeName: snapshot.name || snapshot.symbol,
        model: this.modelLabel(),
        promptVersion: this.promptVersion,
        reason: `Web research pass failed: ${reason}`,
        failed: reason,
        evidence,
      }), this.spentSince(spentBefore));
    }

    log.info('research pass complete', {
      tokenId: snapshot.tokenId,
      searches: found.searchesRun,
      citations: found.citations.length,
      noteChars: found.notes.length,
    });

    const searchEvidence = citationsToEvidence(found.citations, nowIso());
    const allEvidence = [...evidence, ...searchEvidence];

    if (found.notes.trim() === '') {
      return withUsage(buildDegradedReport({
        tokenId: snapshot.tokenId,
        memeName: snapshot.name || snapshot.symbol,
        model: this.modelLabel(),
        promptVersion: this.promptVersion,
        reason: 'The research pass produced no notes to extract a report from.',
        evidence: allEvidence,
      }), this.spentSince(spentBefore));
    }

    return this.runExtractionPass(snapshot, chain, found, allEvidence, log, spentBefore);
  }

  // -- phase 1 ---------------------------------------------------------------

  private async runResearchPass(
    snapshot: TokenSnapshot,
    chain: ChainAnalysis | undefined,
    evidence: readonly EvidenceItem[],
    log: Logger,
  ): Promise<ResearchNotes> {
    if (!this.researchLlm.canSearch) {
      log.warn('research model has no web search; notes come from recall', {
        tokenId: snapshot.tokenId,
        provider: this.researchLlm.provider,
      });
    }
    const found = await this.researchLlm.search(
      {
        system: SYSTEM_PROMPT,
        prompt: this.split ? buildGatherPrompt(snapshot, chain, evidence) : buildResearchPrompt(snapshot, chain, evidence),
        maxTokens: this.app.llm.maxOutputTokens,
        maxSearches: this.maxWebSearches,
        long: true,
      },
      this.onUsage,
    );
    if (found.searchError) log.warn('web search stopped', { tokenId: snapshot.tokenId, code: found.searchError });
    if (found.paused) log.warn('research turn still paused after restarts', { tokenId: snapshot.tokenId });

    return {
      notes: found.texts.filter((text) => text.trim() !== '').join('\n\n'),
      citations: [...new Set(found.citations)],
      searchesRun: found.searches,
    };
  }

  // -- phase 2 ---------------------------------------------------------------

  private async runExtractionPass(
    snapshot: TokenSnapshot,
    chain: ChainAnalysis | undefined,
    found: ResearchNotes,
    evidence: EvidenceItem[],
    log: Logger,
    spentBefore: number,
  ): Promise<ProvenanceReport> {
    const prompt = this.split
      ? buildJudgePrompt(snapshot, chain, found.notes, found.citations)
      : buildExtractionPrompt(snapshot, chain, found.notes, found.citations);
    let lastIssues: string[] = [];
    // Set only while the latest attempt threw: a call that failed, not a bad answer.
    let lastError: string | undefined;

    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        const { input, usage } = await this.extractLlm.callTool(
          {
            system: SYSTEM_PROMPT,
            prompt,
            tool: provenanceTool(),
            maxTokens: this.app.llm.maxOutputTokens,
            temperature: this.app.llm.temperature,
            // Copying notes into a schema needs no deliberation; judging them does.
            reasoningEffort: this.split ? 'high' : 'low',
          },
          this.onUsage,
        );
        lastError = undefined;

        if (input === undefined) {
          lastIssues = ['Model returned no tool call despite tool_choice.'];
          log.warn('no tool call in response', { tokenId: snapshot.tokenId, attempt });
          continue;
        }

        const outcome = validateReportDraft(input);
        if (!outcome.draft) {
          lastIssues = outcome.issues;
          log.warn('tool call rejected by validator', {
            tokenId: snapshot.tokenId,
            attempt,
            issues: outcome.issues.slice(0, 3),
          });
          continue;
        }

        if (outcome.repairs.length > 0) {
          log.info('report repaired', { tokenId: snapshot.tokenId, repairs: outcome.repairs.slice(0, 5) });
        }

        // Repairs mean the model produced something out of contract; that is a
        // reason to trust the rest of it less, not merely to patch and move on.
        const penalty = outcome.repairs.length * 0.05;
        // A report built on nothing but recall and on-chain metadata is a
        // weaker claim than one standing on a source the model actually read.
        const grounded =
          found.citations.length > 0 ||
          evidence.some((item) => item.kind !== 'model-knowledge' && item.kind !== 'onchain');

        return {
          ...outcome.draft,
          // The order-of-events test runs in code, against the measured pool
          // time; whatever the model thought about it is not consulted.
          anchor: resolveAnchor(outcome.draft.anchor, snapshot.metrics.poolCreatedAt, found.citations.length),
          tokenId: snapshot.tokenId,
          evidence: mergeEvidence(outcome.draft.evidence, evidence),
          confidence: clamp(outcome.draft.confidence * (grounded ? 1 : 0.7) - penalty, 0, 1),
          model: this.modelLabel(),
          promptVersion: this.promptVersion,
          generatedAt: nowIso(),
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costUsd: Number((this.tracker.totalUsd - spentBefore).toFixed(6)),
          },
        };
      } catch (error) {
        lastError = errorMessage(error);
        lastIssues = [lastError];
        log.warn('extraction call failed', { tokenId: snapshot.tokenId, attempt, error: lastIssues[0] });
      }
    }

    return withUsage(buildDegradedReport({
      tokenId: snapshot.tokenId,
      memeName: snapshot.name || snapshot.symbol,
      model: this.modelLabel(),
      promptVersion: this.promptVersion,
      reason: lastIssues[0] ?? 'The model did not return a usable provenance report.',
      ...(lastError !== undefined ? { failed: lastError } : {}),
      evidence,
    }), this.spentSince(spentBefore));
  }
}

/**
 * The model's `model-knowledge` rows plus the ones this system collected.
 * Deduped on `url` where present, so a source the model cited and a collector
 * also fetched appears once.
 */
export function mergeEvidence(
  fromModel: readonly EvidenceItem[],
  collected: readonly EvidenceItem[],
): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  const seen = new Set<string>();
  for (const item of [...collected, ...fromModel]) {
    const key = item.url ?? `${item.kind}:${item.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function withUsage(report: ProvenanceReport, usage: NonNullable<ProvenanceReport['usage']>): ProvenanceReport {
  return { ...report, usage };
}
