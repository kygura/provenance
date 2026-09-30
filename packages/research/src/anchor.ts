/**
 * The anchor question, which is the whole point of the project: does this meme
 * have a real anchor — an old meme, a cultural artifact, an inciting event the
 * token is reacting to — or is it being pushed because the token exists?
 *
 * This module holds the parts both depths share, plus the fast depth itself:
 *
 *   - `ANCHOR_RULES`, the definitions both prompts quote verbatim, so the fast
 *     check and the full report cannot drift apart on what "forced" means;
 *   - `anchorSchema` / `parseAnchor`, the tool-call shape and its validator;
 *   - `resolveAnchor`, which does the one thing a model must not be trusted
 *     with — comparing the anchor's date to the token's launch — and adjusts
 *     the verdict when the order of events contradicts it;
 *   - `WebSearchAnchorChecker`, the fast check run on every launch that clears
 *     the gate: triage model, a few searches, the verdict and nothing else.
 *
 * The fast check keeps the analyst's two-pass split — search in prose, then a
 * tool-less forced tool call over the notes — because JSON requested at the
 * end of a search turn is where dexscanner's version failed to parse.
 */

import type Anthropic from '@anthropic-ai/sdk';
import {
  nowIso,
  type Anchor,
  type AnchorCheck,
  type AnchorChecker,
  type AnchorConfidence,
  type AnchorSource,
  type AnchorType,
  type AnchorVerdict,
  type AppConfig,
  type Logger,
  type ResearchContext,
  type TokenSnapshot,
} from '@provenance/core';
import { CostTracker } from './cost';
import { createLlm, parseModelSpec, providerApiKey, type CreateLlmOptions, type LlmClient, type ToolSpec, type UsageSink } from './llm';
import { classify } from './lexicon';
import { UNTRUSTED_POLICY, fence } from './untrusted';

export const ANCHOR_PROMPT_VERSION = 'anchor-v1';
export const ANCHOR_TOOL_NAME = 'record_anchor';

const VERDICTS: readonly AnchorVerdict[] = ['anchored', 'forced', 'unclear'];
const TYPES: readonly AnchorType[] = ['historical-meme', 'cultural-artifact', 'inciting-event', 'none'];
const CONFIDENCE: readonly AnchorConfidence[] = ['high', 'medium', 'low'];

/**
 * An anchor dated more than this long after the token's first pool did not
 * cause the token. Generous, because "the day of" and "a few hours before"
 * both land on the same date when a source only gives a day.
 */
export const LAUNCH_ORDER_SLACK_HOURS = 24;

/** Quoted by both the fast check and the full research prompt. */
export const ANCHOR_RULES = `# The anchor question

Decide whether the meme behind this token has a real anchor, or is being forced.

- \`anchored\`: the thing the token points at existed BEFORE the token and INDEPENDENTLY of it. Three kinds count:
  - \`historical-meme\`: an internet meme with its own history (a known image, video, catchphrase or character from internet culture).
  - \`cultural-artifact\`: a film, show, game, character, public figure, brand, object or concept recognised outside crypto.
  - \`inciting-event\`: something that just happened in the world — a news story, a viral moment, a statement, an incident — that this token is a reaction to. A recent event is a perfectly good anchor; it does not need a Wikipedia page, it needs to have happened, independently, before the token.
- \`forced\`: the meme exists because the token does. Signs: the earliest mentions you can find are the token's own site, socials, launch posts or paid promotion; nobody was talking about the thing before the pool opened; the "lore" was written to sell the token.
- \`unclear\`: you could not establish either. Say so; it is an honest answer.

The test that separates them is ORDER OF EVENTS. Find the earliest source that is about the thing itself and does not mention the token, and date it. Report that date as \`anchorDate\` (a full ISO date where you have one, a bare year for old memes). Do not compare it to the launch date yourself; the system does that.

Generic dictionary words are not anchors on their own ("Moon", "Based"). Crypto-native in-jokes are not anchors for this purpose unless they have a documented history outside a single token's community.`;

