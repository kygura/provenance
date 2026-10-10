import { describe, expect, test } from 'bun:test';
import { loadConfig, nowIso, silentLogger, type AppConfig, type TokenSnapshot } from '@provenance/core';
import { WebSearchAnalyst } from '../analyst';
import { CostTracker } from '../cost';
import { PROVENANCE_TOOL_NAME } from '../schema';
import { ExaSearch, parseExaArgs } from './exa';
import { createLlm } from './index';
import { OpenAiLlm, chatUsage, toolInput, urlsIn, type FetchLike } from './openai';
import { parseModelSpec } from './spec';
import type { LlmClient, SearchResult, ToolCallResult } from './types';

// --- helpers -----------------------------------------------------------------

interface Call {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/** A fetch that answers from a queue and records every request body. */
function fakeFetch(queue: Array<{ status?: number; body: unknown }>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
      headers: init.headers as Record<string, string>,
    });
    const next = queue.shift();
    if (!next) throw new Error('fake fetch: queue exhausted');
    const status = next.status ?? 200;
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status });
  };
  return { fetch, calls };
}

const noUsage = () => {};
const SEARCH = { system: 'sys', prompt: 'research NYAN', maxTokens: 1000, maxSearches: 2 };
const TOOL = {
  system: 'sys',
  prompt: 'extract',
  tool: { name: 'record', description: 'd', schema: { type: 'object', properties: {} } },
  maxTokens: 500,
  temperature: 0.2,
};

function chat(message: Record<string, unknown>, usage: Record<string, unknown> = {}, finish = 'stop') {
  return { body: { choices: [{ message: { role: 'assistant', ...message }, finish_reason: finish }], usage } };
}

// --- spec --------------------------------------------------------------------

describe('parseModelSpec', () => {
  test('explicit prefixes win', () => {
    expect(parseModelSpec('openai:gpt-5.4-mini')).toEqual({ provider: 'openai', model: 'gpt-5.4-mini' });
    expect(parseModelSpec('openrouter:moonshotai/kimi-k2:free')).toEqual({
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2:free',
    });
    expect(parseModelSpec('openai-compatible:llama-4')).toEqual({ provider: 'openai-compatible', model: 'llama-4' });
  });

  test('bare ids are inferred, defaulting to anthropic', () => {
    expect(parseModelSpec('claude-opus-5').provider).toBe('anthropic');
    expect(parseModelSpec('gpt-5.4-mini').provider).toBe('openai');
    expect(parseModelSpec('kimi-k2-0905-preview').provider).toBe('moonshot');
    expect(parseModelSpec('deepseek-chat').provider).toBe('deepseek');
    expect(parseModelSpec('qwen3.7-plus').provider).toBe('qwen');
    expect(parseModelSpec('moonshotai/kimi-k2').provider).toBe('openrouter');
    expect(parseModelSpec('something-new').provider).toBe('anthropic');
  });
});

describe('config', () => {
  test('LLM_PRICING parses and skips malformed entries', () => {
    const app = loadConfig({ LLM_PRICING: 'gpt-5.4-mini=0.75/4.5, broken, kimi-k2=0.6/2.5' });
    expect(app.llm.pricing).toEqual({
      'gpt-5.4-mini': { inputPerMTok: 0.75, outputPerMTok: 4.5 },
      'kimi-k2': { inputPerMTok: 0.6, outputPerMTok: 2.5 },
    });
  });

  test('extract model defaults to the research model; KIMI_API_KEY is an alias', () => {
    const app = loadConfig({ LLM_MODEL: 'openai:gpt-5.4', KIMI_API_KEY: 'k' });
    expect(app.llm.extractModel).toBe('openai:gpt-5.4');
    expect(app.llm.providers.moonshot.apiKey).toBe('k');
  });

  test('createLlm refuses a provider without its key', () => {
    expect(() => createLlm(loadConfig({}), 'openai:gpt-5.4')).toThrow('OPENAI_API_KEY');
  });
});

