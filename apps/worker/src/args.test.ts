import { describe, expect, test } from 'bun:test';
import { applyFlags, llmDisabled, parseArgs, validateEnv } from './args';
import { colorEnabled } from './format';
import { makeConfig } from './test-fakes';

describe('parseArgs', () => {
  test('reads a command with no flags', () => {
    const parsed = parseArgs(['run']);
    expect(parsed.command).toBe('run');
    expect(parsed.flags).toEqual({});
    expect(parsed.errors).toEqual([]);
  });

  test('accepts both --flag value and --flag=value', () => {
    const spaced = parseArgs(['run', '--limit', '5', '--chains', 'sol,base']);
    const inline = parseArgs(['run', '--limit=5', '--chains=sol,base']);
    expect(spaced.flags).toEqual({ limit: '5', chains: 'sol,base' });
    expect(inline.flags).toEqual({ limit: '5', chains: 'sol,base' });
  });

  test('booleans stand alone and short forms expand', () => {
    const parsed = parseArgs(['run', '--dry-run', '--fixtures', '--no-llm', '-v']);
    expect(parsed.flags).toEqual({
      'dry-run': true,
      fixtures: true,
      'no-llm': true,
      verbose: true,
    });
  });

  test('collects positionals after the command', () => {
    const parsed = parseArgs(['analyze', 'solana:So111', '--verbose']);
    expect(parsed.command).toBe('analyze');
    expect(parsed.positionals).toEqual(['solana:So111']);
  });

  test('rejects unknown flags and commands instead of ignoring them', () => {
    expect(parseArgs(['run', '--turbo']).errors).toEqual(['unknown flag: --turbo']);
    expect(parseArgs(['frobnicate']).errors).toEqual(['unknown command: frobnicate']);
  });

  test('a value flag with no value is an error, not a swallowed next flag', () => {
    const parsed = parseArgs(['run', '--limit', '--verbose']);
    expect(parsed.errors).toEqual(['--limit expects a value']);
    expect(parsed.flags.verbose).toBe(true);
  });

  test('report flags parse', () => {
    const parsed = parseArgs(['report', '--run', 'run_123', '--format', 'markdown']);
    expect(parsed.flags).toEqual({ run: 'run_123', format: 'markdown' });
  });
});

describe('applyFlags', () => {
  test('overrides the pipeline config without mutating the input', () => {
    const app = makeConfig();
    const before = app.pipeline.maxTokensPerRun;
    const { app: next, errors } = applyFlags(
      app,
      parseArgs(['run', '--limit', '3', '--chains', 'sol,base', '--dry-run', '--fixtures', '-v']),
    );

    expect(errors).toEqual([]);
    expect(next.pipeline.maxTokensPerRun).toBe(3);
    expect(next.pipeline.chains).toEqual(['solana', 'base']);
    expect(next.pipeline.dryRun).toBe(true);
    expect(next.pipeline.useFixtures).toBe(true);
    expect(next.logLevel).toBe('debug');
    expect(app.pipeline.maxTokensPerRun).toBe(before);
    expect(app.pipeline.dryRun).toBe(false);
  });

  test('--sources enables exactly the named sources', () => {
    const { app, errors } = applyFlags(makeConfig(), parseArgs(['run', '--sources', 'dexscreener']));
    expect(errors).toEqual([]);
    const enabled = app.pipeline.sources.filter((source) => source.enabled).map((source) => source.id);
    expect(enabled).toEqual(['dexscreener']);
  });

  test('--lane launches runs the launch source alone, even when the lane is off in env', () => {
    const base = makeConfig({ launches: { ...makeConfig().launches, enabled: false } });
    const { app, errors } = applyFlags(base, parseArgs(['run', '--lane', 'launches']));
    expect(errors).toEqual([]);
    expect(app.pipeline.sources.filter((source) => source.enabled).map((source) => source.id)).toEqual(['launches']);
    expect(app.launches.enabled).toBe(true);
    expect(base.launches.enabled).toBe(false);
  });

  test('--lane rejects unknown lanes and does not combine with --sources', () => {
    expect(applyFlags(makeConfig(), parseArgs(['run', '--lane', 'trending'])).errors).toEqual([
      '--lane must be "launches", got "trending"',
    ]);
    expect(
      applyFlags(makeConfig(), parseArgs(['run', '--lane', 'launches', '--sources', 'dexscreener'])).errors,
    ).toEqual(['--lane and --sources cannot be combined']);
  });

  test('bad values are reported, not coerced', () => {
    expect(applyFlags(makeConfig(), parseArgs(['run', '--limit', 'lots'])).errors).toEqual([
      '--limit expects a number, got "lots"',
    ]);
    expect(applyFlags(makeConfig(), parseArgs(['run', '--sources', 'dextoolz'])).errors).toEqual([
      '--sources contains an unknown source: dextoolz',
    ]);
    expect(applyFlags(makeConfig(), parseArgs(['run', '--chains', 'dogechain'])).errors[0]).toContain(
      '--chains contains an unrecognised chain',
    );
    expect(applyFlags(makeConfig(), parseArgs(['report', '--format', 'yaml'])).errors[0]).toContain(
      '--format must be one of',
    );
  });
});

