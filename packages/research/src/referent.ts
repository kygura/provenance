/**
 * The launch lane's cultural gate, carried over from dexscanner.
 *
 * One question: does this ticker/name point at something people outside crypto
 * would recognise? It runs on every launch that clears the hard filters, so it
 * is built to be cheap — the triage model, a small search budget, a four-field
 * answer — and to be skeptical by default. The full provenance research waits
 * until a catalogued token earns it by showing up on a trending list.
 *
 * Same two-pass split as the analyst, for the same reason: the search pass
 * writes prose with no schema in front of it, then a tool-less pass structures
 * those notes into a forced tool call. Asking for JSON at the end of a search
 * turn, as dexscanner did, is where it failed to parse.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  nowIso,
  type AppConfig,
  type Logger,
  type ReferentCheck,
  type ReferentChecker,
  type ReferentConfidence,
  type ResearchContext,
  type TokenSnapshot,
} from '@provenance/core';
import { harvest, searchErrorCode } from './analyst';
import { CostTracker, usageFromResponse } from './cost';
import { classify } from './lexicon';
import { UNTRUSTED_POLICY, fence } from './untrusted';

export const REFERENT_PROMPT_VERSION = 'referent-v1';
export const REFERENT_TOOL_NAME = 'record_referent';

const WEB_SEARCH_TOOL_TYPE = 'web_search_20260209' as const;
const CONFIDENCE: readonly ReferentConfidence[] = ['high', 'medium', 'low'];

export const REFERENT_SYSTEM_PROMPT = `You are a cultural analyst evaluating cryptocurrency token names for real-world significance.

Your only job is to decide whether a token's name or ticker refers to a genuine cultural artifact — a person, event, film, character, concept, meme or object — that exists entirely independently of the crypto industry and has sustained mainstream recognition.

You are deeply skeptical. Crypto-native references, inside jokes, and obscure internet culture do not qualify. Only things someone with no knowledge of cryptocurrency would recognise pass. Generic dictionary words do not pass on their own: "Moon" is a word, not a referent.

Search to verify rather than relying on memory. Search for the thing the name refers to, not for the token.

${UNTRUSTED_POLICY}`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function buildReferentPrompt(snapshot: TokenSnapshot): string {
  const rows = [`ticker: ${snapshot.symbol}`, `name: ${snapshot.name}`];
  if (snapshot.description) rows.push(`description: ${snapshot.description.slice(0, 600)}`);
  return [
    'Decide whether this token refers to something with mainstream recognition outside crypto.',
    '',
    fence('token metadata, written by the deployer', rows.join('\n')),
    '',
    'Work through:',
    '1. What does the name or ticker refer to, if anything, outside crypto?',
    '2. Does that referent have a Wikipedia article or substantial mainstream media coverage?',
    '3. Has interest in the referent itself — not the token — been sustained, rather than a one-week spike?',
    '',
    'Write short notes with what you found and where. Say plainly if you found nothing.',
  ].join('\n');
}

export function buildReferentExtractionPrompt(notes: string, citations: readonly string[]): string {
  return [
    'Record the verdict from these research notes by calling the tool. Do not add facts the notes do not contain.',
    '',
    fence('research notes from the previous pass', notes),
    '',
    citations.length > 0 ? `Sources consulted: ${citations.slice(0, 10).join(', ')}` : 'No sources were consulted.',
    '',
    'validated is true only for a referent with verifiable mainstream presence outside crypto. If the notes are uncertain, use low confidence.',
  ].join('\n');
}

export function referentTool(): Anthropic.Tool {
  return {
    name: REFERENT_TOOL_NAME,
    description: 'Record whether the token name refers to a real-world cultural referent.',
    input_schema: {
      type: 'object',
      properties: {
        validated: { type: 'boolean', description: 'True only for a referent with mainstream recognition outside crypto.' },
        referent: { type: 'string', description: 'What the name refers to, in a few words. Empty if nothing.' },
        summary: { type: 'string', description: 'One or two sentences on staying power, or why it fails.' },
        confidence: { type: 'string', enum: [...CONFIDENCE] },
      },
      required: ['validated', 'referent', 'summary', 'confidence'],
    },
  };
}

type ReferentDraft = Pick<ReferentCheck, 'validated' | 'referent' | 'summary' | 'confidence'>;

/** Never throws; a malformed answer is an unvalidated, low-confidence one. */
export function parseReferentDraft(input: unknown): ReferentDraft {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const confidence = CONFIDENCE.includes(raw.confidence as ReferentConfidence)
    ? (raw.confidence as ReferentConfidence)
    : 'low';
  return {
    validated: raw.validated === true,
    referent: typeof raw.referent === 'string' ? raw.referent.trim().slice(0, 200) : '',
    summary: typeof raw.summary === 'string' ? raw.summary.trim().slice(0, 600) : '',
    confidence,
  };
}

/**
 * A verdict nobody searched for is recall, and recall is how a model "knows"
 * a referent it made up. Without a single citation it cannot be `high`.
 */
export function groundConfidence(draft: ReferentDraft, citations: number): ReferentDraft {
  if (citations > 0 || draft.confidence !== 'high') return draft;
  return { ...draft, confidence: 'medium' };
}

