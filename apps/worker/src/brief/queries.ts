/**
 * Queries A–G from CLAUDE.md §2, verbatim, with the run ids bound as libSQL
 * arguments rather than pasted into the SQL. Every cell is coerced here:
 * remote libSQL and Turso's HTTP API can hand numbers back as strings, and a
 * string compared with a number is the bug the old prompt kept making.
 *
 * Read-only. Nothing in this file writes.
 */

import { SEVERE_ALERT_RULES } from './ledger';

/** The slice of `@libsql/client`'s Client the brief needs. `LibsqlStore.raw` satisfies it. */
export interface SqlExecutor {
  execute(stmt: { sql: string; args: (string | number | null)[] }): Promise<{ rows: ArrayLike<unknown> }>;
}

type Cell = unknown;
type RawRow = Record<string, Cell>;

async function select(db: SqlExecutor, sql: string, args: (string | number | null)[] = []): Promise<RawRow[]> {
  const result = await db.execute({ sql, args });
  return Array.from(result.rows as ArrayLike<RawRow>);
}

export function toNum(value: Cell): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function toStr(value: Cell): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return undefined;
}

/** SQLite has no boolean: 1/0, '1'/'0', 'true'/'false' and JSON true/false all arrive. */
export function toBool(value: Cell): boolean | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (text === '1' || text === 'true') return true;
  if (text === '0' || text === 'false') return false;
  return undefined;
}

function parseJson<T>(value: Cell, fallback: T): T {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// A. pipeline health
// ---------------------------------------------------------------------------

export interface RunRow {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: string;
  error?: string;
  discovered?: number;
  analysed?: number;
  alertsFired?: number;
  llmCostUsd?: number;
  launchesCatalogued?: number;
  launchesExpressed?: number;
  sourceErrors: number;
  hasSnapshots: boolean;
}

export const SQL_A_RUNS = `SELECT id, started_at, finished_at, status, error,
       json_extract(stats_json,'$.discovered')           AS discovered,
       json_extract(stats_json,'$.analysed')             AS analysed,
       json_extract(stats_json,'$.alertsFired')          AS alerts_fired,
       json_extract(stats_json,'$.llmCostUsd')           AS llm_cost_usd,
       json_extract(stats_json,'$.launches.catalogued')  AS launches_catalogued,
       json_extract(stats_json,'$.launches.expressed')   AS launches_expressed,
       json_array_length(json_extract(stats_json,'$.sourceErrors')) AS source_errors,
       EXISTS (SELECT 1 FROM snapshots s WHERE s.run_id = runs.id) AS has_snapshots
FROM runs
WHERE started_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')
ORDER BY started_at DESC`;

export const SQL_A_FULL_RUNS = `SELECT id, started_at, status FROM runs r
WHERE status IN ('ok','partial')
  AND EXISTS (SELECT 1 FROM snapshots s WHERE s.run_id = r.id)
ORDER BY started_at DESC, id DESC LIMIT 2`;

export const SQL_A_RUN_ERRORS = `SELECT json_extract(stats_json,'$.sourceErrors') AS source_errors, error FROM runs WHERE id=?`;

export interface FullRun {
  id: string;
  startedAt: string;
  status: string;
}

export async function queryRuns24h(db: SqlExecutor): Promise<RunRow[]> {
  return (await select(db, SQL_A_RUNS)).map((row) => ({
    id: toStr(row.id) ?? '',
    startedAt: toStr(row.started_at) ?? '',
    ...(toStr(row.finished_at) ? { finishedAt: toStr(row.finished_at) } : {}),
    status: toStr(row.status) ?? 'unknown',
    ...(toStr(row.error) ? { error: toStr(row.error) } : {}),
    discovered: toNum(row.discovered),
    analysed: toNum(row.analysed),
    alertsFired: toNum(row.alerts_fired),
    llmCostUsd: toNum(row.llm_cost_usd),
    launchesCatalogued: toNum(row.launches_catalogued),
    launchesExpressed: toNum(row.launches_expressed),
    sourceErrors: toNum(row.source_errors) ?? 0,
    hasSnapshots: toBool(row.has_snapshots) ?? false,
  }));
}

/** `[CUR, PREV]`: the two latest finished runs that wrote snapshots. Launch-lane runs never do. */
export async function queryFullRuns(db: SqlExecutor): Promise<{ cur?: FullRun; prev?: FullRun }> {
  const rows = (await select(db, SQL_A_FULL_RUNS)).map((row) => ({
    id: toStr(row.id) ?? '',
    startedAt: toStr(row.started_at) ?? '',
    status: toStr(row.status) ?? 'unknown',
  }));
  return { cur: rows[0], prev: rows[1] };
}

export interface RunErrors {
  sourceErrors: { source: string; error: string }[];
  error?: string;
}

export async function queryRunErrors(db: SqlExecutor, runId: string): Promise<RunErrors> {
  const row = (await select(db, SQL_A_RUN_ERRORS, [runId]))[0];
  if (!row) return { sourceErrors: [] };
  const raw = parseJson<unknown>(row.source_errors, []);
  const sourceErrors = (Array.isArray(raw) ? raw : [])
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({ source: toStr(item.source) ?? 'unknown', error: toStr(item.error) ?? '' }));
  return { sourceErrors, ...(toStr(row.error) ? { error: toStr(row.error) } : {}) };
}

