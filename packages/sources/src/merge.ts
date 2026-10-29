import {
  type MarketMetrics,
  type PairInfo,
  type PipelineConfig,
  type SocialLinks,
  type SourceId,
  type TokenSnapshot,
  type TrendingEntry,
  TRENDING_SOURCES,
  isEvm,
  isTokenAddress,
  ratio,
  tokenId,
} from '@provenance/core';

import { readEnrichment } from './enrichment';
import { ageHoursFrom, countDefinedMetrics, isRecord, mergeSocials, metricKeys } from './normalize';

/**
 * MERGE PRECEDENCE (numeric market data).
 *
 *   dexscreener (40) > geckoterminal (30) > dextools (20) > launches (15) > manual (10)
 *
 * DexScreener and GeckoTerminal are structured, versioned JSON APIs whose
 * numbers come straight from their indexers; DexTools is scraped, so its values
 * are rendered-and-reparsed at best and a guessed XHR shape at worst. `manual`
 * is a hand-seeded backfill row and is deliberately ranked last so a human
 * typo can never silently overwrite a live API reading.
 *
 * `launches` hydrates through the same DexScreener endpoint, so its numbers are
 * no worse than `dexscreener`'s — but it ranks below every trending source on
 * purpose. A trending row was read at the moment a list surfaced the token; a
 * launch row may be an unindexed stub whose only fact is an estimated creation
 * time. When a launch starts trending, the trending reading describes it.
 *
 * Within the same source the entry with the MORE COMPLETE `MarketMetrics`
 * (more defined fields) wins, then the better rank. Selection is field by
 * field: a snapshot can take price from DexScreener and `poolCreatedAt` from
 * GeckoTerminal if that is where the non-undefined values are.
 */
export const SOURCE_PRECEDENCE: Record<SourceId, number> = {
  dexscreener: 40,
  geckoterminal: 30,
  dextools: 20,
  launches: 15,
  manual: 10,
};

export function sourcePrecedence(source: SourceId): number {
  return SOURCE_PRECEDENCE[source] ?? 0;
}

/** Most authoritative first. The order every field-by-field pick walks. */
function byAuthority(entries: readonly TrendingEntry[]): TrendingEntry[] {
  return [...entries].sort(
    (a, b) =>
      sourcePrecedence(b.source) - sourcePrecedence(a.source) ||
      countDefinedMetrics(b.metrics) - countDefinedMetrics(a.metrics) ||
      a.rank - b.rank,
  );
}

function pairKey(chain: TokenSnapshot['chain'], address: string): string {
  return isEvm(chain) ? address.toLowerCase() : address;
}

function isMeaningfulName(value: string | undefined): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  return trimmed !== '' && trimmed.toUpperCase() !== 'UNKNOWN';
}

/**
 * Groups trending rows by `tokenId(chain, address)` and folds each group into a
 * single `TokenSnapshot`. Cross-source agreement is preserved in `sourceCount`
 * and `appearances` rather than being averaged away.
 */
