/**
 * Test-only doubles. Lives beside the code it fakes so `bun test apps/worker`
 * needs nothing from the sibling packages — the worker's whole contract with
 * them is `PipelineDeps`, and this file implements it.
 */
import {
  type Alert,
  type AlertChannelSink,
  type AlertRule,
  type AlertRuleInput,
  type AppConfig,
  type ChainAnalysis,
  type DeliveryResult,
  type DossierQuery,
  type EvidenceItem,
  type ProvenanceReport,
  type ProvenanceScore,
  type ProvenanceStore,
  type AnchorCheck,
  type RunRecord,
  type RunStats,
  type RunStatus,
  type ScoringInput,
  type SocialFetchResult,
  type SocialFirstSeen,
  type SocialSighting,
  type TokenDossier,
  type TokenSnapshot,
  type WatchEntry,
  type WatchQuery,
  TRENDING_SOURCES,
  loadConfig,
  nowIso,
} from '@provenance/core';
import type { DiscoveryResult, FilterResult, PipelineDeps } from './deps';

export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig({});
  return {
    ...base,
    ...overrides,
    pipeline: { ...base.pipeline, ...(overrides.pipeline ?? {}) },
    llm: { ...base.llm, ...(overrides.llm ?? {}) },
    launches: { ...base.launches, ...(overrides.launches ?? {}) },
  };
}

export function makeSnapshot(tokenId: string, overrides: Partial<TokenSnapshot> = {}): TokenSnapshot {
  const [chain = 'solana', address = tokenId] = tokenId.split(':');
  return {
    tokenId,
    chain: chain as TokenSnapshot['chain'],
    tokenAddress: address,
    symbol: address.toUpperCase().slice(0, 6),
    name: `${address} token`,
    socials: {},
    metrics: { liquidityUsd: 100_000, volume24hUsd: 500_000, priceChange24h: 12 },
    pairs: [],
    appearances: [],
    bestRank: 1,
    sourceCount: 2,
    capturedAt: nowIso(),
    ...overrides,
  };
}

export function makeChainAnalysis(tokenId: string): ChainAnalysis {
  const [chain = 'solana', address = tokenId] = tokenId.split(':');
  return {
    tokenId,
    chain: chain as ChainAnalysis['chain'],
    tokenAddress: address,
    method: 'rpc',
    topHolders: [],
    flags: [],
    notes: [],
    fetchedAt: nowIso(),
  };
}

export function makeReport(tokenId: string, overrides: Partial<ProvenanceReport> = {}): ProvenanceReport {
  return {
    tokenId,
    memeName: 'test meme',
    narrativeCluster: 'dog',
    originSummary: 'A meme used only in tests.',
    lineage: [],
    priorCycles: [],
    recycleVerdict: 'revival',
    recycleGeneration: 1,
    memeticDurability: 60,
    culturalReach: 40,
    authenticityScore: 70,
    speculativeSetup: 'Not financial advice.',
    risks: [],
    confidence: 0.6,
    evidence: [],
    model: 'test-model',
    promptVersion: 'test-1',
    generatedAt: nowIso(),
    usage: { inputTokens: 1000, outputTokens: 500, costUsd: 0.5 },
    ...overrides,
  };
}

export function makeScore(tokenId: string, total = 75): ProvenanceScore {
  return {
    tokenId,
    total,
    tier: total >= 85 ? 'S' : total >= 70 ? 'A' : 'B',
    components: {
      recycling: total,
      memetic: total,
      distribution: total,
      liquidity: total,
      momentum: total,
      authenticity: total,
    },
    penalties: [],
    computedAt: nowIso(),
  };
}

export function makeAlert(runId: string, tokenId: string, rule = 'clean-revival'): Alert {
  return {
    id: `${runId}:${tokenId}:${rule}`,
    runId,
    tokenId,
    rule,
    severity: 'info',
    title: `${tokenId} fired ${rule}`,
    body: 'body',
    markdown: '*body*',
    createdAt: nowIso(),
    payload: {},
  };
}

