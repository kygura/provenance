/**
 * The zero-network collector. Everything here is already in hand — the
 * DexScreener description, the socials, the pair list, the chain analysis — so
 * it cannot fail and cannot be rate limited.
 *
 * That matters more than it sounds: when every web collector is blocked (a CI
 * egress proxy, a Reddit ban wave, DDG serving a captcha), this is the reason
 * the pipeline still produces a report instead of a hole. It is also the only
 * place the model learns what the TOKEN claims about itself, which is the
 * material it needs to judge whether the token's self-description matches the
 * meme's actual history.
 */
import type {
  ChainAnalysis,
  EvidenceCollector,
  EvidenceItem,
  ResearchContext,
  SocialLinks,
  TokenSnapshot,
} from '@provenance/core';
import { formatUsd, nowIso } from '@provenance/core';
import { cleanSnippet, quality } from '../evidence';
import { buildQueries } from '../queries';

function socialLines(socials: SocialLinks): string[] {
  const lines: string[] = [];
  const entries: [string, string | undefined][] = [
    ['website', socials.website],
    ['twitter', socials.twitter],
    ['telegram', socials.telegram],
    ['discord', socials.discord],
    ['github', socials.github],
    ['docs', socials.docs],
  ];
  for (const [label, value] of entries) {
    if (typeof value === 'string' && value.trim().length > 0) lines.push(`${label}: ${value.trim()}`);
  }
  for (const other of socials.other ?? []) {
    if (other.trim().length > 0) lines.push(`other: ${other.trim()}`);
  }
  return lines;
}