// --- usage and parsing -------------------------------------------------------

describe('chatUsage', () => {
  test('splits cached tokens out of prompt_tokens, per provider field', () => {
    expect(chatUsage({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 40 } }).usage)
      .toEqual({ inputTokens: 60, outputTokens: 10, cacheReadTokens: 40, cacheWriteTokens: 0 });
    expect(chatUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 30 }).usage.cacheReadTokens).toBe(30);
    expect(chatUsage({ prompt_tokens: 100, cached_tokens: 20 }).usage.inputTokens).toBe(80);
  });

  test('passes through a billed cost', () => {
    expect(chatUsage({ prompt_tokens: 1, cost: 0.0042 }).costUsd).toBe(0.0042);
    expect(chatUsage({ prompt_tokens: 1 }).costUsd).toBeUndefined();
  });
});

describe('toolInput', () => {
  test('reads function arguments', () => {
    const message = { role: 'assistant', tool_calls: [{ id: '1', function: { name: 'record', arguments: '{"a":1}' } }] };
    expect(toolInput(message, 'record')).toEqual({ a: 1 });
  });

  test('falls back to JSON in content, fenced or bare', () => {
    expect(toolInput({ role: 'assistant', content: 'Here:\n```json\n{"a":2}\n```' }, 'record')).toEqual({ a: 2 });
    expect(toolInput({ role: 'assistant', content: 'result {"a":3} done' }, 'record')).toEqual({ a: 3 });
    expect(toolInput({ role: 'assistant', content: 'no json here' }, 'record')).toBeUndefined();
  });
});

test('urlsIn trims trailing punctuation', () => {
  expect(urlsIn('See https://a.invalid/x. And (https://b.invalid/y), ok')).toEqual([
    'https://a.invalid/x',
    'https://b.invalid/y',
  ]);
});

// --- providers ---------------------------------------------------------------

describe('openai', () => {
  test('search uses the Responses API and reads url_citation annotations', async () => {
    const { fetch, calls } = fakeFetch([
      {
        body: {
          output: [
            { type: 'web_search_call' },
            { type: 'web_search_call' },
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: 'Nyan Cat dates to 2011.',
                  annotations: [{ type: 'url_citation', url: 'https://kym.invalid/nyan' }],
                },
              ],
            },
          ],
          usage: { input_tokens: 500, output_tokens: 50, input_tokens_details: { cached_tokens: 100 } },
        },
      },
    ]);
    const usages: unknown[] = [];
    const llm = new OpenAiLlm('openai', 'gpt-5.4', { apiKey: 'k', fetch });
    const found = await llm.search(SEARCH, (_m, usage) => usages.push(usage));

    expect(calls[0]?.url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0]?.body.tools).toEqual([{ type: 'web_search' }]);
    expect(calls[0]?.body.max_tool_calls).toBe(2);
    expect(found).toEqual({ texts: ['Nyan Cat dates to 2011.'], citations: ['https://kym.invalid/nyan'], searches: 2 });
    expect(usages[0]).toEqual({ inputTokens: 400, outputTokens: 50, cacheReadTokens: 100, cacheWriteTokens: 0 });
  });

  test('extraction forces the function and uses reasoning-model params', async () => {
    const { fetch, calls } = fakeFetch([
      chat({ tool_calls: [{ id: '1', function: { name: 'record', arguments: '{"ok":true}' } }] }),
    ]);
    const llm = new OpenAiLlm('openai', 'gpt-5.4-mini', { apiKey: 'k', fetch });
    const result = await llm.callTool(TOOL, noUsage);

    expect(result.input).toEqual({ ok: true });
    expect(calls[0]?.body.tool_choice).toEqual({ type: 'function', function: { name: 'record' } });
    expect(calls[0]?.body.max_completion_tokens).toBe(500);
    expect(calls[0]?.body).not.toHaveProperty('temperature');
    expect(calls[0]?.headers.authorization).toBe('Bearer k');
  });

  test('retries a 429 and gives up at once on a 400', async () => {
    const retried = fakeFetch([{ status: 429, body: 'slow down' }, chat({ content: 'fine' })]);
    const llm = new OpenAiLlm('deepseek', 'deepseek-chat', { apiKey: 'k', fetch: retried.fetch, retries: 2 });
    await llm.search(SEARCH, noUsage);
    expect(retried.calls).toHaveLength(2);

    const rejected = fakeFetch([{ status: 400, body: 'bad model' }, chat({ content: 'never' })]);
    const strict = new OpenAiLlm('deepseek', 'deepseek-chat', { apiKey: 'k', fetch: rejected.fetch, retries: 3 });
    await expect(strict.search(SEARCH, noUsage)).rejects.toThrow('HTTP 400');
    expect(rejected.calls).toHaveLength(1);
  });
});