export interface ReferentOptions {
  client?: Pick<Anthropic, 'messages'>;
  tracker?: CostTracker;
  maxWebSearches?: number;
}

export class WebSearchReferentChecker implements ReferentChecker {
  private readonly client: Pick<Anthropic, 'messages'>;
  private readonly maxWebSearches: number;
  readonly tracker: CostTracker;

  constructor(
    private readonly app: AppConfig,
    private readonly logger: Logger,
    options: ReferentOptions = {},
  ) {
    this.client = options.client ?? new Anthropic({ apiKey: app.anthropicApiKey ?? '', maxRetries: 3 });
    this.tracker = options.tracker ?? new CostTracker(app.llm.maxCostUsdPerRun);
    this.maxWebSearches = options.maxWebSearches ?? app.launches.maxReferentSearches;
  }

  async check(snapshot: TokenSnapshot, _ctx: ResearchContext): Promise<ReferentCheck> {
    const log = this.logger.child('referent');
    const model = this.app.llm.triageModel;
    const spentBefore = this.tracker.totalUsd;
    let inputTokens = 0;
    let outputTokens = 0;
    const finish = (draft: ReferentDraft, citations: string[]): ReferentCheck => ({
      ...draft,
      model,
      checkedAt: nowIso(),
      citations,
      usage: { inputTokens, outputTokens, costUsd: Number((this.tracker.totalUsd - spentBefore).toFixed(6)) },
    });
    const failed = (reason: string, citations: string[] = []): ReferentCheck =>
      finish({ validated: false, referent: '', summary: reason, confidence: 'low' }, citations);

    // ---- pass 1: search, prose only ------------------------------------------
    let notes = '';
    let citations: string[] = [];
    try {
      const message = await this.client.messages.create({
        model,
        max_tokens: 1500,
        system: [{ type: 'text', text: REFERENT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: buildReferentPrompt(snapshot) }],
        tools: [
          { type: WEB_SEARCH_TOOL_TYPE, name: 'web_search', max_uses: this.maxWebSearches },
        ] as unknown as Anthropic.ToolUnion[],
      });
      const usage = usageFromResponse(message.usage);
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      this.tracker.add(model, usage);
      const code = searchErrorCode(message);
      if (code) log.warn('web search stopped', { tokenId: snapshot.tokenId, code });
      const found = harvest(message);
      notes = found.texts.filter((text) => text.trim() !== '').join('\n\n');
      citations = [...new Set(found.citations)];
    } catch (error) {
      log.warn('referent search failed', { tokenId: snapshot.tokenId, error: errorMessage(error) });
      return failed(`Referent search failed: ${errorMessage(error)}`);
    }
    if (notes.trim() === '') return failed('The search pass produced no notes.', citations);

    // ---- pass 2: structure the notes, no tools -------------------------------
    try {
      const response = await this.client.messages.create({
        model,
        max_tokens: 400,
        temperature: 0,
        system: [{ type: 'text', text: REFERENT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        tools: [referentTool()],
        tool_choice: { type: 'tool', name: REFERENT_TOOL_NAME },
        messages: [{ role: 'user', content: buildReferentExtractionPrompt(notes, citations) }],
      });
      const usage = usageFromResponse(response.usage);
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      this.tracker.add(model, usage);
      const block = response.content.find(
        (item): item is Anthropic.ToolUseBlock => item.type === 'tool_use' && item.name === REFERENT_TOOL_NAME,
      );
      if (!block) return failed('The model returned no verdict.', citations);
      return finish(groundConfidence(parseReferentDraft(block.input), citations.length), citations);
    } catch (error) {
      log.warn('referent extraction failed', { tokenId: snapshot.tokenId, error: errorMessage(error) });
      return failed(`Referent extraction failed: ${errorMessage(error)}`, citations);
    }
  }
}

/**
 * Offline stand-in. It cannot know what a name refers to, so it says so: a
 * lexicon hit is reported as a `medium` guess labelled as such, and anything
 * else is unvalidated. Enough to demo the lane end to end without pretending
 * a fixture run researched anything.
 */
export class StubReferentChecker implements ReferentChecker {
  constructor(private readonly app: AppConfig) {}

  async check(snapshot: TokenSnapshot): Promise<ReferentCheck> {
    const hits = classify(`${snapshot.symbol} ${snapshot.name}`);
    const top = hits.find((hit) => hit.archetype.key !== 'explicit_revival') ?? hits[0];
    const base = { model: `stub:${this.app.llm.triageModel}`, checkedAt: nowIso(), citations: [] };
    if (!top) {
      return {
        ...base,
        validated: false,
        referent: '',
        summary: 'Offline stub: no lexicon archetype matched and nothing was searched.',
        confidence: 'low',
      };
    }
    return {
      ...base,
      validated: true,
      referent: top.archetype.label,
      summary: `Offline stub: lexicon match on ${top.matched.map((m) => `'${m}'`).join(', ')}; not researched.`,
      confidence: 'medium',
    };
  }
}

/** Real checker with a key and live data; the stub otherwise, never a throw. */
export function createReferentChecker(
  app: AppConfig,
  logger: Logger,
  options: ReferentOptions = {},
): ReferentChecker {
  if (app.pipeline.useFixtures || !app.anthropicApiKey) return new StubReferentChecker(app);
  return new WebSearchReferentChecker(app, logger, options);
}
