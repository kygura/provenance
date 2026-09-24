import type { Alert, DeliveryResult } from './alerts';
import type { Logger } from './log';
import type { AppConfig, SourceConfig } from './config';
import type { TokenSnapshot, TrendingEntry } from './market';
import type { ChainAnalysis } from './onchain';
import type { EvidenceItem, ProvenanceReport, ProvenanceScore } from './provenance';
import type { AnchorCheck } from './watchlist';

/** A trending-list provider. One implementation per upstream site. */
export interface TrendingSource {
  readonly id: SourceConfig['id'];
  /** Human name for logs and the dashboard. */
  readonly label: string;
  /** Pull the current trending list. Must never throw for a partial result. */
  fetchTrending(ctx: SourceContext): Promise<TrendingEntry[]>;
  /** Release browsers, sockets, etc. */
  dispose?(): Promise<void>;
}

export interface SourceContext {
  config: SourceConfig;
  app: AppConfig;
  logger: Logger;
  signal?: AbortSignal;
}

/** Per-chain on-chain analyser: holders, supply, authorities, risk flags. */
export interface ChainAnalyzer {
  readonly chains: readonly string[];
  analyze(snapshot: TokenSnapshot, ctx: AnalyzerContext): Promise<ChainAnalysis>;
}

export interface AnalyzerContext {
  app: AppConfig;
  logger: Logger;
  signal?: AbortSignal;
}

/** Gathers public evidence about a meme before the model reasons over it. */
export interface EvidenceCollector {
  readonly id: string;
  collect(snapshot: TokenSnapshot, ctx: ResearchContext): Promise<EvidenceItem[]>;
}

export interface ResearchContext {
  app: AppConfig;
  logger: Logger;
  /** Returns cached page content, or null on a miss. */
  cacheGet?(key: string): Promise<string | null>;
  cachePut?(key: string, url: string, content: string): Promise<void>;
  signal?: AbortSignal;
}

/** Turns a snapshot plus evidence into a provenance report via the LLM. */
export interface ProvenanceResearcher {
  research(
    snapshot: TokenSnapshot,
    chain: ChainAnalysis | undefined,
    evidence: EvidenceItem[],
    ctx: ResearchContext,
  ): Promise<ProvenanceReport>;
}

/**
 * The fast answer to the anchor question, run on every launch that clears the
 * gate. A few searches on the triage model; an `anchored` answer is followed
 * straight away by the full `ProvenanceResearcher`, at launch.
 */
export interface AnchorChecker {
  check(snapshot: TokenSnapshot, ctx: ResearchContext): Promise<AnchorCheck>;
}

export interface ScoringInput {
  snapshot: TokenSnapshot;
  chain?: ChainAnalysis;
  provenance?: ProvenanceReport;
}

export interface Scorer {
  score(input: ScoringInput): ProvenanceScore;
}

/** A named alert condition evaluated against a fully analysed token. */
export interface AlertRule {
  readonly id: string;
  readonly description: string;
  evaluate(input: AlertRuleInput): Omit<Alert, 'id' | 'runId' | 'createdAt'> | null;
}

export interface AlertRuleInput extends ScoringInput {
  score: ProvenanceScore;
  config: AppConfig;
  /** Prior scores for the same token, oldest first. Enables delta rules. */
  history: ProvenanceScore[];
}

export interface AlertChannelSink {
  readonly channel: DeliveryResult['channel'];
  readonly enabled: boolean;
  send(alert: Alert): Promise<DeliveryResult>;
}