// ---------------------------------------------------------------------------
// B. the current run's dossiers, with the previous run's score
// ---------------------------------------------------------------------------

export interface ChainFlag {
  code: string;
  severity: string;
  detail: string;
}

export interface DossierRow {
  tokenId: string;
  chain: string;
  address: string;
  /** Deployer-written. Untrusted. */
  symbol: string;
  /** Deployer-written. Untrusted. */
  name: string;
  firstSeenAt: string;
  bestRank?: number;
  sourceCount?: number;
  liqUsd?: number;
  vol24hUsd?: number;
  mcapUsd?: number;
  chg24hPct?: number;
  ageH?: number;
  pairUrl?: string;
  score?: number;
  tier?: string;
  components: Record<string, number>;
  penalties: { reason: string; points: number }[];
  prevScore?: number;
  prevTier?: string;
  anchorVerdict?: string;
  recycleVerdict?: string;
  recycleGeneration?: number;
  confidence?: number;
  /** LLM-written from web evidence. Untrusted. */
  memeName?: string;
  narrativeCluster?: string;
  provenanceAt?: string;
  setup?: string;
  reportRisks: string[];
  anchorSummary?: string;
  top10Pct?: number;
  holderCount?: number;
  largestHolderPct?: number;
  creatorPct?: number;
  lpBurnedPct?: number;
  lpLockedPct?: number;
  mintActive?: boolean;
  freezeActive?: boolean;
  flags: ChainFlag[];
}

export const SQL_B = `SELECT t.id AS token_id, t.chain, t.address, t.symbol, t.name, t.first_seen_at,
       sn.best_rank, sn.source_count,
       json_extract(sn.metrics_json,'$.liquidityUsd')    AS liq_usd,
       json_extract(sn.metrics_json,'$.volume24hUsd')    AS vol24h_usd,
       json_extract(sn.metrics_json,'$.marketCapUsd')    AS mcap_usd,
       json_extract(sn.metrics_json,'$.priceChange24h')  AS chg24h_pct,
       json_extract(sn.metrics_json,'$.ageHours')        AS age_h,
       json_extract(sn.pairs_json,'$[0].url')            AS pair_url,
       sc.total AS score, sc.tier, sc.components_json, sc.penalties_json,
       prev.total AS prev_score, prev.tier AS prev_tier,
       p.anchor_verdict, p.recycle_verdict, p.recycle_generation, p.confidence,
       p.meme_name, p.narrative_cluster, p.created_at AS provenance_at,
       json_extract(p.report_json,'$.speculativeSetup')  AS setup,
       json_extract(p.report_json,'$.risks')             AS report_risks,
       json_extract(p.report_json,'$.anchor.summary')    AS anchor_summary,
       ca.top10_pct, ca.holder_count,
       json_extract(ca.data_json,'$.largestHolderPct')   AS largest_holder_pct,
       json_extract(ca.data_json,'$.creatorHoldingPct')  AS creator_pct,
       json_extract(ca.data_json,'$.lpBurnedPct')        AS lp_burned_pct,
       json_extract(ca.data_json,'$.lpLockedPct')        AS lp_locked_pct,
       json_extract(ca.data_json,'$.mintAuthorityActive')   AS mint_active,
       json_extract(ca.data_json,'$.freezeAuthorityActive') AS freeze_active,
       json_extract(ca.data_json,'$.flags')              AS flags
FROM snapshots sn
JOIN tokens t ON t.id = sn.token_id
LEFT JOIN scores sc         ON sc.run_id = sn.run_id AND sc.token_id = sn.token_id
LEFT JOIN scores prev       ON prev.run_id = ? AND prev.token_id = sn.token_id
LEFT JOIN provenance p      ON p.run_id = sn.run_id AND p.token_id = sn.token_id
LEFT JOIN chain_analysis ca ON ca.run_id = sn.run_id AND ca.token_id = sn.token_id
WHERE sn.run_id = ?
ORDER BY sc.total IS NULL, sc.total DESC, sn.best_rank ASC`;