/** In-memory `ProvenanceStore` that records the order of every write. */
export class FakeStore implements ProvenanceStore {
  readonly calls: string[] = [];
  readonly snapshots: TokenSnapshot[] = [];
  readonly chainAnalyses: ChainAnalysis[] = [];
  readonly reports: ProvenanceReport[] = [];
  readonly scores: ProvenanceScore[] = [];
  readonly alerts: { alert: Alert; deliveries: DeliveryResult[] }[] = [];
  readonly runs = new Map<string, RunRecord>();
  readonly priorReports = new Map<string, ProvenanceReport>();
  readonly priorScores = new Map<string, ProvenanceScore[]>();
  readonly evidenceCache = new Map<string, string>();
  readonly watch = new Map<string, WatchEntry>();
  readonly sightings: SocialSighting[] = [];
  closed = false;
  /** Set to make a specific method reject, for failure-isolation tests. */
  failOn?: { method: string; times?: number };

  private guard(method: string): void {
    this.calls.push(method);
    if (this.failOn?.method !== method) return;
    if (this.failOn.times !== undefined) {
      if (this.failOn.times <= 0) return;
      this.failOn.times -= 1;
    }
    throw new Error(`fake store failure in ${method}`);
  }

  async migrate(): Promise<void> {
    this.guard('migrate');
  }

  async startRun(id: string): Promise<RunRecord> {
    this.guard('startRun');
    const record: RunRecord = {
      id,
      startedAt: nowIso(),
      status: 'running',
      stats: {
        discovered: 0,
        afterFilter: 0,
        analysed: 0,
        reused: 0,
        alertsFired: 0,
        llmCostUsd: 0,
        sourceErrors: [],
      },
    };
    this.runs.set(id, record);
    return record;
  }

  async finishRun(id: string, status: RunStatus, stats: RunStats, error?: string): Promise<void> {
    this.guard('finishRun');
    const existing = this.runs.get(id);
    if (existing) {
      existing.status = status;
      existing.stats = stats;
      existing.finishedAt = nowIso();
      if (error) existing.error = error;
    }
  }

  async getRun(id: string): Promise<RunRecord | null> {
    this.guard('getRun');
    return this.runs.get(id) ?? null;
  }

  async latestRun(): Promise<RunRecord | null> {
    this.guard('latestRun');
    const all = [...this.runs.values()];
    return all[all.length - 1] ?? null;
  }

  async listRuns(): Promise<RunRecord[]> {
    this.guard('listRuns');
    return [...this.runs.values()];
  }

  async saveSnapshot(_runId: string, snapshot: TokenSnapshot): Promise<void> {
    this.guard('saveSnapshot');
    this.snapshots.push(snapshot);
  }

  async saveChainAnalysis(_runId: string, analysis: ChainAnalysis): Promise<void> {
    this.guard('saveChainAnalysis');
    this.chainAnalyses.push(analysis);
  }

  async saveProvenance(_runId: string, report: ProvenanceReport): Promise<void> {
    this.guard('saveProvenance');
    this.reports.push(report);
  }

  async saveScore(_runId: string, score: ProvenanceScore): Promise<void> {
    this.guard('saveScore');
    this.scores.push(score);
  }

  async saveAlert(alert: Alert, deliveries: DeliveryResult[]): Promise<void> {
    this.guard('saveAlert');
    this.alerts.push({ alert, deliveries });
  }

  async latestProvenance(tokenId: string): Promise<ProvenanceReport | null> {
    this.guard('latestProvenance');
    return this.priorReports.get(tokenId) ?? null;
  }

  async scoreHistory(tokenId: string): Promise<ProvenanceScore[]> {
    this.guard('scoreHistory');
    return this.priorScores.get(tokenId) ?? [];
  }

  async listDossiers(_query?: DossierQuery): Promise<TokenDossier[]> {
    this.guard('listDossiers');
    return this.snapshots.map((snapshot) => ({
      snapshot,
      chain: this.chainAnalyses.find((c) => c.tokenId === snapshot.tokenId),
      provenance: this.reports.find((r) => r.tokenId === snapshot.tokenId),
      score: this.scores.find((s) => s.tokenId === snapshot.tokenId),
      alerts: this.alerts.filter((a) => a.alert.tokenId === snapshot.tokenId).map((a) => a.alert),
      runId: 'fake',
    }));
  }

