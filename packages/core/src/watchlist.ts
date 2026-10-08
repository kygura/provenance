import type { Chain } from './chains';
import type { Anchor } from './provenance';
import type { SocialPlatform } from './social';

/**
 * The launch lane's record of every token it judged.
 *
 * The point is to decide early. A token is judged when its first pool appears,
 * not after it trends: the gate checks the contract and liquidity, the anchor
 * check asks whether the meme has a real anchor or is being pushed, and an
 * anchored token gets the full provenance research on the spot. Trending lists
 * then serve as the outcome, recorded against the verdict that came first.
 *
 * - active:    anchored at launch, not yet seen trending
 * - expressed: judged at launch, later seen on a trending list
 * - dormant:   anchored, never expressed within `dormantAfterHours`
 * - dismissed: judged forced or unclear at launch. Kept so it is not paid
 *              for again every run, and so a forced meme that trends anyway
 *              is on record as exactly that.
 */
export type WatchStatus = 'active' | 'expressed' | 'dormant' | 'dismissed';

/**
 * The launch lane's fast answer to the anchor question: the triage model, a
 * small search budget, the `Anchor` block and nothing else. The full
 * `ProvenanceReport` asks the same question in depth right after, when the
 * fast answer is `anchored` — at launch, not once the token trends.
 */
export interface AnchorCheck extends Anchor {
  model: string;
  checkedAt: string;
  /** URLs the model consulted, when it searched. */
  citations: string[];
  usage?: { inputTokens: number; outputTokens: number; costUsd?: number };
}

/** Outcome of the launch lane's hard filters. `reasons` names every failure. */
export interface LaunchGateResult {
  passed: boolean;
  reasons: string[];
}

export interface WatchEntry {
  tokenId: string;
  chain: Chain;
  tokenAddress: string;
  symbol: string;
  name: string;
  status: WatchStatus;
  /** When the launch lane catalogued it. Never overwritten. */
  firstSeenAt: string;
  /** Pool creation time, when known. */
  launchedAt?: string;
  /** First trending appearance after cataloguing. */
  expressedAt?: string;
  /** Hours from cataloguing to first trending appearance. */
  leadHours?: number;
  /** Trending sources it appeared on when it expressed. */
  expressedOn?: string[];
  /**
   * First time a crypto-social trending feed listed the contract. Can be
   * earlier than `firstSeenAt`: the crowd sometimes gets there first.
   */
  socialAt?: string;
  /**
   * Hours from cataloguing to that first sighting. Positive means we judged
   * the token before crypto-social noticed it; negative means it was already
   * being talked about when we did.
   */
  socialLeadHours?: number;
  /** Platforms it had trended on when first matched. */
  socialOn?: SocialPlatform[];
  /** Liquidity at the moment of cataloguing, for later comparison. */
  liquidityUsdAtCatalog?: number;
  /** The fast verdict at launch. The full report, when run, is in `provenance`. */
  anchor: AnchorCheck;
  /** True once the full provenance research ran for this entry. */
  researched?: boolean;
  gate: LaunchGateResult;
  updatedAt: string;
}

export interface WatchQuery {
  status?: WatchStatus;
  verdict?: Anchor['verdict'];
  chain?: string;
  limit?: number;
}
