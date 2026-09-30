/**
 * The two things the research layer asks of a model, independent of who
 * serves it: a prose turn that may search the web, and a forced tool call
 * over text already gathered. Every provider adapter implements both; the
 * analyst and the anchor checker never see a vendor SDK type.
 */

import type { LlmProvider } from '@provenance/core';
import type { TokenUsage } from '../cost';

export interface ToolSpec {
  name: string;
  description: string;
  /** Plain JSON Schema; Anthropic's `input_schema` and OpenAI's `parameters` both take it. */
  schema: Record<string, unknown>;
  /** Anthropic only: put a cache breakpoint on the tool so the static prefix is cached. */
  cacheable?: boolean;
}

export interface SearchRequest {
  system: string;
  prompt: string;
  maxTokens: number;
  /** Ceiling on web searches. Providers without a cap enforce it client-side or ignore it. */
  maxSearches: number;
  /**
   * A long research turn: streamed, so it cannot trip the HTTP read timeout,
   * and resumed when the provider pauses it. The fast anchor check leaves this off.
   */
  long?: boolean;
  reasoningEffort?: ReasoningEffort;
}

/**
 * Hint for reasoning models. Their hidden reasoning is billed and counted
 * against the output budget, so a short structured call asks for little of it.
 * Providers without the knob ignore it.
 */
export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface SearchResult {
  texts: string[];
  citations: string[];
  searches: number;
  /** Error code a search tool reported in place of results, if any. */
  searchError?: string;
  /** Still paused after every allowed resume (Anthropic only). */
  paused?: boolean;
}

export interface ToolCallRequest {
  system: string;
  prompt: string;
  tool: ToolSpec;
  maxTokens: number;
  temperature?: number;
  reasoningEffort?: ReasoningEffort;
}

export interface ToolCallResult {
  /** The tool's arguments, or undefined when the model did not call it. */
  input: unknown;
  usage: TokenUsage;
}

/**
 * Called once per underlying API call. `costUsd` is set when the provider
 * reports what it billed (OpenRouter), so the tracker can use the real figure
 * instead of the price table.
 */
export type UsageSink = (model: string, usage: TokenUsage, costUsd?: number) => void;

export interface LlmClient {
  readonly provider: LlmProvider;
  readonly model: string;
  /** False when the provider has no web search; `search` then answers from recall. */
  readonly canSearch: boolean;
  search(request: SearchRequest, onUsage: UsageSink): Promise<SearchResult>;
  callTool(request: ToolCallRequest, onUsage: UsageSink): Promise<ToolCallResult>;
}