export const ANCHOR_SYSTEM_PROMPT = `You are an analyst deciding whether a memecoin's meme has a real anchor or is being forced. You are skeptical by default: most new tokens are names attached to nothing. Search to verify; search for the thing the name refers to, not for the token.

${ANCHOR_RULES}

${UNTRUSTED_POLICY}`;

// ---------------------------------------------------------------------------
// shared shape
// ---------------------------------------------------------------------------

/** JSON schema for the `anchor` object, shared by both tools. */
export function anchorSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      verdict: { type: 'string', enum: [...VERDICTS] },
      type: { type: 'string', enum: [...TYPES] },
      subject: { type: 'string', description: 'What the token points at, in a few words. Empty if nothing.' },
      anchorDate: {
        type: 'string',
        description: 'When the anchor first existed: ISO date, or a bare year. Omit if unknown.',
      },
      earliestSource: {
        type: 'object',
        description: 'The earliest source found that is about the anchor and does not mention the token.',
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          date: { type: 'string' },
        },
        required: ['title'],
      },
      summary: { type: 'string', description: 'One or two sentences: what the anchor is, or why there is none.' },
      confidence: { type: 'string', enum: [...CONFIDENCE] },
    },
    required: ['verdict', 'type', 'subject', 'summary', 'confidence'],
  };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function text(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : undefined;
}

/** Never throws: anything out of contract degrades to `unclear`, low confidence. */
export function parseAnchor(input: unknown): Anchor {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const verdict = oneOf(raw.verdict, VERDICTS, 'unclear');
  const anchor: Anchor = {
    verdict,
    type: oneOf(raw.type, TYPES, 'none'),
    subject: text(raw.subject, 200) ?? '',
    summary: text(raw.summary, 600) ?? '',
    // A verdict the model did not commit to is not a confident one.
    confidence: raw.verdict === verdict ? oneOf(raw.confidence, CONFIDENCE, 'low') : 'low',
  };
  const anchorDate = text(raw.anchorDate, 40);
  if (anchorDate) anchor.anchorDate = anchorDate;
  const source = raw.earliestSource;
  if (typeof source === 'object' && source !== null) {
    const s = source as Record<string, unknown>;
    const title = text(s.title, 200);
    if (title) {
      const earliest: AnchorSource = { title };
      const url = text(s.url, 500);
      const date = text(s.date, 40);
      if (url) earliest.url = url;
      if (date) earliest.date = date;
      anchor.earliestSource = earliest;
    }
  }
  return anchor;
}

/**
 * Reads an anchor date at the precision it was given, and always at the END of
 * that period: "2013" is the last moment of 2013, "2024-03" the last of March,
 * "2024-03-05" the last of that day. The most lenient reading is the right
 * one for this test — a source dated only to a day or a month must not make a
 * same-day reaction look like it came after the launch.
 */
