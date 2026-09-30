/** Builds the client for a `provider:model` spec from the app config. */

import type { AppConfig } from '@provenance/core';
import { AnthropicLlm, type AnthropicLlmOptions } from './anthropic';
import { OpenAiLlm, type FetchLike } from './openai';
import { parseModelSpec, providerApiKey, PROVIDER_KEY_ENV } from './spec';
import type { LlmClient } from './types';

export interface CreateLlmOptions {
  /** Injected Anthropic `messages` client; tests use this. */
  anthropicClient?: AnthropicLlmOptions['client'];
  maxPauseTurnRestarts?: number;
  fetch?: FetchLike;
}

export function createLlm(app: AppConfig, spec: string, options: CreateLlmOptions = {}): LlmClient {
  const { provider, model } = parseModelSpec(spec);
  const apiKey = providerApiKey(app, provider);
  const baseUrl = app.llm.providers?.[provider]?.baseUrl;
  if (provider === 'anthropic') {
    return new AnthropicLlm(model, {
      client: options.anthropicClient,
      apiKey,
      baseUrl,
      maxPauseTurnRestarts: options.maxPauseTurnRestarts,
    });
  }
  if (!apiKey) throw new Error(`${PROVIDER_KEY_ENV[provider]} is not set, needed for ${provider}:${model}.`);
  return new OpenAiLlm(provider, model, { apiKey, baseUrl, fetch: options.fetch });
}

export { AnthropicLlm, WEB_SEARCH_TOOL_TYPE } from './anthropic';
export { OpenAiLlm, PROVIDER_PROFILES, chatUsage, toolInput, urlsIn, type SearchMode, type FetchLike } from './openai';
export {
  parseModelSpec,
  providerApiKey,
  configuredModelSpecs,
  missingCredentials,
  PROVIDER_KEY_ENV,
  type ModelSpec,
} from './spec';
export type * from './types';