/** Pure projection of snapshot + chain analysis into evidence. Never throws. */
export function tokenMetaEvidence(
  snapshot: TokenSnapshot,
  chain?: ChainAnalysis,
  retrievedAt = nowIso(),
): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const queries = buildQueries(snapshot);

  // 1. Identity. Always emitted — it is what anchors the model's "which token
  //    is this" and, critically, the LAUNCH date it must not mistake for the
  //    meme's origin year.
  const identity: string[] = [
    `Ticker ${snapshot.symbol || '(none)'}; name "${snapshot.name || '(none)'}"; chain ${snapshot.chain}; address ${snapshot.tokenAddress}.`,
    `Derived meme subject: ${queries.degraded ? '(none derivable from ticker or name)' : queries.subject}.`,
    `Listed on ${snapshot.sourceCount} trending source(s), best rank ${snapshot.bestRank}.`,
  ];
  const pool = snapshot.metrics.poolCreatedAt ?? snapshot.pairs.find((pair) => pair.createdAt)?.createdAt;
  if (pool !== undefined) {
    identity.push(`TOKEN pool first created at ${pool} — this is the token's launch, NOT the meme's origin.`);
  } else if (snapshot.metrics.ageHours !== undefined) {
    identity.push(
      `Oldest observed pool is roughly ${snapshot.metrics.ageHours.toFixed(1)}h old — token launch age, not meme age.`,
    );
  }
  if (snapshot.metrics.liquidityUsd !== undefined || snapshot.metrics.volume24hUsd !== undefined) {
    identity.push(
      `Liquidity ${formatUsd(snapshot.metrics.liquidityUsd)}, 24h volume ${formatUsd(snapshot.metrics.volume24hUsd)}, FDV ${formatUsd(snapshot.metrics.fdvUsd)}.`,
    );
  }
  items.push({
    kind: 'onchain',
    title: `Token identity — ${snapshot.symbol || snapshot.tokenId}`,
    snippet: identity.join(' '),
    retrievedAt,
    // High-confidence facts, but about the token rather than the meme, so they
    // must not outrank a Wikipedia article at trim time.
    sourceQuality: quality(0.55),
  });

  // 2. The token's own description: the project's claim about its meme. Useful
  //    and unreliable in equal measure — it is marketing copy.
  const description = cleanSnippet(snapshot.description ?? '', 900);
  if (description.length > 0) {
    items.push({
      kind: 'onchain',
      url: snapshot.socials.website,
      title: `Self-described narrative — ${snapshot.symbol || snapshot.tokenId}`,
      snippet: `Listing description (the project's own claim, unverified): ${description}`,
      retrievedAt,
      sourceQuality: quality(0.4),
    });
  }

  // 3. Socials. A meme with a 2013 origin and a two-week-old Twitter handle is
  //    a signal; the model can only see that if we hand it the handles.
  const socials = socialLines(snapshot.socials);
  if (socials.length > 0) {
    items.push({
      kind: 'social',
      url: snapshot.socials.twitter ?? snapshot.socials.website,
      title: `Declared social presence — ${snapshot.symbol || snapshot.tokenId}`,
      snippet: `Links published with the listing: ${socials.join('; ')}.`,
      retrievedAt,
      sourceQuality: quality(0.38),
    });
  }

  // 4. Pairs and venues.
  if (snapshot.pairs.length > 0) {
    const pairs = snapshot.pairs
      .slice(0, 6)
      .map((pair) => {
        const venue = pair.dexId ?? 'unknown dex';
        const quote = pair.quoteSymbol ?? '?';
        const created = pair.createdAt ? `, created ${pair.createdAt}` : '';
        return `${venue} ${snapshot.symbol}/${quote} (${formatUsd(pair.liquidityUsd)}${created})`;
      })
      .join('; ');
    items.push({
      kind: 'onchain',
      title: `Trading venues — ${snapshot.symbol || snapshot.tokenId}`,
      snippet: `${snapshot.pairs.length} pair(s) observed: ${pairs}.`,
      retrievedAt,
      sourceQuality: quality(0.35),
    });
  }

  // 5. Chain analysis flags. Distribution and authority state feed the
  //    authenticity judgement: a "community revival" whose creator holds 40% is
  //    not what it says it is.
  if (chain !== undefined) {
    const facts: string[] = [`Analysis method: ${chain.method}.`];
    if (chain.holderCount !== undefined) facts.push(`${chain.holderCount} holders.`);
    if (chain.top10Pct !== undefined) facts.push(`Top 10 hold ${chain.top10Pct.toFixed(1)}%.`);
    if (chain.creatorHoldingPct !== undefined) facts.push(`Creator holds ${chain.creatorHoldingPct.toFixed(1)}%.`);
    if (chain.lpBurnedPct !== undefined) facts.push(`LP burned ${chain.lpBurnedPct.toFixed(1)}%.`);
    if (chain.lpLockedPct !== undefined) facts.push(`LP locked ${chain.lpLockedPct.toFixed(1)}%.`);
    if (chain.mintAuthorityActive === true) facts.push('Mint authority is STILL ACTIVE.');
    if (chain.freezeAuthorityActive === true) facts.push('Freeze authority is STILL ACTIVE.');
    if (chain.ownerRenounced === false) facts.push('Contract ownership not renounced.');
    if (chain.contractVerified === false) facts.push('Contract source not verified on the explorer.');
    for (const flag of chain.flags.slice(0, 10)) facts.push(`[${flag.severity}] ${flag.code}: ${flag.detail}`);
    for (const note of chain.notes.slice(0, 4)) facts.push(`Note: ${note}`);

    items.push({
      kind: 'onchain',
      title: `On-chain distribution and authorities — ${snapshot.symbol || snapshot.tokenId}`,
      snippet: facts.join(' '),
      retrievedAt,
      sourceQuality: quality(0.6),
    });
  }

  return items;
}

export class TokenMetaCollector implements EvidenceCollector {
  readonly id = 'tokenmeta';

  constructor(private readonly chain?: ChainAnalysis) {}

  // eslint-disable-next-line @typescript-eslint/require-await -- contract is async
  async collect(snapshot: TokenSnapshot, ctx: ResearchContext): Promise<EvidenceItem[]> {
    try {
      return tokenMetaEvidence(snapshot, this.chain);
    } catch (error) {
      // Belt and braces: the contract says a collector never throws, and this
      // one is the fallback everything else depends on.
      ctx.logger.child('tokenmeta').warn('projection failed', { error: String(error) });
      return [];
    }
  }
}