function numberRecord(value: Cell): Record<string, number> {
  const parsed = parseJson<unknown>(value, {});
  const out: Record<string, number> = {};
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out;
  for (const [key, raw] of Object.entries(parsed)) {
    const n = toNum(raw);
    if (n !== undefined) out[key] = n;
  }
  return out;
}

function penaltyList(value: Cell): { reason: string; points: number }[] {
  const parsed = parseJson<unknown>(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({ reason: toStr(item.reason) ?? '', points: toNum(item.points) ?? 0 }));
}

function stringList(value: Cell): string[] {
  const parsed = parseJson<unknown>(value, []);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
}

export function parseFlags(value: Cell): ChainFlag[] {
  const parsed = parseJson<unknown>(value, []);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      code: toStr(item.code) ?? '',
      severity: (toStr(item.severity) ?? '').toLowerCase(),
      detail: toStr(item.detail) ?? '',
    }));
}

/** `prevRunId` may be undefined (first full run ever): the join then matches nothing. */
export async function queryDossiers(db: SqlExecutor, curRunId: string, prevRunId?: string): Promise<DossierRow[]> {
  const rows = await select(db, SQL_B, [prevRunId ?? null, curRunId]);
  return rows.map((row) => ({
    tokenId: toStr(row.token_id) ?? '',
    chain: toStr(row.chain) ?? '',
    address: toStr(row.address) ?? '',
    symbol: toStr(row.symbol) ?? '',
    name: toStr(row.name) ?? '',
    firstSeenAt: toStr(row.first_seen_at) ?? '',
    bestRank: toNum(row.best_rank),
    sourceCount: toNum(row.source_count),
    liqUsd: toNum(row.liq_usd),
    vol24hUsd: toNum(row.vol24h_usd),
    mcapUsd: toNum(row.mcap_usd),
    chg24hPct: toNum(row.chg24h_pct),
    ageH: toNum(row.age_h),
    pairUrl: toStr(row.pair_url),
    score: toNum(row.score),
    tier: toStr(row.tier),
    components: numberRecord(row.components_json),
    penalties: penaltyList(row.penalties_json),
    prevScore: toNum(row.prev_score),
    prevTier: toStr(row.prev_tier),
    anchorVerdict: toStr(row.anchor_verdict),
    recycleVerdict: toStr(row.recycle_verdict),
    recycleGeneration: toNum(row.recycle_generation),
    confidence: toNum(row.confidence),
    memeName: toStr(row.meme_name),
    narrativeCluster: toStr(row.narrative_cluster),
    provenanceAt: toStr(row.provenance_at),
    setup: toStr(row.setup),
    reportRisks: stringList(row.report_risks),
    anchorSummary: toStr(row.anchor_summary),
    top10Pct: toNum(row.top10_pct),
    holderCount: toNum(row.holder_count),
    largestHolderPct: toNum(row.largest_holder_pct),
    creatorPct: toNum(row.creator_pct),
    lpBurnedPct: toNum(row.lp_burned_pct),
    lpLockedPct: toNum(row.lp_locked_pct),
    mintActive: toBool(row.mint_active),
    freezeActive: toBool(row.freeze_active),
    flags: parseFlags(row.flags),
  }));
}

// ---------------------------------------------------------------------------
// C. previous verdicts, for every token in a run
// ---------------------------------------------------------------------------

export interface VerdictRow {
  tokenId: string;
  runId: string;
  createdAt: string;
  anchorVerdict?: string;
  recycleVerdict?: string;
  confidence?: number;
}

/**
 * Query C for every token of a run in one round trip: the three newest
 * provenance rows per token (CLAUDE.md's `ORDER BY created_at DESC LIMIT 3`),
 * windowed instead of one query per token. Notable selection needs it to see
 * a changed verdict, so it has to cover the whole run, before selection.
 */
export const SQL_C_WINDOWED = `SELECT token_id, run_id, created_at, anchor_verdict, recycle_verdict, confidence FROM (
  SELECT p.token_id, p.run_id, p.created_at, p.anchor_verdict, p.recycle_verdict, p.confidence,
         ROW_NUMBER() OVER (PARTITION BY p.token_id ORDER BY p.created_at DESC) AS rn
  FROM provenance p
  WHERE p.token_id IN (SELECT token_id FROM snapshots WHERE run_id = ?)
) WHERE rn <= 3
ORDER BY token_id, created_at DESC`;