export function mergeToSnapshots(entries: TrendingEntry[]): TokenSnapshot[] {
  const groups = new Map<string, TrendingEntry[]>();
  for (const entry of entries) {
    // Drop unknown chains and malformed addresses (scraped links) before they become token ids.
    if (!entry || typeof entry.tokenAddress !== 'string' || !isTokenAddress(entry.chain, entry.tokenAddress)) continue;
    const key = tokenId(entry.chain, entry.tokenAddress);
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }

  const snapshots: TokenSnapshot[] = [];

  for (const [id, group] of groups) {
    const ordered = byAuthority(group);
    const primary = ordered[0];
    if (!primary) continue;

    // --- metrics: highest-precedence non-undefined value, per field ---
    const metrics: Record<string, unknown> = {};
    for (const key of metricKeys()) {
      for (const entry of ordered) {
        const value = entry.metrics?.[key];
        if (value !== undefined) {
          metrics[key] = value;
          break;
        }
      }
    }

    const capturedAt = group
      .map((entry) => entry.capturedAt)
      .filter((value): value is string => typeof value === 'string' && value !== '')
      .sort()
      .pop() ?? new Date().toISOString();

    // Age is derived, so recompute it against the merged `poolCreatedAt`
    // instead of trusting whichever source happened to win the `ageHours` field.
    const poolCreatedAt = typeof metrics.poolCreatedAt === 'string' ? metrics.poolCreatedAt : undefined;
    const derivedAge = ageHoursFrom(poolCreatedAt, new Date(capturedAt));
    if (derivedAge !== undefined) metrics.ageHours = derivedAge;

    // --- identity ---
    const symbol = ordered.map((entry) => entry.symbol).find(isMeaningfulName) ?? primary.symbol ?? 'UNKNOWN';
    const name = ordered.map((entry) => entry.name).find(isMeaningfulName) ?? symbol;

    // --- enrichment: image by precedence, longest description, unioned socials ---
    let imageUrl: string | undefined;
    let description: string | undefined;
    let socials: SocialLinks = {};
    const pairs = new Map<string, PairInfo>();

    for (const entry of ordered) {
      const enrichment = readEnrichment(entry);
      if (!enrichment) continue;
      if (!imageUrl && enrichment.imageUrl) imageUrl = enrichment.imageUrl;
      const candidate = enrichment.description?.trim();
      // "Longest non-empty" is a crude but effective proxy for "most informative":
      // boost feeds hand out one-liners, profile feeds hand out real copy.
      if (candidate && candidate.length > (description?.length ?? 0)) description = candidate;
      if (enrichment.socials) socials = mergeSocials(socials, enrichment.socials);
      for (const pair of enrichment.pairs ?? []) {
        if (!pair || typeof pair.pairAddress !== 'string' || pair.pairAddress === '') continue;
        const key = pairKey(primary.chain, pair.pairAddress);
        const existing = pairs.get(key);
        pairs.set(key, existing ? { ...pair, ...stripUndefined(existing) } : pair);
      }
    }

    // A source may have reported a pair address without a full PairInfo block.
    for (const entry of ordered) {
      if (!entry.pairAddress) continue;
      const key = pairKey(primary.chain, entry.pairAddress);
      if (!pairs.has(key)) pairs.set(key, { pairAddress: entry.pairAddress, url: entry.url });
    }

    const sources = new Set<SourceId>(group.map((entry) => entry.source));

    snapshots.push({
      tokenId: id,
      chain: primary.chain,
      tokenAddress: primary.tokenAddress,
      symbol,
      name,
      imageUrl,
      description,
      socials,
      metrics: metrics as MarketMetrics,
      pairs: [...pairs.values()].sort((a, b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1)),
      appearances: [...group].sort((a, b) => a.rank - b.rank || a.source.localeCompare(b.source)),
      bestRank: Math.min(...group.map((entry) => (Number.isFinite(entry.rank) ? entry.rank : Number.MAX_SAFE_INTEGER))),
      sourceCount: sources.size,
      capturedAt,
    });
  }

  return snapshots;
}

export interface Lanes {
  trending: TokenSnapshot[];
  launches: TokenSnapshot[];
}

/**
 * Splits merged snapshots into the demand lane and the supply lane. A token on
 * any trending list is trending, even if we also saw it launch: the demand
 * signal is the stronger observation and the trending pipeline is the deeper
 * treatment. Only rows seen *solely* by the launch scan go to `launches`.
 * Anything else — manual-only, or manual plus launch — stays in `trending`,
 * because a hand-seeded row has always meant "analyse this fully".
 */
export function splitLanes(snapshots: TokenSnapshot[]): Lanes {
  const trending: TokenSnapshot[] = [];
  const launches: TokenSnapshot[] = [];
  for (const snapshot of snapshots) {
    const sources = snapshot.appearances.map((entry) => entry.source);
    const launchOnly = sources.length > 0 && sources.every((source) => source === 'launches');
    const onTrendingList = sources.some((source) => TRENDING_SOURCES.includes(source));
    if (launchOnly && !onTrendingList) launches.push(snapshot);
    else trending.push(snapshot);
  }
  return { trending, launches };
}

function stripUndefined(value: PairInfo): Partial<PairInfo> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out as Partial<PairInfo>;
}

export interface DroppedSnapshot {
  tokenId: string;
  reason: string;
}

export interface FilterResult {
  kept: TokenSnapshot[];
  dropped: DroppedSnapshot[];
}

/**
 * MISSING-DATA POLICY: **unknown is not a rejection.**
 *
 * A threshold only rejects a token when the relevant value is actually known
 * and actually fails. A token with no 24h volume or no pool-creation
 * timestamp is KEPT and handed to the chain/research stages, which are far
 * better placed to find the real number than the trending list was.
 * Liquidity is the exception: every market source reports it for a pool it
 * has indexed, so a row without it is a DexScreener boost or profile that
 * never hydrated (paid promotion, nothing tradeable behind it yet), and those
 * filled a third of the run's slots (Oct 2026).
 *
 * The chain filter is the one hard gate: if `pipeline.chains` is non-empty, a
 * token must be on one of those chains. `unknown` chains are dropped in that
 * case (we could not even name the chain, so we cannot analyse it) but pass
 * when no chain filter is configured.
 *
 * Every drop reason names the rule, the observed value and the threshold.
 */
export function filterSnapshots(snapshots: TokenSnapshot[], pipeline: PipelineConfig): FilterResult {
  const kept: TokenSnapshot[] = [];
  const dropped: DroppedSnapshot[] = [];
  const allowed = new Set(pipeline.chains ?? []);

  for (const snapshot of snapshots) {
    const reason = rejectionReason(snapshot, pipeline, allowed);
    if (reason) dropped.push({ tokenId: snapshot.tokenId, reason });
    else kept.push(snapshot);
  }

  return { kept, dropped };
}

