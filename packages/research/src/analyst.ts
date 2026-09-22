/**
 * The LLM half: web research, then structured extraction.
 *
 * Two calls on purpose. The first runs with the web search server tool and no
 * output constraint, so the model can follow a lead, find it wrong and say so.
 * The second reads those notes with no tools and a forced tool call, and emits
 * the schema-validated report. Forcing both jobs into one call makes the
 * research worse, because the model starts optimising for filling fields
 * halfway through the search — and the lineage is the field that suffers.
 *
 * Search happens server-side. The alternative this replaced was scraping
 * DuckDuckGo and Know Your Meme HTML, which breaks whenever either site
 * reflows and returns nothing rather than saying it failed.
 */

import Anthropic from '@anthropic-ai/sdk';
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
import { CostTracker, usageFromResponse } from './cost';
import { PROMPT_VERSION, SYSTEM_PROMPT, buildExtractionPrompt, buildResearchPrompt } from './prompt';
import { PROVENANCE_TOOL_NAME, buildDegradedReport, provenanceTool, validateReportDraft } from './schema';

/**
 * Dynamic-filtering variant of the web search server tool. Requires a recent
 * model; an older one returns a 400 naming the tool type, which `research()`
 * treats as "no search available" rather than as a failed run.
 */
const WEB_SEARCH_TOOL_TYPE = 'web_search_20260209' as const;

export interface AnalystOptions {
  client?: Pick<Anthropic, 'messages'>;
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

interface Harvest {
  texts: string[];
  citations: string[];
  searches: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Pull prose, source URLs and search count out of one response.
 *
 * Server-tool errors arrive as a 200 with an error object where the result list
 * would be, so the content of a `web_search_tool_result` is checked before it
 * is iterated — treating it as an array throws on exactly the responses that
 * most need reporting.
 */
export function harvest(message: Anthropic.Message): Harvest {
  const texts: string[] = [];
  const citations: string[] = [];
  let searches = 0;

  for (const block of message.content) {
    if (block.type === 'text') {
      texts.push(block.text);
      for (const citation of block.citations ?? []) {
        const url = (citation as { url?: string }).url;
        if (url) citations.push(url);
      }
    } else if (block.type === 'web_search_tool_result') {
      searches += 1;
      const content = block.content as unknown;
      if (!Array.isArray(content)) continue;
      for (const item of content) {
        const url = (item as { url?: string }).url;
        if (url) citations.push(url);
      }
    }
  }

  return { texts, citations, searches };
}

/** Error code on a `web_search_tool_result` whose search did not run. */
export function searchErrorCode(message: Anthropic.Message): string | undefined {
  for (const block of message.content) {
    if (block.type !== 'web_search_tool_result') continue;
    const content = block.content as unknown;
    if (Array.isArray(content)) continue;
    const code = (content as { error_code?: string } | undefined)?.error_code;
    if (code) return code;
  }
  return undefined;
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
  private readonly client: Pick<Anthropic, 'messages'>;
  private readonly attempts: number;
  private readonly maxWebSearches: number;
  private readonly maxPauseTurnRestarts: number;

  constructor(
    private readonly app: AppConfig,
    private readonly logger: Logger,
    readonly tracker: CostTracker,
    options: AnalystOptions = {},
  ) {
    this.client = options.client ?? new Anthropic({ apiKey: app.anthropicApiKey ?? '', maxRetries: 3 });
    this.attempts = options.attempts ?? 2;
    this.maxWebSearches = options.maxWebSearches ?? app.llm.maxWebSearches ?? 6;
    this.maxPauseTurnRestarts = options.maxPauseTurnRestarts ?? 3;
  }

  async research(
    snapshot: TokenSnapshot,
    chain: ChainAnalysis | undefined,
    evidence: EvidenceItem[],
    _ctx: ResearchContext,
  ): Promise<ProvenanceReport> {
    const log = this.logger.child('analyst');
    const model = this.app.llm.model;

    let found: ResearchNotes;
    try {
      found = await this.runResearchPass(snapshot, chain, evidence, log);
    } catch (error) {
      const reason = errorMessage(error);
      log.error('research pass failed', { tokenId: snapshot.tokenId, error: reason });
      return buildDegradedReport({
        tokenId: snapshot.tokenId,
        memeName: snapshot.name || snapshot.symbol,
        model,
        promptVersion: PROMPT_VERSION,
        reason: `Web research pass failed: ${reason}`,
        evidence,
      });
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
      return buildDegradedReport({
        tokenId: snapshot.tokenId,
        memeName: snapshot.name || snapshot.symbol,
        model,
        promptVersion: PROMPT_VERSION,
        reason: 'The research pass produced no notes to extract a report from.',
        evidence: allEvidence,
      });
    }

    return this.runExtractionPass(snapshot, chain, found, allEvidence, log);
  }

  // -- phase 1 ---------------------------------------------------------------

  private async runResearchPass(
    snapshot: TokenSnapshot,
    chain: ChainAnalysis | undefined,
    evidence: readonly EvidenceItem[],
    log: Logger,
  ): Promise<ResearchNotes> {
    const model = this.app.llm.model;
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: buildResearchPrompt(snapshot, chain, evidence) },
    ];
    const tools = [
      { type: WEB_SEARCH_TOOL_TYPE, name: 'web_search', max_uses: this.maxWebSearches },
    ] as unknown as Anthropic.ToolUnion[];