/** Newest first per token; tokens with no provenance are absent. */
export async function queryVerdictHistory(db: SqlExecutor, runId: string): Promise<Map<string, VerdictRow[]>> {
  const out = new Map<string, VerdictRow[]>();
  for (const row of await select(db, SQL_C_WINDOWED, [runId])) {
    const verdict: VerdictRow = {
      tokenId: toStr(row.token_id) ?? '',
      runId: toStr(row.run_id) ?? '',
      createdAt: toStr(row.created_at) ?? '',
      anchorVerdict: toStr(row.anchor_verdict),
      recycleVerdict: toStr(row.recycle_verdict),
      confidence: toNum(row.confidence),
    };
    const list = out.get(verdict.tokenId) ?? [];
    list.push(verdict);
    out.set(verdict.tokenId, list);
  }
  return out;
}

// ---------------------------------------------------------------------------
// D. alerts in the last 24 h
// ---------------------------------------------------------------------------

export interface AlertRow {
  createdAt: string;
  runId: string;
  tokenId: string;
  symbol?: string;
  rule: string;
  severity: string;
  /** Rendered from web-derived report text. Untrusted. */
  title: string;
  body: string;
}

export const SQL_D = `SELECT a.created_at, a.run_id, a.token_id, t.symbol, a.rule, a.severity, a.title, a.body
FROM alerts a LEFT JOIN tokens t ON t.id = a.token_id
WHERE a.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')
ORDER BY a.created_at DESC`;

export async function queryAlerts24h(db: SqlExecutor): Promise<AlertRow[]> {
  return (await select(db, SQL_D)).map((row) => ({
    createdAt: toStr(row.created_at) ?? '',
    runId: toStr(row.run_id) ?? '',
    tokenId: toStr(row.token_id) ?? '',
    symbol: toStr(row.symbol),
    rule: toStr(row.rule) ?? '',
    severity: toStr(row.severity) ?? '',
    title: toStr(row.title) ?? '',
    body: toStr(row.body) ?? '',
  }));
}

/** Severe alerts on specific tokens, any age: the ledger's kill condition compares them with each setup's creation time. */
export async function querySevereAlerts(db: SqlExecutor, tokenIds: readonly string[]): Promise<AlertRow[]> {
  if (tokenIds.length === 0) return [];
  const ids = [...new Set(tokenIds)].slice(0, 200);
  const rows = await select(
    db,
    `SELECT a.created_at, a.run_id, a.token_id, a.rule, a.severity, a.title, a.body
     FROM alerts a
     WHERE a.rule IN (${SEVERE_ALERT_RULES.map(() => '?').join(', ')}) AND a.token_id IN (${ids.map(() => '?').join(', ')})
     ORDER BY a.created_at DESC`,
    [...SEVERE_ALERT_RULES, ...ids],
  );
  return rows.map((row) => ({
    createdAt: toStr(row.created_at) ?? '',
    runId: toStr(row.run_id) ?? '',
    tokenId: toStr(row.token_id) ?? '',
    rule: toStr(row.rule) ?? '',
    severity: toStr(row.severity) ?? '',
    title: toStr(row.title) ?? '',
    body: toStr(row.body) ?? '',
  }));
}

// ---------------------------------------------------------------------------
// E. watchlist changes in the last 24 h
// ---------------------------------------------------------------------------

export interface WatchRow {
  tokenId: string;
  chain: string;
  address: string;
  symbol: string;
  status: string;
  anchorVerdict?: string;
  anchorType?: string;
  anchorDate?: string;
  firstSeenAt: string;
  launchedAt?: string;
  expressedAt?: string;
  leadHours?: number;
  socialAt?: string;
  socialLeadHours?: number;
  updatedAt: string;
  /** LLM-written from web evidence. Untrusted. */
  anchorSubject?: string;
  anchorSummary?: string;
  anchorConf?: string;
  liqAtCatalog?: number;
  expressedOn: string[];
}

