/**
 * Settings. Everything tunable lives in config/provenance.toml; everything
 * secret lives in the environment.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadDotenv } from "dotenv";
import { parse as parseToml } from "smol-toml";

// From src/ (tsx) or dist/ (compiled) the repo root is one level up either way.
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_CONFIG_PATH = join(REPO_ROOT, "config", "provenance.toml");

function env(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

export interface Secrets {
  anthropicApiKey: string | null;
  dextoolsApiKey: string | null;
  heliusApiKey: string | null;
  etherscanApiKey: string | null;
  birdeyeApiKey: string | null;
  telegramBotToken: string | null;
  telegramChatId: string | null;
  discordWebhookUrl: string | null;
  githubToken: string | null;
  githubRepository: string | null;
}

export function loadSecrets(): Secrets {
  loadDotenv({ path: join(REPO_ROOT, ".env"), override: false, quiet: true });
  return {
    anthropicApiKey: env("ANTHROPIC_API_KEY"),
    dextoolsApiKey: env("DEXTOOLS_API_KEY"),
    heliusApiKey: env("HELIUS_API_KEY"),
    etherscanApiKey: env("ETHERSCAN_API_KEY"),
    birdeyeApiKey: env("BIRDEYE_API_KEY"),
    telegramBotToken: env("TELEGRAM_BOT_TOKEN"),
    telegramChatId: env("TELEGRAM_CHAT_ID"),
    discordWebhookUrl: env("DISCORD_WEBHOOK_URL"),
    githubToken: env("GITHUB_TOKEN"),
    githubRepository: env("GITHUB_REPOSITORY"),
  };
}

export interface SourceConfig {
  chains: string[];
  dextoolsPlan: string;
  dextoolsEnabled: boolean;
  dexscreenerEnabled: boolean;
  geckoterminalEnabled: boolean;
  perSourceLimit: number;
}

export interface FilterConfig {
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  maxAgeHours: number | null;
  minAgeHours: number;
  maxTop10Pct: number | null;
  requireSocials: boolean;
}

export interface ResearchConfig {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens: number;
  maxWebSearches: number;
  maxTokensPerRun: number;
  maxPauseTurnRestarts: number;
}

export interface AlertConfig {
  minRecycleConfidence: number;
  noveltyAllowlist: string[];
  realertAfterHours: number;
  writeMarkdownReport: boolean;
  reportsDir: string;
}

export interface Config {
  sources: SourceConfig;
  filters: FilterConfig;
  research: ResearchConfig;
  alerts: AlertConfig;
  statePath: string;
  secrets: Secrets;
}

export const DEFAULTS = {
  sources: {
    chains: ["solana", "ethereum", "base", "bsc"],
    dextoolsPlan: "trial",
    dextoolsEnabled: true,
    dexscreenerEnabled: true,
    geckoterminalEnabled: true,
    perSourceLimit: 30,
  } satisfies SourceConfig,
  filters: {
    minLiquidityUsd: 25_000,
    minVolume24hUsd: 50_000,
    maxAgeHours: 24 * 21,
    minAgeHours: 1,
    maxTop10Pct: 92,
    requireSocials: false,
  } satisfies FilterConfig,
  research: {
    model: "claude-opus-5",
    effort: "high",
    maxTokens: 16_000,
    maxWebSearches: 8,
    maxTokensPerRun: 6,
    maxPauseTurnRestarts: 4,
  } satisfies ResearchConfig,
  alerts: {
    minRecycleConfidence: 55,
    noveltyAllowlist: ["pure-rerun", "remix", "novel"],
    realertAfterHours: 72,
    writeMarkdownReport: true,
    reportsDir: "reports",
  } satisfies AlertConfig,
  statePath: "state/provenance.sqlite3",
};

/**
 * TOML keys are snake_case (that is what a config file should look like);
 * everything in the code is camelCase. This maps between them rather than
 * leaking snake_case into the type system.
 */
function section<T extends object>(defaults: T, raw: unknown): T {
  if (typeof raw !== "object" || raw === null) return { ...defaults };
  const table = raw as Record<string, unknown>;
  const out = { ...defaults } as Record<string, unknown>;
  for (const key of Object.keys(defaults)) {
    const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
    const value = table[snake] ?? table[key];
    if (value !== undefined) out[key] = value;
  }
  return out as T;
}

export function loadConfig(path?: string | null): Config {
  const target = path ?? DEFAULT_CONFIG_PATH;
  let raw: Record<string, unknown> = {};
  if (existsSync(target)) {
    raw = parseToml(readFileSync(target, "utf8")) as Record<string, unknown>;
  }
  return {
    sources: section(DEFAULTS.sources, raw.sources),
    filters: section(DEFAULTS.filters, raw.filters),
    research: section(DEFAULTS.research, raw.research),
    alerts: section(DEFAULTS.alerts, raw.alerts),
    statePath: typeof raw.state_path === "string" ? raw.state_path : DEFAULTS.statePath,
    secrets: loadSecrets(),
  };
}

export function resolvedStatePath(config: Config): string {
  return isAbsolute(config.statePath) ? config.statePath : join(REPO_ROOT, config.statePath);
}
