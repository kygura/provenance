import type {
  Alert,
  AnalysisMethod,
  Chain,
  ChainAnalysis,
  DeliveryResult,
  EvidenceItem,
  HolderRow,
  LineageNode,
  Logger,
  MarketMetrics,
  PairInfo,
  PriorCycle,
  ProvenanceReport,
  ProvenanceScore,
  RecycleVerdict,
  RiskFlag,
  RiskSeverity,
  RunRecord,
  RunStats,
  RunStatus,
  ScoreComponents,
  ScoreTier,
  SocialFirstSeen,
  SocialLinks,
  SocialPlatform,
  TokenSnapshot,
  TrendingEntry,
  AnchorCheck,
  AnchorConfidence,
  AnchorType,
  AnchorVerdict,
  WatchEntry,
  WatchStatus,
} from '@provenance/core';
import { normalizeChain, parseTokenId, SOCIAL_PLATFORMS, silentLogger } from '@provenance/core';

/**
 * Row -> domain translation lives here, on its own, for two reasons: it is the
 * only part of the store worth unit-testing in isolation, and it is the part
 * that has to be paranoid. Every `*_json` column is data written by a previous
 * process; a truncated write, a hand-edited row or a contract change must not
 * turn a dashboard page into a 500. So nothing in this file throws: a column it
 * cannot read is logged and replaced with a degraded-but-valid value, and the
 * promoted (real) columns — which are what the query filtered on — always win
 * over the JSON blob.
 */

/** Loosely-typed result row. libSQL's `Row` satisfies this. */
export type SqlRow = Record<string, unknown>;

// ---------------------------------------------------------------------------
// scalar coercion
// ---------------------------------------------------------------------------

export function asText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'bigint') return String(value);
  return undefined;
}

export function text(value: unknown, fallback = ''): string {
  return asText(value) ?? fallback;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function num(value: unknown, fallback = 0): number {
  return asNumber(value) ?? fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const raw = asText(value);
  return raw !== undefined && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

const RUN_STATUSES: readonly RunStatus[] = ['running', 'ok', 'partial', 'failed'];
const VERDICTS: readonly RecycleVerdict[] = ['original', 'revival', 'derivative', 'copycat', 'unclear'];
const TIERS: readonly ScoreTier[] = ['S', 'A', 'B', 'C', 'D'];
const SEVERITIES: readonly RiskSeverity[] = ['info', 'warn', 'critical'];
const METHODS: readonly AnalysisMethod[] = ['rpc', 'explorer', 'indexer', 'partial', 'unavailable'];

export const asRunStatus = (v: unknown): RunStatus => oneOf(v, RUN_STATUSES, 'failed');
export const asVerdict = (v: unknown): RecycleVerdict => oneOf(v, VERDICTS, 'unclear');
export const asTier = (v: unknown): ScoreTier => oneOf(v, TIERS, 'D');
export const asSeverity = (v: unknown): RiskSeverity => oneOf(v, SEVERITIES, 'info');
export const asMethod = (v: unknown): AnalysisMethod => oneOf(v, METHODS, 'unavailable');

// ---------------------------------------------------------------------------
// JSON columns
// ---------------------------------------------------------------------------

function parse(raw: unknown, column: string, logger: Logger): unknown {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    logger.warn('non-text JSON column', { column, type: typeof raw });
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    // Deliberately not rethrown: one bad row must not take down a listing.
    logger.warn('unparseable JSON column, degrading', {
      column,
      error: error instanceof Error ? error.message : String(error),
      sample: raw.slice(0, 120),
    });
    return undefined;
  }
}

export function parseObject<T extends object>(raw: unknown, column: string, fallback: T, logger: Logger = silentLogger): T {
  const parsed = parse(raw, column, logger);
  if (parsed === undefined) return fallback;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logger.warn('JSON column was not an object, degrading', { column });
    return fallback;
  }
  return parsed as T;
}

export function parseArray<T>(raw: unknown, column: string, logger: Logger = silentLogger): T[] {
  const parsed = parse(raw, column, logger);
  if (parsed === undefined) return [];
  if (!Array.isArray(parsed)) {
    logger.warn('JSON column was not an array, degrading', { column });
    return [];
  }
  return parsed as T[];
}