export const SQL_E = `SELECT token_id, chain, address, symbol, status, anchor_verdict, anchor_type, anchor_date,
       first_seen_at, launched_at, expressed_at, lead_hours, social_at, social_lead_hours, updated_at,
       json_extract(entry_json,'$.anchor.subject')        AS anchor_subject,
       json_extract(entry_json,'$.anchor.summary')        AS anchor_summary,
       json_extract(entry_json,'$.anchor.confidence')     AS anchor_conf,
       json_extract(entry_json,'$.liquidityUsdAtCatalog') AS liq_at_catalog,
       json_extract(entry_json,'$.expressedOn')           AS expressed_on
FROM watchlist
WHERE first_seen_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')
   OR expressed_at  >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')
   OR social_at     >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours')
   OR (status = 'dormant' AND updated_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-24 hours'))
ORDER BY updated_at DESC`;

export async function queryWatchChanges(db: SqlExecutor): Promise<WatchRow[]> {
  return (await select(db, SQL_E)).map((row) => ({
    tokenId: toStr(row.token_id) ?? '',
    chain: toStr(row.chain) ?? '',
    address: toStr(row.address) ?? '',
    symbol: toStr(row.symbol) ?? '',
    status: toStr(row.status) ?? '',
    anchorVerdict: toStr(row.anchor_verdict),
    anchorType: toStr(row.anchor_type),
    anchorDate: toStr(row.anchor_date),
    firstSeenAt: toStr(row.first_seen_at) ?? '',
    launchedAt: toStr(row.launched_at),
    expressedAt: toStr(row.expressed_at),
    leadHours: toNum(row.lead_hours),
    socialAt: toStr(row.social_at),
    socialLeadHours: toNum(row.social_lead_hours),
    updatedAt: toStr(row.updated_at) ?? '',
    anchorSubject: toStr(row.anchor_subject),
    anchorSummary: toStr(row.anchor_summary),
    anchorConf: toStr(row.anchor_conf),
    liqAtCatalog: toNum(row.liq_at_catalog),
    expressedOn: stringList(row.expressed_on),
  }));
}

/** Active watchlist entries: the other place a setup may come from (spec, gate rule 1). */
export async function queryActiveWatch(db: SqlExecutor): Promise<{ tokenId: string; anchorVerdict?: string }[]> {
  const rows = await select(db, `SELECT token_id, anchor_verdict FROM watchlist WHERE status = 'active'`);
  return rows.map((row) => ({ tokenId: toStr(row.token_id) ?? '', anchorVerdict: toStr(row.anchor_verdict) }));
}

// ---------------------------------------------------------------------------
// F. watchlist track record
// ---------------------------------------------------------------------------

export interface TrackRow {
  anchorVerdict: string;
  status: string;
  n: number;
  avgLeadH?: number;
  avgSocialLeadH?: number;
  n7d: number;
}

export const SQL_F = `SELECT anchor_verdict, status, count(*) AS n,
       round(avg(lead_hours),1) AS avg_lead_h,
       round(avg(social_lead_hours),1) AS avg_social_lead_h,
       sum(first_seen_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')) AS n_7d
FROM watchlist GROUP BY anchor_verdict, status ORDER BY anchor_verdict, status`;

