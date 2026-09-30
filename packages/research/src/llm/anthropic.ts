/**
 * Anthropic Messages API: the web search server tool for the prose turn, a
 * forced `tool_choice` for extraction. The system prompt carries a cache
 * breakpoint in both, so the second call of every token reads it from cache.
 */

import Anthropic from '@anthropic-ai/sdk';
import { usageFromResponse } from '../cost';
import { harvest, searchErrorCode } from '../search';
import type { LlmClient, SearchRequest, SearchResult, ToolCallRequest, ToolCallResult, UsageSink } from './types';

/**
 * Dynamic-filtering variant of the web search server tool. Requires a recent
 * model; an older one returns a 400 naming the tool type, which the caller
 * treats as a failed research pass rather than a failed run.
 */
export const WEB_SEARCH_TOOL_TYPE = 'web_search_20260209' as const;

export interface AnthropicLlmOptions {
  client?: Pick<Anthropic, 'messages'>;
  apiKey?: string;
  baseUrl?: string;
  /** A long search turn can stop with `pause_turn`; this bounds the resumes. */
  maxPauseTurnRestarts?: number;
}

export class AnthropicLlm implements LlmClient {
  readonly provider = 'anthropic' as const;
  readonly canSearch = true;
  private readonly client: Pick<Anthropic, 'messages'>;
  private readonly maxPauseTurnRestarts: number;

  constructor(
    readonly model: string,
    options: AnthropicLlmOptions = {},
  ) {
    this.client =
      options.client ??
      new Anthropic({ apiKey: options.apiKey ?? '', baseURL: options.baseUrl, maxRetries: 3 });
    this.maxPauseTurnRestarts = options.maxPauseTurnRestarts ?? 3;
  }

  private system(text: string): Anthropic.TextBlockParam[] {
    return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
  }

  async search(request: SearchRequest, onUsage: UsageSink): Promise<SearchResult> {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: request.prompt }];
    const tools = [
      { type: WEB_SEARCH_TOOL_TYPE, name: 'web_search', max_uses: request.maxSearches },
    ] as unknown as Anthropic.ToolUnion[];
    const result: SearchResult = { texts: [], citations: [], searches: 0 };
    const restarts = request.long ? this.maxPauseTurnRestarts : 0;
    let paused = true;

    for (let attempt = 0; attempt <= restarts; attempt++) {
      const params = {
        model: this.model,
        max_tokens: request.maxTokens,
        system: this.system(request.system),
        messages,
        tools,
      };
      const message = request.long
        ? await this.client.messages.stream(params).finalMessage()
        : ((await this.client.messages.create(params)) as Anthropic.Message);
      onUsage(this.model, usageFromResponse(message.usage));

      const code = searchErrorCode(message);
      if (code) result.searchError = code;
      const batch = harvest(message);
      result.texts.push(...batch.texts);
      result.citations.push(...batch.citations);
      result.searches += batch.searches;

      if (message.stop_reason !== 'pause_turn') {
        paused = false;
        break;
      }
      // Resuming a paused turn means handing the assistant turn straight back.
      messages.push({ role: 'assistant', content: message.content });
    }

    // Only a long turn resumes; a short one that paused just keeps what it has.
    if (paused && request.long) result.paused = true;
    return result;
  }

  async callTool(request: ToolCallRequest, onUsage: UsageSink): Promise<ToolCallResult> {
    const tool: Anthropic.Tool = {
      name: request.tool.name,
      description: request.tool.description,
      input_schema: request.tool.schema as Anthropic.Tool['input_schema'],
    };
    // Tools render before system and messages, so a breakpoint here covers the
    // whole static prefix.
    if (request.tool.cacheable) tool.cache_control = { type: 'ephemeral' };

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens,
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      system: this.system(request.system),
      tools: [tool],
      tool_choice: { type: 'tool', name: request.tool.name },
      messages: [{ role: 'user', content: request.prompt }],
    });
    const usage = usageFromResponse(response.usage);
    onUsage(this.model, usage);
    const block = response.content.find(
      (item): item is Anthropic.ToolUseBlock => item.type === 'tool_use' && item.name === request.tool.name,
    );
    return { input: block?.input, usage };
  }
}