// ---------------------------------------------------------------------------
// runs
// ---------------------------------------------------------------------------

export const EMPTY_STATS: RunStats = {
  discovered: 0,
  afterFilter: 0,
  analysed: 0,
  reused: 0,
  alertsFired: 0,
  llmCostUsd: 0,
  sourceErrors: [],
};

export function rowToRun(row: SqlRow, logger: Logger = silentLogger): RunRecord {
  const stats = parseObject<Partial<RunStats>>(row.stats_json, 'runs.stats_json', {}, logger);
  return {
    id: text(row.id),
    startedAt: text(row.started_at),
    finishedAt: asText(row.finished_at),
    status: asRunStatus(row.status),
    stats: {
      ...EMPTY_STATS,
      ...stats,
      sourceErrors: Array.isArray(stats.sourceErrors) ? stats.sourceErrors : [],
    },
    error: asText(row.error),
  };
}

export function runRowArgs(run: RunRecord): [string, string, string | null, string, string, string | null] {
  return [
    run.id,
    run.startedAt,
    run.finishedAt ?? null,
    run.status,
    JSON.stringify(run.stats),
    run.error ?? null,
  ];
}

// ---------------------------------------------------------------------------
// tokens + snapshots
// ---------------------------------------------------------------------------

/**
 * A `TokenSnapshot` is spread over two tables: the slowly-changing identity in
 * `tokens` and the per-run measurement in `snapshots`. Both rows are needed.
 */
export function rowToSnapshot(tokenRow: SqlRow, snapRow: SqlRow, logger: Logger = silentLogger): TokenSnapshot {
  const id = text(snapRow.token_id) || text(tokenRow.id);
  const chain: Chain = normalizeChain(asText(tokenRow.chain) ?? parseTokenId(id).chain);
  return {
    tokenId: id,
    chain,
    tokenAddress: text(tokenRow.address) || parseTokenId(id).address,
    symbol: text(tokenRow.symbol),
    name: text(tokenRow.name),
    imageUrl: asText(tokenRow.image_url),
    description: asText(tokenRow.description),
    socials: parseObject<SocialLinks>(tokenRow.socials_json, 'tokens.socials_json', {}, logger),
    metrics: parseObject<MarketMetrics>(snapRow.metrics_json, 'snapshots.metrics_json', {}, logger),
    pairs: parseArray<PairInfo>(snapRow.pairs_json, 'snapshots.pairs_json', logger),
    appearances: parseArray<TrendingEntry>(snapRow.appearances_json, 'snapshots.appearances_json', logger),
    bestRank: num(snapRow.best_rank, Number.MAX_SAFE_INTEGER),
    sourceCount: num(snapRow.source_count, 0),
    capturedAt: text(snapRow.captured_at),
  };
}

/**
 * Args for the `tokens` upsert. `first_seen_at` and `last_seen_at` are both
 * seeded with this snapshot's capture time; the ON CONFLICT clause in
 * libsql-store.ts keeps the earliest first_seen_at and the latest last_seen_at,
 * which is what makes "seen before" a reliable signal across runs.
 */
export function tokenRowArgs(
  snapshot: TokenSnapshot,
): [string, string, string, string, string, string | null, string | null, string, string, string] {
  return [
    snapshot.tokenId,
    snapshot.chain,
    snapshot.tokenAddress,
    snapshot.symbol,
    snapshot.name,
    snapshot.imageUrl ?? null,
    snapshot.description ?? null,
    JSON.stringify(snapshot.socials ?? {}),
    snapshot.capturedAt,
    snapshot.capturedAt,
  ];
}

export function snapshotRowArgs(
  runId: string,
  snapshot: TokenSnapshot,
): [string, string, string, string, number, number, string, string, string] {
  return [
    snapshotId(runId, snapshot.tokenId),
    runId,
    snapshot.tokenId,
    snapshot.capturedAt,
    snapshot.bestRank,
    snapshot.sourceCount,
    JSON.stringify(snapshot.metrics ?? {}),
    JSON.stringify(snapshot.pairs ?? []),
    JSON.stringify(snapshot.appearances ?? []),
  ];
}

