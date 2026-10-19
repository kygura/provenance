import { describe, expect, test } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import {
  loadConfig,
  nowIso,
  silentLogger,
  type AppConfig,
  type EvidenceItem,
  type ResearchContext,
  type TokenSnapshot,
} from '@provenance/core';
import { WebSearchAnalyst, citationsToEvidence, harvest, mergeEvidence, searchErrorCode } from './analyst';
import { CostTracker } from './cost';
import { PROMPT_VERSION, SPLIT_PROMPT_VERSION } from './prompt';
import { PROVENANCE_TOOL_NAME } from './schema';

// --- fixtures ---------------------------------------------------------------

// Pinned: these tests drive the Anthropic adapter, whatever the shipped default is.
const CLAUDE_ENV = { LLM_MODEL: 'claude-opus-5', LLM_EXTRACT_MODEL: 'claude-opus-5', LLM_TRIAGE_MODEL: 'claude-sonnet-5' };

function app(overrides: Partial<AppConfig['llm']> = {}): AppConfig {
  const base = loadConfig(CLAUDE_ENV);
  return { ...base, anthropicApiKey: 'sk-test', llm: { ...base.llm, ...overrides } };
}

const LAUNCH = '2026-09-01T12:00:00.000Z';

function snapshot(metrics: TokenSnapshot['metrics'] = {}): TokenSnapshot {
  return {
    tokenId: 'solana:abc',
    chain: 'solana',
    tokenAddress: 'abc',
    symbol: 'NYAN',
    name: 'Nyan Cat',
    socials: {},
    metrics: { liquidityUsd: 100_000, volume24hUsd: 400_000, poolCreatedAt: LAUNCH, ...metrics },
    pairs: [],
    appearances: [],
    bestRank: 1,
    sourceCount: 2,
    capturedAt: nowIso(),
  };
}

const ctx = { logger: silentLogger } as unknown as ResearchContext;

const USAGE = { input_tokens: 1000, output_tokens: 500 };

function textMessage(text: string, extra: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: USAGE,
    content: [{ type: 'text', text, citations: [] }],
    ...extra,
  } as unknown as Anthropic.Message;
}

/** A well-formed tool call the schema validator accepts without repairs. */
function goodDraft(): Record<string, unknown> {
  return {
    anchor: {
      verdict: 'anchored',
      type: 'historical-meme',
      subject: 'Nyan Cat animation',
      anchorDate: '2011-04-02',
      earliestSource: { title: 'Nyan Cat - YouTube', url: 'https://example.invalid/nyan', date: '2011-04-02' },
      summary: 'A 2011 animation that spread on YouTube.',
      confidence: 'high',
    },
    organic: {
      verdict: 'mixed',
      outsideTraction: 40,
      signals: [{ kind: 'media', organic: true, detail: 'Covered outside crypto.' }],
      rivals: [{ name: 'NYAN (Solana)', chain: 'solana' }],
      summary: 'Some outside coverage; a same-name rival splits the audience.',
    },
    memeName: 'Nyan Cat',
    narrativeCluster: 'cat',
    originYear: 2011,
    originSummary: 'A 2011 animation that spread on YouTube [E1].',
    lineage: [{ kind: 'origin', year: 2011, label: 'Nyan Cat published', note: 'YouTube, April 2011' }],
    priorCycles: [{ name: 'Nyan Cat NFT', year: 2021, outcome: 'faded' }],
    recycleVerdict: 'revival',
    recycleGeneration: 1,
    memeticDurability: 70,
    culturalReach: 75,
    authenticityScore: 55,
    speculativeSetup: 'A dormant meme returning in front of a newer cohort.',
    risks: ['Several tokens share the name.'],
    confidence: 0.8,
    evidence: [],
  };
}

function toolMessage(input: Record<string, unknown>): Anthropic.Message {
  return {
    id: 'msg_2',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: USAGE,
    content: [{ type: 'tool_use', id: 'tu_1', name: PROVENANCE_TOOL_NAME, input }],
  } as unknown as Anthropic.Message;
}

interface Recorded {
  stream: Anthropic.MessageCreateParams[];
  create: Anthropic.MessageCreateParams[];
}

/**
 * Stands in for `client.messages`. `streamQueue` feeds the research pass in
 * order (so a `pause_turn` can be followed by a finished turn) and
 * `createQueue` feeds the extraction pass.
 */