  async getDossier(tokenId: string): Promise<TokenDossier | null> {
    this.guard('getDossier');
    const all = await this.listDossiers();
    return all.find((dossier) => dossier.snapshot.tokenId === tokenId) ?? null;
  }

  async listAlerts(): Promise<Alert[]> {
    this.guard('listAlerts');
    return this.alerts.map((entry) => entry.alert);
  }

  async getCachedEvidence(key: string): Promise<string | null> {
    this.guard('getCachedEvidence');
    return this.evidenceCache.get(key) ?? null;
  }

  async putCachedEvidence(key: string, _url: string, content: string): Promise<void> {
    this.guard('putCachedEvidence');
    this.evidenceCache.set(key, content);
  }

  async saveWatch(entry: WatchEntry): Promise<void> {
    this.guard('saveWatch');
    const prior = this.watch.get(entry.tokenId);
    // Same keep-the-first semantics as the libSQL upsert.
    this.watch.set(
      entry.tokenId,
      prior
        ? {
            ...entry,
            firstSeenAt: prior.firstSeenAt < entry.firstSeenAt ? prior.firstSeenAt : entry.firstSeenAt,
            ...(prior.expressedAt ? { expressedAt: prior.expressedAt, leadHours: prior.leadHours } : {}),
            ...(prior.socialAt ? { socialAt: prior.socialAt, socialLeadHours: prior.socialLeadHours } : {}),
          }
        : entry,
    );
  }

  async getWatch(tokenId: string): Promise<WatchEntry | null> {
    this.guard('getWatch');
    return this.watch.get(tokenId) ?? null;
  }

  async listWatch(query: WatchQuery = {}): Promise<WatchEntry[]> {
    this.guard('listWatch');
    return [...this.watch.values()]
      .filter((entry) => !query.status || entry.status === query.status)
      .sort((a, b) => b.firstSeenAt.localeCompare(a.firstSeenAt))
      .slice(0, query.limit ?? 200);
  }

  async recordSocialSightings(sightings: SocialSighting[]): Promise<void> {
    this.guard('recordSocialSightings');
    this.sightings.push(...sightings);
  }

  async socialFirstSeen(tokenIds: string[]): Promise<SocialFirstSeen[]> {
    this.guard('socialFirstSeen');
    const out: SocialFirstSeen[] = [];
    for (const id of new Set(tokenIds)) {
      const rows = this.sightings.filter((row) => row.tokenId === id);
      if (rows.length === 0) continue;
      out.push({
        tokenId: id,
        firstSeenAt: rows.map((row) => row.seenAt).sort()[0] as string,
        platforms: (['twitter', 'telegram'] as const).filter((p) => rows.some((row) => row.platform === p)),
        peakMentions: Math.max(...rows.map((row) => row.mentionCount)),
      });
    }
    return out;
  }

  async close(): Promise<void> {
    this.guard('close');
    this.closed = true;
  }
}

export interface HarnessOptions {
  snapshots?: TokenSnapshot[];
  discoveryErrors?: { source: string; error: string }[];
  dropped?: { tokenId: string; reason: string }[];
  /** Cost attributed to every generated report; drives the ceiling tests. */
  costPerReport?: number;
  analyzeToken?: (snapshot: TokenSnapshot) => Promise<ChainAnalysis>;
  research?: (snapshot: TokenSnapshot) => Promise<ProvenanceReport>;
  createAlerts?: (runId: string, input: AlertRuleInput) => Alert[];
  createResearcher?: () => never;
  scoreToken?: (input: ScoringInput) => ProvenanceScore;
  store?: FakeStore;
  /** Launch lane: fast anchor verdict per token; defaults to anchored, high. */
  anchor?: (snapshot: TokenSnapshot) => AnchorCheck;
  /** Launch lane: chain-gate verdict; defaults to pass. */
  chainGate?: (chain: ChainAnalysis | undefined) => { passed: boolean; reasons: string[] };
  /** Social feeds; defaults to nothing sighted. */
  social?: () => SocialFetchResult;
}