/** One row per (run, token) for every per-run child table. */
export function snapshotId(runId: string, tokenId: string): string {
  return `${runId}::${tokenId}`;
}

// ---------------------------------------------------------------------------
// chain analysis
// ---------------------------------------------------------------------------

export function rowToChainAnalysis(row: SqlRow, logger: Logger = silentLogger): ChainAnalysis {
  const tokenId = text(row.token_id);
  const parsed = parseObject<Partial<ChainAnalysis>>(row.data_json, 'chain_analysis.data_json', {}, logger);
  const parsedTokenId = parseTokenId(tokenId);
  return {
    ...parsed,
    tokenId,
    chain: normalizeChain(parsed.chain ?? parsedTokenId.chain),
    tokenAddress: parsed.tokenAddress ?? parsedTokenId.address,
    method: asMethod(row.method),
    holderCount: asNumber(row.holder_count) ?? parsed.holderCount,
    top10Pct: asNumber(row.top10_pct) ?? parsed.top10Pct,
    topHolders: Array.isArray(parsed.topHolders) ? (parsed.topHolders as HolderRow[]) : [],
    flags: Array.isArray(parsed.flags) ? (parsed.flags as RiskFlag[]) : [],
    notes: Array.isArray(parsed.notes) ? parsed.notes.filter((n): n is string => typeof n === 'string') : [],
    fetchedAt: parsed.fetchedAt ?? text(row.created_at),
  };
}

export function chainRowArgs(
  runId: string,
  analysis: ChainAnalysis,
): [string, string, string, string, string, number | null, number | null, string] {
  return [
    snapshotId(runId, analysis.tokenId),
    runId,
    analysis.tokenId,
    analysis.fetchedAt,
    analysis.method,
    analysis.top10Pct ?? null,
    analysis.holderCount ?? null,
    JSON.stringify(analysis),
  ];
}

// ---------------------------------------------------------------------------
// provenance
// ---------------------------------------------------------------------------

export function rowToProvenance(row: SqlRow, logger: Logger = silentLogger): ProvenanceReport {
  const tokenId = text(row.token_id);
  const createdAt = text(row.created_at);
  const parsed = parseObject<Partial<ProvenanceReport>>(row.report_json, 'provenance.report_json', {}, logger);
  const degraded = parsed.originSummary === undefined;
  return {
    ...parsed,
    tokenId,
    memeName: text(row.meme_name),
    narrativeCluster: text(row.narrative_cluster),
    originSummary: parsed.originSummary ?? '',
    lineage: Array.isArray(parsed.lineage) ? (parsed.lineage as LineageNode[]) : [],
    priorCycles: Array.isArray(parsed.priorCycles) ? (parsed.priorCycles as PriorCycle[]) : [],
    recycleVerdict: asVerdict(row.recycle_verdict),
    recycleGeneration: num(row.recycle_generation, 0),
    memeticDurability: parsed.memeticDurability ?? 0,
    culturalReach: parsed.culturalReach ?? 0,
    authenticityScore: parsed.authenticityScore ?? 0,
    speculativeSetup: parsed.speculativeSetup ?? '',
    risks: Array.isArray(parsed.risks)
      ? parsed.risks.filter((r): r is string => typeof r === 'string')
      : degraded
        ? ['Stored report could not be read; showing indexed fields only.']
        : [],
    confidence: asNumber(row.confidence) ?? 0,
    evidence: Array.isArray(parsed.evidence) ? (parsed.evidence as EvidenceItem[]) : [],
    model: text(row.model),
    promptVersion: text(row.prompt_version),
    generatedAt: parsed.generatedAt ?? createdAt,
  };
}

export function provenanceRowArgs(
  runId: string,
  report: ProvenanceReport,
): [string, string, string, string, string, string, string, number, number, string, string, string, string | null] {
  return [
    snapshotId(runId, report.tokenId),
    runId,
    report.tokenId,
    report.generatedAt,
    report.memeName,
    report.narrativeCluster,
    report.recycleVerdict,
    report.recycleGeneration,
    report.confidence,
    report.model,
    report.promptVersion,
    JSON.stringify(report),
    report.anchor?.verdict ?? null,
  ];
}