describe('openrouter', () => {
  test('search uses the web plugin and reports billed cost', async () => {
    const { fetch, calls } = fakeFetch([
      chat(
        {
          content: 'Found it.',
          annotations: [{ type: 'url_citation', url_citation: { url: 'https://src.invalid/a' } }],
        },
        { prompt_tokens: 200, completion_tokens: 20, cost: 0.0011 },
      ),
    ]);
    const costs: Array<number | undefined> = [];
    const llm = new OpenAiLlm('openrouter', 'moonshotai/kimi-k2', { apiKey: 'k', fetch });
    const found = await llm.search(SEARCH, (_m, _u, cost) => costs.push(cost));

    expect(calls[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(calls[0]?.body.plugins).toEqual([{ id: 'web', max_results: 2 }]);
    expect(calls[0]?.body.usage).toEqual({ include: true });
    expect(found.citations).toEqual(['https://src.invalid/a']);
    expect(costs).toEqual([0.0011]);
  });
});

describe('reasoning effort', () => {
  test('is sent in each dialect that has it and nowhere else', async () => {
    const reply = () => chat({ tool_calls: [{ id: '1', function: { name: 'record', arguments: '{}' } }] });
    const request = { ...TOOL, reasoningEffort: 'low' as const };

    const openai = fakeFetch([reply()]);
    await new OpenAiLlm('openai', 'gpt-5.6-luna', { apiKey: 'k', fetch: openai.fetch }).callTool(request, noUsage);
    expect(openai.calls[0]?.body.reasoning_effort).toBe('low');

    const router = fakeFetch([reply()]);
    await new OpenAiLlm('openrouter', 'openai/gpt-5.6-luna', { apiKey: 'k', fetch: router.fetch }).callTool(
      request,
      noUsage,
    );
    expect(router.calls[0]?.body.reasoning).toEqual({ effort: 'low' });

    const qwen = fakeFetch([reply()]);
    await new OpenAiLlm('qwen', 'qwen3.8-flash', { apiKey: 'k', fetch: qwen.fetch }).callTool(request, noUsage);
    expect(qwen.calls[0]?.body).not.toHaveProperty('reasoning');
    expect(qwen.calls[0]?.body).not.toHaveProperty('reasoning_effort');
  });
});

describe('reasoning models that spend the budget thinking', () => {
  test('an empty answer is retried once with twice the budget and low effort', async () => {
    const { fetch, calls } = fakeFetch([
      chat({ content: '', reasoning: 'thinking...' }, {}, 'length'),
      chat({ content: 'Nyan Cat, 2011.', annotations: [{ type: 'url_citation', url_citation: { url: 'https://a.invalid' } }] }),
    ]);
    const llm = new OpenAiLlm('openrouter', 'moonshotai/kimi-k2.6', { apiKey: 'k', fetch });
    const found = await llm.search(SEARCH, noUsage);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.body.max_tokens).toBe(1000);
    expect(calls[1]?.body.max_tokens).toBe(2000);
    expect(calls[1]?.body.reasoning).toEqual({ effort: 'low' });
    expect(found.texts).toEqual(['Nyan Cat, 2011.']);
    expect(found.citations).toEqual(['https://a.invalid']);
  });

  test('when the retry is empty too, the visible reasoning stands in for the notes', async () => {
    const { fetch } = fakeFetch([
      chat({ content: null, reasoning: 'first' }, {}, 'length'),
      chat({ content: '  ', reasoning: 'Searched: Nyan Cat is a 2011 animation.' }, {}, 'length'),
    ]);
    const llm = new OpenAiLlm('openrouter', 'moonshotai/kimi-k2.6', { apiKey: 'k', fetch });
    expect((await llm.search(SEARCH, noUsage)).texts).toEqual(['Searched: Nyan Cat is a 2011 animation.']);
  });

  test('a non-empty answer is not retried', async () => {
    const { fetch, calls } = fakeFetch([chat({ content: 'done' })]);
    await new OpenAiLlm('openrouter', 'x/y', { apiKey: 'k', fetch }).search(SEARCH, noUsage);
    expect(calls).toHaveLength(1);
  });
});

describe('moonshot', () => {
  test('echoes $web_search arguments back and stops offering search at the cap', async () => {
    const searchCall = (id: string) => ({
      tool_calls: [{ id, type: 'builtin_function', function: { name: '$web_search', arguments: '{"q":"nyan"}' } }],
    });
    const { fetch, calls } = fakeFetch([
      chat(searchCall('a'), {}, 'tool_calls'),
      chat(searchCall('b'), {}, 'tool_calls'),
      chat({ content: 'Origin 2011, see https://kym.invalid/nyan.' }),
    ]);
    const llm = new OpenAiLlm('moonshot', 'kimi-k2-0905-preview', { apiKey: 'k', fetch });
    const found = await llm.search(SEARCH, noUsage);

    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toBe('https://api.moonshot.ai/v1/chat/completions');
    const echoed = (calls[1]?.body.messages as Array<Record<string, unknown>>).at(-1);
    expect(echoed).toEqual({ role: 'tool', tool_call_id: 'a', name: '$web_search', content: '{"q":"nyan"}' });
    // Two searches used, so the last round is offered no tools and must write.
    expect(calls[2]?.body).not.toHaveProperty('tools');
    expect(found.searches).toBe(2);
    expect(found.citations).toEqual(['https://kym.invalid/nyan']);
  });

  test('extraction asks for the function instead of forcing it', async () => {
    const { fetch, calls } = fakeFetch([chat({ content: '```json\n{"ok":1}\n```' })]);
    const llm = new OpenAiLlm('moonshot', 'kimi-k2', { apiKey: 'k', fetch });
    expect((await llm.callTool(TOOL, noUsage)).input).toEqual({ ok: 1 });
    expect(calls[0]?.body.tool_choice).toBe('auto');
    // Kimi fixes temperature per mode and rejects any value sent.
    expect(calls[0]?.body.temperature).toBeUndefined();
  });
});

describe('qwen', () => {
  test('search goes to the native DashScope endpoint and reads search_info sources', async () => {
    const { fetch, calls } = fakeFetch([
      {
        body: {
          output: {
            choices: [{ message: { content: 'Nyan Cat, 2011.' } }],
            search_info: { search_results: [{ index: 1, title: 'KYM', url: 'https://kym.invalid/nyan' }, { index: 2 }] },
          },
          usage: { input_tokens: 900, output_tokens: 80, prompt_tokens_details: { cached_tokens: 300 } },
        },
      },
    ]);
    const usages: unknown[] = [];
    const llm = new OpenAiLlm('qwen', 'qwen3.7-plus', { apiKey: 'k', fetch });
    const found = await llm.search(SEARCH, (_m, usage) => usages.push(usage));

    expect(calls[0]?.url).toBe(
      'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/text-generation/generation',
    );
    const parameters = calls[0]?.body.parameters as Record<string, unknown>;
    expect(parameters.enable_search).toBe(true);
    expect(parameters.search_options).toEqual({ forced_search: true, enable_source: true });
    expect(found).toEqual({ texts: ['Nyan Cat, 2011.'], citations: ['https://kym.invalid/nyan'], searches: 1 });
    expect(usages[0]).toEqual({ inputTokens: 600, outputTokens: 80, cacheReadTokens: 300, cacheWriteTokens: 0 });
  });

  test('extraction uses the compatible endpoint', async () => {
    const { fetch, calls } = fakeFetch([
      chat({ tool_calls: [{ id: '1', function: { name: 'record', arguments: '{"ok":true}' } }] }),
    ]);
    const llm = new OpenAiLlm('qwen', 'qwen3.8-flash', { apiKey: 'k', fetch });
    expect((await llm.callTool(TOOL, noUsage)).input).toEqual({ ok: true });
    expect(calls[0]?.url).toBe('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions');
  });
});

describe('deepseek', () => {
  test('has no search: says so in the system prompt and cites nothing', async () => {
    const { fetch, calls } = fakeFetch([chat({ content: 'Probably 2011, per https://recalled.invalid' })]);
    const llm = new OpenAiLlm('deepseek', 'deepseek-chat', { apiKey: 'k', fetch });
    expect(llm.canSearch).toBe(false);
    const found = await llm.search(SEARCH, noUsage);

    const system = (calls[0]?.body.messages as Array<{ content: string }>)[0]?.content;
    expect(system).toContain('Web search is not available');
    expect(found).toEqual({ texts: ['Probably 2011, per https://recalled.invalid'], citations: [], searches: 0 });
  });
});

// --- cost --------------------------------------------------------------------

describe('CostTracker', () => {
  test('a billed cost beats the table; overrides price unknown models', () => {
    const tracker = new CostTracker(1, { 'kimi-k2': { inputPerMTok: 1, outputPerMTok: 2 } });
    expect(tracker.add('anything', { inputTokens: 10, outputTokens: 10 }, 0.25)).toBe(0.25);
    expect(tracker.add('kimi-k2', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(3);
    expect(tracker.add('unknown-model', { inputTokens: 1, outputTokens: 1 })).toBe(0);
    expect(tracker.history().at(-1)?.unpriced).toBe(true);
  });
});

// --- analyst across providers ------------------------------------------------

function goodDraft(): Record<string, unknown> {
  return {
    anchor: {
      verdict: 'anchored',
      type: 'historical-meme',
      subject: 'Nyan Cat animation',
      anchorDate: '2011-04-02',
      summary: 'A 2011 animation.',
      confidence: 'high',
    },
    memeName: 'Nyan Cat',
    narrativeCluster: 'cat',
    originYear: 2011,
    originSummary: 'A 2011 animation [E1].',
    lineage: [{ kind: 'origin', year: 2011, label: 'Nyan Cat published' }],
    priorCycles: [],
    recycleVerdict: 'revival',
    recycleGeneration: 1,
    memeticDurability: 70,
    culturalReach: 75,
    authenticityScore: 55,
    speculativeSetup: 'A dormant meme returning.',
    risks: [],
    confidence: 0.8,
    evidence: [],
  };
}

function scripted(model: string, found: SearchResult | undefined, extracted: ToolCallResult | undefined): LlmClient & {
  searched: number;
  called: number;
} {
  return {
    provider: 'openrouter',
    model,
    canSearch: true,
    searched: 0,
    called: 0,
    async search(_request, onUsage) {
      this.searched += 1;
      onUsage(model, { inputTokens: 100, outputTokens: 10 }, 0.01);
      if (!found) throw new Error('search not expected');
      return found;
    },
    async callTool(request, onUsage) {
      this.called += 1;
      expect(request.tool.name).toBe(PROVENANCE_TOOL_NAME);
      onUsage(model, { inputTokens: 100, outputTokens: 10 }, 0.002);
      if (!extracted) throw new Error('extraction not expected');
      return extracted;
    },
  };
}

test('the analyst can research on one model and extract on a cheaper one', async () => {
  const app: AppConfig = loadConfig({});
  const researcher = scripted('moonshotai/kimi-k2', { texts: ['notes'], citations: ['https://a.invalid'], searches: 1 }, undefined);
  const extractor = scripted('deepseek/deepseek-chat', undefined, {
    input: goodDraft(),
    usage: { inputTokens: 100, outputTokens: 10 },
  });
  const tracker = new CostTracker(5);
  const analyst = new WebSearchAnalyst(app, silentLogger, tracker, { researchLlm: researcher, extractLlm: extractor });
  const snapshot: TokenSnapshot = {
    tokenId: 'solana:abc',
    chain: 'solana',
    tokenAddress: 'abc',
    symbol: 'NYAN',
    name: 'Nyan Cat',
    socials: {},
    metrics: { poolCreatedAt: '2026-09-01T12:00:00.000Z' },
    pairs: [],
    appearances: [],
    bestRank: 1,
    sourceCount: 1,
    capturedAt: nowIso(),
  };
  const report = await analyst.research(snapshot, undefined, [], { runId: 'r' } as never);

  expect(researcher.searched).toBe(1);
  expect(researcher.called).toBe(0);
  expect(extractor.called).toBe(1);
  expect(report.model).toBe('moonshotai/kimi-k2+deepseek/deepseek-chat');
  expect(report.memeName).toBe('Nyan Cat');
  expect(report.usage?.costUsd).toBeCloseTo(0.012, 6);
});

// --- exa -----------------------------------------------------------------------

describe('exa search', () => {
  const exaReply = (urls: string[], cost = 0.005) => ({
    body: {
      results: urls.map((url, i) => ({ url, title: `page ${i}`, publishedDate: '2011-04-05T00:00:00.000Z', text: 'Nyan  Cat\nfirst seen' })),
      costDollars: { total: cost },
    },
  });
  const searchCall = (id: string, args: string) => ({
    tool_calls: [{ id, type: 'function', function: { name: 'web_search', arguments: args } }],
  });

  test('runs the model\'s queries on Exa and cites every page it was shown', async () => {
    const exa = fakeFetch([exaReply(['https://a.invalid', 'https://b.invalid']), exaReply(['https://b.invalid', 'https://c.invalid'])]);
    const llm = fakeFetch([
      chat({ ...searchCall('a', '{"query":"nyan cat origin","end_published_date":"2026-09-01"}'), reasoning_content: 'think' }, {}, 'tool_calls'),
      chat(searchCall('b', '{"query":"nyan cat 2011"}'), {}, 'tool_calls'),
      chat({ content: 'Nyan Cat dates to April 2011.' }),
    ]);
    const client = new OpenAiLlm('moonshot', 'kimi-k2.6', {
      apiKey: 'k',
      fetch: llm.fetch,
      exa: new ExaSearch({ apiKey: 'exa-key', fetch: exa.fetch }),
    });
    const billed: Array<[string, number | undefined]> = [];
    const found = await client.search(SEARCH, (model, _usage, cost) => billed.push([model, cost]));

    expect(client.canSearch).toBe(true);
    expect(exa.calls[0]?.url).toBe('https://api.exa.ai/search');
    expect(exa.calls[0]?.headers['x-api-key']).toBe('exa-key');
    expect(exa.calls[0]?.body).toMatchObject({ query: 'nyan cat origin', endPublishedDate: '2026-09-01T23:59:59.999Z' });
    expect(exa.calls[1]?.body).not.toHaveProperty('endPublishedDate');
    // The assistant turn goes back verbatim, Kimi's reasoning included.
    const history = llm.calls[1]?.body.messages as Array<Record<string, unknown>>;
    expect(history.at(-2)).toMatchObject({ reasoning_content: 'think' });
    expect(String(history.at(-1)?.content)).toContain('published: 2011-04-05');
    // Two searches used: the last round may not search again.
    expect(llm.calls[2]?.body.tool_choice).toBe('none');
    expect(found).toMatchObject({ texts: ['Nyan Cat dates to April 2011.'], searches: 2 });
    expect(found.citations).toEqual(['https://a.invalid', 'https://b.invalid', 'https://c.invalid']);
    expect(billed.filter(([model]) => model === 'exa').map(([, cost]) => cost)).toEqual([0.005, 0.005]);
  });

  test('a failed search is reported to the model, not thrown; a refused key is thrown', async () => {
    const down = fakeFetch([{ status: 500, body: 'boom' }]);
    const llm = fakeFetch([chat(searchCall('a', '{"query":"x"}'), {}, 'tool_calls'), chat({ content: 'nothing found' })]);
    const client = new OpenAiLlm('moonshot', 'kimi-k2.6', { apiKey: 'k', fetch: llm.fetch, exa: new ExaSearch({ apiKey: 'e', fetch: down.fetch }) });
    const found = await client.search(SEARCH, noUsage);
    expect(found.searchError).toBe('exa_error');
    expect(found.texts).toEqual(['nothing found']);

    const broke = fakeFetch([{ status: 402, body: 'no credits' }]);
    const again = fakeFetch([chat(searchCall('a', '{"query":"x"}'), {}, 'tool_calls')]);
    const refused = new OpenAiLlm('moonshot', 'kimi-k2.6', { apiKey: 'k', fetch: again.fetch, exa: new ExaSearch({ apiKey: 'e', fetch: broke.fetch }) });
    await expect(refused.search(SEARCH, noUsage)).rejects.toThrow('HTTP 402');
  });

  test('bad arguments get an error back, not a search', () => {
    expect(parseExaArgs('{"query":"  "}')).toBeUndefined();
    expect(parseExaArgs('not json')).toBeUndefined();
    expect(parseExaArgs('{"query":"pepe","end_published_date":"last week"}')).toEqual({ query: 'pepe' });
  });

  test('createLlm puts Exa behind every non-Anthropic model unless told not to', () => {
    const app = loadConfig({ MOONSHOT_API_KEY: 'k', EXA_API_KEY: 'e' });
    const llm = createLlm(app, app.llm.model) as OpenAiLlm;
    expect(llm.model).toBe('kimi-k2.6');
    expect((llm as unknown as { options: { exa?: unknown } }).options.exa).toBeInstanceOf(ExaSearch);
    const native = loadConfig({ MOONSHOT_API_KEY: 'k', EXA_API_KEY: 'e', LLM_SEARCH_BACKEND: 'native' });
    expect((createLlm(native, native.llm.model) as unknown as { options: { exa?: unknown } }).options.exa).toBeUndefined();
  });

  test('Kimi K2.6 drops thinking for a low-effort call and never sends temperature', async () => {
    const { fetch, calls } = fakeFetch([chat({ content: '{"ok":1}' }), chat({ content: '{"ok":1}' })]);
    const llm = new OpenAiLlm('moonshot', 'kimi-k2.6', { apiKey: 'k', fetch });
    await llm.callTool({ ...TOOL, reasoningEffort: 'low' }, noUsage);
    expect(calls[0]?.body.thinking).toEqual({ type: 'disabled' });
    expect(calls[0]?.body).not.toHaveProperty('temperature');
    const k3 = new OpenAiLlm('moonshot', 'kimi-k3', { apiKey: 'k', fetch });
    await k3.callTool({ ...TOOL, reasoningEffort: 'medium' }, noUsage);
    expect(calls[1]?.body.reasoning_effort).toBe('high');
  });
});
