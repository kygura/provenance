/**
 * Cost accounting for the only paid credential in the project.
 *
 * The pipeline runs twice a day against a per-run budget (`llm.maxCostUsdPerRun`),
 * so spend has to be known after every call, not estimated afterwards from logs.
 */

export interface ModelPricing {
  /** USD per 1,000,000 input tokens. */
  inputPerMTok: number;
  /** USD per 1,000,000 output tokens. */
  outputPerMTok: number;
}

/**
 * List price, USD per million tokens.
 *
 * SOURCE: the `claude-api` skill's "Current Models" table (skill cache date
 * 2026-06-24), read 2026-09-21. These are Anthropic first-party API rates;
 * Bedrock and Vertex are partner-priced and would need their own table.
 *
 * Keep this the ONLY place a price literal appears. When a model is added or
 * repriced, re-read the skill rather than editing from memory.
 */
export const MODEL_PRICING_USD_PER_MTOK: Readonly<Record<string, ModelPricing>> = {
  'claude-fable-5-1': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-mythos-5-1': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-5': { inputPerMTok: 2, outputPerMTok: 10 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
};

/**
 * Cache multipliers relative to the base input rate, per the `claude-api`
 * skill's prompt-caching section: a write costs ~1.25x an input token, a read
 * ~0.1x. Applied to the 5-minute (default) TTL.
 */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens written into the prompt cache on this call. */
  cacheWriteTokens?: number;
  /** Tokens served from the prompt cache on this call. */
  cacheReadTokens?: number;
}

/**
 * Resolve pricing for a model id, tolerating date-suffixed variants
 * (`claude-opus-5-20260401`) by falling back to the longest matching prefix.
 * Returns undefined for a genuinely unknown model — an honest "cost unknown"
 * beats a fabricated number in a budget check.
 */
export function resolvePricing(model: string): ModelPricing | undefined {
  const exact = MODEL_PRICING_USD_PER_MTOK[model];
  if (exact !== undefined) return exact;
  let best: { id: string; pricing: ModelPricing } | undefined;
  for (const [id, pricing] of Object.entries(MODEL_PRICING_USD_PER_MTOK)) {
    if (!model.startsWith(id)) continue;
    if (best === undefined || id.length > best.id.length) best = { id, pricing };
  }
  return best?.pricing;
}

function nonNegative(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

/** USD cost of one API call, or undefined when the model is not in the table. */
export function estimateCostUsd(model: string, usage: TokenUsage): number | undefined {
  const pricing = resolvePricing(model);
  if (pricing === undefined) return undefined;
  const perToken = pricing.inputPerMTok / 1_000_000;
  const cost =
    nonNegative(usage.inputTokens) * perToken +
    nonNegative(usage.cacheWriteTokens) * perToken * CACHE_WRITE_MULTIPLIER +
    nonNegative(usage.cacheReadTokens) * perToken * CACHE_READ_MULTIPLIER +
    nonNegative(usage.outputTokens) * (pricing.outputPerMTok / 1_000_000);
  // Six decimals: a single triage call can legitimately cost under a cent.
  return Number(cost.toFixed(6));
}

/** Shape of the `usage` block the Messages API returns. */
export interface ApiUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/**
 * Normalize the API's usage block. `input_tokens` from the API already EXCLUDES
 * cached tokens, so the three buckets are added, never double counted.
 */
export function usageFromResponse(usage: ApiUsageLike | null | undefined): TokenUsage {
  return {
    inputTokens: nonNegative(usage?.input_tokens ?? 0),
    outputTokens: nonNegative(usage?.output_tokens ?? 0),
    cacheWriteTokens: nonNegative(usage?.cache_creation_input_tokens ?? 0),
    cacheReadTokens: nonNegative(usage?.cache_read_input_tokens ?? 0),
  };
}

export interface CostEntry {
  model: string;
  usage: TokenUsage;
  costUsd: number;
  /** True when the model was missing from the price table and cost is a guess of 0. */
  unpriced: boolean;
  at: string;
}

/**
 * Running total for one pipeline run. The caller checks `exceeded()` before
 * spending on the next token rather than being interrupted mid-call, which
 * keeps every started report finishable.
 */
export class CostTracker {
  private readonly entries: CostEntry[] = [];
  private running = 0;

  constructor(readonly limitUsd: number = Number.POSITIVE_INFINITY) {}

  /** Record one API call; returns its cost in USD (0 when unpriced). */
  add(model: string, usage: TokenUsage): number {
    const priced = estimateCostUsd(model, usage);
    const costUsd = priced ?? 0;
    this.entries.push({
      model,
      usage,
      costUsd,
      unpriced: priced === undefined,
      at: new Date().toISOString(),
    });
    this.running = Number((this.running + costUsd).toFixed(6));
    return costUsd;
  }

  get totalUsd(): number {
    return this.running;
  }

  get callCount(): number {
    return this.entries.length;
  }

  history(): readonly CostEntry[] {
    return this.entries;
  }

  remainingUsd(): number {
    if (!Number.isFinite(this.limitUsd)) return Number.POSITIVE_INFINITY;
    return Number(Math.max(0, this.limitUsd - this.running).toFixed(6));
  }

  /** True once the budget is spent; the caller should stop analysing. */
  exceeded(): boolean {
    return this.running >= this.limitUsd;
  }

  /**
   * True when one more call of roughly this size would break the budget.
   * Used to decline a token cleanly instead of overshooting.
   */
  wouldExceed(estimatedUsd: number): boolean {
    return this.running + Math.max(0, estimatedUsd) > this.limitUsd;
  }

  reset(): void {
    this.entries.length = 0;
    this.running = 0;
  }
}