// ---------------------------------------------------------------------------
// scores
// ---------------------------------------------------------------------------

export const ZERO_COMPONENTS: ScoreComponents = {
  recycling: 0,
  memetic: 0,
  distribution: 0,
  liquidity: 0,
  momentum: 0,
  authenticity: 0,
};

export function rowToScore(row: SqlRow, logger: Logger = silentLogger): ProvenanceScore {
  const components = parseObject<Partial<ScoreComponents>>(
    row.components_json,
    'scores.components_json',
    {},
    logger,
  );
  return {
    tokenId: text(row.token_id),
    total: num(row.total, 0),
    tier: asTier(row.tier),
    components: { ...ZERO_COMPONENTS, ...components },
    penalties: parseArray<{ reason: string; points: number }>(row.penalties_json, 'scores.penalties_json', logger),
    computedAt: text(row.computed_at),
  };
}

export function scoreRowArgs(
  runId: string,
  score: ProvenanceScore,
): [string, string, string, string, number, string, string, string] {
  return [
    snapshotId(runId, score.tokenId),
    runId,
    score.tokenId,
    score.computedAt,
    score.total,
    score.tier,
    JSON.stringify(score.components ?? ZERO_COMPONENTS),
    JSON.stringify(score.penalties ?? []),
  ];
}

// ---------------------------------------------------------------------------
// alerts
// ---------------------------------------------------------------------------

export function rowToAlert(row: SqlRow, logger: Logger = silentLogger): Alert {
  return {
    id: text(row.id),
    runId: text(row.run_id),
    tokenId: text(row.token_id),
    rule: text(row.rule),
    severity: asSeverity(row.severity),
    title: text(row.title),
    body: text(row.body),
    markdown: text(row.markdown),
    createdAt: text(row.created_at),
    payload: parseObject<Record<string, unknown>>(row.payload_json, 'alerts.payload_json', {}, logger),
  };
}

/** Deliveries ride along on the alert row; nothing queries them individually. */
export function rowToDeliveries(row: SqlRow, logger: Logger = silentLogger): DeliveryResult[] {
  return parseArray<DeliveryResult>(row.deliveries_json, 'alerts.deliveries_json', logger);
}

export function alertRowArgs(
  alert: Alert,
  deliveries: readonly DeliveryResult[],
): [string, string, string, string, string, string, string, string, string, string, string] {
  return [
    alert.id,
    alert.runId,
    alert.tokenId,
    alert.rule,
    alert.severity,
    alert.title,
    alert.body,
    alert.markdown,
    alert.createdAt,
    JSON.stringify(alert.payload ?? {}),
    JSON.stringify(deliveries ?? []),
  ];
}

// ---------------------------------------------------------------------------
// watchlist
// ---------------------------------------------------------------------------

const WATCH_STATUSES: readonly WatchStatus[] = ['active', 'expressed', 'dormant', 'dismissed'];
export const asWatchStatus = (v: unknown): WatchStatus => oneOf(v, WATCH_STATUSES, 'active');

const ANCHOR_VERDICTS: readonly AnchorVerdict[] = ['anchored', 'forced', 'unclear'];
const ANCHOR_TYPES: readonly AnchorType[] = ['historical-meme', 'cultural-artifact', 'inciting-event', 'none'];
const ANCHOR_CONFIDENCE: readonly AnchorConfidence[] = ['high', 'medium', 'low'];

/**
 * The JSON blob carries the full anchor check and gate; the promoted columns
 * win for everything a listing filters on, and rebuild a minimal anchor when
 * the blob is unreadable.
 */
