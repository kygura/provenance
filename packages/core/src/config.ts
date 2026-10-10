import { type Chain, normalizeChain } from './chains';
import type { SourceId } from './market';
import { SOCIAL_PLATFORMS, type SocialPlatform } from './social';

export interface SourceConfig {
  id: SourceId;
  enabled: boolean;
  /** Max rows to take from this source per run. */
  limit: number;
  /** Milliseconds between requests to this source. */
  rateLimitMs: number;
}

export interface PipelineConfig {
  /** Chains to keep. Empty array means keep everything. */
  chains: Chain[];
  sources: SourceConfig[];
  /** Tokens surviving triage that get the full chain + LLM treatment. */
  maxTokensPerRun: number;
  /** Minimum USD liquidity to bother analysing. */
  minLiquidityUsd: number;
  /** Minimum 24h USD volume to bother analysing. */
  minVolume24hUsd: number;
  /** Skip tokens whose pool is younger than this; nothing to research yet. */
  minPoolAgeHours: number;
  /** Skip re-running the LLM on a token analysed within this window. */
  reanalyseAfterHours: number;
  /** Alert when the composite score is at or above this. */
  alertScoreThreshold: number;
  dryRun: boolean;
  /** Read from fixtures instead of the network. Used by tests and offline dev. */
  useFixtures: boolean;
}

/**
 * Where a model is served. `anthropic` uses the Messages API; everything else
 * speaks the OpenAI chat-completions dialect, each with its own way (or none)
 * of searching the web.
 */
export const LLM_PROVIDERS = [
  'anthropic',
  'openai',
  'openrouter',
  'moonshot',
  'qwen',
  'deepseek',
  'openai-compatible',
] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export interface ModelSpec {
  provider: LlmProvider;
  model: string;
}

const INFERRED: ReadonlyArray<[RegExp, LlmProvider]> = [
  [/^claude-/, 'anthropic'],
  [/^(gpt-|o\d|chatgpt-)/, 'openai'],
  [/^(kimi-|moonshot-)/, 'moonshot'],
  [/^qwen/, 'qwen'],
  [/^deepseek-/, 'deepseek'],
];

/**
 * `provider:model` parsing. A bare id keeps working (`LLM_MODEL=claude-opus-5`
 * predates provider prefixes), with the provider inferred from well-known
 * prefixes.
 */
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

/** Anthropic models each role falls back to under Anthropic-first. */
export const ANTHROPIC_ROLE_MODELS = {
  model: 'claude-opus-5',
  extractModel: 'claude-opus-5',
  triageModel: 'claude-sonnet-5',
} as const;

/**
 * Anthropic goes first: with an Anthropic key, a role configured for another
 * provider runs on that role's Anthropic model instead. Other providers are
 * used only when there is no Anthropic key, or when LLM_ANTHROPIC_FIRST=false.
 */
function anthropicFirst(
  llm: Pick<LlmConfig, 'model' | 'extractModel' | 'triageModel'>,
): Pick<LlmConfig, 'model' | 'extractModel' | 'triageModel'> {
  const pick = (spec: string, fallback: string) =>
    parseModelSpec(spec).provider === 'anthropic' ? spec : fallback;
  return {
    model: pick(llm.model, ANTHROPIC_ROLE_MODELS.model),
    extractModel: pick(llm.extractModel ?? llm.model, ANTHROPIC_ROLE_MODELS.extractModel),
    triageModel: pick(llm.triageModel, ANTHROPIC_ROLE_MODELS.triageModel),
  };
}

export interface LlmProviderConfig {
  apiKey?: string;
  /** Override for the provider's default API root. Required for `openai-compatible`. */
  baseUrl?: string;
  /** Anthropic only: sent as anthropic-workspace-id, required by keys not scoped to a workspace (sk-ant-usr-…). */
  workspaceId?: string;
}