export function makeAnchor(overrides: Partial<AnchorCheck> = {}): AnchorCheck {
  return {
    verdict: 'anchored',
    type: 'cultural-artifact',
    subject: 'a film character',
    anchorDate: '2001',
    precedesLaunch: true,
    summary: 'Recognised well outside crypto, long before the token.',
    confidence: 'high',
    model: 'test',
    checkedAt: nowIso(),
    citations: [],
    usage: { inputTokens: 10, outputTokens: 10, costUsd: 0.01 },
    ...overrides,
  };
}

/** A launch-lane snapshot: its only appearance is on the `launches` source. */
export function makeLaunchSnapshot(tokenId: string, overrides: Partial<TokenSnapshot> = {}): TokenSnapshot {
  const base = makeSnapshot(tokenId, overrides);
  return {
    ...base,
    sourceCount: 1,
    appearances: [
      {
        source: 'launches',
        rank: 1,
        chain: base.chain,
        tokenAddress: base.tokenAddress,
        symbol: base.symbol,
        name: base.name,
        capturedAt: base.capturedAt,
        metrics: base.metrics,
      },
    ],
    ...overrides,
  };
}

/** A snapshot that appeared on a trending source. */
export function makeTrendingSnapshot(tokenId: string, source: 'dexscreener' | 'geckoterminal' = 'dexscreener'): TokenSnapshot {
  const base = makeSnapshot(tokenId);
  return {
    ...base,
    appearances: [
      {
        source,
        rank: 1,
        chain: base.chain,
        tokenAddress: base.tokenAddress,
        symbol: base.symbol,
        name: base.name,
        capturedAt: base.capturedAt,
        metrics: base.metrics,
      },
    ],
  };
}

export interface Harness {
  deps: PipelineDeps;
  store: FakeStore;
  /** Stage-level call log, in the order the pipeline invoked them. */
  stages: string[];
  researchCalls: string[];
  evidenceCalls: string[];
  dispatched: Alert[][];
  sinkFilter: string[][];
}

const consoleSink: AlertChannelSink = {
  channel: 'console',
  enabled: true,
  async send(alert) {
    return { channel: 'console', ok: true, at: nowIso() } satisfies DeliveryResult;
  },
};

const telegramSink: AlertChannelSink = {
  channel: 'telegram',
  enabled: true,
  async send() {
    return { channel: 'telegram', ok: true, at: nowIso() } satisfies DeliveryResult;
  },
};

