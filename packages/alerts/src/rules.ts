/**
 * Alert rules.
 *
 * A rule is a pure predicate over one fully-analysed token plus its own history. Rules
 * never throw and never do I/O; `createAlerts` turns the ones that fire into `Alert`s
 * with deterministic ids so a replayed run produces the same alerts rather than duplicates.
 */

import {
  formatPct,
  formatUsd,
  hashKey,
  hoursBetween,
  nowIso,
  type Alert,
  type AlertRule,
  type AlertRuleInput,
  type ProvenanceReport,
  type ProvenanceScore,
  type RiskSeverity,
} from '@provenance/core';

import { renderAlertBody } from './format';
import { assessRisk, SINGLE_HOLDER_DOMINANCE_PCT } from './scoring';

type RuleResult = Omit<Alert, 'id' | 'runId' | 'createdAt'>;

// ---------------------------------------------------------------------------
// cross-token context (see the note on `narrative-cluster-heat` below)
// ---------------------------------------------------------------------------

/**
 * `AlertRuleInput` is strictly single-token, so a rule about several tokens moving
 * together has nothing in the contract to read. Rather than widen `packages/core`,
 * the orchestrator builds these contexts for a whole run and attaches them; a rule
 * that finds none simply does not fire, so the contract-only path stays correct.
 */
export interface NarrativeClusterContext {
  cluster: string;
  /** Token ids in this run sharing the cluster, this token included. */
  tokenIds: string[];
  /** Highest total in the cluster this run. */
  topScore?: number;
  /** Mean total across the cluster this run. */
  meanScore?: number;
}

export interface ExtendedAlertRuleInput extends AlertRuleInput {
  clusterContext?: NarrativeClusterContext;
}

/** Groups a run's scored tokens by `narrativeCluster`, keyed by the lowercased name. */
export function buildClusterContexts(
  items: readonly { score: ProvenanceScore; provenance?: ProvenanceReport }[],
): Map<string, NarrativeClusterContext> {
  const buckets = new Map<string, { cluster: string; tokenIds: string[]; totals: number[] }>();
  for (const item of items) {
    const cluster = item.provenance?.narrativeCluster?.trim();
    if (!cluster) continue;
    const key = cluster.toLowerCase();
    const bucket = buckets.get(key) ?? { cluster, tokenIds: [], totals: [] };
    if (!bucket.tokenIds.includes(item.score.tokenId)) bucket.tokenIds.push(item.score.tokenId);
    if (Number.isFinite(item.score.total)) bucket.totals.push(item.score.total);
    buckets.set(key, bucket);
  }

  const out = new Map<string, NarrativeClusterContext>();
  for (const [key, bucket] of buckets) {
    out.set(key, {
      cluster: bucket.cluster,
      tokenIds: bucket.tokenIds,
      topScore: bucket.totals.length > 0 ? Math.max(...bucket.totals) : undefined,
      meanScore:
        bucket.totals.length > 0 ? bucket.totals.reduce((a, b) => a + b, 0) / bucket.totals.length : undefined,
    });
  }
  return out;
}

