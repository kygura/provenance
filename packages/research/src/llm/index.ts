/** Builds the client for a `provider:model` spec from the app config. */

import type { AppConfig } from '@provenance/core';
import { AnthropicLlm, type AnthropicLlmOptions } from './anthropic';
import { ExaSearch } from './exa';
import { FallbackLlm } from './fallback';
import { OpenAiLlm, type FetchLike } from './openai';
import { parseModelSpec, providerApiKey, PROVIDER_KEY_ENV } from './spec';
import type { LlmClient } from './types';

export interface CreateLlmOptions {
  /** Injected Anthropic `messages` client; tests use this. */
  anthropicClient?: AnthropicLlmOptions['client'];
  maxPauseTurnRestarts?: number;
  fetch?: FetchLike;
  /**
   * Spec to switch to when the primary's provider fails at runtime (see
   * `FallbackLlm`); the role's `llm.fallback*Model`. Ignored without its key.
   */
  fallback?: string;
  /** Where the one-time switch warning goes; console.warn otherwise. */
  warn?: (message: string) => void;
}

export function createLlm(app: AppConfig, spec: string, options: CreateLlmOptions = {}): LlmClient {
  const { fallback, warn, ...rest } = options;
  const primary = createSingle(app, spec, rest);
  if (!fallback || !providerApiKey(app, parseModelSpec(fallback).provider)) return primary;
  return new FallbackLlm(primary, createSingle(app, fallback, rest), { warn });
}

function createSingle(app: AppConfig, spec: string, options: CreateLlmOptions): LlmClient {
  const { provider, model } = parseModelSpec(spec);
  const apiKey = providerApiKey(app, provider);
  const baseUrl = app.llm.providers?.[provider]?.baseUrl;
  if (provider === 'anthropic') {
    return new AnthropicLlm(model, {
      client: options.anthropicClient,
      apiKey,
      baseUrl,
      workspaceId: app.llm.providers?.anthropic?.workspaceId,
      maxPauseTurnRestarts: options.maxPauseTurnRestarts,
    });
  }
  if (!apiKey) throw new Error(`${PROVIDER_KEY_ENV[provider]} is not set, needed for ${provider}:${model}.`);
  const exa =
    app.llm.searchBackend !== 'native' && app.exaApiKey
      ? new ExaSearch({ apiKey: app.exaApiKey, fetch: options.fetch })
      : undefined;
  return new OpenAiLlm(provider, model, { apiKey, baseUrl, fetch: options.fetch, ...(exa ? { exa } : {}) });
}

export { AnthropicLlm, WEB_SEARCH_TOOL_TYPE } from './anthropic';
export { FallbackLlm, providerFailure, type FallbackLlmOptions } from './fallback';
export { ExaSearch, EXA_TOOL_NAME, exaTool, formatExaHits, parseExaArgs, type ExaHit, type ExaQuery } from './exa';
export { OpenAiLlm, PROVIDER_PROFILES, chatUsage, toolInput, urlsIn, type SearchMode, type FetchLike } from './openai';
export {
  parseModelSpec,
  providerApiKey,
  configuredModelSpecs,
  fallbackModelSpecs,
  missingCredentials,
  PROVIDER_KEY_ENV,
  type ModelSpec,
} from './spec';
export type * from './types';