export async function queryTrackRecord(db: SqlExecutor): Promise<TrackRow[]> {
  return (await select(db, SQL_F)).map((row) => ({
    anchorVerdict: toStr(row.anchor_verdict) ?? 'unclear',
    status: toStr(row.status) ?? '',
    n: toNum(row.n) ?? 0,
    avgLeadH: toNum(row.avg_lead_h),
    avgSocialLeadH: toNum(row.avg_social_lead_h),
    n7d: toNum(row.n_7d) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// G. narrative clusters, last 7 days
// ---------------------------------------------------------------------------

export interface ClusterRow {
  /** LLM-written label. Untrusted. */
  cluster: string;
  tokens: number;
  avgScore?: number;
  lastSeen: string;
}

export const SQL_G = `SELECT p.narrative_cluster, count(DISTINCT p.token_id) AS tokens,
       round(avg(sc.total),1) AS avg_score, max(p.created_at) AS last_seen
FROM provenance p
LEFT JOIN scores sc ON sc.run_id = p.run_id AND sc.token_id = p.token_id
WHERE p.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')
GROUP BY p.narrative_cluster HAVING tokens >= 2
ORDER BY tokens DESC, avg_score DESC LIMIT 10`;

export async function queryClusters(db: SqlExecutor): Promise<ClusterRow[]> {
  return (await select(db, SQL_G)).map((row) => ({
    cluster: toStr(row.narrative_cluster) ?? '',
    tokens: toNum(row.tokens) ?? 0,
    avgScore: toNum(row.avg_score),
    lastSeen: toStr(row.last_seen) ?? '',
  }));
}

// ---------------------------------------------------------------------------
// Regime inputs (docs/brief-routine.md, pipeline step 3)
// ---------------------------------------------------------------------------

export interface RegimeCounts {
  saTokens7d: number;
  saTokensPrev7d: number;
  meanScore7d?: number;
  meanScorePrev7d?: number;
  alerts7d: number;
  alertsPrev7d: number;
  anchored30d: { expressed: number; dormant: number; active: number };
}

const SQL_REGIME_SCORES = `SELECT
  count(DISTINCT CASE WHEN tier IN ('S','A') AND computed_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days') THEN token_id END) AS sa_cur,
  count(DISTINCT CASE WHEN tier IN ('S','A') AND computed_at <  strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days') THEN token_id END) AS sa_prev,
  avg(CASE WHEN computed_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days') THEN total END) AS mean_cur,
  avg(CASE WHEN computed_at <  strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days') THEN total END) AS mean_prev
FROM scores WHERE computed_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-14 days')`;

const SQL_REGIME_ALERTS = `SELECT
  sum(created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')) AS a_cur,
  sum(created_at <  strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')) AS a_prev
FROM alerts WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-14 days')`;

const SQL_REGIME_ANCHORED = `SELECT status, count(*) AS n FROM watchlist
WHERE anchor_verdict = 'anchored' AND first_seen_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')
GROUP BY status`;

export async function queryRegimeCounts(db: SqlExecutor): Promise<RegimeCounts> {
  const scores = (await select(db, SQL_REGIME_SCORES))[0] ?? {};
  const alerts = (await select(db, SQL_REGIME_ALERTS))[0] ?? {};
  const anchored = { expressed: 0, dormant: 0, active: 0 };
  for (const row of await select(db, SQL_REGIME_ANCHORED)) {
    const status = toStr(row.status);
    if (status === 'expressed' || status === 'dormant' || status === 'active') anchored[status] = toNum(row.n) ?? 0;
  }
  return {
    saTokens7d: toNum(scores.sa_cur) ?? 0,
    saTokensPrev7d: toNum(scores.sa_prev) ?? 0,
    meanScore7d: toNum(scores.mean_cur),
    meanScorePrev7d: toNum(scores.mean_prev),
    alerts7d: toNum(alerts.a_cur) ?? 0,
    alertsPrev7d: toNum(alerts.a_prev) ?? 0,
    anchored30d: anchored,
  };
}

// ---------------------------------------------------------------------------
// Latest per-token facts, for setups and proposals on tokens not in CUR
// ---------------------------------------------------------------------------

export interface TokenFacts {
  tokenId: string;
  symbol?: string;
  tier?: string;
  score?: number;
  anchorVerdict?: string;
  top10Pct?: number;
  largestHolderPct?: number;
  mintActive?: boolean;
  freezeActive?: boolean;
  flags: ChainFlag[];
}

export async function queryLatestFacts(db: SqlExecutor, tokenId: string): Promise<TokenFacts> {
  const score = (
    await select(db, `SELECT total, tier FROM scores WHERE token_id = ? ORDER BY computed_at DESC LIMIT 1`, [tokenId])
  )[0];
  const chain = (
    await select(
      db,
      `SELECT top10_pct,
              json_extract(data_json,'$.largestHolderPct')      AS largest_holder_pct,
              json_extract(data_json,'$.mintAuthorityActive')   AS mint_active,
              json_extract(data_json,'$.freezeAuthorityActive') AS freeze_active,
              json_extract(data_json,'$.flags')                 AS flags
       FROM chain_analysis WHERE token_id = ? ORDER BY created_at DESC LIMIT 1`,
      [tokenId],
    )
  )[0];
  const verdict = (
    await select(
      db,
      `SELECT anchor_verdict FROM provenance WHERE token_id = ? AND anchor_verdict IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      [tokenId],
    )
  )[0];
  const token = (await select(db, `SELECT symbol FROM tokens WHERE id = ?`, [tokenId]))[0];
  return {
    tokenId,
    symbol: toStr(token?.symbol),
    tier: toStr(score?.tier),
    score: toNum(score?.total),
    anchorVerdict: toStr(verdict?.anchor_verdict),
    top10Pct: toNum(chain?.top10_pct),
    largestHolderPct: toNum(chain?.largest_holder_pct),
    mintActive: toBool(chain?.mint_active),
    freezeActive: toBool(chain?.freeze_active),
    flags: parseFlags(chain?.flags),
  };
}