export function rowToWatch(row: SqlRow, logger: Logger = silentLogger): WatchEntry {
  const blob = parseObject<Partial<WatchEntry>>(row.entry_json, 'watchlist.entry_json', {}, logger);
  const tokenId = text(row.token_id);
  const leadHours = asNumber(row.lead_hours);
  const fallbackAnchor: AnchorCheck = {
    verdict: 'unclear',
    type: 'none',
    subject: text(row.referent),
    summary: '',
    confidence: 'low',
    model: 'unknown',
    checkedAt: text(row.first_seen_at),
    citations: [],
  };
  const anchor: AnchorCheck = { ...fallbackAnchor, ...(blob.anchor ?? {}) };
  anchor.verdict = oneOf(row.anchor_verdict, ANCHOR_VERDICTS, anchor.verdict);
  anchor.type = oneOf(row.anchor_type, ANCHOR_TYPES, anchor.type);
  anchor.confidence = oneOf(row.referent_confidence, ANCHOR_CONFIDENCE, anchor.confidence);
  const anchorDate = asText(row.anchor_date);
  if (anchorDate) anchor.anchorDate = anchorDate;

  const entry: WatchEntry = {
    tokenId,
    chain: normalizeChain(asText(row.chain) ?? parseTokenId(tokenId).chain),
    tokenAddress: text(row.address, parseTokenId(tokenId).address),
    symbol: text(row.symbol, blob.symbol ?? ''),
    name: text(row.name, blob.name ?? ''),
    status: asWatchStatus(row.status),
    firstSeenAt: text(row.first_seen_at, blob.firstSeenAt ?? ''),
    anchor,
    gate: blob.gate ?? { passed: true, reasons: [] },
    updatedAt: text(row.updated_at, blob.updatedAt ?? ''),
  };
  const launchedAt = asText(row.launched_at) ?? blob.launchedAt;
  if (launchedAt) entry.launchedAt = launchedAt;
  const expressedAt = asText(row.expressed_at) ?? blob.expressedAt;
  if (expressedAt) entry.expressedAt = expressedAt;
  if (leadHours !== undefined) entry.leadHours = leadHours;
  if (blob.expressedOn) entry.expressedOn = blob.expressedOn;
  const socialAt = asText(row.social_at) ?? blob.socialAt;
  if (socialAt) entry.socialAt = socialAt;
  const socialLeadHours = asNumber(row.social_lead_hours) ?? blob.socialLeadHours;
  if (socialLeadHours !== undefined) entry.socialLeadHours = socialLeadHours;
  if (blob.socialOn) entry.socialOn = blob.socialOn;
  if (blob.liquidityUsdAtCatalog !== undefined) entry.liquidityUsdAtCatalog = blob.liquidityUsdAtCatalog;
  if (blob.researched !== undefined) entry.researched = blob.researched;
  return entry;
}

/**
 * The migration-2 `referent` / `referent_confidence` columns now hold the
 * anchor subject and confidence; renaming them would mean rebuilding the
 * table on libSQL for no behavioural gain.
 */
export function watchRowArgs(entry: WatchEntry): (string | number | null)[] {
  return [
    entry.tokenId,
    entry.chain,
    entry.tokenAddress,
    entry.symbol,
    entry.name,
    entry.status,
    entry.firstSeenAt,
    entry.launchedAt ?? null,
    entry.expressedAt ?? null,
    entry.leadHours ?? null,
    entry.anchor.subject,
    entry.anchor.confidence,
    entry.updatedAt,
    JSON.stringify(entry),
    entry.anchor.verdict,
    entry.anchor.type,
    entry.anchor.anchorDate ?? null,
    entry.socialAt ?? null,
    entry.socialLeadHours ?? null,
  ];
}

// ---------------------------------------------------------------------------
// social sightings
// ---------------------------------------------------------------------------

/** Row from the grouped `socialFirstSeen` query, not from the table itself. */
export function rowToSocialFirstSeen(row: SqlRow): SocialFirstSeen {
  const platforms = new Set(
    text(row.platforms)
      .split(',')
      .map((part) => part.trim())
      .filter((part): part is SocialPlatform => (SOCIAL_PLATFORMS as readonly string[]).includes(part)),
  );
  return {
    tokenId: text(row.token_id),
    firstSeenAt: text(row.first_seen_at),
    platforms: SOCIAL_PLATFORMS.filter((platform) => platforms.has(platform)),
    peakMentions: num(row.peak_mentions),
  };
}
