import type { PairInfo, SocialLinks, TrendingEntry } from '@provenance/core';

/**
 * CONTRACT GAP WORKAROUND.
 *
 * `TokenSnapshot` carries `imageUrl`, `description`, `socials` and `pairs`, but
 * `TrendingEntry` — the only thing a `TrendingSource` is allowed to return — has
 * nowhere to put them. DexScreener's token-profile feed and GeckoTerminal's
 * `/tokens/{address}/info` endpoint both hand us exactly that material, and the
 * research package needs the description.
 *
 * Rather than stuff it into the untyped `raw` blob (which would make the merge
 * step re-parse source-shaped payloads), sources return `EnrichedTrendingEntry`:
 * a structural subtype of `TrendingEntry` with one extra, fully-typed field.
 * It is assignable to `TrendingEntry` everywhere, so the `TrendingSource`
 * contract is honoured; `mergeToSnapshots` reads the extra field back through
 * `readEnrichment` when it is present.
 */
export interface TokenEnrichment {
  imageUrl?: string;
  description?: string;
  socials?: SocialLinks;
  /** Every pair we saw for this token, not just the representative one. */
  pairs?: PairInfo[];
}

export interface EnrichedTrendingEntry extends TrendingEntry {
  enrichment?: TokenEnrichment;
}

export function readEnrichment(entry: TrendingEntry): TokenEnrichment | undefined {
  const candidate = (entry as EnrichedTrendingEntry).enrichment;
  if (!candidate || typeof candidate !== 'object') return undefined;
  return candidate;
}

/** Drops empty sub-objects so entries stay small when a source has no extras. */
export function compactEnrichment(enrichment: TokenEnrichment): TokenEnrichment | undefined {
  const socials = enrichment.socials && Object.keys(enrichment.socials).length > 0 ? enrichment.socials : undefined;
  const pairs = enrichment.pairs && enrichment.pairs.length > 0 ? enrichment.pairs : undefined;
  const out: TokenEnrichment = {};
  if (enrichment.imageUrl) out.imageUrl = enrichment.imageUrl;
  if (enrichment.description) out.description = enrichment.description;
  if (socials) out.socials = socials;
  if (pairs) out.pairs = pairs;
  return Object.keys(out).length > 0 ? out : undefined;
}