export interface LlmConfig {
  /**
   * Model used for the deep provenance synthesis, as `provider:model` or a bare
   * id whose provider is inferred (`claude-*` -> anthropic, `gpt-*` -> openai,
   * `kimi-*` -> moonshot, `qwen*` -> qwen, `deepseek-*` -> deepseek).
   */
  model: string;
  /**
   * Model for the extraction pass (notes -> typed report). No web search, so a
   * cheap model does the job; defaults to `model`.
   */
  extractModel: string;
  /** Cheaper model for triage/classification passes. Same spec format as `model`. */
  triageModel: string;
  providers: Record<LlmProvider, LlmProviderConfig>;
  /**
   * Price overrides, USD per million tokens, keyed by model id (without the
   * provider prefix). Parsed from `LLM_PRICING="gpt-5.4-mini=0.75/4.5,..."`.
   */
  pricing: Record<string, { inputPerMTok: number; outputPerMTok: number }>;
  maxOutputTokens: number;
  /** Hard ceiling on spend per run; the pipeline stops analysing past it. */
  maxCostUsdPerRun: number;
  temperature: number;
  /**
   * Ceiling on server-side web searches in one token's research pass. The
   * single biggest lever on both cost and research depth — six is enough to
   * date a meme and find two prior cycles without wandering.
   */
  maxWebSearches: number;
}

/**
 * The launch lane: where tokens are judged, at their first pool rather than
 * once they trend. Thresholds are hard filters that keep garbage away from the
 * anchor check, not score inputs. Defaults assume a run every 30 minutes: a
 * launch that fails a filter early (too few holders yet) is retried on every
 * run while it is inside `lookbackHours`.
 */
export interface LaunchConfig {
  enabled: boolean;
  /** How far back to read factory events on each run. */
  lookbackHours: number;
  /** New pools hydrated per run, newest first. */
  maxCandidates: number;
  /** Tokens given chain analysis and an anchor check per run. */
  maxCatalogPerRun: number;
  /** Unlike the trending filter, unknown liquidity is a rejection here. */
  minLiquidityUsd: number;
  minHolderCount: number;
  /** Top-10 non-LP concentration ceiling, percent. */
  maxTop10Pct: number;
  /** Reject when LP burn/lock could not be measured, not only when it is low. */
  requireLpSecured: boolean;
  /** Burned + locked LP share required to count as secured, percent. */
  minLpSecuredPct: number;
  /** An active entry that has not expressed after this long goes dormant. */
  dormantAfterHours: number;
  /** Web searches allowed per fast anchor check. */
  maxAnchorSearches: number;
  /** Run the full provenance research on anchored launches, at launch. */
  researchAnchored: boolean;
}

/**
 * Crypto-social sightings from Elfa's trending contract-address feeds. Optional:
 * with no key the step is skipped and nothing else changes. Defaults fit Elfa's
 * free tier (1,000 credits a month): two feeds at one credit each, every two
 * hours, is about 720, leaving room for hypertrade's collector on the same key.
 */
export interface SocialConfig {
  elfaApiKey?: string;
  /**
   * Minimum hours between fetches, measured across runs. Without it the
   * 30-minute launch lane alone would spend about 2,900 credits a month.
   */
  minIntervalHours: number;
  /** Elfa's `minMentions`: contracts below it are not returned. */
  minMentions: number;
  /** Rows per feed per fetch. One page is one credit. */
  pageSize: number;
  platforms: SocialPlatform[];
  rateLimitMs: number;
}

export interface ChainRpcConfig {
  solana: string[];
  ethereum: string[];
  base: string[];
  bsc: string[];
  arbitrum: string[];
  polygon: string[];
  avalanche: string[];
}

export interface AlertConfig {
  telegramBotToken?: string;
  telegramChatId?: string;
  discordWebhookUrl?: string;
  genericWebhookUrl?: string;
  /** Write every alert to disk regardless of remote channels. */
  fileSink?: string;
}

