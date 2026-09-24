/**
 * Provenance synthesis: turns a snapshot plus collected evidence into a
 * structured `ProvenanceReport`.
 *
 * Two implementations behind one interface. `WebSearchAnalyst` (in
 * `analyst.ts`) researches with the web search server tool and then extracts a
 * typed report from its own notes. `StubResearcher` produces a deterministic,
 * clearly-labelled offline report so the whole pipeline is demoable with no API
 * key — its reports say plainly that nothing was researched, because a fixture
 * report that reads like a real one is worse than no report at all.
 */

import {
  hashKey,
  nowIso,
  type Anchor,
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
import { WebSearchAnalyst, type AnalystOptions } from './analyst';
import { resolveAnchor } from './anchor';
import { CostTracker } from './cost';
import { PROMPT_VERSION } from './prompt';
import { buildQueries } from './queries';
import { buildDegradedReport, validateReportDraft } from './schema';

export type ResearcherOptions = AnalystOptions;

/** Best guess at the meme behind a ticker, used for labelling and stub output. */
function memeSubject(snapshot: TokenSnapshot): string {
  const queries = buildQueries({ symbol: snapshot.symbol, name: snapshot.name });
  return queries.subject || snapshot.name || snapshot.symbol;
}

interface Archetype {
  id: string;
  narrativeCluster: string;
  originYear?: number;
  originSummary: string;
  [key: string]: unknown;
}

const STUB_ANCHOR_PREFIX = 'Offline fixture output, not researched:';

/**
 * The same cap for the headline: low confidence, labelled as unresearched in
 * its own summary (the verdict is read on its own, away from `risks`), and no
 * source, since none was consulted.
 */
function stubAnchor(anchor: Anchor, snapshot: TokenSnapshot): Anchor {
  const resolved = resolveAnchor(anchor, snapshot.metrics.poolCreatedAt, 0);
  const { earliestSource: _none, ...rest } = resolved;
  return {
    ...rest,
    summary: resolved.summary.startsWith(STUB_ANCHOR_PREFIX)
      ? resolved.summary
      : `${STUB_ANCHOR_PREFIX} ${resolved.summary}`.trim(),
    confidence: 'low',
  };
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
      anchor: stubAnchor(outcome.draft.anchor, snapshot),
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
  return new WebSearchAnalyst(app, logger, options.tracker ?? new CostTracker(app.llm.maxCostUsdPerRun), options);
}