function fakeClient(
  streamQueue: (Anthropic.Message | Error)[],
  createQueue: (Anthropic.Message | Error)[],
): { client: Pick<Anthropic, 'messages'>; recorded: Recorded } {
  const recorded: Recorded = { stream: [], create: [] };
  const next = (queue: (Anthropic.Message | Error)[]): Anthropic.Message => {
    const item = queue.shift();
    if (item === undefined) throw new Error('fake client: queue exhausted');
    if (item instanceof Error) throw item;
    return item;
  };
  const messages = {
    stream(params: Anthropic.MessageCreateParams) {
      recorded.stream.push(params);
      const message = next(streamQueue);
      return { finalMessage: async () => message };
    },
    async create(params: Anthropic.MessageCreateParams) {
      recorded.create.push(params);
      return next(createQueue);
    },
  };
  return { client: { messages } as unknown as Pick<Anthropic, 'messages'>, recorded };
}

function analyst(
  streamQueue: (Anthropic.Message | Error)[],
  createQueue: (Anthropic.Message | Error)[],
  config = app(),
): { subject: WebSearchAnalyst; recorded: Recorded; tracker: CostTracker } {
  const { client, recorded } = fakeClient(streamQueue, createQueue);
  const tracker = new CostTracker(config.llm.maxCostUsdPerRun);
  return { subject: new WebSearchAnalyst(config, silentLogger, tracker, { client }), recorded, tracker };
}

// --- harvest ----------------------------------------------------------------

describe('harvest', () => {
  test('collects text, citations and search count', () => {
    const message = {
      content: [
        { type: 'text', text: 'Nyan Cat is from 2011.', citations: [{ url: 'https://a.invalid' }] },
        { type: 'web_search_tool_result', content: [{ url: 'https://b.invalid' }, { url: 'https://c.invalid' }] },
      ],
    } as unknown as Anthropic.Message;

    const found = harvest(message);
    expect(found.texts).toEqual(['Nyan Cat is from 2011.']);
    expect(found.citations).toEqual(['https://a.invalid', 'https://b.invalid', 'https://c.invalid']);
    expect(found.searches).toBe(1);
  });

  test('survives a search result that is an error object, not a list', () => {
    // A failed server tool arrives as a 200 with an error where the results
    // would be. Iterating it blindly throws on exactly the response that most
    // needs to be reported.
    const message = {
      content: [
        { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
        { type: 'text', text: 'partial notes', citations: [] },
      ],
    } as unknown as Anthropic.Message;

    expect(() => harvest(message)).not.toThrow();
    expect(harvest(message).texts).toEqual(['partial notes']);
    expect(searchErrorCode(message)).toBe('max_uses_exceeded');
  });

  test('reports no error code for a healthy response', () => {
    expect(searchErrorCode(textMessage('fine'))).toBeUndefined();
  });
});

// --- citations --------------------------------------------------------------

describe('citationsToEvidence', () => {
  test('dedupes and titles rows by hostname', () => {
    const items = citationsToEvidence(
      ['https://www.knowyourmeme.com/a', 'https://www.knowyourmeme.com/a', 'https://en.wikipedia.org/b'],
      nowIso(),
    );
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.title)).toEqual(['knowyourmeme.com', 'en.wikipedia.org']);
    expect(items.every((item) => item.kind === 'web')).toBe(true);
  });

  test('keeps a malformed URL rather than dropping the source', () => {
    const items = citationsToEvidence(['not a url'], nowIso());
    expect(items).toHaveLength(1);
    expect(items[0]?.url).toBe('not a url');
  });
});

describe('mergeEvidence', () => {
  test('dedupes on url and keeps collected rows first', () => {
    const at = nowIso();
    const collected: EvidenceItem[] = [
      { kind: 'onchain', title: 'chain', snippet: 's', retrievedAt: at, sourceQuality: 0.9 },
      { kind: 'web', url: 'https://a.invalid', title: 'a', snippet: 's', retrievedAt: at, sourceQuality: 0.5 },
    ];
    const fromModel: EvidenceItem[] = [
      { kind: 'web', url: 'https://a.invalid', title: 'dup', snippet: 's', retrievedAt: at, sourceQuality: 0.5 },
      { kind: 'model-knowledge', title: 'recall', snippet: 's', retrievedAt: at, sourceQuality: 0.3 },
    ];
    const merged = mergeEvidence(fromModel, collected);
    expect(merged).toHaveLength(3);
    expect(merged[0]?.kind).toBe('onchain');
    expect(merged.filter((item) => item.url === 'https://a.invalid')).toHaveLength(1);
  });
});

