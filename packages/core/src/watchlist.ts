import type { Chain } from './chains';

/**
 * The supply-side half of the system.
 *
 * Trending lists see a token once people are already buying it. The launch lane
 * sees it when its first pool is created, gates it on contract and liquidity
 * safety, and asks one cheap question — does the name point at something that
 * exists outside crypto? — before it is catalogued here. The two perspectives
 * meet when a catalogued token later shows up on a trending list: that
 * transition is recorded, with the hours it took, instead of being inferred.
 *
 * - active:    catalogued from a launch, not yet seen trending
 * - expressed: a catalogued token that later appeared on a trending list
 * - dormant:   catalogued, never expressed within `dormantAfterHours`
 */
export type WatchStatus = 'active' | 'expressed' | 'dormant';

export type ReferentConfidence = 'high' | 'medium' | 'low';

/**
 * The launch lane's cultural gate: does this ticker/name refer to something
 * with mainstream recognition outside crypto? Deliberately narrower than a
 * `ProvenanceReport` — it answers one question for the price of a few searches,
 * and the full lineage research waits until the token earns it by trending.
 */
export interface ReferentCheck {
  validated: boolean;
  /** What the name actually refers to, in a few words. */
  referent: string;
  /** One or two sentences on staying power, or why it fails. */
  summary: string;
  confidence: ReferentConfidence;
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
  /** Liquidity at the moment of cataloguing, for later comparison. */
  liquidityUsdAtCatalog?: number;
  referent: ReferentCheck;
  gate: LaunchGateResult;
  updatedAt: string;
}

export interface WatchQuery {
  status?: WatchStatus;
  chain?: string;
  limit?: number;
}
