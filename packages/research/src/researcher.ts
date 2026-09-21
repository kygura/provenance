/**
 * Provenance synthesis: turns a snapshot plus collected evidence into a
 * structured `ProvenanceReport`.
 *
 * Two implementations behind one interface. `LlmResearcher` calls the Anthropic
 * API with a forced tool call, so the model returns a typed object rather than
 * prose we would have to parse. `StubResearcher` produces a deterministic,
 * clearly-labelled offline report so the whole pipeline is demoable with no API
 * key — its reports say plainly that nothing was researched, because a fixture
 * report that reads like a real one is worse than no report at all.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  clamp,
  hashKey,
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
import archetypeFixture from '../../../fixtures/research/stub-archetypes.json' with { type: 'json' };
import { CostTracker, usageFromResponse } from './cost';
import { PROMPT_VERSION, SYSTEM_PROMPT, buildUserPrompt } from './prompt';
import { buildQueries } from './queries';
import { PROVENANCE_TOOL_NAME, buildDegradedReport, provenanceTool, validateReportDraft } from './schema';

export interface ResearcherOptions {
  client?: Pick<Anthropic, 'messages'>;
  tracker?: CostTracker;
  /** Attempts at a usable tool call before giving up and degrading. */
  attempts?: number;
}

/** Best guess at the meme behind a ticker, used for labelling and stub output. */
function memeSubject(snapshot: TokenSnapshot): string {
  const queries = buildQueries({ symbol: snapshot.symbol, name: snapshot.name });
  return queries.subject || snapshot.name || snapshot.symbol;
}

export class LlmResearcher implements ProvenanceResearcher {
  private readonly client: Pick<Anthropic, 'messages'>;
  private readonly attempts: number;

  constructor(
    private readonly app: AppConfig,
    private readonly logger: Logger,
    readonly tracker: CostTracker,
    options: ResearcherOptions = {},
  ) {
    this.client =
      options.client ??
      new Anthropic({
        apiKey: app.anthropicApiKey ?? '',
        maxRetries: 3,
      });
    this.attempts = options.attempts ?? 2;
  }

  async research(
    snapshot: TokenSnapshot,
    chain: ChainAnalysis | undefined,
    evidence: EvidenceItem[],
    _ctx: ResearchContext,
  ): Promise<ProvenanceReport> {
    const model = this.app.llm.model;
    const meme = memeSubject(snapshot);
    const log = this.logger.child('researcher');
    let lastIssues: string[] = [];

    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        const response = await this.client.messages.create({
          model,
          max_tokens: this.app.llm.maxOutputTokens,
          temperature: this.app.llm.temperature,
          // The system prompt and tool schema are identical for every token in
          // a run, so caching that prefix is most of the saving on a 15-token run.
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          tools: [provenanceTool()],
          tool_choice: { type: 'tool', name: PROVENANCE_TOOL_NAME },
          messages: [{ role: 'user', content: buildUserPrompt(snapshot, chain, evidence) }],
        });

        const usage = usageFromResponse(response.usage);
        const costUsd = this.tracker.add(model, usage);

        const block = response.content.find(
          (item): item is Anthropic.ToolUseBlock => item.type === 'tool_use' && item.name === PROVENANCE_TOOL_NAME,
        );
        if (!block) {
          lastIssues = ['Model returned no tool call despite tool_choice.'];
          log.warn('no tool call in response', { tokenId: snapshot.tokenId, attempt });
          continue;
        }

        const outcome = validateReportDraft(block.input);
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
        const evidenceFloor = evidence.some((item) => item.kind !== 'model-knowledge' && item.kind !== 'onchain')
          ? 1
          : 0.7;

        return {
          ...outcome.draft,
          tokenId: snapshot.tokenId,
          confidence: clamp(outcome.draft.confidence * evidenceFloor - penalty, 0, 1),
          model,
          promptVersion: PROMPT_VERSION,
          generatedAt: nowIso(),
          usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd },
        };
      } catch (error) {
        lastIssues = [error instanceof Error ? error.message : String(error)];
        log.warn('provenance call failed', { tokenId: snapshot.tokenId, attempt, error: lastIssues[0] });
      }
    }

    return buildDegradedReport({
      tokenId: snapshot.tokenId,
      memeName: meme,
      model,
      promptVersion: PROMPT_VERSION,
      reason: lastIssues[0] ?? 'The model did not return a usable provenance report.',
      evidence,
    });
  }
}

