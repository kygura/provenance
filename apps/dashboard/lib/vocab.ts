import type { Chain, RecycleVerdict, RiskSeverity, ScoreTier } from '@provenance/core';

/**
 * The presentational vocabulary: for every categorical value the UI renders,
 * a colour AND a glyph AND a word. Colour is never the only carrier — a reader
 * with any form of colour-vision deficiency, or a printed page, still gets the
 * category from the glyph and the label.
 */

export interface Token {
  /** CSS colour for the mark beside the label. Never used as text colour. */
  color: string;
  /** Short shape/letter that survives greyscale. */
  glyph: string;
  label: string;
  /** Long-form meaning, used in `title` and on the dossier page. */
  hint?: string;
}

export const TIERS: readonly ScoreTier[] = ['S', 'A', 'B', 'C', 'D'];

/**
 * Tier is an ordered scale, so it gets a single-hue ordinal ramp rather than five
 * categorical hues — and the letter itself is the primary channel.
 * Validated with `--ordinal` against the dark surface: monotone lightness,
 * adjacent ΔL ≥ 0.06, darkest step 2.15:1 on #1a1a19.
 */
const TIER_RAMP: Record<ScoreTier, string> = {
  S: 'var(--color-blue-150)',
  A: 'var(--color-blue-250)',
  B: 'var(--color-blue-350)',
  C: 'var(--color-blue-500)',
  D: 'var(--color-blue-600)',
};

const TIER_HINT: Record<ScoreTier, string> = {
  S: 'Top tier — strongest composite score',
  A: 'Strong composite score',
  B: 'Middling composite score',
  C: 'Weak composite score',
  D: 'Bottom tier — weakest composite score',
};

export function tierToken(tier: ScoreTier | undefined): Token {
  if (tier === undefined || !TIERS.includes(tier)) {
    return { color: 'var(--color-ink-muted)', glyph: '–', label: 'unscored', hint: 'No score for this token in this run' };
  }
  return { color: TIER_RAMP[tier], glyph: tier, label: tier, hint: TIER_HINT[tier] };
}

export const VERDICTS: readonly RecycleVerdict[] = [
  'original',
  'revival',
  'derivative',
  'copycat',
  'unclear',
];

/**
 * Verdict uses **emphasis**, not a five-hue categorical set. The thesis is that a
 * revival is the tradeable shape and a copycat is the anti-signal, so those two
 * take categorical slots 1 and 2 (validated all-pairs on the dark surface) and the
 * remaining verdicts stay in neutral ink. Five hues could not have cleared the
 * all-pairs floors, and would have flattened the one distinction that matters.
 */
const VERDICT_TOKENS: Record<RecycleVerdict, Token> = {
  revival: {
    color: 'var(--color-series-1)',
    glyph: '↻',
    label: 'revival',
    hint: 'A dormant meme brought back, typically years later — the setup this project looks for',
  },
  copycat: {
    color: 'var(--color-series-2)',
    glyph: '≡',
    label: 'copycat',
    hint: 'Rides a currently-running meme with no differentiation',
  },
  original: {
    color: 'var(--color-ink-2)',
    glyph: '◆',
    label: 'original',
    hint: 'The meme is genuinely new, or this is its first tokenisation',
  },
  derivative: {
    color: 'var(--color-ink-2)',
    glyph: '⊳',
    label: 'derivative',
    hint: 'Builds on a live meme with a real twist',
  },
  unclear: {
    color: 'var(--color-ink-muted)',
    glyph: '?',
    label: 'unclear',
    hint: 'Evidence insufficient to classify',
  },
};

export function verdictToken(verdict: RecycleVerdict | undefined): Token {
  if (verdict === undefined || !(verdict in VERDICT_TOKENS)) {
    return {
      color: 'var(--color-ink-muted)',
      glyph: '·',
      label: 'no report',
      hint: 'No provenance report for this token in this run',
    };
  }
  return VERDICT_TOKENS[verdict];
}

/** Reserved status palette. Icon + label always ship with the colour. */
const SEVERITY_TOKENS: Record<RiskSeverity, Token> = {
  info: { color: 'var(--color-ink-muted)', glyph: 'i', label: 'info' },
  warn: { color: 'var(--color-warning)', glyph: '▲', label: 'warn' },
  critical: { color: 'var(--color-critical)', glyph: '✕', label: 'critical' },
};

export function severityToken(severity: RiskSeverity | undefined): Token {
  if (severity === undefined || !(severity in SEVERITY_TOKENS)) {
    return SEVERITY_TOKENS.info;
  }
  return SEVERITY_TOKENS[severity];
}

/** Sort order for listing flags and alerts worst-first. */
export const SEVERITY_RANK: Record<RiskSeverity, number> = {
  critical: 0,
  warn: 1,
  info: 2,
};

