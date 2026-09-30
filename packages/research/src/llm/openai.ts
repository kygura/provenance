/**
 * Every non-Anthropic provider, over plain `fetch` in the OpenAI dialect.
 *
 * Extraction is the same everywhere: chat completions with one function and
 * `tool_choice` naming it. Search is where providers differ, so each gets a
 * mode:
 *
 *   - `responses`  OpenAI's Responses API with the hosted `web_search` tool;
 *                  sources come back as `url_citation` annotations.
 *   - `plugin`     OpenRouter's `web` plugin, which works for any model it
 *                  routes to (Kimi, DeepSeek, GPT, ...). OpenRouter also reports
 *                  the billed cost per call, so no price table is needed.
 *   - `builtin`    Moonshot's `$web_search` builtin function: the model asks,
 *                  the client echoes the arguments back, Moonshot runs it.
 *                  No structured citations, so URLs are read out of the prose.
 *   - `none`       DeepSeek and custom endpoints: no search. The turn is
 *                  answered from recall, which the analyst already scores as
 *                  ungrounded.
 */

import type { LlmProvider } from '@provenance/core';
import type { TokenUsage } from '../cost';
import type { LlmClient, SearchRequest, SearchResult, ToolCallRequest, ToolCallResult, UsageSink } from './types';

export type SearchMode = 'responses' | 'plugin' | 'builtin' | 'none';
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

interface ProviderProfile {
  baseUrl?: string;
  search: SearchMode;
  /** Named `tool_choice`. Moonshot rejects it, so there the prompt asks instead. */
  forceToolChoice: boolean;
  /** OpenAI's reasoning models reject `temperature` and `max_tokens`. */
  reasoningParams: boolean;
}

export const PROVIDER_PROFILES: Readonly<Record<Exclude<LlmProvider, 'anthropic'>, ProviderProfile>> = {
  openai: { baseUrl: 'https://api.openai.com/v1', search: 'responses', forceToolChoice: true, reasoningParams: true },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', search: 'plugin', forceToolChoice: true, reasoningParams: false },
  moonshot: { baseUrl: 'https://api.moonshot.ai/v1', search: 'builtin', forceToolChoice: false, reasoningParams: false },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', search: 'none', forceToolChoice: true, reasoningParams: false },
  'openai-compatible': { search: 'none', forceToolChoice: true, reasoningParams: false },
};

const NO_SEARCH_NOTE =
  'Web search is not available in this run. Work from what you already know, and say plainly which claims you could not verify against a source.';

export interface OpenAiLlmOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Attempts per HTTP call on 429 and 5xx. */
  retries?: number;
  timeoutMs?: number;
}

// -- response shapes (only the fields read) -----------------------------------

interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number } | null;
  /** DeepSeek. */
  prompt_cache_hit_tokens?: number;
  /** Moonshot. */
  cached_tokens?: number;
  /** OpenRouter, with `usage: { include: true }`: USD actually billed. */
  cost?: number;
}

interface ChatToolCall {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

interface ChatMessage {
  role: string;
  content?: string | null;
  tool_calls?: ChatToolCall[];
  annotations?: Array<{ type?: string; url_citation?: { url?: string } }>;
}

interface ChatResponse {
  choices?: Array<{ message?: ChatMessage; finish_reason?: string }>;
  usage?: ChatUsage;
}

interface ResponsesResponse {
  output?: Array<{
    type?: string;
    content?: Array<{ type?: string; text?: string; annotations?: Array<{ type?: string; url?: string }> }>;
  }>;
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
}

// -- helpers --------------------------------------------------------------------

function count(value: number | undefined | null): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * OpenAI-dialect `prompt_tokens` INCLUDES cached tokens, unlike Anthropic's
 * `input_tokens`. Split them so the tracker prices each bucket once.
 */
export function chatUsage(usage: ChatUsage | undefined): { usage: TokenUsage; costUsd?: number } {
  const prompt = count(usage?.prompt_tokens);
  const cached = Math.min(
    prompt,
    count(usage?.prompt_tokens_details?.cached_tokens) || count(usage?.prompt_cache_hit_tokens) || count(usage?.cached_tokens),
  );
  return {
    usage: {
      inputTokens: prompt - cached,
      outputTokens: count(usage?.completion_tokens),
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    },
    costUsd: typeof usage?.cost === 'number' && Number.isFinite(usage.cost) ? usage.cost : undefined,
  };
}

const URL_PATTERN = /https?:\/\/[^\s)\]}>"'`,]+/g;

