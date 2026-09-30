/**
 * `provider:model` parsing. A bare id keeps working (`LLM_MODEL=claude-opus-5`
 * predates this module), with the provider inferred from well-known prefixes.
 */

import { LLM_PROVIDERS, type AppConfig, type LlmProvider } from '@provenance/core';

export interface ModelSpec {
  provider: LlmProvider;
  model: string;
}

const INFERRED: ReadonlyArray<[RegExp, LlmProvider]> = [
  [/^claude-/, 'anthropic'],
  [/^(gpt-|o\d|chatgpt-)/, 'openai'],
  [/^(kimi-|moonshot-)/, 'moonshot'],
  [/^deepseek-/, 'deepseek'],
];

export function parseModelSpec(spec: string): ModelSpec {
  const trimmed = spec.trim();
  const colon = trimmed.indexOf(':');
  if (colon > 0) {
    const prefix = trimmed.slice(0, colon).toLowerCase();
    if ((LLM_PROVIDERS as readonly string[]).includes(prefix)) {
      return { provider: prefix as LlmProvider, model: trimmed.slice(colon + 1).trim() };
    }
  }
  for (const [pattern, provider] of INFERRED) {
    if (pattern.test(trimmed)) return { provider, model: trimmed };
  }
  // An `org/model` id is OpenRouter's naming; nothing else in the list uses it.
  if (trimmed.includes('/')) return { provider: 'openrouter', model: trimmed };
  return { provider: 'anthropic', model: trimmed };
}

/**
 * The key for a provider. The top-level `anthropicApiKey` is still honoured,
 * since configs built in code (tests, older callers) set only that.
 */
export function providerApiKey(app: AppConfig, provider: LlmProvider): string | undefined {
  const key = app.llm.providers?.[provider]?.apiKey;
  if (key) return key;
  return provider === 'anthropic' ? app.anthropicApiKey || undefined : undefined;
}

/** Env var a user sets to supply the key for a provider; used in error messages. */
export const PROVIDER_KEY_ENV: Readonly<Record<LlmProvider, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  'openai-compatible': 'OPENAI_COMPATIBLE_API_KEY',
};

/** Every model spec a live run may call, deduped. */
export function configuredModelSpecs(app: AppConfig): ModelSpec[] {
  const specs = [app.llm.model, app.llm.extractModel ?? app.llm.model, app.llm.triageModel].map(parseModelSpec);
  const seen = new Set<string>();
  return specs.filter((spec) => {
    const key = `${spec.provider}:${spec.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Specs whose provider has no key. Empty means every configured model can be called. */
export function missingCredentials(app: AppConfig): ModelSpec[] {
  return configuredModelSpecs(app).filter((spec) => !providerApiKey(app, spec.provider));
}
