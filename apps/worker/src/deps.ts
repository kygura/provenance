/**
 * The worker's seam against the five sibling packages.
 *
 * Everything the pipeline needs from `@provenance/{sources,chain,research,store,alerts}`
 * is declared here as a plain structural bundle over `@provenance/core` types. Two
 * reasons, both deliberate:
 *
 *  1. `runPipeline` takes this bundle as an argument, so the orchestration logic can
 *     be tested with stubs without a database, a browser or an API key.
 *  2. The real modules are pulled in through a *dynamic* import with a non-literal
 *     specifier, so the worker compiles and its tests run even while the packages
 *     behind those specifiers are still being written.
 */
import type {
  Alert,
  AlertChannelSink,
  AlertRule,
  AlertRuleInput,
  AnalyzerContext,
  AppConfig,
  ChainAnalysis,
  DeliveryResult,
  EvidenceItem,
  Logger,
  PipelineConfig,
  ProvenanceReport,
  ProvenanceResearcher,
  ProvenanceScore,
  ProvenanceStore,
  ResearchContext,
  ScoringInput,
  TokenSnapshot,
  TrendingEntry,
} from '@provenance/core';

export interface DiscoveryResult {
  entries: TrendingEntry[];
  errors: { source: string; error: string }[];
}

export interface FilterResult {
  kept: TokenSnapshot[];
  dropped: { tokenId: string; reason: string }[];
}

/** Everything the worker borrows from its sibling packages, in one injectable object. */
export interface PipelineDeps {
  // @provenance/sources
  discoverTrending(app: AppConfig, logger: Logger): Promise<DiscoveryResult>;
  mergeToSnapshots(entries: TrendingEntry[]): TokenSnapshot[];
  filterSnapshots(snapshots: TokenSnapshot[], pipeline: PipelineConfig): FilterResult;
  triageOrder(snapshots: TokenSnapshot[]): TokenSnapshot[];

  // @provenance/chain
  analyzeToken(snapshot: TokenSnapshot, ctx: AnalyzerContext): Promise<ChainAnalysis>;

  // @provenance/research
  collectEvidence(snapshot: TokenSnapshot, ctx: ResearchContext): Promise<EvidenceItem[]>;
  createResearcher(app: AppConfig, logger: Logger): ProvenanceResearcher;
  promptVersion: string;
  /** Free-text meme name -> stable slug, or null when nothing identifiable. */
  resolveMemeIdentity(name: string): { id: string; displayName: string } | null;
  /** Provisional meme subject from ticker and name alone, before the model runs. */
  provisionalMemeSubject(snapshot: TokenSnapshot): string;

  // @provenance/store
  createStore(app: AppConfig): ProvenanceStore;
  seedDemoData(store: ProvenanceStore): Promise<void>;

  // @provenance/alerts
  scoreToken(input: ScoringInput): ProvenanceScore;
  defaultRules: AlertRule[];
  createAlerts(runId: string, input: AlertRuleInput, rules?: AlertRule[]): Alert[];
  createSinks(app: AppConfig, logger: Logger): AlertChannelSink[];
  dispatchAlerts(
    alerts: Alert[],
    sinks: AlertChannelSink[],
    logger: Logger,
  ): Promise<Map<string, DeliveryResult[]>>;
}

/** Re-exported for the CLI, which hands reports around without importing the packages. */
export type { ProvenanceReport };

/**
 * Non-literal specifier on purpose: TypeScript does not try to resolve it, so a
 * sibling package that is mid-rewrite cannot break `bun test apps/worker` or add
 * an error to this file. Bun resolves it at runtime through the workspace links.
 */
async function loadModule<T>(specifier: string): Promise<T> {
  const mod: unknown = await import(specifier);
  return mod as T;
}

type SourcesModule = Pick<
  PipelineDeps,
  'discoverTrending' | 'mergeToSnapshots' | 'filterSnapshots' | 'triageOrder'
>;
type ChainModule = Pick<PipelineDeps, 'analyzeToken'>;
type ResearchModule = Pick<
  PipelineDeps,
  'collectEvidence' | 'createResearcher' | 'resolveMemeIdentity'
> & {
  PROMPT_VERSION?: string;
  buildQueries(input: { symbol?: string | null; name?: string | null }): { subject: string; degraded: boolean };
};
type StoreModule = Pick<PipelineDeps, 'createStore' | 'seedDemoData'>;
type AlertsModule = Pick<
  PipelineDeps,
  'scoreToken' | 'defaultRules' | 'createAlerts' | 'createSinks' | 'dispatchAlerts'
>;

let cached: PipelineDeps | undefined;

/** Loads the real implementations. Memoised: the CLI may ask more than once. */
export async function loadRuntimeDeps(): Promise<PipelineDeps> {
  if (cached) return cached;

  const [sources, chain, research, store, alerts] = await Promise.all([
    loadModule<SourcesModule>('@provenance/sources'),
    loadModule<ChainModule>('@provenance/chain'),
    loadModule<ResearchModule>('@provenance/research'),
    loadModule<StoreModule>('@provenance/store'),
    loadModule<AlertsModule>('@provenance/alerts'),
  ]);

  cached = {
    discoverTrending: sources.discoverTrending,
    mergeToSnapshots: sources.mergeToSnapshots,
    filterSnapshots: sources.filterSnapshots,
    triageOrder: sources.triageOrder,
    analyzeToken: chain.analyzeToken,
    collectEvidence: research.collectEvidence,
    createResearcher: research.createResearcher,
    promptVersion: research.PROMPT_VERSION ?? 'unknown',
    resolveMemeIdentity: research.resolveMemeIdentity,
    provisionalMemeSubject: (snapshot) => {
      const queries = research.buildQueries({ symbol: snapshot.symbol, name: snapshot.name });
      return queries.degraded ? '' : queries.subject;
    },
    createStore: store.createStore,
    seedDemoData: store.seedDemoData,
    scoreToken: alerts.scoreToken,
    defaultRules: alerts.defaultRules,
    createAlerts: alerts.createAlerts,
    createSinks: alerts.createSinks,
    dispatchAlerts: alerts.dispatchAlerts,
  };
  return cached;
}
