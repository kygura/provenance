import { describe, expect, test } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfig } from '@provenance/core';
import { CostTracker } from '../cost';
import { FallbackLlm, providerFailure } from './fallback';
import { createLlm } from './index';
import type { LlmClient, ToolCallRequest } from './types';

const REQUEST: ToolCallRequest = {
  system: 's',
  prompt: 'p',
  tool: { name: 't', description: 'd', schema: { type: 'object' } },
  maxTokens: 100,
};

function apiError(status: number, message: string): Error {
  return Anthropic.APIError.generate(
    status,
    { type: 'error', error: { type: 'invalid_request_error', message } },
    undefined,
    new Headers(),
  );
}

/** A client that bills one call under its own model, or throws the queued error. */
function client(provider: LlmClient['provider'], model: string, errors: unknown[] = []): LlmClient & { calls: number } {
  return {
    provider,
    model,
    canSearch: true,
    calls: 0,
    async search(_request, onUsage) {
      this.calls += 1;
      if (errors.length > 0) throw errors.shift();
      onUsage(model, { inputTokens: 1_000_000, outputTokens: 0 });
      return { texts: ['ok'], citations: [], searches: 0 };
    },
    async callTool(_request, onUsage) {
      this.calls += 1;
      if (errors.length > 0) throw errors.shift();
      onUsage(model, { inputTokens: 1_000_000, outputTokens: 0 });
      return { input: { ok: true }, usage: { inputTokens: 1_000_000, outputTokens: 0 } };
    },
  };
}

describe('FallbackLlm', () => {
  test('a 400 credit error switches to the fallback, stays switched, and bills the fallback model', async () => {
    const primary = client('anthropic', 'claude-opus-5', [apiError(400, 'Your credit balance is too low to access the Anthropic API.')]);
    const fallback = client('moonshot', 'kimi-k2.6');
    const warnings: string[] = [];
    const llm = new FallbackLlm(primary, fallback, { warn: (m) => warnings.push(m) });
    const tracker = new CostTracker();
    const sink = (model: string, usage: Parameters<CostTracker['add']>[1]) => tracker.add(model, usage);

    expect(llm.model).toBe('claude-opus-5');
    await llm.callTool(REQUEST, sink);
    await llm.search({ system: 's', prompt: 'p', maxTokens: 10, maxSearches: 1 }, sink);

    expect(llm.switched).toBe(true);
    expect([llm.provider, llm.model]).toEqual(['moonshot', 'kimi-k2.6']);
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('credit balance too low');
    expect(warnings[0]).toContain('moonshot:kimi-k2.6');
    expect(tracker.history().map((e) => e.model)).toEqual(['kimi-k2.6', 'kimi-k2.6']);
    // 1M input tokens at Kimi K2.6's price, not Opus's.
    expect(tracker.history()[0]?.costUsd).toBe(0.95);
  });

  test('a 529 overload switches too', async () => {
    const primary = client('anthropic', 'claude-sonnet-5', [apiError(529, 'Overloaded')]);
    const llm = new FallbackLlm(primary, client('moonshot', 'kimi-k2.6'), { warn: () => {} });
    await llm.callTool(REQUEST, () => {});
    expect(llm.switched).toBe(true);
  });

  test('an error of our own surfaces and does not switch', async () => {
    const primary = client('anthropic', 'claude-opus-5', [new Error('schema mismatch')]);
    const fallback = client('moonshot', 'kimi-k2.6');
    const llm = new FallbackLlm(primary, fallback, { warn: () => {} });
    await expect(llm.callTool(REQUEST, () => {})).rejects.toThrow('schema mismatch');
    expect(llm.switched).toBe(false);
    expect(fallback.calls).toBe(0);
    await llm.callTool(REQUEST, () => {});
    expect(primary.calls).toBe(2);
  });

  test('classifies provider failures and keeps a bad-request message visible', () => {
    expect(providerFailure(apiError(401, 'invalid x-api-key'))).toContain('authentication');
    expect(providerFailure(apiError(429, 'rate'))).toContain('429');
    expect(providerFailure(apiError(500, 'boom'))).toContain('500');
    expect(providerFailure(apiError(400, "tool_choice 'tool' is not supported"))).toContain('tool_choice');
    expect(providerFailure(new Anthropic.APIConnectionError({ message: 'socket hang up' }))).toContain('network');
    expect(providerFailure(new Anthropic.APIUserAbortError())).toBeUndefined();
    expect(providerFailure(new Error('ours'))).toBeUndefined();
  });

  test('createLlm wraps only when the role has a keyed fallback', () => {
    const app = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant', MOONSHOT_API_KEY: 'k' });
    const llm = createLlm(app, app.llm.model, { fallback: app.llm.fallbackModel });
    expect(llm).toBeInstanceOf(FallbackLlm);
    expect((llm as FallbackLlm).fallback.model).toBe('kimi-k3');
    expect(createLlm(app, app.llm.model)).not.toBeInstanceOf(FallbackLlm);
    const noKimi = loadConfig({ ANTHROPIC_API_KEY: 'sk-ant' });
    expect(createLlm(noKimi, noKimi.llm.model, { fallback: 'moonshot:kimi-k3' })).not.toBeInstanceOf(FallbackLlm);
  });
});