function rejectionReason(
  snapshot: TokenSnapshot,
  pipeline: PipelineConfig,
  allowed: Set<TokenSnapshot['chain']>,
): string | undefined {
  if (allowed.size > 0 && !allowed.has(snapshot.chain)) {
    return `chain: ${snapshot.chain} not in configured chains [${[...allowed].join(', ')}]`;
  }

  const metrics = snapshot.metrics ?? {};

  // Unknown liquidity is dropped, unlike the other metrics: a row with no
  // market data is almost always a DexScreener boost or profile that never
  // hydrated, i.e. paid promotion with nothing behind it yet.
  const liquidity = metrics.liquidityUsd;
  if (pipeline.minLiquidityUsd > 0 && liquidity === undefined) {
    return 'minLiquidityUsd: liquidity unknown (no market data for the token)';
  }
  if (pipeline.minLiquidityUsd > 0 && liquidity !== undefined && liquidity < pipeline.minLiquidityUsd) {
    return `minLiquidityUsd: known liquidity ${fmt(liquidity)} < ${fmt(pipeline.minLiquidityUsd)}`;
  }

  const volume = metrics.volume24hUsd;
  if (pipeline.minVolume24hUsd > 0 && volume !== undefined && volume < pipeline.minVolume24hUsd) {
    return `minVolume24hUsd: known 24h volume ${fmt(volume)} < ${fmt(pipeline.minVolume24hUsd)} (missing volume is kept)`;
  }

  const age = knownAgeHours(snapshot);
  if (pipeline.minPoolAgeHours > 0 && age !== undefined && age < pipeline.minPoolAgeHours) {
    return `minPoolAgeHours: known pool age ${age.toFixed(2)}h < ${pipeline.minPoolAgeHours}h (unknown pool age is kept)`;
  }

  const tokenAge = oldestPoolAgeHours(snapshot);
  if (pipeline.maxPoolAgeHours > 0 && tokenAge !== undefined && tokenAge > pipeline.maxPoolAgeHours) {
    return `maxPoolAgeHours: oldest known pool ${Math.round(tokenAge)}h > ${pipeline.maxPoolAgeHours}h, an established token (unknown pool age is kept)`;
  }

  return undefined;
}

function knownAgeHours(snapshot: TokenSnapshot): number | undefined {
  const metrics = snapshot.metrics ?? {};
  if (typeof metrics.ageHours === 'number' && Number.isFinite(metrics.ageHours)) return metrics.ageHours;
  return ageHoursFrom(metrics.poolCreatedAt, new Date(snapshot.capturedAt));
}

/**
 * The token's age as far as the rows show it: the oldest of the headline
 * pool and every pair carried. An established token trending through a fresh
 * pool still carries its old pairs when a source listed them.
 */
function oldestPoolAgeHours(snapshot: TokenSnapshot): number | undefined {
  const now = new Date(snapshot.capturedAt);
  const ages = [
    knownAgeHours(snapshot),
    ...(snapshot.pairs ?? []).map((pair) => ageHoursFrom(pair.createdAt, now)),
  ].filter((age): age is number => age !== undefined && Number.isFinite(age));
  return ages.length > 0 ? Math.max(...ages) : undefined;
}

function fmt(value: number): string {
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

/**
 * Triage ordering, most interesting first:
 *
 *   1. `sourceCount` desc — cross-source agreement is the strongest signal we
 *      have before any analysis, and it is cheap and hard to fake.
 *   2. `bestRank` asc — how high the best list put it.
 *   3. volume/liquidity ratio desc — turnover relative to depth; a pool doing
 *      many times its own liquidity in a day is where attention actually is.
 *   4. `tokenId` asc — stable tiebreak so runs are reproducible.
 *
 * The `maxTokensPerRun` cap belongs to the caller, not here.
 */
export function triageOrder(snapshots: TokenSnapshot[]): TokenSnapshot[] {
  return [...snapshots].sort((a, b) => {
    if (b.sourceCount !== a.sourceCount) return b.sourceCount - a.sourceCount;
    if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank;
    const turnoverA = turnover(a);
    const turnoverB = turnover(b);
    if (turnoverA !== turnoverB) return turnoverB - turnoverA;
    return a.tokenId.localeCompare(b.tokenId);
  });
}

/** Volume-to-liquidity turnover. Unknown sorts last, never first. */
function turnover(snapshot: TokenSnapshot): number {
  const metrics = isRecord(snapshot.metrics) ? snapshot.metrics : {};
  const value = ratio(
    typeof metrics.volume24hUsd === 'number' ? metrics.volume24hUsd : undefined,
    typeof metrics.liquidityUsd === 'number' ? metrics.liquidityUsd : undefined,
  );
  return value === undefined || !Number.isFinite(value) ? -1 : value;
}
