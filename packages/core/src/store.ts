import type { Alert, DeliveryResult } from './alerts';
import type { TokenSnapshot } from './market';
import type { ChainAnalysis } from './onchain';
import type { OrganicVerdict, ProvenanceReport, ProvenanceScore, ScoreComponents, ScoreTier } from './provenance';
import type { SocialFirstSeen, SocialSighting, SocialStats } from './social';
import type { WatchEntry, WatchQuery } from './watchlist';

export type RunStatus = 'running' | 'ok' | 'partial' | 'failed';

export interface RunRecord {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  stats: RunStats;
  error?: string;
}

export interface RunStats {
  discovered: number;
  afterFilter: number;
  analysed: number;
  reused: number;
  alertsFired: number;
  llmCostUsd: number;
  sourceErrors: { source: string; error: string }[];
  durationMs?: number;
  /** Which lane wrote the run. Absent on runs from before it was recorded. */
  lane?: 'full' | 'launches';
  /** Launch-lane counters. Absent on runs from before the lane existed. */
  launches?: LaunchStats;
  /** Crypto-social step. Absent on runs from before it existed. */
  social?: SocialStats;
  /** Outcome labelling step (docs/calibration.md). Absent when it did not run. */
  outcomes?: OutcomeStats;
}

export interface OutcomeStats {
  /** Scored (run, token) pairs past the horizon and not yet labelled, after the one-per-day dedupe. */
  pending: number;
  /** Labelled this run. */
  measured: number;
  survived: number;
  /** Labelled with no pair found at all. */
  notFound: number;
  /** Candidates whose address could not be put in a request (empty or with whitespace). */
  skipped: number;
}

/**
 * A scored (run, token) old enough to label, with the market as it stood
 * when it was scored. `liqAtScore` is the deepest pair's liquidity in the
 * snapshot (the labels compare it with the deepest pair now); only rows with
 * a reading are candidates, since survival is defined against it.
 */
export interface OutcomeCandidate {
  tokenId: string;
  chain: string;
  address: string;
  runId: string;
  /** The run's `started_at`. */
  scoredAt: string;
  liqAtScore: number;
  priceAtScore?: number;
}

/**
 * Oldest a score may be and still be labelled at a horizon, in hours: half a
 * horizon of slack for missed runs, plus a day because a token-day is only
 * labelled once the whole UTC day is past the horizon (so the day's latest
 * run is the one labelled). Older scores are never labelled, so turning the
 * step on does not label the whole history late; calibration also drops any
 * label measured later than this after its score.
 */
export function outcomeMaxLagHours(horizonHours: number): number {
  return 1.5 * horizonHours + 24;
}

/**
 * The forward look at one scored token: did its deepest pool keep at least
 * half of the liquidity it had when scored (docs/calibration.md)?
 */
export interface OutcomeRecord {
  tokenId: string;
  runId: string;
  /** Nominal horizon. `measuredAt - scoredAt` is the real one, and can be longer on a backlog. */
  horizonH: number;
  scoredAt: string;
  measuredAt: string;
  liqAtScore: number;
  liqNow?: number;
  priceAtScore?: number;
  priceNow?: number;
  /** False when DexScreener returned no pair for the token at all. */
  pairFound: boolean;
  survived: boolean;
}

/** One labelled score with the report it was scored on: the calibration input. */
export interface CalibrationRow {
  tokenId: string;
  runId: string;
  scoredAt: string;
  total: number;
  tier: ScoreTier;
  components: ScoreComponents;
  /** Absent when the token was scored without a report. */
  recycleGeneration?: number;
  /** Absent on pre-v4 reports and report-less scores. */
  organicVerdict?: OrganicVerdict;
  /** lower(meme_name). */
  meme?: string;
  narrativeCluster?: string;
  survived: boolean;
}

export interface LaunchStats {
  /** Launch-only tokens discovered this run. */
  discovered: number;
  /** Rejected by a hard filter, before or after chain analysis. */
  rejected: number;
  /** Passed the gate, judged forced or unclear. */
  dismissed: number;
  /** Passed the gate, judged anchored, added to the watchlist. */
  catalogued: number;
  /** Anchored launches that also got the full provenance research. */
  researched: number;
  /** Watchlisted tokens seen trending for the first time this run. */
  expressed: number;
  /** Watchlisted tokens aged out this run. */
  dormant: number;
}

