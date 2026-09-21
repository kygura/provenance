/**
 * Data shapes carried through the pipeline.
 *
 * Two families live here. The snapshot types are what the scrapers produce:
 * plain facts, every field optional because every upstream API drops fields
 * without notice. The verdict schema is what the LLM produces, and it is a Zod
 * schema rather than an interface because the Messages API validates the
 * model's output against its JSON Schema.
 */

import { z } from "zod";

// --------------------------------------------------------------------------
// Scraped facts
// --------------------------------------------------------------------------

/** Identity of one token on one chain, plus the pool we saw it trending in. */
export interface TokenRef {
  chain: string;
  address: string;
  symbol?: string | null;
  name?: string | null;
  pairAddress?: string | null;
  dex?: string | null;
}

export function tokenKey(ref: TokenRef): string {
  return `${ref.chain}:${ref.address.toLowerCase()}`;
}

export function describeToken(ref: TokenRef): string {
  return `${ref.symbol ?? "???"} (${ref.chain}:${ref.address.slice(0, 8)}…)`;
}

export interface MarketSnapshot {
  priceUsd?: number | null;
  fdvUsd?: number | null;
  marketCapUsd?: number | null;
  liquidityUsd?: number | null;
  volume24hUsd?: number | null;
  volume6hUsd?: number | null;
  volume1hUsd?: number | null;
  priceChange24hPct?: number | null;
  priceChange6hPct?: number | null;
  priceChange1hPct?: number | null;
  buys24h?: number | null;
  sells24h?: number | null;
  /** Epoch milliseconds. */
  pairCreatedAt?: number | null;
}

export function emptyMarket(): MarketSnapshot {
  return {};
}

export function ageHours(m: MarketSnapshot, now = Date.now()): number | null {
  if (m.pairCreatedAt == null) return null;
  return (now - m.pairCreatedAt) / 3_600_000;
}

/** Thin-float tell. Below ~1% means the quoted FDV is close to fictional. */
export function liquidityToFdv(m: MarketSnapshot): number | null {
  if (!m.liquidityUsd || !m.fdvUsd) return null;
  return m.liquidityUsd / m.fdvUsd;
}

/** Churn. Very high with a flat price is the classic wash-trading shape. */
export function volumeToLiquidity(m: MarketSnapshot): number | null {
  if (!m.liquidityUsd || m.volume24hUsd == null) return null;
  return m.volume24hUsd / m.liquidityUsd;
}

export function buySellRatio(m: MarketSnapshot): number | null {
  if (!m.sells24h) return null;
  return (m.buys24h ?? 0) / m.sells24h;
}

/** Distribution. The part that says who actually eats the loss. */
export interface HolderSnapshot {
  holderCount?: number | null;
  top10Pct?: number | null;
  top50Pct?: number | null;
  gini?: number | null;
  creatorPct?: number | null;
  /**
   * Addresses identified as pools, locks or burns and excluded from the
   * concentration figures above. Kept for auditability.
   */
  excludedAddresses: string[];
  source?: string | null;
}

export function emptyHolders(): HolderSnapshot {
  return { excludedAddresses: [] };
}

export interface SecuritySnapshot {
  mintAuthorityActive?: boolean | null;
  freezeAuthorityActive?: boolean | null;
  lpLockedPct?: number | null;
  lpBurned?: boolean | null;
  buyTaxPct?: number | null;
  sellTaxPct?: number | null;
  isHoneypot?: boolean | null;
  flags: string[];
  source?: string | null;
}

export function emptySecurity(): SecuritySnapshot {
  return { flags: [] };
}

export interface Socials {
  website?: string | null;
  twitter?: string | null;
  telegram?: string | null;
  discord?: string | null;
  other: string[];
  description?: string | null;
}

export function emptySocials(): Socials {
  return { other: [] };
}

export function socialLines(s: Socials): string[] {
  const out: string[] = [];
  const pairs: [string, string | null | undefined][] = [
    ["site", s.website],
    ["x", s.twitter],
    ["tg", s.telegram],
    ["discord", s.discord],
  ];
  for (const [label, value] of pairs) {
    if (value) out.push(`${label}: ${value}`);
  }
  out.push(...s.other);
  return out;
}

