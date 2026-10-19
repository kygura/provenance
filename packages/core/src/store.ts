import type { Alert, DeliveryResult } from './alerts';
import type { TokenSnapshot } from './market';
import type { ChainAnalysis } from './onchain';
import type { ProvenanceReport, ProvenanceScore } from './provenance';
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

  /** Cache for fetched evidence pages, keyed by URL hash. */
  getCachedEvidence(key: string, maxAgeHours: number): Promise<string | null>;
  putCachedEvidence(key: string, url: string, content: string): Promise<void>;

  close(): Promise<void>;
}