// --- the two-phase run ------------------------------------------------------

/** A research turn that consulted one source. */
function citedMessage(): Anthropic.Message {
  return {
    ...textMessage('notes'),
    content: [
      { type: 'text', text: 'notes', citations: [] },
      { type: 'web_search_tool_result', content: [{ url: 'https://knowyourmeme.com/nyan' }] },
    ],
  } as unknown as Anthropic.Message;
}

describe('WebSearchAnalyst', () => {
  test('researches first with the search tool, then extracts with a forced tool call', async () => {
    const { subject, recorded } = analyst([textMessage('Nyan Cat dates to 2011.')], [toolMessage(goodDraft())]);

    const report = await subject.research(snapshot(), undefined, [], ctx);

    expect(recorded.stream).toHaveLength(1);
    expect(recorded.create).toHaveLength(1);

    const research = recorded.stream[0] as Anthropic.MessageCreateParams;
    expect(research.tools?.[0]).toMatchObject({ type: 'web_search_20260209', name: 'web_search' });
    expect(research.tool_choice).toBeUndefined();

    const extraction = recorded.create[0] as Anthropic.MessageCreateParams;
    expect(extraction.tool_choice).toEqual({ type: 'tool', name: PROVENANCE_TOOL_NAME });
    expect(JSON.stringify(extraction.messages)).toContain('Nyan Cat dates to 2011.');

    expect(report.memeName).toBe('Nyan Cat');
    expect(report.recycleVerdict).toBe('revival');
    expect(report.originYear).toBe(2011);
  });

  test('leads with an anchor whose launch order is computed from the snapshot', async () => {
    // The model claims the anchor came after the launch; the dates say otherwise.
    const draft = { ...goodDraft(), anchor: { ...(goodDraft().anchor as object), precedesLaunch: false } };
    const { subject } = analyst([citedMessage()], [toolMessage(draft)]);
    const report = await subject.research(snapshot(), undefined, [], ctx);

    expect(report.anchor?.verdict).toBe('anchored');
    expect(report.anchor?.precedesLaunch).toBe(true);
    expect(report.anchor?.confidence).toBe('high');
    expect(report.anchor?.earliestSource?.date).toBe('2011-04-02');
  });

  test('an anchor dated after the pool opened is not an anchor for this token', async () => {
    const late = { ...goodDraft(), anchor: { ...(goodDraft().anchor as object), anchorDate: '2026-09-10' } };
    const { subject } = analyst([citedMessage()], [toolMessage(late)]);
    const report = await subject.research(snapshot(), undefined, [], ctx);

    expect(report.anchor?.precedesLaunch).toBe(false);
    expect(report.anchor?.verdict).toBe('unclear');

    // Same draft, pool opened later: now the anchor precedes it.
    const again = analyst([citedMessage()], [toolMessage(late)]);
    const later = await again.subject.research(snapshot({ poolCreatedAt: '2026-09-20T00:00:00.000Z' }), undefined, [], ctx);
    expect(later.anchor?.precedesLaunch).toBe(true);
    expect(later.anchor?.verdict).toBe('anchored');
  });

  test('an unknown launch time leaves precedesLaunch undefined', async () => {
    const { subject } = analyst([citedMessage()], [toolMessage(goodDraft())]);
    const report = await subject.research(snapshot({ poolCreatedAt: undefined }), undefined, [], ctx);
    expect(report.anchor?.precedesLaunch).toBeUndefined();
    expect(report.anchor?.verdict).toBe('anchored');
  });

  test('a high-confidence anchor with no citations drops to medium', async () => {
    const { subject } = analyst([textMessage('notes')], [toolMessage(goodDraft())]);
    const report = await subject.research(snapshot(), undefined, [], ctx);
    expect(report.anchor?.confidence).toBe('medium');
  });

  test('a report with no anchor is repaired to unclear, not rejected', async () => {
    const { anchor: _dropped, ...noAnchor } = goodDraft();
    const { subject } = analyst([citedMessage()], [toolMessage(noAnchor)]);
    const report = await subject.research(snapshot(), undefined, [], ctx);
    expect(report.memeName).toBe('Nyan Cat');
    expect(report.anchor?.verdict).toBe('unclear');
    expect(report.anchor?.confidence).toBe('low');
    expect(report.confidence).toBeLessThanOrEqual(0.45);
  });

  test('caches the system prompt on both calls', () => {
    const { subject, recorded } = analyst([textMessage('notes')], [toolMessage(goodDraft())]);
    return subject.research(snapshot(), undefined, [], ctx).then(() => {
      for (const params of [...recorded.stream, ...recorded.create]) {
        expect(params.system?.[0]).toMatchObject({ cache_control: { type: 'ephemeral' } });
      }
    });
  });

  test('honours the configured web-search ceiling', async () => {
    const { subject, recorded } = analyst(
      [textMessage('notes')],
      [toolMessage(goodDraft())],
      app({ maxWebSearches: 2 }),
    );
    await subject.research(snapshot(), undefined, [], ctx);
    expect((recorded.stream[0]?.tools?.[0] as { max_uses?: number }).max_uses).toBe(2);
  });

  test('resumes a paused research turn and keeps the earlier notes', async () => {
    const paused = textMessage('first half.', { stop_reason: 'pause_turn' } as Partial<Anthropic.Message>);
    const { subject, recorded } = analyst([paused, textMessage('second half.')], [toolMessage(goodDraft())]);

    await subject.research(snapshot(), undefined, [], ctx);

    expect(recorded.stream).toHaveLength(2);
    // The resume hands the paused assistant turn straight back.
    expect((recorded.stream[1]?.messages ?? []).at(-1)?.role).toBe('assistant');
    const sentToExtraction = JSON.stringify(recorded.create[0]?.messages);
    expect(sentToExtraction).toContain('first half.');
    expect(sentToExtraction).toContain('second half.');
  });

  test('citations from the search pass land on the report as evidence', async () => {
    const withCitation = {
      ...textMessage('notes'),
      content: [
        { type: 'text', text: 'notes', citations: [] },
        { type: 'web_search_tool_result', content: [{ url: 'https://knowyourmeme.com/nyan' }] },
      ],
    } as unknown as Anthropic.Message;

    const { subject } = analyst([withCitation], [toolMessage(goodDraft())]);
    const report = await subject.research(snapshot(), undefined, [], ctx);

    expect(report.evidence.some((item) => item.url === 'https://knowyourmeme.com/nyan')).toBe(true);
  });

  test('an ungrounded report is discounted; a cited one is not', async () => {
    const cited = {
      ...textMessage('notes'),
      content: [
        { type: 'text', text: 'notes', citations: [] },
        { type: 'web_search_tool_result', content: [{ url: 'https://knowyourmeme.com/nyan' }] },
      ],
    } as unknown as Anthropic.Message;

    const grounded = await analyst([cited], [toolMessage(goodDraft())]).subject.research(
      snapshot(),
      undefined,
      [],
      ctx,
    );
    const ungrounded = await analyst([textMessage('notes')], [toolMessage(goodDraft())]).subject.research(
      snapshot(),
      undefined,
      [],
      ctx,
    );

    expect(grounded.confidence).toBeCloseTo(0.8, 5);
    expect(ungrounded.confidence).toBeCloseTo(0.56, 5);
    expect(ungrounded.confidence).toBeLessThan(grounded.confidence);
  });

  test('degrades rather than throwing when the research pass fails', async () => {
    const { subject, recorded } = analyst([new Error('503 upstream')], []);
    const report = await subject.research(snapshot(), undefined, [], ctx);

    expect(recorded.create).toHaveLength(0);
    expect(report.recycleVerdict).toBe('unclear');
    expect(report.confidence).toBeLessThanOrEqual(0.2);
    expect(report.risks.join(' ')).toContain('503 upstream');
    expect(report.anchor).toMatchObject({ verdict: 'unclear', type: 'none', confidence: 'low' });
    expect(report.anchor?.summary).toContain('503 upstream');
  });

  test('degrades when the research pass produces no notes at all', async () => {
    const empty = { ...textMessage(''), content: [] } as unknown as Anthropic.Message;
    const { subject, recorded } = analyst([empty], []);
    const report = await subject.research(snapshot(), undefined, [], ctx);

    expect(recorded.create).toHaveLength(0);
    expect(report.recycleVerdict).toBe('unclear');
  });

  test('retries extraction once, then degrades', async () => {
    const { subject, recorded } = analyst(
      [textMessage('notes')],
      [textMessage('I would rather explain in prose.'), textMessage('still prose.')],
    );
    const report = await subject.research(snapshot(), undefined, [], ctx);

    expect(recorded.create).toHaveLength(2);
    expect(report.recycleVerdict).toBe('unclear');
    expect(report.anchor?.verdict).toBe('unclear');
  });

  test('a second extraction attempt can still succeed', async () => {
    const { subject } = analyst(
      [textMessage('notes')],
      [new Error('overloaded'), toolMessage(goodDraft())],
    );
    const report = await subject.research(snapshot(), undefined, [], ctx);
    expect(report.recycleVerdict).toBe('revival');
  });

  test('both calls are billed to the cost tracker', async () => {
    const { subject, tracker } = analyst([textMessage('notes')], [toolMessage(goodDraft())]);
    await subject.research(snapshot(), undefined, [], ctx);

    expect(tracker.callCount).toBe(2);
    expect(tracker.totalUsd).toBeGreaterThan(0);
  });
});