export function attachClusterContext<T extends AlertRuleInput>(
  input: T,
  contexts: Map<string, NarrativeClusterContext>,
): T & ExtendedAlertRuleInput {
  const cluster = input.provenance?.narrativeCluster?.trim().toLowerCase();
  const context = cluster ? contexts.get(cluster) : undefined;
  return context ? { ...input, clusterContext: context } : { ...input };
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** Minimum rise, in points, that counts as a surge. */
export const SURGE_DELTA_POINTS = 15;
/**
 * How old a baseline may be and still be comparable. The pipeline runs twice a day,
 * so four days is roughly eight observations — past that the "previous" score
 * describes a different market, and the delta stops being actionable.
 */
export const SURGE_MAX_BASELINE_AGE_HOURS = 96;
/** How many tokens must share a cluster before it counts as heat. */
export const CLUSTER_HEAT_MIN_TOKENS = 3;
/** Score at or above which a token counts as "otherwise scoring well" for `rug-risk`. */
export const RUG_RISK_MIN_SCORE = 55;
/** Memetic component at or above this means the meme itself is real. */
export const IMPOSTOR_MIN_MEMETIC = 65;
/** Model authenticity at or below this means this token is not the meme's instance. */
export const IMPOSTOR_MAX_AUTHENTICITY = 35;

/**
 * The most recent comparable prior observation for the same token.
 *
 * Deliberately strict, because the whole value of a delta rule is that the delta is
 * real: the candidate must be for the same token, must be strictly older than the
 * current score (so replaying a run never compares a score against itself), must
 * carry a usable total, and must not be stale.
 */
export function previousObservation(
  current: ProvenanceScore,
  history: readonly ProvenanceScore[],
  maxAgeHours: number = SURGE_MAX_BASELINE_AGE_HOURS,
): ProvenanceScore | undefined {
  const currentAt = Date.parse(current.computedAt);
  if (!Number.isFinite(currentAt)) return undefined;

  let best: ProvenanceScore | undefined;
  let bestAt = -Infinity;
  for (const candidate of history ?? []) {
    if (!candidate || candidate.tokenId !== current.tokenId) continue;
    if (!Number.isFinite(candidate.total)) continue;
    const at = Date.parse(candidate.computedAt);
    if (!Number.isFinite(at) || at >= currentAt) continue;
    if (hoursBetween(candidate.computedAt, current.computedAt) > maxAgeHours) continue;
    if (at > bestAt) {
      bestAt = at;
      best = candidate;
    }
  }
  return best;
}

function result(
  input: AlertRuleInput,
  rule: string,
  severity: RiskSeverity,
  title: string,
  options: { lead?: string[]; footer?: string[]; payload?: Record<string, unknown> } = {},
): RuleResult {
  const { markdown, body } = renderAlertBody(input, { lead: options.lead, footer: options.footer });
  return {
    tokenId: input.score.tokenId,
    rule,
    severity,
    title,
    body: `${title}\n\n${body}`,
    markdown: `*${title}*\n\n${markdown}`.replace(/^\*/, '**').replace(/\*\n\n/, '**\n\n'),
    payload: {
      symbol: input.snapshot.symbol,
      chain: input.snapshot.chain,
      tokenAddress: input.snapshot.tokenAddress,
      total: input.score.total,
      tier: input.score.tier,
      components: input.score.components,
      recycleVerdict: input.provenance?.recycleVerdict,
      memeName: input.provenance?.memeName,
      narrativeCluster: input.provenance?.narrativeCluster,
      priorCycles: input.provenance?.priorCycles?.length ?? 0,
      ...(options.payload ?? {}),
    },
  };
}

// ---------------------------------------------------------------------------
// the rules
// ---------------------------------------------------------------------------

/**
 * The flagship. A proven, dormant narrative brought back by a token that is not
 * structurally a trap is the exact setup this project exists to find, so it gets its
 * own rule rather than hiding inside `high-score`.
 */
export const cleanRevivalRule: AlertRule = {
  id: 'clean-revival',
  description: 'High-scoring revival of a meme with real prior cycles and no critical on-chain risk.',
  evaluate(input: AlertRuleInput): RuleResult | null {
    const report = input.provenance;
    if (!report || report.recycleVerdict !== 'revival') return null;
    const cycles = report.priorCycles?.length ?? 0;
    if (cycles < 1) return null;
    if (input.score.total < input.config.pipeline.alertScoreThreshold) return null;
    if (assessRisk(input.chain).hasCritical) return null;

    const lead = [
      `**Clean revival.** ${report.memeName} ran before${
        report.originYear !== undefined ? ` (meme from ${report.originYear})` : ''
      } and is being run again — generation ${report.recycleGeneration}, ${cycles} prior cycle(s) on record, no critical on-chain flags.`,
    ];
    return result(
      input,
      'clean-revival',
      'critical',
      `Clean revival: $${input.snapshot.symbol} — ${report.memeName} (tier ${input.score.tier}, ${input.score.total.toFixed(1)})`,
      { lead, payload: { recycleGeneration: report.recycleGeneration } },
    );
  },
};

/** The generic feed: anything at or above the configured threshold. */
export const highScoreRule: AlertRule = {
  id: 'high-score',
  description: 'Composite score at or above config.pipeline.alertScoreThreshold.',
  evaluate(input: AlertRuleInput): RuleResult | null {
    const threshold = input.config.pipeline.alertScoreThreshold;
    if (!Number.isFinite(threshold) || input.score.total < threshold) return null;
    return result(
      input,
      'high-score',
      input.score.tier === 'S' || input.score.tier === 'A' ? 'warn' : 'info',
      `Score ${input.score.total.toFixed(1)} (tier ${input.score.tier}): $${input.snapshot.symbol}`,
      {
        lead: [`**Scored ${input.score.total.toFixed(1)}**, at or above the alert threshold of ${threshold}.`],
        payload: { threshold },
      },
    );
  },
};

/**
 * Deltas are the most actionable thing a twice-daily pipeline produces: a token that
 * gained 15 points since the last observation has had something change — new holders,
 * a revoked authority, a provenance report that finally resolved the lineage.
 */
export const scoreSurgeRule: AlertRule = {
  id: 'score-surge',
  description: `Composite score rose by at least ${SURGE_DELTA_POINTS} points versus the previous observation.`,
  evaluate(input: AlertRuleInput): RuleResult | null {
    const previous = previousObservation(input.score, input.history ?? []);
    if (!previous) return null;
    const delta = input.score.total - previous.total;
    if (delta < SURGE_DELTA_POINTS) return null;

    const movers = (Object.keys(input.score.components) as (keyof ProvenanceScore['components'])[])
      .map((key) => ({ key, delta: input.score.components[key] - previous.components[key] }))
      .filter((entry) => Number.isFinite(entry.delta) && Math.abs(entry.delta) >= 1)
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
      .slice(0, 3)
      .map((entry) => `${entry.key} ${entry.delta >= 0 ? '+' : ''}${entry.delta.toFixed(0)}`);

    return result(
      input,
      'score-surge',
      'warn',
      `Score surge +${delta.toFixed(1)}: $${input.snapshot.symbol} now ${input.score.total.toFixed(1)} (tier ${input.score.tier})`,
      {
        lead: [
          `**+${delta.toFixed(1)} points** since ${previous.computedAt} (${previous.total.toFixed(1)} → ${input.score.total.toFixed(1)}, tier ${previous.tier} → ${input.score.tier}).`,
          movers.length > 0 ? `Biggest movers: ${movers.join(', ')}.` : '',
        ].filter(Boolean),
        payload: {
          delta,
          previousTotal: previous.total,
          previousTier: previous.tier,
          previousComputedAt: previous.computedAt,
        },
      },
    );
  },
};

/**
 * Several tokens from one narrative cluster trending at once is the market
 * rediscovering a whole family, which historically precedes the cleanest revivals.
 *
 * Needs cross-token context that `AlertRuleInput` does not carry; see
 * `NarrativeClusterContext` above. Without it the rule is silent by design.
 */
export const narrativeClusterHeatRule: AlertRule = {
  id: 'narrative-cluster-heat',
  description: `At least ${CLUSTER_HEAT_MIN_TOKENS} tokens in the same narrative cluster trending in one run.`,
  evaluate(input: AlertRuleInput): RuleResult | null {
    const context = (input as ExtendedAlertRuleInput).clusterContext;
    if (!context || context.tokenIds.length < CLUSTER_HEAT_MIN_TOKENS) return null;
    // Only alert on the cluster through a token actually worth looking at, otherwise
    // one hot cluster produces a dozen alerts for its worst members.
    if (input.score.total < 60) return null;

    const others = context.tokenIds.filter((id) => id !== input.score.tokenId);
    return result(
      input,
      'narrative-cluster-heat',
      'info',
      `Cluster heat "${context.cluster}": ${context.tokenIds.length} tokens trending — $${input.snapshot.symbol} leads at ${input.score.total.toFixed(1)}`,
      {
        lead: [
          `**${context.tokenIds.length} tokens in the "${context.cluster}" cluster are trending in this run**${
            context.meanScore !== undefined ? ` (mean score ${context.meanScore.toFixed(1)})` : ''
          }. Whole-family rotations tend to surface the canonical carrier late.`,
          others.length > 0 ? `Others: ${others.slice(0, 6).join(', ')}` : '',
        ].filter(Boolean),
        payload: {
          cluster: context.cluster,
          clusterSize: context.tokenIds.length,
          clusterTokenIds: context.tokenIds,
          clusterTopScore: context.topScore,
          clusterMeanScore: context.meanScore,
        },
      },
    );
  },
};

/**
 * The trap worth naming out loud: an attractive story on a token that still has a live
 * mint authority, a dominant wallet or an otherwise critical flag. These score well on
 * everything a reader notices and badly on the one thing that decides the outcome.
 */
export const rugRiskRule: AlertRule = {
  id: 'rug-risk',
  description: 'Critical on-chain risk flag on a token that is otherwise scoring well.',
  evaluate(input: AlertRuleInput): RuleResult | null {
    const risk = assessRisk(input.chain);
    if (!risk.hasCritical) return null;
    const story = (input.score.components.recycling + input.score.components.memetic) / 2;
    if (input.score.total < RUG_RISK_MIN_SCORE && story < 65) return null;

    const reasons: string[] = [];
    if (risk.mintAuthorityActive) reasons.push('mint authority ACTIVE (supply can be inflated)');
    if (risk.freezeAuthorityActive) reasons.push('freeze authority ACTIVE (accounts can be locked)');
    if (risk.singleHolderPct !== undefined && risk.singleHolderPct >= SINGLE_HOLDER_DOMINANCE_PCT) {
      reasons.push(`single wallet holds ${risk.singleHolderPct.toFixed(1)}%`);
    }
    if (risk.extremeConcentration) reasons.push(`top-10 hold ${(input.chain?.top10Pct ?? 0).toFixed(1)}%`);
    for (const flag of risk.criticalFlags.slice(0, 3)) reasons.push(`${flag.code}: ${flag.detail}`);

    return result(
      input,
      'rug-risk',
      'critical',
      `Rug risk on a good story: $${input.snapshot.symbol} (${input.score.total.toFixed(1)}, tier ${input.score.tier})`,
      {
        lead: [
          '**Do not size this on the story.** The narrative reads well and the token is structurally unsafe:',
          ...reasons.map((reason) => `• ${reason}`),
        ],
        payload: {
          criticalFlags: risk.criticalFlags.map((flag) => flag.code),
          mintAuthorityActive: risk.mintAuthorityActive,
          freezeAuthorityActive: risk.freezeAuthorityActive,
          singleHolderPct: risk.singleHolderPct,
        },
      },
    );
  },
};

/**
 * The meme is real; this token is not its instance. Worth an alert because the
 * canonical carrier usually exists somewhere and is the thing actually worth holding.
 */
export const canonicalImpostorRule: AlertRule = {
  id: 'canonical-impostor',
  description: 'Strong meme with a low authenticity score: the narrative is real, the token is not its carrier.',
  evaluate(input: AlertRuleInput): RuleResult | null {
    const report = input.provenance;
    if (!report) return null;
    const authenticity = report.authenticityScore;
    if (!Number.isFinite(authenticity) || authenticity > IMPOSTOR_MAX_AUTHENTICITY) return null;
    if (input.score.components.memetic < IMPOSTOR_MIN_MEMETIC) return null;

    return result(
      input,
      'canonical-impostor',
      'warn',
      `Impostor watch: $${input.snapshot.symbol} rides ${report.memeName} but scores ${Math.round(authenticity)}/100 on authenticity`,
      {
        lead: [
          `**The meme is real, this token probably is not its carrier.** "${report.memeName}" scores ${Math.round(
            input.score.components.memetic,
          )}/100 memetically, but the model puts this instance's authenticity at ${Math.round(authenticity)}/100.`,
          'If the narrative runs, the flows are likely to find a different token.',
        ],
        payload: { authenticityScore: authenticity, memetic: input.score.components.memetic },
      },
    );
  },
};

/** Evaluation order is the order alerts appear for a token. Flagship first. */
export const defaultRules: AlertRule[] = [
  cleanRevivalRule,
  rugRiskRule,
  scoreSurgeRule,
  canonicalImpostorRule,
  narrativeClusterHeatRule,
  highScoreRule,
];

/**
 * Evaluates rules and materialises `Alert`s.
 *
 * Ids are `hashKey(runId + tokenId + rule)`: replaying a run produces byte-identical
 * ids, so the store's upsert turns a replay into a no-op instead of a duplicate feed.
 * A rule that throws is skipped rather than failing the run — partial alerts beat none.
 */
export function createAlerts(
  runId: string,
  input: AlertRuleInput,
  rules: AlertRule[] = defaultRules,
): Alert[] {
  const alerts: Alert[] = [];
  const createdAt = nowIso();
  for (const rule of rules) {
    let fired: RuleResult | null = null;
    try {
      fired = rule.evaluate(input);
    } catch {
      continue;
    }
    if (!fired) continue;
    alerts.push({
      ...fired,
      id: hashKey(`${runId}${fired.tokenId}${rule.id}`),
      runId,
      createdAt,
    });
  }
  return alerts;
}

/** Re-exported so callers can format numbers the same way the bodies do. */
export { formatPct, formatUsd };