export interface AppConfig {
  databaseUrl: string;
  databaseAuthToken?: string;
  anthropicApiKey?: string;
  /** Optional: enables `contractVerified`. Every other EVM read is keyless. */
  etherscanApiKey?: string;
  /** Exa search, used to find DexTools pair pages without fetching DexTools. */
  exaApiKey?: string;
  pipeline: PipelineConfig;
  launches: LaunchConfig;
  social: SocialConfig;
  llm: LlmConfig;
  rpc: ChainRpcConfig;
  alerts: AlertConfig;
  /** Root for fixtures, artifacts and the local sqlite file. */
  dataDir: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/** `id=in/out,id2=in/out` -> price table. Malformed entries are skipped, not guessed. */
function pricing(value: string | undefined): LlmConfig['pricing'] {
  const out: LlmConfig['pricing'] = {};
  for (const entry of list(value)) {
    const match = /^(.+?)=([\d.]+)\/([\d.]+)$/.exec(entry);
    if (!match) continue;
    const input = Number(match[2]);
    const output = Number(match[3]);
    if (Number.isFinite(input) && Number.isFinite(output)) {
      out[(match[1] as string).trim()] = { inputPerMTok: input, outputPerMTok: output };
    }
  }
  return out;
}

/** Unknown names are dropped; a blank or fully unknown list means every platform. */
function socialPlatforms(value: string | undefined): SocialPlatform[] {
  const wanted = list(value).map((part) => part.toLowerCase());
  const known = SOCIAL_PLATFORMS.filter((platform) => wanted.includes(platform));
  return known.length > 0 ? known : [...SOCIAL_PLATFORMS];
}

const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/**
 * Turso tokens are JWTs, and a JWT has no whitespace, quotes or `=`. A secret
 * pasted as a whole `NAME= eyJ...` line, quoted, or wrapped across lines
 * carries characters that are illegal in the Authorization header libsql
 * builds from it, and so does a look-alike dash a rich-text paste put in place
 * of `-`. When the value holds exactly one JWT, that JWT is the token.
 */
export function extractJwt(value: string | undefined): string | undefined {
  if (!value) return value;
  // Rich-text editors and chat apps swap `-` for a Unicode dash and pad with
  // zero-width characters; NFKC plus the dash fold undoes both. A JWT is pure
  // ASCII, so nothing a real token contains is changed by this.
  const folded = value
    .normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212\uFE63\uFF0D]/g, '-')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '');
  const found = folded.match(JWT) ?? folded.replace(/\s+/g, '').match(JWT);
  return found && found.length === 1 ? found[0] : value;
}