/** Short, unambiguous chain labels for a dense table cell. */
const CHAIN_LABELS: Record<Chain, string> = {
  solana: 'SOL',
  ethereum: 'ETH',
  base: 'BASE',
  bsc: 'BSC',
  arbitrum: 'ARB',
  polygon: 'POLY',
  avalanche: 'AVAX',
  sui: 'SUI',
  ton: 'TON',
  blast: 'BLAST',
  hyperliquid: 'HL',
  unknown: '?',
};

export function chainLabel(chain: string | undefined): string {
  if (chain === undefined) return '?';
  return CHAIN_LABELS[chain as Chain] ?? chain.slice(0, 5).toUpperCase();
}

/** Score components, in the order the composite reads best. */
export const SCORE_COMPONENTS = [
  { key: 'recycling', label: 'Recycling', hint: 'Strength of the recycled-narrative setup' },
  { key: 'memetic', label: 'Memetic', hint: 'Memetic durability × cultural reach' },
  { key: 'authenticity', label: 'Authenticity', hint: 'Is this the canonical carrier of the meme' },
  { key: 'distribution', label: 'Distribution', hint: 'Holder distribution health: inverse of concentration' },
  { key: 'liquidity', label: 'Liquidity', hint: 'Liquidity depth relative to market cap' },
  { key: 'momentum', label: 'Momentum', hint: 'Volume and price momentum' },
] as const;

const METHOD_HINTS: Record<string, string> = {
  rpc: 'Read directly from a public RPC node',
  explorer: 'Scraped from a public block explorer',
  indexer: 'Read from a public indexer',
  partial: 'Only part of the analysis completed',
  unavailable: 'No on-chain analysis was possible for this token',
};

export function methodHint(method: string | undefined): string {
  if (method === undefined) return 'No on-chain analysis recorded';
  return METHOD_HINTS[method] ?? method;
}

/** Evidence quality is a 0..1 collector weight; three buckets is all a reader needs. */
export function evidenceQuality(value: number | undefined): Token {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return { color: 'var(--color-ink-muted)', glyph: '○○○', label: 'unrated' };
  }
  if (value >= 0.7) return { color: 'var(--color-blue-250)', glyph: '●●●', label: 'strong source' };
  if (value >= 0.4) return { color: 'var(--color-blue-400)', glyph: '●●○', label: 'fair source' };
  return { color: 'var(--color-blue-600)', glyph: '●○○', label: 'weak source' };
}

const LINEAGE_KIND_TOKENS: Record<string, Token> = {
  origin: { color: 'var(--color-blue-150)', glyph: '◆', label: 'origin' },
  revival: { color: 'var(--color-series-1)', glyph: '↻', label: 'revival' },
  derivative: { color: 'var(--color-blue-500)', glyph: '⊳', label: 'derivative' },
  'platform-shift': { color: 'var(--color-blue-600)', glyph: '⇄', label: 'platform shift' },
};

export function lineageToken(kind: string | undefined): Token {
  if (kind === undefined) return { color: 'var(--color-ink-muted)', glyph: '·', label: 'step' };
  return LINEAGE_KIND_TOKENS[kind] ?? { color: 'var(--color-ink-muted)', glyph: '·', label: kind };
}

const OUTCOME_TOKENS: Record<string, Token> = {
  'still-alive': { color: 'var(--color-good)', glyph: '●', label: 'still alive' },
  faded: { color: 'var(--color-ink-muted)', glyph: '○', label: 'faded' },
  rugged: { color: 'var(--color-critical)', glyph: '✕', label: 'rugged' },
  unknown: { color: 'var(--color-ink-muted)', glyph: '?', label: 'unknown' },
};

export function outcomeToken(outcome: string | undefined): Token {
  if (outcome === undefined) return OUTCOME_TOKENS.unknown as Token;
  return OUTCOME_TOKENS[outcome] ?? { color: 'var(--color-ink-muted)', glyph: '?', label: outcome };
}

const RUN_STATUS_TOKENS: Record<string, Token> = {
  ok: { color: 'var(--color-good)', glyph: '●', label: 'ok' },
  partial: { color: 'var(--color-warning)', glyph: '▲', label: 'partial' },
  failed: { color: 'var(--color-critical)', glyph: '✕', label: 'failed' },
  running: { color: 'var(--color-blue-250)', glyph: '◐', label: 'running' },
};

export function runStatusToken(status: string | undefined): Token {
  if (status === undefined) return { color: 'var(--color-ink-muted)', glyph: '·', label: 'unknown' };
  return RUN_STATUS_TOKENS[status] ?? { color: 'var(--color-ink-muted)', glyph: '·', label: status };
}