describe('gather/judge split', () => {
  const splitConfig = () => app({ searchModel: 'claude-sonnet-5', extractModel: 'claude-sonnet-5' });

  test('the search model gathers without deciding; the main model judges', async () => {
    const { subject, recorded } = analyst(
      [textMessage('2011-04-02 Nyan Cat on YouTube, https://example.invalid/nyan')],
      [toolMessage(goodDraft())],
      splitConfig(),
    );

    const report = await subject.research(snapshot(), undefined, [], ctx);

    const gather = recorded.stream[0] as Anthropic.MessageCreateParams;
    expect(gather.model).toBe('claude-sonnet-5');
    expect(JSON.stringify(gather.messages)).toContain('gather evidence, in prose. Do not decide.');

    // The judge is `model`, not `extractModel`: the split replaces extraction.
    const judge = recorded.create[0] as Anthropic.MessageCreateParams;
    expect(judge.model).toBe('claude-opus-5');
    expect(judge.tool_choice).toEqual({ type: 'tool', name: PROVENANCE_TOOL_NAME });
    const judgeText = JSON.stringify(judge.messages);
    expect(judgeText).toContain('judge, then structure');
    expect(judgeText).toContain('2011-04-02 Nyan Cat on YouTube');

    expect(report.promptVersion).toBe(SPLIT_PROMPT_VERSION);
    expect(report.model).toBe('claude-sonnet-5+claude-opus-5');
    expect(report.anchor?.verdict).toBe('anchored');
  });

  test('a degraded split report is still labelled as a split report', async () => {
    const { subject } = analyst([new Error('overloaded')], [], splitConfig());
    const report = await subject.research(snapshot(), undefined, [], ctx);
    expect(report.anchor?.failed).toContain('overloaded');
    expect(report.promptVersion).toBe(SPLIT_PROMPT_VERSION);
  });

  test('a search model equal to the main model keeps the single-researcher flow', async () => {
    const { subject, recorded } = analyst(
      [textMessage('notes')],
      [toolMessage(goodDraft())],
      app({ searchModel: 'claude-opus-5' }),
    );
    const report = await subject.research(snapshot(), undefined, [], ctx);
    expect(JSON.stringify(recorded.stream[0]?.messages)).toContain('research, in prose');
    expect(report.promptVersion).toBe(PROMPT_VERSION);
  });
});

// --- cost accounting ----------------------------------------------------------

describe('per-report cost', () => {
  test('each report carries its own spend, not the run total', async () => {
    // The pipeline sums `usage.costUsd` across reports against the run budget,
    // so a cumulative figure here would count every earlier token again.
    const { subject, tracker } = analyst(
      [textMessage('notes one'), textMessage('notes two')],
      [toolMessage(goodDraft()), toolMessage(goodDraft())],
    );
    const first = await subject.research(snapshot(), undefined, [], ctx);
    const second = await subject.research(snapshot(), undefined, [], ctx);
    expect(first.usage?.costUsd).toBeGreaterThan(0);
    expect(second.usage?.costUsd).toBe(first.usage?.costUsd);
    expect((first.usage?.costUsd ?? 0) + (second.usage?.costUsd ?? 0)).toBeCloseTo(tracker.totalUsd, 6);
  });
});