/** One token's complete picture for a run: what the dashboard renders. */
export interface TokenDossier {
  snapshot: TokenSnapshot;
  chain?: ChainAnalysis;
  provenance?: ProvenanceReport;
  score?: ProvenanceScore;
  alerts: Alert[];
  runId: string;
}

export interface DossierQuery {
  runId?: string;
  chain?: string;
  minScore?: number;
  tier?: string;
  verdict?: string;
  /** Anchor verdict: anchored | forced | unclear. */
  anchor?: string;
  /** Free-text match against symbol, name and meme name. */
  search?: string;
  limit?: number;
  offset?: number;
  /** Default: score descending. */
  orderBy?: 'score' | 'capturedAt' | 'rank';
}

/**
 * Persistence contract. The worker and the dashboard both talk to this, so a
 * different backing store only needs a new implementation of this interface.
 */
export interface ProvenanceStore {
  migrate(): Promise<void>;

  startRun(id: string): Promise<RunRecord>;
  finishRun(id: string, status: RunStatus, stats: RunStats, error?: string): Promise<void>;
  getRun(id: string): Promise<RunRecord | null>;
  latestRun(): Promise<RunRecord | null>;
  listRuns(limit?: number): Promise<RunRecord[]>;

  saveSnapshot(runId: string, snapshot: TokenSnapshot): Promise<void>;
  saveChainAnalysis(runId: string, analysis: ChainAnalysis): Promise<void>;
  saveProvenance(runId: string, report: ProvenanceReport): Promise<void>;
  saveScore(runId: string, score: ProvenanceScore): Promise<void>;
  saveAlert(alert: Alert, deliveries: DeliveryResult[]): Promise<void>;

  /** Most recent report for a token, used to skip re-analysis inside the TTL. */
  latestProvenance(tokenId: string): Promise<ProvenanceReport | null>;
  /** Score history for a token, oldest first. */
  scoreHistory(tokenId: string, limit?: number): Promise<ProvenanceScore[]>;

  listDossiers(query?: DossierQuery): Promise<TokenDossier[]>;
  getDossier(tokenId: string, runId?: string): Promise<TokenDossier | null>;
  listAlerts(limit?: number): Promise<Alert[]>;

  /** Launch-lane watchlist. `saveWatch` upserts, keeping `firstSeenAt`. */
  saveWatch(entry: WatchEntry): Promise<void>;
  getWatch(tokenId: string): Promise<WatchEntry | null>;
  listWatch(query?: WatchQuery): Promise<WatchEntry[]>;

  /**
   * Crypto-social sightings, one row per token and platform. Upserts keep the
   * earliest `seenAt`, so a token that drops off a feed and returns keeps its
   * first sighting.
   */
  recordSocialSightings(sightings: SocialSighting[]): Promise<void>;
  /** Earliest sighting per token, across platforms. Unsighted ids are absent. */
  socialFirstSeen(tokenIds: string[]): Promise<SocialFirstSeen[]>;

  /**
   * Scored (run, token) pairs from full-lane runs on UTC days that ended at
   * least `horizonHours` before `now`, started no more than
   * `outcomeMaxLagHours` ago, and have no outcome at that horizon on that
   * day yet. Every such row, newest first: the caller picks the latest per
   * token per day (one day's hourly runs must not count as many outcomes).
   */
  outcomeCandidates(query: { horizonHours: number; now?: string }): Promise<OutcomeCandidate[]>;
  /** Upserts on (token_id, run_id, horizon_h). */
  saveOutcomes(records: OutcomeRecord[]): Promise<void>;
  /**
   * Every labelled score at `horizonHours` measured within
   * `outcomeMaxLagHours` of its score, joined to the report it was scored on.
   */
  calibrationRows(horizonHours: number): Promise<CalibrationRow[]>;

  /** Cache for fetched evidence pages, keyed by URL hash. */
  getCachedEvidence(key: string, maxAgeHours: number): Promise<string | null>;
  putCachedEvidence(key: string, url: string, content: string): Promise<void>;

  close(): Promise<void>;
}