/** Everything the scrapers found for one token, before the LLM sees it. */
export interface TokenDossier {
  ref: TokenRef;
  market: MarketSnapshot;
  holders: HolderSnapshot;
  security: SecuritySnapshot;
  socials: Socials;
  sources: string[];
  trendingRank?: number | null;
  heuristicScore: number;
  heuristicNotes: string[];
  collectedAt: string;
}

export function newDossier(ref: TokenRef, overrides: Partial<TokenDossier> = {}): TokenDossier {
  return {
    ref,
    market: emptyMarket(),
    holders: emptyHolders(),
    security: emptySecurity(),
    socials: emptySocials(),
    sources: [],
    trendingRank: null,
    heuristicScore: 0,
    heuristicNotes: [],
    collectedAt: new Date().toISOString(),
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// LLM output
// --------------------------------------------------------------------------

/** A prior meme this token appears to be a rerun of. */
export const AncestorSchema = z.object({
  name: z.string().describe("The earlier project, meme, or narrative."),
  ticker: z.string().nullable().describe("Its ticker, if it had one. Null if it had none."),
  era: z.string().describe("Roughly when it peaked, e.g. '2021 bull' or 'early 2024'."),
  peak_context: z.string().describe("What it reached and on what story. Numbers where known."),
  what_happened_next: z
    .string()
    .describe("How it resolved. Drawdown, rug, slow bleed, or survival."),
  resemblance: z
    .string()
    .describe(
      "The specific link to the token under review: name, art, mechanic, founder, or community lineage.",
    ),
  evidence_urls: z.array(z.string()).describe("Sources supporting this link."),
});

/** The LLM's read on where a token's meme came from. */
export const ProvenanceVerdictSchema = z.object({
  one_liner: z.string().describe("One sentence a trader could act on."),
  archetype: z
    .string()
    .describe(
      "The narrative family, e.g. 'dog coin', 'AI agent', 'political', " +
        "'revival of a dead ticker', 'celebrity', 'infrastructure cosplay'.",
    ),
  origin_story: z
    .string()
    .describe(
      "Where this specific meme came from: who made it, from what, and when. " +
        "Say plainly if the origin could not be established.",
    ),
  lineage: z
    .array(AncestorSchema)
    .describe("Prior memes this is a rerun of, strongest link first. Empty if genuinely novel."),
  novelty: z
    .enum(["pure-rerun", "remix", "novel"])
    .describe(
      "'pure-rerun' means the same meme returning with a new contract; " +
        "'remix' means old meme, new mechanic or chain.",
    ),
  cycle_distance_years: z
    .number()
    .nullable()
    .describe("Years between the closest ancestor's peak and now. Null if no ancestor."),
  recycle_confidence: z
    .number()
    .int()
    .min(0)
    .max(100)
    .describe("Confidence that the lineage claim is correct, 0-100."),
  audience_read: z
    .string()
    .describe(
      "Who is buying and whether they plausibly remember the ancestor. " +
        "Ground this in the holder and age data given, not vibes.",
    ),
  what_would_confirm: z
    .array(z.string())
    .describe("Observable events in the next days that would support the thesis."),
  what_would_kill_it: z
    .array(z.string())
    .describe("Observable events that would invalidate the thesis."),
  red_flags: z
    .array(z.string())
    .describe(
      "Concrete risks from the supplied data: concentration, unlocked LP, live mint " +
        "authority, wash-trade shape, unverifiable team.",
    ),
  open_questions: z
    .array(z.string())
    .describe("What could not be determined and would need a human to check."),
});

export type Ancestor = z.infer<typeof AncestorSchema>;
export type ProvenanceVerdict = z.infer<typeof ProvenanceVerdictSchema>;

export interface ReportEntry {
  dossier: TokenDossier;
  verdict?: ProvenanceVerdict | null;
  researchNotes?: string | null;
  citations: string[];
  error?: string | null;
}

/** One scheduled run. */
export interface Report {
  runId: string;
  startedAt: Date;
  finishedAt?: Date | null;
  entries: ReportEntry[];
  skipped: number;
  errors: string[];
}