/** URLs mentioned in prose, trailing punctuation trimmed. */
export function urlsIn(text: string): string[] {
  return [...text.matchAll(URL_PATTERN)].map((match) => match[0].replace(/[.;:!?]+$/, ''));
}

/**
 * A tool call's arguments, or — for providers that answer in content instead
 * — the first JSON object in the message text, fenced or not.
 */
export function toolInput(message: ChatMessage | undefined, name: string): unknown {
  const call = message?.tool_calls?.find((item) => item.function?.name === name) ?? message?.tool_calls?.[0];
  if (call) {
    try {
      return JSON.parse(call.function.arguments);
    } catch {
      return undefined;
    }
  }
  const text = message?.content ?? '';
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  if (!candidate.trim().startsWith('{')) return undefined;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

export class OpenAiLlm implements LlmClient {
  readonly canSearch: boolean;
  private readonly profile: ProviderProfile;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly retries: number;
  private readonly timeoutMs: number;

  constructor(
    readonly provider: Exclude<LlmProvider, 'anthropic'>,
    readonly model: string,
    private readonly options: OpenAiLlmOptions,
  ) {
    this.profile = PROVIDER_PROFILES[provider];
    const baseUrl = options.baseUrl ?? this.profile.baseUrl;
    if (!baseUrl) throw new Error(`${provider} needs a base URL (OPENAI_COMPATIBLE_BASE_URL).`);
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.canSearch = this.profile.search !== 'none';
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.retries = options.retries ?? 3;
    this.timeoutMs = options.timeoutMs ?? 180_000;
  }

  // -- transport ----------------------------------------------------------------

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.retries; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.options.apiKey}`,
            ...(this.provider === 'openrouter' ? { 'x-title': 'provenance' } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        await this.backoff(attempt);
        continue;
      }
      if (response.ok) return (await response.json()) as T;
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      lastError = new Error(`${this.provider} ${path} HTTP ${response.status}: ${detail}`);
      // A 4xx other than rate limiting will not change on retry.
      if (response.status !== 429 && response.status < 500) throw lastError;
      await this.backoff(attempt);
    }
    throw lastError ?? new Error(`${this.provider} ${path} failed`);
  }

  private async backoff(attempt: number): Promise<void> {
    if (attempt >= this.retries) return;
    await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
  }

  /** Output-length and sampling params in the dialect this provider accepts. */
  private sampling(maxTokens: number, temperature?: number): Record<string, unknown> {
    if (this.profile.reasoningParams) return { max_completion_tokens: maxTokens };
    return { max_tokens: maxTokens, ...(temperature !== undefined ? { temperature } : {}) };
  }

  private report(onUsage: UsageSink, raw: ChatUsage | undefined): TokenUsage {
    const { usage, costUsd } = chatUsage(raw);
    onUsage(this.model, usage, costUsd);
    return usage;
  }

  // -- search -------------------------------------------------------------------

  async search(request: SearchRequest, onUsage: UsageSink): Promise<SearchResult> {
    switch (this.profile.search) {
      case 'responses':
        return this.searchResponses(request, onUsage);
      case 'plugin':
        return this.searchPlugin(request, onUsage);
      case 'builtin':
        return this.searchBuiltin(request, onUsage);
      default:
        return this.searchNone(request, onUsage);
    }
  }

  private async searchResponses(request: SearchRequest, onUsage: UsageSink): Promise<SearchResult> {
    const response = await this.post<ResponsesResponse>('/responses', {
      model: this.model,
      instructions: request.system,
      input: request.prompt,
      tools: [{ type: 'web_search' }],
      max_tool_calls: request.maxSearches,
      max_output_tokens: request.maxTokens,
    });
    const cached = count(response.usage?.input_tokens_details?.cached_tokens);
    const input = count(response.usage?.input_tokens);
    onUsage(this.model, {
      inputTokens: Math.max(0, input - cached),
      outputTokens: count(response.usage?.output_tokens),
      cacheReadTokens: Math.min(cached, input),
      cacheWriteTokens: 0,
    });

    const result: SearchResult = { texts: [], citations: [], searches: 0 };
    for (const item of response.output ?? []) {
      if (item.type === 'web_search_call') result.searches += 1;
      if (item.type !== 'message') continue;
      for (const part of item.content ?? []) {
        if (part.type !== 'output_text' || !part.text) continue;
        result.texts.push(part.text);
        for (const note of part.annotations ?? []) {
          if (note.type === 'url_citation' && note.url) result.citations.push(note.url);
        }
      }
    }
    return result;
  }

  private async searchPlugin(request: SearchRequest, onUsage: UsageSink): Promise<SearchResult> {
    const response = await this.post<ChatResponse>('/chat/completions', {
      model: this.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.prompt },
      ],
      plugins: [{ id: 'web', max_results: Math.max(1, Math.min(10, request.maxSearches)) }],
      usage: { include: true },
      ...this.sampling(request.maxTokens),
    });
    this.report(onUsage, response.usage);
    const message = response.choices?.[0]?.message;
    const citations = (message?.annotations ?? [])
      .filter((note) => note.type === 'url_citation' && note.url_citation?.url)
      .map((note) => note.url_citation?.url as string);
    return {
      texts: message?.content ? [message.content] : [],
      citations,
      // The plugin runs one search per call, before the model sees the prompt.
      searches: request.maxSearches > 0 ? 1 : 0,
    };
  }

  private async searchBuiltin(request: SearchRequest, onUsage: UsageSink): Promise<SearchResult> {
    const messages: Array<Record<string, unknown>> = [
      { role: 'system', content: request.system },
      { role: 'user', content: request.prompt },
    ];
    const tools = [{ type: 'builtin_function', function: { name: '$web_search' } }];
    const result: SearchResult = { texts: [], citations: [], searches: 0 };

    // One more round than searches, so the model always gets a turn to write.
    for (let round = 0; round <= request.maxSearches; round++) {
      const allowSearch = result.searches < request.maxSearches;
      const response = await this.post<ChatResponse>('/chat/completions', {
        model: this.model,
        messages,
        ...(allowSearch ? { tools } : {}),
        ...this.sampling(request.maxTokens),
      });
      this.report(onUsage, response.usage);
      const choice = response.choices?.[0];
      const message = choice?.message;
      const calls = (message?.tool_calls ?? []).filter((call) => call.function?.name === '$web_search');
      if (choice?.finish_reason !== 'tool_calls' || calls.length === 0) {
        if (message?.content) result.texts.push(message.content);
        break;
      }
      messages.push(message as unknown as Record<string, unknown>);
      for (const call of calls) {
        result.searches += 1;
        // The protocol: hand the arguments back verbatim and Moonshot runs the search.
        messages.push({ role: 'tool', tool_call_id: call.id, name: '$web_search', content: call.function.arguments });
      }
    }
    if (result.searches > 0) result.citations = [...new Set(result.texts.flatMap(urlsIn))];
    return result;
  }

  private async searchNone(request: SearchRequest, onUsage: UsageSink): Promise<SearchResult> {
    const response = await this.post<ChatResponse>('/chat/completions', {
      model: this.model,
      messages: [
        { role: 'system', content: `${request.system}\n\n${NO_SEARCH_NOTE}` },
        { role: 'user', content: request.prompt },
      ],
      ...this.sampling(request.maxTokens),
    });
    this.report(onUsage, response.usage);
    const content = response.choices?.[0]?.message?.content;
    // URLs recalled without a search were never consulted, so none are citations.
    return { texts: content ? [content] : [], citations: [], searches: 0 };
  }

  // -- extraction ---------------------------------------------------------------

  async callTool(request: ToolCallRequest, onUsage: UsageSink): Promise<ToolCallResult> {
    const prompt = this.profile.forceToolChoice
      ? request.prompt
      : `${request.prompt}\n\nRespond by calling the \`${request.tool.name}\` function exactly once.`;
    const response = await this.post<ChatResponse>('/chat/completions', {
      model: this.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: prompt },
      ],
      tools: [
        {
          type: 'function',
          function: { name: request.tool.name, description: request.tool.description, parameters: request.tool.schema },
        },
      ],
      tool_choice: this.profile.forceToolChoice
        ? { type: 'function', function: { name: request.tool.name } }
        : 'auto',
      ...(this.provider === 'openrouter' ? { usage: { include: true } } : {}),
      ...this.sampling(request.maxTokens, request.temperature),
    });
    const usage = this.report(onUsage, response.usage);
    return { input: toolInput(response.choices?.[0]?.message, request.tool.name), usage };
  }
}
