/**
 * The one question every report answers first: is there a real anchor behind
 * this meme, or is it being pushed?
 *
 * - anchored: the thing the token points at existed before the token and
 *             outside it — an old meme, a cultural artifact, or an inciting
 *             event the token is a reaction to
 * - forced:   the meme exists because the token does; the earliest mentions
 *             are the deployer's own copy, paid posts, or nothing at all
 * - unclear:  the evidence does not settle it
 */
export type AnchorVerdict = 'anchored' | 'forced' | 'unclear';

export type AnchorType = 'historical-meme' | 'cultural-artifact' | 'inciting-event' | 'none';

export type AnchorConfidence = 'high' | 'medium' | 'low';

export interface AnchorSource {
  title: string;
  url?: string;
  /** ISO date (or year) the source was published. */
  date?: string;
}

export interface Anchor {
  verdict: AnchorVerdict;
  type: AnchorType;
  /** What the token points at, in a few words. Empty when there is nothing. */
  subject: string;
  /** When the anchor first existed: ISO date, or a bare year for old memes. */
  anchorDate?: string;
  /** The earliest source found that does not mention the token. */
  earliestSource?: AnchorSource;
  /**
   * Did the anchor exist before the token's first pool? Computed in code from
   * `anchorDate` and the pool creation time, never taken from the model:
   * models are unreliable at date comparison, and this is the test that
   * separates a reaction from a manufactured meme.
   */
  precedesLaunch?: boolean;
  /** One or two sentences: what the anchor is, or why there is none. */
  summary: string;
  confidence: AnchorConfidence;
}

/**
 * The thesis this project encodes: most "new" narratives are old narratives with
 * new participants. A token's provenance — where its meme came from, how many
 * times that meme has already been monetised, and whether this instance is the
 * canonical carrier or a latecomer — is treated as a first-class signal.
 */

export type EvidenceKind =
  | 'web'
  | 'wiki'
  | 'knowyourmeme'
  | 'reddit'
  | 'social'
  | 'news'
  | 'onchain'
  | 'model-knowledge';

export interface EvidenceItem {
  kind: EvidenceKind;
  url?: string;
  title: string;
  snippet: string;
  publishedAt?: string;
  retrievedAt: string;
  /** Crude 0..1 trust weight assigned by the collector, not the model. */
  sourceQuality: number;
}

/** A prior token or cultural event that already ran this same meme. */
export interface PriorCycle {
  name: string;
  ticker?: string;
  chain?: string;
  /** Year the prior instance had its run. */
  year?: number;
  peakMarketCapUsd?: number;
  outcome?: 'still-alive' | 'faded' | 'rugged' | 'unknown';
  note?: string;
}

export interface LineageNode {
  label: string;
  /** Year this step in the lineage happened. */
  year?: number;
  kind: 'origin' | 'revival' | 'derivative' | 'platform-shift';
  note?: string;
}

/**
 * Where this token sits in the recycling chain.
 * - original:   the meme is genuinely new, or this is its first tokenisation
 * - revival:    a dormant meme brought back, typically years later
 * - derivative: builds on a live meme with a real twist
 * - copycat:    rides a currently-running meme with no differentiation
 * - unclear:    evidence insufficient
 */
export type RecycleVerdict = 'original' | 'revival' | 'derivative' | 'copycat' | 'unclear';

export interface ProvenanceReport {
  tokenId: string;
  /**
   * The headline answer. Everything below it is supporting detail. Optional
   * only because reports written before the verdict existed lack it.
   */
  anchor?: Anchor;
  /** Canonical name of the underlying meme/narrative, not the ticker. */
  memeName: string;
  /** Broad family: "dog", "frog", "political", "ai-agents", "nostalgia", etc. */
  narrativeCluster: string;
  /** Year the underlying meme first entered culture (not the token launch). */
  originYear?: number;
  /** Two to four sentences on where the meme came from. */
  originSummary: string;
  lineage: LineageNode[];
  priorCycles: PriorCycle[];
  recycleVerdict: RecycleVerdict;
  /** 0 = first tokenisation of the meme, 1 = first revival, 2 = revival of a revival. */
  recycleGeneration: number;
  /** 0-100: how well this meme has survived previous attention cycles. */
  memeticDurability: number;
  /** 0-100: how far outside crypto the meme is recognised. */
  culturalReach: number;
  /** 0-100: is this the token the meme's audience would consider canonical? */
  authenticityScore: number;
  /** Plain-language read of the speculative setup. Not financial advice. */
  speculativeSetup: string;
  risks: string[];
  /** 0..1 self-reported by the model, adjusted down when evidence is thin. */
  confidence: number;
  evidence: EvidenceItem[];
  model: string;
  promptVersion: string;
  generatedAt: string;
  /** Token accounting for cost tracking. */
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
}

/** Component breakdown of the composite score. Each is 0-100. */
export interface ScoreComponents {
  /** Strength of the recycled-narrative setup (proven meme, clean revival). */
  recycling: number;
  /** Memetic durability x cultural reach. */
  memetic: number;
  /** Holder distribution health: inverse of concentration. */
  distribution: number;
  /** Liquidity depth relative to market cap. */
  liquidity: number;
  /** Volume and price momentum. */
  momentum: number;
  /** Is this the canonical carrier of the meme. */
  authenticity: number;
}

export type ScoreTier = 'S' | 'A' | 'B' | 'C' | 'D';

export interface ProvenanceScore {
  tokenId: string;
  total: number;
  tier: ScoreTier;
  components: ScoreComponents;
  /** Penalties applied by hard risk flags, with reasons. */
  penalties: { reason: string; points: number }[];
  computedAt: string;
}