    const notes: string[] = [];
    const citations: string[] = [];
    let searches = 0;
    let paused = true;

    for (let attempt = 0; attempt <= this.maxPauseTurnRestarts; attempt++) {
      // Streamed so a long research turn cannot trip the HTTP read timeout.
      const stream = this.client.messages.stream({
        model,
        max_tokens: this.app.llm.maxOutputTokens,
        // Same cacheable prefix as the extraction pass, so the second call of
        // every token reads the system prompt from cache rather than paying.
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages,
        tools,
      });
      const message = await stream.finalMessage();
      this.tracker.add(model, usageFromResponse(message.usage));

      const code = searchErrorCode(message);
      if (code) log.warn('web search stopped', { tokenId: snapshot.tokenId, code });

      const batch = harvest(message);
      notes.push(...batch.texts);
      citations.push(...batch.citations);
      searches += batch.searches;

      if (message.stop_reason !== 'pause_turn') {
        paused = false;
        break;
      }
      // Resuming a paused turn means handing the assistant turn straight back.
      messages.push({ role: 'assistant', content: message.content });
    }

    if (paused) {
      log.warn('research turn still paused after restarts', {
        tokenId: snapshot.tokenId,
        restarts: this.maxPauseTurnRestarts,
      });
    }

    return {
      notes: notes.filter((text) => text.trim() !== '').join('\n\n'),
      citations: [...new Set(citations)],
      searchesRun: searches,
    };
  }

  // -- phase 2 ---------------------------------------------------------------

  private async runExtractionPass(
    snapshot: TokenSnapshot,
    chain: ChainAnalysis | undefined,
    found: ResearchNotes,
    evidence: EvidenceItem[],
    log: Logger,
  ): Promise<ProvenanceReport> {
    const model = this.app.llm.model;
    const prompt = buildExtractionPrompt(snapshot, chain, found.notes, found.citations);
    let lastIssues: string[] = [];

    for (let attempt = 1; attempt <= this.attempts; attempt++) {
      try {
        const response = await this.client.messages.create({
          model,
          max_tokens: this.app.llm.maxOutputTokens,
          temperature: this.app.llm.temperature,
          system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
          tools: [provenanceTool()],
          tool_choice: { type: 'tool', name: PROVENANCE_TOOL_NAME },
          messages: [{ role: 'user', content: prompt }],
        });

        const usage = usageFromResponse(response.usage);
        this.tracker.add(model, usage);

        const block = response.content.find(
          (item): item is Anthropic.ToolUseBlock =>
            item.type === 'tool_use' && item.name === PROVENANCE_TOOL_NAME,
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
        // A report built on nothing but recall and on-chain metadata is a
        // weaker claim than one standing on a source the model actually read.
        const grounded =
          found.citations.length > 0 ||
          evidence.some((item) => item.kind !== 'model-knowledge' && item.kind !== 'onchain');

        return {
          ...outcome.draft,
          tokenId: snapshot.tokenId,
          evidence: mergeEvidence(outcome.draft.evidence, evidence),
          confidence: clamp(outcome.draft.confidence * (grounded ? 1 : 0.7) - penalty, 0, 1),
          model,
          promptVersion: PROMPT_VERSION,
          generatedAt: nowIso(),
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            costUsd: this.tracker.totalUsd,
          },
        };
      } catch (error) {
        lastIssues = [errorMessage(error)];
        log.warn('extraction call failed', { tokenId: snapshot.tokenId, attempt, error: lastIssues[0] });
      }
    }

    return buildDegradedReport({
      tokenId: snapshot.tokenId,
      memeName: snapshot.name || snapshot.symbol,
      model,
      promptVersion: PROMPT_VERSION,
      reason: lastIssues[0] ?? 'The model did not return a usable provenance report.',
      evidence,
    });
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
