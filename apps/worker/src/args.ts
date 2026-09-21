/**
 * Bun-native argument parsing. No dependency, and deliberately dumb: a flag is
 * either known to take a value or it is a boolean, and anything unrecognised is
 * a configuration error rather than a silently ignored typo.
 */
import { type AppConfig, type Chain, normalizeChain } from '@provenance/core';

export const COMMANDS = [
  'run',
  'discover',
  'analyze',
  'migrate',
  'seed',
  'alerts:test',
  'report',
  'help',
  'version',
] as const;

export type CommandName = (typeof COMMANDS)[number];

export function isCommand(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value);
}

/** Flags that consume the following argument when not written as `--flag=value`. */
export const VALUE_FLAGS = ['limit', 'chains', 'sources', 'run', 'format'] as const;

export const BOOLEAN_FLAGS = [
  'dry-run',
  'fixtures',
  'no-llm',
  'verbose',
  'no-color',
  'help',
  'version',
] as const;

const SHORT: Record<string, string> = {
  v: 'verbose',
  h: 'help',
  n: 'dry-run',
};

export type FlagValue = string | boolean;

export interface ParsedArgs {
  command?: CommandName;
  positionals: string[];
  flags: Record<string, FlagValue>;
  /** Parse-time complaints: unknown flags, missing values. Exit code 2 material. */
  errors: string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], flags: {}, errors: [] };
  const rest: string[] = [];
  let passthrough = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;

    if (passthrough) {
      rest.push(arg);
      continue;
    }
    if (arg === '--') {
      passthrough = true;
      continue;
    }

    if (arg.startsWith('--') || (arg.startsWith('-') && arg.length > 1)) {
      const long = arg.startsWith('--');
      const body = long ? arg.slice(2) : arg.slice(1);
      const eq = body.indexOf('=');
      const rawName = eq === -1 ? body : body.slice(0, eq);
      const inline = eq === -1 ? undefined : body.slice(eq + 1);
      const name = long ? rawName : (SHORT[rawName] ?? rawName);

      if ((VALUE_FLAGS as readonly string[]).includes(name)) {
        const value = inline ?? argv[++i];
        if (value === undefined || value.startsWith('-')) {
          parsed.errors.push(`--${name} expects a value`);
          continue;
        }
        parsed.flags[name] = value;
        continue;
      }

      if ((BOOLEAN_FLAGS as readonly string[]).includes(name)) {
        parsed.flags[name] = inline === undefined ? true : !['0', 'false', 'no'].includes(inline);
        continue;
      }

      parsed.errors.push(`unknown flag: ${long ? '--' : '-'}${rawName}`);
      continue;
    }

    if (!parsed.command) {
      if (isCommand(arg)) parsed.command = arg;
      else parsed.errors.push(`unknown command: ${arg}`);
      continue;
    }
    rest.push(arg);
  }

  parsed.positionals = rest;
  return parsed;
}

export function flagString(flags: Record<string, FlagValue>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function flagBool(flags: Record<string, FlagValue>, name: string): boolean {
  return flags[name] === true;
}

export function flagNumber(
  flags: Record<string, FlagValue>,
  name: string,
): { value?: number; error?: string } {
  const raw = flagString(flags, name);
  if (raw === undefined) return {};
  const value = Number(raw);
  if (!Number.isFinite(value)) return { error: `--${name} expects a number, got "${raw}"` };
  return { value };
}

export interface AppliedArgs {
  app: AppConfig;
  errors: string[];
}

/**
 * Folds CLI flags onto a loaded config. Returns a copy: the caller may want the
 * untouched environment view (`alerts:test` does).
 */
export function applyFlags(app: AppConfig, parsed: ParsedArgs): AppliedArgs {
  const errors: string[] = [];
  const pipeline = { ...app.pipeline, sources: app.pipeline.sources.map((s) => ({ ...s })) };
  const next: AppConfig = { ...app, pipeline };

  const limit = flagNumber(parsed.flags, 'limit');
  if (limit.error) errors.push(limit.error);
  else if (limit.value !== undefined) pipeline.maxTokensPerRun = Math.max(0, Math.trunc(limit.value));

  const chains = flagString(parsed.flags, 'chains');
  if (chains !== undefined) {
    const wanted: Chain[] = chains
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map(normalizeChain);
    if (wanted.includes('unknown')) errors.push(`--chains contains an unrecognised chain: ${chains}`);
    pipeline.chains = wanted.filter((chain) => chain !== 'unknown');
  }

  const sources = flagString(parsed.flags, 'sources');
  if (sources !== undefined) {
    const wanted = sources
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean);
    const known = pipeline.sources.map((source) => source.id as string);
    for (const id of wanted) {
      if (!known.includes(id)) errors.push(`--sources contains an unknown source: ${id}`);
    }
    for (const source of pipeline.sources) source.enabled = wanted.includes(source.id);
  }

  if (flagBool(parsed.flags, 'dry-run')) pipeline.dryRun = true;
  if (flagBool(parsed.flags, 'fixtures')) pipeline.useFixtures = true;
  if (flagBool(parsed.flags, 'verbose')) next.logLevel = 'debug';

  const format = flagString(parsed.flags, 'format');
  if (format !== undefined && !['table', 'json', 'markdown'].includes(format)) {
    errors.push(`--format must be one of table|json|markdown, got "${format}"`);
  }

  return { app: next, errors };
}

/** True when the model should not be called at all for this invocation. */
export function llmDisabled(app: AppConfig, parsed: ParsedArgs): boolean {
  return flagBool(parsed.flags, 'no-llm') || app.pipeline.useFixtures;
}

/**
 * Environment checks per command. Every message names the variable to set, so a
 * misconfigured cron run says exactly what is missing (exit code 2).
 */
export function validateEnv(command: CommandName, app: AppConfig, parsed: ParsedArgs): string[] {
  const errors: string[] = [];
  const needsLlm = (command === 'run' || command === 'analyze') && !llmDisabled(app, parsed);

  if (needsLlm && !app.anthropicApiKey) {
    errors.push(
      'ANTHROPIC_API_KEY is not set. It is the only paid credential; pass --fixtures or --no-llm to run without it.',
    );
  }
  if (!app.databaseUrl) {
    errors.push('DATABASE_URL is not set and no default applied.');
  }
  if (app.databaseUrl.startsWith('libsql://') && !app.databaseAuthToken) {
    errors.push('DATABASE_AUTH_TOKEN is required for a remote libsql:// DATABASE_URL.');
  }
  if (command === 'alerts:test') {
    const alerts = app.alerts;
    const configured =
      (alerts.telegramBotToken && alerts.telegramChatId) ||
      alerts.discordWebhookUrl ||
      alerts.genericWebhookUrl ||
      alerts.fileSink;
    if (!configured) {
      errors.push(
        'No alert channel configured: set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, DISCORD_WEBHOOK_URL, ALERT_WEBHOOK_URL or ALERT_FILE_SINK.',
      );
    }
  }
  if (command === 'analyze' && parsed.positionals.length === 0) {
    errors.push('analyze needs a token: `analyze <chain:address>` (e.g. solana:So111…).');
  }
  return errors;
}