function list(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Every knob is an env var so the same build runs locally, in GitHub Actions and
 * on Vercel without code changes. Defaults are tuned to be conservative: a run
 * with no configuration does something sensible and cheap.
 */
export function loadConfig(raw: Record<string, string | undefined> = process.env): AppConfig {
  // A value pasted into a secrets form often brings a leading space or a
  // trailing newline. In a token that becomes an invalid Authorization header,
  // which fails far from the paste that caused it. No setting here means
  // anything by surrounding whitespace.
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(raw)) env[key] = value?.trim();
  const chains = list(env.PROVENANCE_CHAINS).map(normalizeChain);
  // Your own endpoints lead and the public ones follow, so a keyed node that
  // rate-limits or refuses a range (Alchemy's free eth_getLogs cap) still has
  // somewhere to fail over to. RPC_PUBLIC_FALLBACK=false keeps only your list.
  const publicFallback = bool(env.RPC_PUBLIC_FALLBACK, true);
  const rpcOr = (key: string, fallback: string[]): string[] => {
    const configured = list(env[key]);
    if (configured.length === 0) return fallback;
    if (!publicFallback) return configured;
    return [...new Set([...configured, ...fallback])];
  };

  return {
    databaseUrl: env.DATABASE_URL ?? 'file:./data/provenance.db',
    databaseAuthToken: extractJwt(env.DATABASE_AUTH_TOKEN),
    anthropicApiKey: env.ANTHROPIC_API_KEY,
    etherscanApiKey: env.ETHERSCAN_API_KEY,
    exaApiKey: env.EXA_API_KEY || undefined,
    dataDir: env.PROVENANCE_DATA_DIR ?? './data',
    logLevel: (env.LOG_LEVEL as AppConfig['logLevel']) ?? 'info',
    pipeline: {
      chains,
      sources: [
        {
          id: 'dextools',
          enabled: bool(env.SOURCE_DEXTOOLS, true),
          limit: num(env.SOURCE_DEXTOOLS_LIMIT, 30),
          rateLimitMs: num(env.SOURCE_DEXTOOLS_RATE_MS, 2500),
        },
        {
          id: 'dexscreener',
          enabled: bool(env.SOURCE_DEXSCREENER, true),
          limit: num(env.SOURCE_DEXSCREENER_LIMIT, 30),
          rateLimitMs: num(env.SOURCE_DEXSCREENER_RATE_MS, 1200),
        },
        {
          id: 'geckoterminal',
          enabled: bool(env.SOURCE_GECKOTERMINAL, true),
          limit: num(env.SOURCE_GECKOTERMINAL_LIMIT, 30),
          rateLimitMs: num(env.SOURCE_GECKOTERMINAL_RATE_MS, 2200),
        },
        {
          id: 'launches',
          enabled: bool(env.LAUNCHES_ENABLED, true),
          limit: num(env.LAUNCHES_MAX_CANDIDATES, 40),
          rateLimitMs: num(env.LAUNCHES_RATE_MS, 250),
        },
      ],
      maxTokensPerRun: num(env.MAX_TOKENS_PER_RUN, 15),
      minLiquidityUsd: num(env.MIN_LIQUIDITY_USD, 25_000),
      minVolume24hUsd: num(env.MIN_VOLUME_24H_USD, 100_000),
      minPoolAgeHours: num(env.MIN_POOL_AGE_HOURS, 2),
      reanalyseAfterHours: num(env.REANALYSE_AFTER_HOURS, 72),
      alertScoreThreshold: num(env.ALERT_SCORE_THRESHOLD, 70),
      dryRun: bool(env.DRY_RUN, false),
      useFixtures: bool(env.USE_FIXTURES, false),
    },
    llm: {
      ...((): Pick<LlmConfig, 'model' | 'extractModel' | 'triageModel'> => {
        const configured = {
          model: env.LLM_MODEL || 'claude-opus-5',
          extractModel: env.LLM_EXTRACT_MODEL || env.LLM_MODEL || 'claude-opus-5',
          triageModel: env.LLM_TRIAGE_MODEL || 'claude-sonnet-5',
        };
        return env.ANTHROPIC_API_KEY && bool(env.LLM_ANTHROPIC_FIRST, true) ? anthropicFirst(configured) : configured;
      })(),
      providers: {
        anthropic: {
          apiKey: env.ANTHROPIC_API_KEY || undefined,
          baseUrl: env.ANTHROPIC_BASE_URL || undefined,
          workspaceId: env.ANTHROPIC_WORKSPACE_ID || undefined,
        },
        openai: { apiKey: env.OPENAI_API_KEY || undefined, baseUrl: env.OPENAI_BASE_URL || undefined },
        openrouter: { apiKey: env.OPENROUTER_API_KEY || undefined, baseUrl: env.OPENROUTER_BASE_URL || undefined },
        moonshot: {
          apiKey: env.MOONSHOT_API_KEY || env.KIMI_API_KEY || undefined,
          baseUrl: env.MOONSHOT_BASE_URL || undefined,
        },
        qwen: {
          apiKey: env.DASHSCOPE_API_KEY || env.QWEN_API_KEY || undefined,
          baseUrl: env.DASHSCOPE_BASE_URL || undefined,
        },
        deepseek: { apiKey: env.DEEPSEEK_API_KEY || undefined, baseUrl: env.DEEPSEEK_BASE_URL || undefined },
        'openai-compatible': {
          apiKey: env.OPENAI_COMPATIBLE_API_KEY || undefined,
          baseUrl: env.OPENAI_COMPATIBLE_BASE_URL || undefined,
        },
      },
      pricing: pricing(env.LLM_PRICING),
      maxOutputTokens: num(env.LLM_MAX_OUTPUT_TOKENS, 4096),
      maxCostUsdPerRun: num(env.LLM_MAX_COST_USD_PER_RUN, 5),
      temperature: num(env.LLM_TEMPERATURE, 0.2),
      maxWebSearches: num(env.LLM_MAX_WEB_SEARCHES, 6),
    },
    launches: {
      enabled: bool(env.LAUNCHES_ENABLED, true),
      lookbackHours: num(env.LAUNCHES_LOOKBACK_HOURS, 6),
      maxCandidates: num(env.LAUNCHES_MAX_CANDIDATES, 40),
      maxCatalogPerRun: num(env.LAUNCHES_MAX_CATALOG_PER_RUN, 8),
      minLiquidityUsd: num(env.LAUNCHES_MIN_LIQUIDITY_USD, 40_000),
      minHolderCount: num(env.LAUNCHES_MIN_HOLDERS, 50),
      maxTop10Pct: num(env.LAUNCHES_MAX_TOP10_PCT, 40),
      requireLpSecured: bool(env.LAUNCHES_REQUIRE_LP_SECURED, true),
      minLpSecuredPct: num(env.LAUNCHES_MIN_LP_SECURED_PCT, 90),
      dormantAfterHours: num(env.LAUNCHES_DORMANT_AFTER_HOURS, 168),
      maxAnchorSearches: num(env.LAUNCHES_MAX_ANCHOR_SEARCHES, 3),
      researchAnchored: bool(env.LAUNCHES_RESEARCH_ANCHORED, true),
    },
    social: {
      elfaApiKey: env.ELFA_API_KEY || undefined,
      minIntervalHours: num(env.ELFA_MIN_INTERVAL_HOURS, 2),
      minMentions: num(env.ELFA_MIN_MENTIONS, 5),
      pageSize: num(env.ELFA_PAGE_SIZE, 50),
      platforms: socialPlatforms(env.ELFA_PLATFORMS),
      rateLimitMs: num(env.ELFA_RATE_MS, 1100),
    },
    rpc: {
      // Public, keyless, tried in order after any configured endpoint.
      // publicnode.com is Allnodes' open tier. api.mainnet-beta 429s under any
      // load and Ankr now requires a key, so neither can lead.
      solana: rpcOr('RPC_SOLANA', [
        'https://solana-rpc.publicnode.com',
        'https://solana.drpc.org',
        'https://api.mainnet-beta.solana.com',
      ]),
      ethereum: rpcOr('RPC_ETHEREUM', [
        'https://ethereum-rpc.publicnode.com',
        'https://eth.drpc.org',
        'https://1rpc.io/eth',
        'https://eth.llamarpc.com',
      ]),
      base: rpcOr('RPC_BASE', ['https://mainnet.base.org', 'https://base-rpc.publicnode.com']),
      bsc: rpcOr('RPC_BSC', ['https://bsc-dataseed.binance.org', 'https://bsc-rpc.publicnode.com']),
      arbitrum: rpcOr('RPC_ARBITRUM', ['https://arb1.arbitrum.io/rpc']),
      polygon: rpcOr('RPC_POLYGON', ['https://polygon-rpc.com']),
      avalanche: rpcOr('RPC_AVALANCHE', ['https://api.avax.network/ext/bc/C/rpc']),
    },
    alerts: {
      telegramBotToken: env.TELEGRAM_BOT_TOKEN,
      telegramChatId: env.TELEGRAM_CHAT_ID,
      discordWebhookUrl: env.DISCORD_WEBHOOK_URL,
      genericWebhookUrl: env.ALERT_WEBHOOK_URL,
      fileSink: env.ALERT_FILE_SINK,
    },
  };
}
