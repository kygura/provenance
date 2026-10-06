import type { Chain } from './chains';

/**
 * Crypto-social attention, read from Elfa's trending contract-address feeds.
 *
 * This is not a verdict input. Provenance judges a meme at its first pool; the
 * social feed is the yardstick that verdict is measured against: when did the
 * crowd notice the token, and was that before or after we did? A contract
 * address is matched exactly, so a sighting is unambiguous in a way a ticker
 * mention is not.
 */
export type SocialPlatform = 'twitter' | 'telegram';

export const SOCIAL_PLATFORMS: readonly SocialPlatform[] = ['twitter', 'telegram'];

/** One row of one trending-CA feed, as fetched. */
export interface SocialSighting {
  tokenId: string;
  chain: Chain;
  tokenAddress: string;
  platform: SocialPlatform;
  /** Mentions inside the window the feed was asked for. */
  mentionCount: number;
  seenAt: string;
}

/** The earliest sighting of a token across platforms. */
export interface SocialFirstSeen {
  tokenId: string;
  firstSeenAt: string;
  /** Platforms that have listed it, in any fetch. */
  platforms: SocialPlatform[];
  peakMentions: number;
}

export interface SocialFetchResult {
  sightings: SocialSighting[];
  errors: { source: string; error: string }[];
}

/** Per-run record of the social step. Absent on runs from before it existed. */
export interface SocialStats {
  /** Set only when a fetch succeeded; the throttle reads it from past runs. */
  fetchedAt?: string;
  /** Why no fetch happened this run. */
  skipped?: 'no-key' | 'throttled';
  /** Rows returned across feeds. */
  sightings: number;
  /** Tokens never sighted before this fetch. */
  newTokens: number;
  /** Watchlist entries given their first social sighting this run. */
  matched: number;
}