export function makeHarness(options: HarnessOptions = {}): Harness {
  const snapshots = options.snapshots ?? [makeSnapshot('solana:aaa'), makeSnapshot('solana:bbb')];
  const store = options.store ?? new FakeStore();
  const stages: string[] = [];
  const researchCalls: string[] = [];
  const evidenceCalls: string[] = [];
  const dispatched: Alert[][] = [];
  const sinkFilter: string[][] = [];

  const rule: AlertRule = {
    id: 'test-rule',
    description: 'fires for every token',
    evaluate: () => null,
  };

  const deps: PipelineDeps = {
    async discoverTrending(): Promise<DiscoveryResult> {
      stages.push('discover');
      return { entries: [], errors: options.discoveryErrors ?? [] };
    },
    async fetchSocialTrending(): Promise<SocialFetchResult> {
      stages.push('social');
      return options.social ? options.social() : { sightings: [], errors: [] };
    },
    mergeToSnapshots(): TokenSnapshot[] {
      stages.push('merge');
      return snapshots;
    },
    filterSnapshots(input): FilterResult {
      stages.push('filter');
      const dropped = options.dropped ?? [];
      const rejected = new Set(dropped.map((entry) => entry.tokenId));
      return { kept: input.filter((s) => !rejected.has(s.tokenId)), dropped };
    },
    triageOrder(input): TokenSnapshot[] {
      stages.push('triage');
      return input;
    },
    splitLanes(input) {
      const isLaunchOnly = (snapshot: TokenSnapshot) =>
        snapshot.appearances.some((a) => a.source === 'launches') &&
        !snapshot.appearances.some((a) => (TRENDING_SOURCES as readonly string[]).includes(a.source));
      return { trending: input.filter((s) => !isLaunchOnly(s)), launches: input.filter(isLaunchOnly) };
    },
    async analyzeToken(snapshot): Promise<ChainAnalysis> {
      stages.push(`analyze:${snapshot.tokenId}`);
      if (options.analyzeToken) return options.analyzeToken(snapshot);
      return makeChainAnalysis(snapshot.tokenId);
    },
    async collectEvidence(snapshot): Promise<EvidenceItem[]> {
      stages.push(`evidence:${snapshot.tokenId}`);
      evidenceCalls.push(snapshot.tokenId);
      return [];
    },
    createResearcher() {
      stages.push('createResearcher');
      if (options.createResearcher) return options.createResearcher();
      return {
        async research(snapshot) {
          stages.push(`research:${snapshot.tokenId}`);
          researchCalls.push(snapshot.tokenId);
          if (options.research) return options.research(snapshot);
          return makeReport(snapshot.tokenId, {
            usage: { inputTokens: 100, outputTokens: 100, costUsd: options.costPerReport ?? 0.1 },
          });
        },
      };
    },
    createAnchorChecker() {
      stages.push('createAnchorChecker');
      return {
        async check(snapshot) {
          stages.push(`anchor:${snapshot.tokenId}`);
          return options.anchor ? options.anchor(snapshot) : makeAnchor();
        },
      };
    },
    promptVersion: 'test-1',
    createStore(): ProvenanceStore {
      stages.push('createStore');
      return store;
    },
    async seedDemoData(): Promise<void> {
      stages.push('seed');
    },
    scoreToken(input): ProvenanceScore {
      stages.push(`score:${input.snapshot.tokenId}`);
      if (options.scoreToken) return options.scoreToken(input);
      return makeScore(input.snapshot.tokenId);
    },
    defaultRules: [rule],
    createAlerts(runId, input): Alert[] {
      stages.push(`alerts:${input.snapshot.tokenId}`);
      if (options.createAlerts) return options.createAlerts(runId, input);
      return [];
    },
    gateLaunchMarket(snapshot) {
      const liquidity = snapshot.metrics.liquidityUsd;
      return liquidity !== undefined && liquidity >= 40_000
        ? { passed: true, reasons: [] }
        : { passed: false, reasons: ['liquidity'] };
    },
    gateLaunchChain(chain) {
      return options.chainGate ? options.chainGate(chain) : { passed: true, reasons: [] };
    },
    launchAnchoredAlert(runId, entry, _snapshot, _chain, report) {
      return {
        ...makeAlert(runId, entry.tokenId, 'launch-anchored'),
        id: `${runId}:${entry.tokenId}:anchored`,
        payload: { researched: report !== undefined },
      };
    },
    launchExpressedAlert(runId, entry) {
      return { ...makeAlert(runId, entry.tokenId, 'launch-expressed'), id: `${runId}:${entry.tokenId}:expressed` };
    },
    createSinks(): AlertChannelSink[] {
      stages.push('createSinks');
      return [consoleSink, telegramSink];
    },
    async dispatchAlerts(alerts, sinks): Promise<Map<string, DeliveryResult[]>> {
      stages.push('dispatch');
      dispatched.push(alerts);
      sinkFilter.push(sinks.map((sink) => sink.channel));
      const out = new Map<string, DeliveryResult[]>();
      for (const alert of alerts) {
        out.set(
          alert.id,
          sinks.map((sink) => ({ channel: sink.channel, ok: true, at: nowIso() })),
        );
      }
      return out;
    },
  };

  return { deps, store, stages, researchCalls, evidenceCalls, dispatched, sinkFilter };
}
