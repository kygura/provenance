/**
 * Anthropic-first with a way out: every call goes to the primary (Claude)
 * until the provider itself fails — credits exhausted, a rejected key, a rate
 * limit or overload that outlasted the SDK's retries, the network — then the
 * call is retried on the fallback (Kimi by default) and the client stays there
 * for the rest of the process. Our own errors (a bad tool payload, a schema
 * miss) are not provider failures and surface unchanged.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { LlmClient, SearchRequest, SearchResult, ToolCallRequest, ToolCallResult, UsageSink } from './types';

/**
 * Why the error means "Anthropic is unusable right now", or undefined when it
 * does not. Every API error counts: a 400 is usually exhausted credits, and
 * when it is not (a model id or parameter the API refuses) the message is kept
 * in the reason so the misconfiguration is visible in the log.
 */
export function providerFailure(error: unknown): string | undefined {
  if (error instanceof Anthropic.APIUserAbortError) return undefined;
  if (error instanceof Anthropic.APIConnectionError) return `network error (${error.message})`;
  if (!(error instanceof Anthropic.APIError)) return undefined;
  const status = error.status;
  const message = error.message.slice(0, 300);
  if (/credit balance/i.test(message) || status === 402) return 'credit balance too low';
  if (status === 401 || status === 403) return `authentication failed (HTTP ${status})`;
  if (status === 429) return 'rate limited (HTTP 429)';
  if (status === 529) return 'overloaded (HTTP 529)';
  if (status !== undefined && status >= 500) return `server error (HTTP ${status})`;
  return `HTTP ${status ?? '?'}: ${message}`;
}

export interface FallbackLlmOptions {
  warn?: (message: string) => void;
}

export class FallbackLlm implements LlmClient {
  private active: LlmClient;
  private readonly warn: (message: string) => void;

  constructor(
    readonly primary: LlmClient,
    readonly fallback: LlmClient,
    options: FallbackLlmOptions = {},
  ) {
    this.active = primary;
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  get provider(): LlmClient['provider'] {
    return this.active.provider;
  }

  get model(): string {
    return this.active.model;
  }

  get canSearch(): boolean {
    return this.active.canSearch;
  }

  /** True once the primary has failed and every call goes to the fallback. */
  get switched(): boolean {
    return this.active === this.fallback;
  }

  search(request: SearchRequest, onUsage: UsageSink): Promise<SearchResult> {
    return this.run((llm) => llm.search(request, onUsage));
  }

  callTool(request: ToolCallRequest, onUsage: UsageSink): Promise<ToolCallResult> {
    return this.run((llm) => llm.callTool(request, onUsage));
  }

  private async run<T>(call: (llm: LlmClient) => Promise<T>): Promise<T> {
    if (this.switched) return call(this.fallback);
    try {
      return await call(this.primary);
    } catch (error) {
      const reason = providerFailure(error);
      if (reason === undefined) throw error;
      this.warn(
        `${this.primary.provider}:${this.primary.model} failed (${reason}); ` +
          `switching to ${this.fallback.provider}:${this.fallback.model} for the rest of the run`,
      );
      this.active = this.fallback;
      return call(this.fallback);
    }
  }
}
