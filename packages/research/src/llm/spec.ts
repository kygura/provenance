/**
 * Provider keys and the model specs a run will call. `parseModelSpec` lives in
 * core, since config applies the Anthropic-first rule with it.
 */

import { parseModelSpec, type AppConfig, type LlmProvider, type ModelSpec } from '@provenance/core';

export { parseModelSpec, type ModelSpec };

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
  qwen: 'DASHSCOPE_API_KEY',
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