describe('validateEnv', () => {
  test('names the missing variable for a live run', () => {
    const errors = validateEnv('run', makeConfig(), parseArgs(['run']));
    expect(errors[0]).toContain('ANTHROPIC_API_KEY');
  });

  test('--no-llm and offline fixtures need no key', () => {
    expect(validateEnv('run', makeConfig(), parseArgs(['run', '--no-llm']))).toEqual([]);
    const base = makeConfig();
    const fixtures = makeConfig({ pipeline: { ...base.pipeline, useFixtures: true } });
    expect(validateEnv('run', fixtures, parseArgs(['run', '--fixtures']))).toEqual([]);
    // A fixtures run still runs the research stage; it just gets the offline
    // stub researcher rather than the API.
    expect(llmDisabled(fixtures, parseArgs(['run', '--fixtures']))).toBe(false);
    expect(llmDisabled(fixtures, parseArgs(['run', '--fixtures', '--no-llm']))).toBe(true);
  });

  test('a remote database needs its auth token', () => {
    const app = makeConfig({ databaseUrl: 'libsql://provenance.turso.io', anthropicApiKey: 'sk-test' });
    expect(validateEnv('run', app, parseArgs(['run']))[0]).toContain('DATABASE_AUTH_TOKEN');
  });

  test('names the key of whichever provider each configured model needs', () => {
    const base = makeConfig();
    const app = makeConfig({
      anthropicApiKey: 'sk-test',
      llm: { ...base.llm, model: 'openrouter:moonshotai/kimi-k2', extractModel: 'deepseek:deepseek-chat' },
    });
    const errors = validateEnv('run', app, parseArgs(['run'])).join('\n');
    expect(errors).toContain('OPENROUTER_API_KEY');
    expect(errors).toContain('DEEPSEEK_API_KEY');
    expect(errors).not.toContain('ANTHROPIC_API_KEY');
  });

  test('an unpriced model is refused unless the provider reports billed cost', () => {
    const base = makeConfig();
    const providers = {
      ...base.llm.providers,
      openai: { apiKey: 'sk-openai' },
      openrouter: { apiKey: 'sk-or' },
    };
    const unpriced = makeConfig({
      anthropicApiKey: 'sk-test',
      llm: { ...base.llm, providers, model: 'openai:gpt-5.4-mini', extractModel: 'openrouter:deepseek/deepseek-chat' },
    });
    const errors = validateEnv('run', unpriced, parseArgs(['run']));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('LLM_PRICING');
    expect(errors[0]).toContain('gpt-5.4-mini');

    const priced = makeConfig({
      anthropicApiKey: 'sk-test',
      llm: { ...unpriced.llm, pricing: { 'gpt-5.4-mini': { inputPerMTok: 0.75, outputPerMTok: 4.5 } } },
    });
    expect(validateEnv('run', priced, parseArgs(['run']))).toEqual([]);
  });

  test('alerts:test insists on at least one channel', () => {
    const errors = validateEnv('alerts:test', makeConfig(), parseArgs(['alerts:test']));
    expect(errors[0]).toContain('TELEGRAM_BOT_TOKEN');

    const configured = makeConfig({ alerts: { discordWebhookUrl: 'https://discord.test/hook' } });
    expect(validateEnv('alerts:test', configured, parseArgs(['alerts:test']))).toEqual([]);
  });

  test('analyze insists on a token argument', () => {
    const app = makeConfig({ anthropicApiKey: 'sk-test' });
    expect(validateEnv('analyze', app, parseArgs(['analyze']))[0]).toContain('analyze needs a token');
    expect(validateEnv('analyze', app, parseArgs(['analyze', 'solana:abc']))).toEqual([]);
  });
});

describe('colour', () => {
  test('NO_COLOR and non-tty win over everything', () => {
    expect(colorEnabled({ isTty: true, env: { NO_COLOR: '1' } })).toBe(false);
    expect(colorEnabled({ isTty: true, env: {}, noColor: true })).toBe(false);
    expect(colorEnabled({ isTty: false, env: {} })).toBe(false);
    expect(colorEnabled({ isTty: true, env: {} })).toBe(true);
    expect(colorEnabled({ isTty: true, env: { CI: 'true' } })).toBe(false);
    expect(colorEnabled({ isTty: false, env: { FORCE_COLOR: '1' } })).toBe(true);
  });
});