export function anchorTime(value: string): number | undefined {
  const trimmed = value.trim();
  const parts = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(trimmed);
  if (parts) {
    const year = Number(parts[1]);
    if (parts[2] === undefined) return Date.UTC(year + 1, 0, 1) - 1;
    const month = Number(parts[2]) - 1;
    if (parts[3] === undefined) return Date.UTC(year, month + 1, 1) - 1;
    return Date.UTC(year, month, Number(parts[3]) + 1) - 1;
  }
  // Anything else must carry its own time, or it is not comparable at all.
  if (!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(trimmed)) return undefined;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Applies the order-of-events test and the rules a model cannot be trusted to
 * apply to itself. Pure; used by both depths.
 *
 * - `precedesLaunch` is computed here from `anchorDate` (or the earliest
 *   source's date) and the pool creation time.
 * - An `anchored` verdict whose anchor is dated well after the launch is not
 *   an anchor for this token: it becomes `unclear`, and the summary says why.
 * - An `anchored` verdict with type `none`, or with no subject, contradicts
 *   itself and becomes `unclear`.
 * - `unclear` is never `high`: a confident "could not tell" is `medium`.
 * - `high` confidence needs at least one citation: a verdict nobody searched
 *   for is recall, and recall is how a model "knows" an anchor it made up.
 */
export function resolveAnchor(anchor: Anchor, launchedAt: string | undefined, citations: number): Anchor {
  const out: Anchor = { ...anchor };
  const notes: string[] = [];

  const dated = out.anchorDate ?? out.earliestSource?.date;
  const at = dated !== undefined ? anchorTime(dated) : undefined;
  const launch = launchedAt !== undefined ? Date.parse(launchedAt) : Number.NaN;
  if (at !== undefined && Number.isFinite(launch)) {
    out.precedesLaunch = at <= launch + LAUNCH_ORDER_SLACK_HOURS * 3_600_000;
    if (out.verdict === 'anchored' && !out.precedesLaunch) {
      out.verdict = 'unclear';
      notes.push(`The anchor is dated ${dated}, after the token launched; it cannot be what the token reacted to.`);
    }
  }

  if (out.verdict === 'anchored' && (out.type === 'none' || out.subject === '')) {
    out.verdict = 'unclear';
    notes.push('Marked anchored without naming an anchor.');
  }
  if (out.verdict !== 'anchored' && out.verdict !== 'forced' && out.confidence === 'high') out.confidence = 'medium';
  if (citations === 0 && out.confidence === 'high') out.confidence = 'medium';

  if (notes.length > 0) out.summary = [out.summary, ...notes].filter(Boolean).join(' ');
  return out;
}

/** The anchor block for a report that could not be researched. */
export function unresolvedAnchor(reason: string): Anchor {
  return { verdict: 'unclear', type: 'none', subject: '', summary: reason, confidence: 'low' };
}

// ---------------------------------------------------------------------------
// the fast check
// ---------------------------------------------------------------------------

export function buildAnchorPrompt(snapshot: TokenSnapshot): string {
  const rows = [`ticker: ${snapshot.symbol}`, `name: ${snapshot.name}`];
  if (snapshot.description) rows.push(`description: ${snapshot.description.slice(0, 600)}`);
  const launched = snapshot.metrics.poolCreatedAt;
  return [
    'Decide whether this token has a real anchor or is forced.',
    '',
    fence('token metadata, written by the deployer', rows.join('\n')),
    '',
    `The token's first pool opened at ${launched ?? 'an unknown time'} (measured, not claimed).`,
    '',
    '1. What does the name or ticker refer to, if anything, outside this token?',
    '2. Find the earliest source about that thing that does not mention the token, and note its date.',
    '3. If the only sources are the token\'s own promotion, say so plainly.',
    '',
    'Write short notes with what you found, where, and when. Say plainly if you found nothing.',
  ].join('\n');
}

export function buildAnchorExtractionPrompt(notes: string, citations: readonly string[]): string {
  return [
    'Record the verdict from these research notes by calling the tool. Do not add facts the notes do not contain.',
    '',
    fence('research notes from the previous pass', notes),
    '',
    citations.length > 0 ? `Sources consulted: ${citations.slice(0, 10).join(', ')}` : 'No sources were consulted.',
    '',
    'If the notes are uncertain, the verdict is unclear and the confidence is low.',
  ].join('\n');
}

export function anchorTool(): ToolSpec {
  return {
    name: ANCHOR_TOOL_NAME,
    description: 'Record whether the token has a real anchor or is forced.',
    schema: anchorSchema() as Record<string, unknown>,
  };
}

export interface AnchorOptions {
  /** Injected Anthropic `messages` client, used when the triage model is Anthropic's. */
  client?: Pick<Anthropic, 'messages'>;
  llm?: LlmClient;
  fetch?: CreateLlmOptions['fetch'];
  tracker?: CostTracker;
  maxWebSearches?: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WebSearchAnchorChecker implements AnchorChecker {
  private readonly llm: LlmClient;
  private readonly maxWebSearches: number;
  readonly tracker: CostTracker;

  constructor(
    private readonly app: AppConfig,
    private readonly logger: Logger,
    options: AnchorOptions = {},
  ) {
    this.llm =
      options.llm ?? createLlm(app, app.llm.triageModel, { anthropicClient: options.client, fetch: options.fetch });
    this.tracker = options.tracker ?? new CostTracker(app.llm.maxCostUsdPerRun, app.llm.pricing);
    this.maxWebSearches = options.maxWebSearches ?? app.launches.maxAnchorSearches;
  }

  async check(snapshot: TokenSnapshot, _ctx: ResearchContext): Promise<AnchorCheck> {
    const log = this.logger.child('anchor');
    const model = this.llm.model;
    const spentBefore = this.tracker.totalUsd;
    let inputTokens = 0;
    let outputTokens = 0;
    const onUsage: UsageSink = (name, usage, costUsd) => {
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      this.tracker.add(name, usage, costUsd);
    };
    const finish = (anchor: Anchor, citations: string[]): AnchorCheck => ({
      ...resolveAnchor(anchor, snapshot.metrics.poolCreatedAt, citations.length),
      model,
      checkedAt: nowIso(),
      citations,
      usage: { inputTokens, outputTokens, costUsd: Number((this.tracker.totalUsd - spentBefore).toFixed(6)) },
    });

    // ---- pass 1: search, prose only ------------------------------------------
    let notes = '';
    let citations: string[] = [];
    try {
      const found = await this.llm.search(
        {
          system: ANCHOR_SYSTEM_PROMPT,
          prompt: buildAnchorPrompt(snapshot),
          maxTokens: 1500,
          maxSearches: this.maxWebSearches,
        },
        onUsage,
      );
      if (found.searchError) log.warn('web search stopped', { tokenId: snapshot.tokenId, code: found.searchError });
      notes = found.texts.filter((part) => part.trim() !== '').join('\n\n');
      citations = [...new Set(found.citations)];
    } catch (error) {
      log.warn('anchor search failed', { tokenId: snapshot.tokenId, error: errorMessage(error) });
      return finish(unresolvedAnchor(`Anchor search failed: ${errorMessage(error)}`), []);
    }
    if (notes.trim() === '') return finish(unresolvedAnchor('The search pass produced no notes.'), citations);

    // ---- pass 2: structure the notes, no tools -------------------------------
    try {
      const { input } = await this.llm.callTool(
        {
          system: ANCHOR_SYSTEM_PROMPT,
          prompt: buildAnchorExtractionPrompt(notes, citations),
          tool: anchorTool(),
          maxTokens: 600,
          temperature: 0,
        },
        onUsage,
      );
      if (input === undefined) return finish(unresolvedAnchor('The model returned no verdict.'), citations);
      return finish(parseAnchor(input), citations);
    } catch (error) {
      log.warn('anchor extraction failed', { tokenId: snapshot.tokenId, error: errorMessage(error) });
      return finish(unresolvedAnchor(`Anchor extraction failed: ${errorMessage(error)}`), citations);
    }
  }
}

/**
 * Offline stand-in. It cannot know whether a meme is anchored, so it says so:
 * a lexicon hit is reported as an `anchored` guess at medium confidence,
 * labelled as unresearched, and anything else is `unclear`. Enough to demo
 * the lane end to end without pretending a fixture run researched anything.
 */
export class StubAnchorChecker implements AnchorChecker {
  constructor(private readonly app: AppConfig) {}

  async check(snapshot: TokenSnapshot): Promise<AnchorCheck> {
    const hits = classify(`${snapshot.symbol} ${snapshot.name}`);
    const top = hits.find((hit) => hit.archetype.key !== 'explicit_revival') ?? hits[0];
    const base = { model: `stub:${this.app.llm.triageModel}`, checkedAt: nowIso(), citations: [] };
    if (!top) {
      return {
        ...base,
        ...unresolvedAnchor('Offline stub: no lexicon archetype matched and nothing was searched.'),
      };
    }
    return {
      ...base,
      verdict: 'anchored',
      type: 'historical-meme',
      subject: top.archetype.label,
      summary: `Offline stub: lexicon match on ${top.matched.map((m) => `'${m}'`).join(', ')}; not researched.`,
      confidence: 'medium',
    };
  }
}

/** Real checker with a key and live data; the stub otherwise, never a throw. */
export function createAnchorChecker(app: AppConfig, logger: Logger, options: AnchorOptions = {}): AnchorChecker {
  if (app.pipeline.useFixtures) return new StubAnchorChecker(app);
  const { provider } = parseModelSpec(app.llm.triageModel);
  if (!providerApiKey(app, provider)) return new StubAnchorChecker(app);
  return new WebSearchAnchorChecker(app, logger, options);
}
