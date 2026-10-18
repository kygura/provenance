import { describe, expect, test } from 'bun:test';
import { briefSettings, usableModels, validateBriefOutput } from './llm';
import { makeConfig } from '../test-fakes';

const CONTEXT = { notableIds: new Set(['solana:a']), openSetupIds: new Set(['A-20261018-1']) };
const BASE = {
  headline: 'h',
  tokens: [{ token_id: 'solana:a', change: 'c', why: 'w', evidence: 'e', confidence: 'we lean', breaks_if: 'b' }],
  watchlist: [],
  track_record: 't',
  clusters: [],
  pipeline: [],
  new_setups: [],
  cancel: [],
  stand_aside_reason: 'nothing clears the bar',
};

describe('validateBriefOutput', () => {
  test('accepts a well-formed object', () => {
    const checked = validateBriefOutput(BASE, CONTEXT);
    expect(checked.ok).toBe(true);
  });

  test('shape errors fail with the path named', () => {
    const checked = validateBriefOutput({ ...BASE, tokens: [{ ...BASE.tokens[0], confidence: 'certain' }], cancel: 'no' }, CONTEXT);
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.errors.join(' ')).toContain('tokens[0].confidence');
      expect(checked.errors.join(' ')).toContain('cancel must be an array');
    }
  });

  test('stand_aside_reason is required with no setups; more than two setups is invalid', () => {
    const { stand_aside_reason: _, ...rest } = BASE;
    expect(validateBriefOutput(rest, CONTEXT).ok).toBe(false);
    const setup = {
      token_id: 'solana:a', direction: 'long', thesis: 't', trigger: 'g', conviction: 'low',
      entry_mcap_low: 1, entry_mcap_high: 2, invalidation_mcap: 0.5, targets: [4], expiry_days: 3,
    };
    expect(validateBriefOutput({ ...rest, new_setups: [setup] }, CONTEXT).ok).toBe(true);
    expect(validateBriefOutput({ ...rest, new_setups: [setup, setup, setup] }, CONTEXT).ok).toBe(false);
    expect(validateBriefOutput({ ...rest, new_setups: [{ ...setup, entry_mcap_low: '1M' }] }, CONTEXT).ok).toBe(false);
  });

  test('reads for unknown tokens and cancels of unknown setups are dropped, not fatal', () => {
    const checked = validateBriefOutput(
      { ...BASE, tokens: [...BASE.tokens, { ...BASE.tokens[0], token_id: 'solana:zzz' }], cancel: [{ id: 'X-1', reason: 'r' }] },
      CONTEXT,
    );
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.value.tokens).toHaveLength(1);
      expect(checked.value.cancel).toEqual([]);
      expect(checked.dropped).toHaveLength(2);
    }
  });

  test('long text is clipped', () => {
    const checked = validateBriefOutput({ ...BASE, headline: 'x'.repeat(5000) }, CONTEXT);
    expect(checked.ok && checked.value.headline.length).toBe(400);
  });
});

describe('settings', () => {
  test('defaults and overrides', () => {
    expect(briefSettings({})).toEqual({ model: 'moonshot:kimi-k3', fallback: 'moonshot:kimi-k2.6', maxUsd: 0.5 });
    expect(briefSettings({ LLM_BRIEF_MODEL: 'deepseek:deepseek-chat', LLM_BRIEF_MAX_USD: '0.1' })).toMatchObject({
      model: 'deepseek:deepseek-chat',
      maxUsd: 0.1,
    });
    expect(briefSettings({ LLM_BRIEF_MAX_USD: 'lots' }).maxUsd).toBe(0.5);
  });

  test('only models with a key are usable', () => {
    const app = makeConfig();
    expect(usableModels(app, briefSettings({}))).toEqual([]);
    const keyed = makeConfig({ llm: { ...app.llm, providers: { ...app.llm.providers, moonshot: { apiKey: 'k' } } } });
    expect(usableModels(keyed, briefSettings({}))).toEqual(['moonshot:kimi-k3', 'moonshot:kimi-k2.6']);
  });
});