interface Archetype {
  id: string;
  narrativeCluster: string;
  originYear?: number;
  originSummary: string;
  [key: string]: unknown;
}

/**
 * Offline researcher. Picks an archetype deterministically from the token id so
 * repeated fixture runs are stable, and keeps confidence low with an explicit
 * note: this output is illustrative, not researched.
 */
export class StubResearcher implements ProvenanceResearcher {
  private readonly archetypes: Archetype[];

  constructor(
    private readonly app: AppConfig,
    private readonly logger: Logger,
  ) {
    const raw = archetypeFixture as { archetypes?: unknown };
    this.archetypes = Array.isArray(raw.archetypes) ? (raw.archetypes as Archetype[]) : [];
  }

  async research(
    snapshot: TokenSnapshot,
    _chain: ChainAnalysis | undefined,
    evidence: EvidenceItem[],
    _ctx: ResearchContext,
  ): Promise<ProvenanceReport> {
    const meme = memeSubject(snapshot);
    const model = `stub:${this.app.llm.model}`;

    if (this.archetypes.length === 0) {
      return buildDegradedReport({
        tokenId: snapshot.tokenId,
        memeName: meme,
        model,
        promptVersion: PROMPT_VERSION,
        reason: 'Offline stub researcher has no archetypes available.',
        evidence,
      });
    }

    // Stable pick: the same token yields the same archetype across runs.
    const index = Number.parseInt(hashKey(snapshot.tokenId).slice(0, 8), 16) % this.archetypes.length;
    const archetype = this.archetypes[index] as Archetype;
    const filled = JSON.parse(
      JSON.stringify(archetype).replaceAll('{{MEME}}', meme).replaceAll('{{TICKER}}', snapshot.symbol),
    ) as Record<string, unknown>;

    const outcome = validateReportDraft({ ...filled, memeName: meme });
    if (!outcome.draft) {
      this.logger.warn('stub archetype failed validation', { id: archetype.id, issues: outcome.issues.slice(0, 3) });
      return buildDegradedReport({
        tokenId: snapshot.tokenId,
        memeName: meme,
        model,
        promptVersion: PROMPT_VERSION,
        reason: `Stub archetype "${archetype.id}" did not validate.`,
        evidence,
      });
    }

    return {
      ...outcome.draft,
      tokenId: snapshot.tokenId,
      // Capped hard: fixture output must never look like a researched finding.
      confidence: Math.min(outcome.draft.confidence, 0.2),
      risks: [...outcome.draft.risks, 'Offline fixture output: no sources were consulted.'],
      evidence,
      model,
      promptVersion: PROMPT_VERSION,
      generatedAt: nowIso(),
    };
  }
}

/**
 * Picks the real researcher when an API key is present and fixtures are off.
 * Everything else falls back to the stub, so a missing key degrades the run
 * rather than failing it.
 */
export function createResearcher(
  app: AppConfig,
  logger: Logger,
  options: ResearcherOptions = {},
): ProvenanceResearcher {
  if (app.pipeline.useFixtures || !app.anthropicApiKey) {
    if (!app.pipeline.useFixtures) {
      logger.warn('ANTHROPIC_API_KEY not set — provenance reports will be offline stubs');
    }
    return new StubResearcher(app, logger);
  }
  return new LlmResearcher(app, logger, options.tracker ?? new CostTracker(app.llm.maxCostUsdPerRun), options);
}
