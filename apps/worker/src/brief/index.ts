/**
 * `cli.ts brief`: the daily brief and the setups ledger (docs/brief-routine.md).
 *
 * Reads queries A–G and the open setups, labels the regimes, updates open
 * setups from observed market data, asks the model once for the read and 0–2
 * proposals, gates them, and renders. Writes only the `setups` table, and
 * nothing at all on a dry run.
 */
import { appendFile } from 'node:fs/promises';
import type { Alert, AppConfig, Logger, Setup } from '@provenance/core';
import type { LlmClient } from '@provenance/research';
import { gateProposals, type GateCandidate, type GateVerdict } from './gate';
import {
  DEFAULT_SETUP_KILL,
  fetchDexScreenerMarket,
  setupStats,
  updateSetup,
  type SetupObservation,
} from './ledger';
import { DEFAULT_BRIEF_MAX_USD, buildBriefPrompt, runBriefLlm, type BriefOutput, type PromptToken } from './llm';
import { selectNotable } from './notable';
import {
  queryActiveWatch,
  queryAlerts24h,
  queryClusters,
  queryDossiers,
  queryFullRuns,
  queryLatestFacts,
  queryRegimeCounts,
  queryRunErrors,
  queryRuns24h,
  querySevereAlerts,
  queryTrackRecord,
  queryVerdictHistory,
  queryWatchChanges,
  type DossierRow,
  type FullRun,
  type RunRow,
  type SqlExecutor,
} from './queries';
import { MEME_REGIME_RULE, fetchBtcRegime, labelMemeRegime, type FetchLike } from './regime';
import { discordSafe, renderBrief, splitBrief, type BriefView, type SetupChange } from './render';

export { briefSettings, usableModels } from './llm';

/** The two store helpers the brief writes through. `LibsqlStore` has both. */
export interface SetupStore {
  listSetups(query?: { open?: boolean; updatedSince?: string }): Promise<Setup[]>;
  upsertSetups(setups: readonly Setup[]): Promise<void>;
}

export interface RunBriefOptions {
  app: AppConfig;
  logger: Logger;
  db: SqlExecutor;
  setups: SetupStore;
  /** Model specs with a key, primary first. Empty or `noLlm` → deterministic brief. */
  models?: string[];
  noLlm?: boolean;
  maxUsd?: number;
  dryRun?: boolean;
  fetchImpl?: FetchLike;
  createClient?: (spec: string) => LlmClient;
  now?: () => Date;
}

export interface BriefResult {
  text: string;
  parts: string[];
  /** Run-output lines: the regime rule, gate decisions, model notes. */
  log: string[];
  /** Setups written this run (or that would have been, on a dry run). */
  written: Setup[];
  newSetups: Setup[];
  changes: SetupChange[];
  dropped: GateVerdict[];
  llm: { model?: string; costUsd: number; calls: number; used: boolean };
  curRunId?: string;
}

const DAY_MS = 86_400_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `${symbol}-${YYYYMMDD}-${n}`; the symbol is deployer-written, so only [A-Z0-9] survive. */
export function setupId(symbol: string, nowIso: string, taken: ReadonlySet<string>): string {
  const sym = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'TOKEN';
  const day = nowIso.slice(0, 10).replaceAll('-', '');
  for (let n = 1; ; n++) {
    const id = `${sym}-${day}-${n}`;
    if (!taken.has(id)) return id;
  }
}

/** The full run's job timeout (provenance.yml) and the launch lane's (launches.yml), in minutes. */
const FULL_RUN_TIMEOUT_MIN = 45;
const LAUNCH_RUN_TIMEOUT_MIN = 20;

/**
 * A full run that is still going. Runs carry no lane marker, so: a `running`
 * row newer than CUR that already wrote snapshots (launch-lane runs never
 * do), or that has been running longer than a launch-lane job can live. A
 * row still `running` past the full-run timeout is a killed job, not a run in
 * flight, and must not hold the brief back for a day.
 */
export function fullRunInFlight(runs: readonly RunRow[], cur: FullRun | undefined, nowMs: number): RunRow | undefined {
  const killedBefore = new Date(nowMs - FULL_RUN_TIMEOUT_MIN * 60_000).toISOString();
  const launchLimit = new Date(nowMs - LAUNCH_RUN_TIMEOUT_MIN * 60_000).toISOString();
  return runs.find(
    (run) =>
      run.status === 'running' &&
      run.startedAt >= killedBefore &&
      (cur === undefined || run.startedAt > cur.startedAt) &&
      (run.hasSnapshots || run.startedAt <= launchLimit),
  );
}

function pipelineLines(runs: readonly RunRow[], details: Map<string, string[]>): string[] {
  const lines: string[] = [];
  for (const run of runs.filter((r) => r.status === 'failed')) {
    lines.push(`${run.id} failed${run.error ? `: ${run.error.slice(0, 160)}` : ''}`);
  }
  const erroring = runs.filter((r) => r.sourceErrors > 0);
  if (erroring.length > 0) {
    const bySource = new Map<string, { runs: number; sample: string }>();
    for (const run of erroring) {
      for (const entry of details.get(run.id) ?? []) {
        const [source = 'unknown', ...rest] = entry.split(': ');
        const prior = bySource.get(source);
        bySource.set(source, { runs: (prior?.runs ?? 0) + 1, sample: prior?.sample ?? rest.join(': ').slice(0, 100) });
      }
    }
    const summary = [...bySource.entries()].map(([source, info]) => `${source} ×${info.runs} (${info.sample})`).join('; ');
    lines.push(`${erroring.length} run${erroring.length === 1 ? '' : 's'} with source errors${summary ? `: ${summary}` : ''}`);
  }
  const cost = runs.reduce((sum, run) => sum + (run.llmCostUsd ?? 0), 0);
  if (cost > 0) lines.push(`pipeline LLM cost 24 h $${cost.toFixed(2)}`);
  return lines;
}

function tokenPrompt(row: DossierRow, reasons: string[]): PromptToken {
  return {
    facts: {
      token_id: row.tokenId,
      chain: row.chain,
      notable_because: reasons,
      tier: row.tier,
      score: row.score,
      prev_tier: row.prevTier,
      prev_score: row.prevScore,
      components: row.components,
      penalties: row.penalties.map((p) => ({ points: p.points, reason: p.reason.slice(0, 120) })),
      liquidity_usd: row.liqUsd,
      mcap_usd: row.mcapUsd,
      volume_24h_usd: row.vol24hUsd,
      change_24h_pct: row.chg24hPct,
      age_h: row.ageH,
      best_rank: row.bestRank,
      first_seen_at: row.firstSeenAt,
      anchor_verdict: row.anchorVerdict,
      recycle_verdict: row.recycleVerdict,
      recycle_generation: row.recycleGeneration,
      research_confidence: row.confidence,
      top10_pct: row.top10Pct,
      holder_count: row.holderCount,
      largest_holder_pct: row.largestHolderPct,
      creator_pct: row.creatorPct,
      lp_burned_pct: row.lpBurnedPct,
      lp_locked_pct: row.lpLockedPct,
      mint_active: row.mintActive,
      freeze_active: row.freezeActive,
      flags: row.flags.map((flag) => ({ code: flag.code, severity: flag.severity })),
    },
    untrusted: {
      symbol: row.symbol,
      name: row.name,
      meme_name: row.memeName,
      narrative_cluster: row.narrativeCluster,
      anchor_summary: row.anchorSummary?.slice(0, 600),
      speculative_setup: row.setup?.slice(0, 600),
      risks: row.reportRisks.slice(0, 6).map((risk) => risk.slice(0, 200)),
    },
  };
}

function setupPrompt(setup: Setup, mcapNow?: number): PromptToken {
  return {
    facts: {
      id: setup.id,
      token_id: setup.tokenId,
      status: setup.status,
      conviction: setup.conviction,
      entry_mcap_low: setup.entryMcapLow,
      entry_mcap_high: setup.entryMcapHigh,
      invalidation_mcap: setup.invalidationMcap,
      targets: setup.targets,
      created_at: setup.createdAt,
      expires_at: setup.expiresAt,
      r_result: setup.rResult,
      status_note: setup.statusNote,
      ...(mcapNow !== undefined ? { mcap_now_usd: mcapNow } : {}),
    },
    untrusted: { symbol: setup.symbol, thesis: setup.thesis, trigger: setup.trigger },
  };
}

async function readSetups(store: SetupStore, sinceIso: string, gaps: string[]): Promise<Setup[]> {
  try {
    return await store.listSetups({ open: true, updatedSince: sinceIso });
  } catch (error) {
    // A dry run against a database the migration has not reached yet.
    if (/no such table/i.test(errorMessage(error))) {
      gaps.push('setups table missing; run `cli.ts migrate`');
      return [];
    }
    throw error;
  }
}

export async function runBrief(options: RunBriefOptions): Promise<BriefResult> {
  const { app, db, logger } = options;
  const log: string[] = [];
  const gaps: string[] = [];
  const fetchImpl = options.fetchImpl ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const now = options.now?.() ?? new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const dayAgo = new Date(nowMs - DAY_MS).toISOString();

  // ---- 1. health (A) -------------------------------------------------------
  const runs = await queryRuns24h(db);
  const { cur, prev } = await queryFullRuns(db);
  const inFlight = fullRunInFlight(runs, cur, nowMs);
  // CLAUDE.md §2 A: a full run still running means today's has not landed;
  // CUR is then the previous run and must not be briefed as today's.
  const fresh = cur !== undefined && cur.startedAt >= dayAgo && !inFlight;
  if (inFlight) log.push(`full run ${inFlight.id} still running (started ${inFlight.startedAt}); briefing watchlist, alerts and ledger only`);
  const details = new Map<string, string[]>();
  for (const run of runs.filter((r) => r.sourceErrors > 0 || r.status === 'failed').slice(0, 5)) {
    const detail = await queryRunErrors(db, run.id);
    details.set(run.id, detail.sourceErrors.map((item) => `${item.source}: ${item.error}`));
  }

  // ---- 2. B–G and the notable set -----------------------------------------
  const alerts = await queryAlerts24h(db);
  const watch = await queryWatchChanges(db);
  const track = await queryTrackRecord(db);
  const clusters = await queryClusters(db);
  const rows = fresh && cur ? await queryDossiers(db, cur.id, prev?.id) : [];
  const verdicts = fresh && cur ? await queryVerdictHistory(db, cur.id) : new Map();
  const notable = selectNotable(rows, alerts, verdicts, nowMs);

  // ---- 3. regimes ----------------------------------------------------------
  const counts = await queryRegimeCounts(db);
  const meme = labelMemeRegime({ ...counts, hottestCluster: Math.max(0, ...clusters.map((c) => c.tokens)) });
  const btc = await fetchBtcRegime(fetchImpl);
  if (btc.gap) gaps.push(btc.gap);
  log.push(`rule: ${MEME_REGIME_RULE}`, `meme regime ${meme.label} (${meme.score}): ${meme.reasons.join('; ') || 'no signal moved'}`);

  // ---- 4. update open setups ----------------------------------------------
  const known = await readSetups(options.setups, new Date(nowMs - 90 * DAY_MS).toISOString(), gaps);
  const open = known.filter((setup) => setup.status === 'watching' || setup.status === 'triggered');
  const rowsById = new Map(rows.map((row) => [row.tokenId, row]));
  const severe = await querySevereAlerts(db, open.map((setup) => setup.tokenId));
  const mcapNow = new Map<string, number>();
  const changes: SetupChange[] = [];
  const current = new Map(known.map((setup) => [setup.id, setup]));
  for (const setup of open) {
    const row = rowsById.get(setup.tokenId);
    const obs: SetupObservation = {
      source: 'none',
      severeAlerts: severe.filter((a) => a.tokenId === setup.tokenId).map((a) => ({ rule: a.rule, createdAt: a.createdAt })),
    };
    if (row) {
      Object.assign(obs, {
        source: 'snapshot',
        mcapUsd: row.mcapUsd,
        liquidityUsd: row.liqUsd,
        top10Pct: row.top10Pct,
        largestHolderPct: row.largestHolderPct,
        mintActive: row.mintActive,
        freezeActive: row.freezeActive,
      });
    } else {
      const market = await fetchDexScreenerMarket(setup.address, setup.chain || undefined, fetchImpl);
      if (market.gap) gaps.push(`${setup.id}: ${market.gap}`);
      const facts = await queryLatestFacts(db, setup.tokenId);
      Object.assign(obs, {
        source: market.gap ? 'none' : 'dexscreener',
        mcapUsd: market.mcapUsd,
        liquidityUsd: market.liquidityUsd,
        top10Pct: facts.top10Pct,
        largestHolderPct: facts.largestHolderPct,
        mintActive: facts.mintActive,
        freezeActive: facts.freezeActive,
      });
    }
    if (obs.mcapUsd !== undefined) mcapNow.set(setup.id, obs.mcapUsd);
    const next = updateSetup(setup, obs, nowIso);
    if (next !== setup) {
      changes.push({ before: setup.status, after: next });
      current.set(next.id, next);
    }
  }

  // ---- 5. the model --------------------------------------------------------
  const pipeline = pipelineLines(runs, details);
  const stillOpen = [...current.values()].filter((s) => s.status === 'watching' || s.status === 'triggered');
  const models = options.noLlm ? [] : (options.models ?? []);
  let output: BriefOutput | undefined;
  let llmMeta: BriefResult['llm'] = { costUsd: 0, calls: 0, used: false };
  if (models.length > 0 && fresh && cur) {
    const weekAgo = new Date(nowMs - 7 * DAY_MS).toISOString();
    const prompt = buildBriefPrompt({
      run: {
        date: nowIso.slice(0, 10),
        current_full_run: cur,
        previous_full_run: prev,
        tokens_in_run: rows.length,
        alerts_24h: alerts.length,
        runs_24h: runs.length,
      },
      regime: {
        meme: meme.label,
        meme_score: meme.score,
        meme_reasons: meme.reasons,
        meme_rule: MEME_REGIME_RULE,
        btc_state: btc.state ?? null,
        btc_since: btc.since ?? null,
        btc_risk_off: btc.riskOff,
        btc_gap: btc.gap ?? null,
      },
      tokens: notable.map((token) => tokenPrompt(token.row, token.reasons)),
      watchlist: watch.slice(0, 20).map((row) => ({
        facts: {
          token_id: row.tokenId,
          status: row.status,
          anchor_verdict: row.anchorVerdict,
          anchor_type: row.anchorType,
          anchor_date: row.anchorDate,
          first_seen_at: row.firstSeenAt,
          expressed_at: row.expressedAt,
          lead_hours: row.leadHours,
          social_at: row.socialAt,
          social_lead_hours: row.socialLeadHours,
          liquidity_at_catalog_usd: row.liqAtCatalog,
          expressed_on: row.expressedOn,
        },
        untrusted: { symbol: row.symbol, anchor_subject: row.anchorSubject, anchor_summary: row.anchorSummary?.slice(0, 400) },
      })),
      alerts: alerts.slice(0, 20).map((alert) => ({
        facts: { created_at: alert.createdAt, token_id: alert.tokenId, rule: alert.rule, severity: alert.severity },
        untrusted: { symbol: alert.symbol, title: alert.title.slice(0, 200), body: alert.body.slice(0, 600) },
      })),
      trackRecord: track,
      clusters: clusters.map((c) => ({
        facts: { tokens: c.tokens, avg_score: c.avgScore, last_seen: c.lastSeen },
        untrusted: { cluster: c.cluster },
      })),
      openSetups: stillOpen.map((setup) => setupPrompt(setup, mcapNow.get(setup.id))),
      closedSetups: [...current.values()]
        .filter((s) => s.status !== 'watching' && s.status !== 'triggered' && s.updatedAt >= weekAgo)
        .map((setup) => setupPrompt(setup)),
      pipeline: [...pipeline, ...gaps],
    });
    const llm = await runBriefLlm({
      app,
      logger,
      models,
      maxUsd: options.maxUsd ?? DEFAULT_BRIEF_MAX_USD,
      prompt,
      context: {
        notableIds: new Set(notable.map((token) => token.row.tokenId)),
        openSetupIds: new Set(stillOpen.map((setup) => setup.id)),
      },
      ...(options.createClient ? { createClient: options.createClient } : {}),
    });
    output = llm.output;
    llmMeta = { ...(llm.model ? { model: llm.model } : {}), costUsd: llm.costUsd, calls: llm.calls, used: true };
    for (const note of llm.notes) gaps.push(`brief model: ${note}`);
    log.push(`brief model ${llm.model ?? 'none succeeded'}: ${llm.calls} call(s), $${llm.costUsd.toFixed(4)}`);
  } else if (models.length === 0) {
    log.push(options.noLlm ? 'model skipped (--no-llm)' : 'model skipped: no key for LLM_BRIEF_MODEL or LLM_BRIEF_FALLBACK');
  } else {
    log.push('model skipped: no full run in the last 24 h');
  }

  // ---- cancellations -------------------------------------------------------
  for (const item of output?.cancel ?? []) {
    const setup = current.get(item.id);
    if (!setup || (setup.status !== 'watching' && setup.status !== 'triggered')) continue;
    const next: Setup = { ...setup, status: 'cancelled', statusNote: `cancelled: ${item.reason}`, updatedAt: nowIso };
    delete next.rResult;
    changes.push({ before: setup.status, after: next });
    current.set(next.id, next);
  }

  // ---- 6. gate -------------------------------------------------------------
  const proposals = output?.new_setups ?? [];
  const candidates = new Map<string, GateCandidate>();
  for (const row of rows) {
    candidates.set(row.tokenId, {
      tokenId: row.tokenId,
      inCur: true,
      onActiveWatchlist: false,
      tier: row.tier,
      anchorVerdict: row.anchorVerdict,
      liquidityUsd: row.liqUsd,
      top10Pct: row.top10Pct,
      largestHolderPct: row.largestHolderPct,
      mintActive: row.mintActive,
      freezeActive: row.freezeActive,
      flags: row.flags,
    });
  }
  const symbols = new Map<string, { symbol: string; chain: string; address: string; mcap?: number }>(
    rows.map((row) => [row.tokenId, { symbol: row.symbol, chain: row.chain, address: row.address, mcap: row.mcapUsd }]),
  );
  const outside = proposals.filter((p) => !candidates.has(p.token_id));
  if (outside.length > 0) {
    const active = new Map((await queryActiveWatch(db)).map((entry) => [entry.tokenId, entry]));
    for (const proposal of outside) {
      const entry = active.get(proposal.token_id);
      if (!entry) continue;
      const facts = await queryLatestFacts(db, proposal.token_id);
      const [chain = '', address = ''] = proposal.token_id.split(':');
      const market = await fetchDexScreenerMarket(address, chain || undefined, fetchImpl);
      if (market.gap) gaps.push(`${proposal.token_id}: ${market.gap}`);
      candidates.set(proposal.token_id, {
        tokenId: proposal.token_id,
        inCur: false,
        onActiveWatchlist: true,
        tier: facts.tier,
        anchorVerdict: facts.anchorVerdict ?? entry.anchorVerdict,
        liquidityUsd: market.liquidityUsd,
        top10Pct: facts.top10Pct,
        largestHolderPct: facts.largestHolderPct,
        mintActive: facts.mintActive,
        freezeActive: facts.freezeActive,
        flags: facts.flags,
      });
      symbols.set(proposal.token_id, { symbol: facts.symbol ?? '', chain, address, mcap: market.mcapUsd });
    }
  }
  const verdictsOut = gateProposals(proposals, candidates, {
    memeRegime: meme.label,
    btcRiskOff: btc.riskOff,
    openTokenIds: [...current.values()].filter((s) => s.status === 'watching' || s.status === 'triggered').map((s) => s.tokenId),
  });
  const dropped = verdictsOut.filter((verdict) => !verdict.accepted);
  for (const verdict of dropped) log.push(`gate dropped ${verdict.proposal.token_id}: ${verdict.reasons.join('; ')}`);

  const taken = new Set(current.keys());
  const newSetups: Setup[] = [];
  for (const verdict of verdictsOut.filter((v) => v.accepted)) {
    const proposal = verdict.proposal;
    const meta = symbols.get(proposal.token_id);
    const candidate = candidates.get(proposal.token_id);
    const id = setupId(meta?.symbol ?? '', nowIso, taken);
    taken.add(id);
    const setup: Setup = {
      id,
      tokenId: proposal.token_id,
      chain: meta?.chain ?? '',
      address: meta?.address ?? '',
      symbol: (meta?.symbol ?? '').slice(0, 40),
      thesis: proposal.thesis,
      trigger: proposal.trigger,
      conviction: proposal.conviction,
      regime: {
        meme: meme.label,
        memeScore: meme.score,
        btc: btc.state ?? null,
        btcRiskOff: btc.riskOff,
        rr: verdict.rr ?? null,
        mcapAtCreation: meta?.mcap ?? null,
        model: llmMeta.model ?? null,
      },
      entryMcapLow: proposal.entry_mcap_low,
      entryMcapHigh: proposal.entry_mcap_high,
      invalidationMcap: proposal.invalidation_mcap,
      targets: proposal.targets,
      kill: {
        ...DEFAULT_SETUP_KILL,
        ...(candidate?.liquidityUsd !== undefined ? { liquidityUsdAtCreation: candidate.liquidityUsd } : {}),
      },
      status: 'watching',
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt: new Date(nowMs + proposal.expiry_days * DAY_MS).toISOString(),
    };
    newSetups.push(setup);
    current.set(id, setup);
    log.push(`gate accepted ${id} (${verdict.rr}R)`);
  }

  // ---- 7. write ------------------------------------------------------------
  const written = [...changes.map((change) => change.after), ...newSetups];
  // Latest version per id: a ledger change and a cancel of the same setup collapse to the cancel.
  const byId = new Map(written.map((setup) => [setup.id, setup]));
  if (!options.dryRun && byId.size > 0) await options.setups.upsertSetups([...byId.values()]);

  const view: BriefView = {
    date: nowIso.slice(0, 10),
    ...(cur ? { cur } : {}),
    ...(inFlight ? { latest: { startedAt: inFlight.startedAt, status: inFlight.status } } : cur ? { latest: cur } : {}),
    fresh,
    tokenCount: rows.length,
    alerts,
    meme,
    btc,
    notable,
    watch,
    track,
    clusters,
    pipeline,
    gaps,
    ...(output ? { llm: output } : {}),
    newSetups,
    changes,
    dropped,
    stats: setupStats([...current.values()], nowMs),
    ...(output?.stand_aside_reason ? { standAside: output.stand_aside_reason } : {}),
  };
  const text = renderBrief(view, nowMs);
  return {
    text,
    parts: splitBrief(text),
    log,
    written: [...byId.values()],
    newSetups,
    changes,
    dropped,
    llm: llmMeta,
    ...(cur ? { curRunId: cur.id } : {}),
  };
}

// ---------------------------------------------------------------------------
// delivery
// ---------------------------------------------------------------------------

/** One synthetic alert per part, rule `daily-brief`, numbered when there is more than one. */
export function briefAlerts(parts: readonly string[], date: string, runId: string | undefined, nowMs: number): Alert[] {
  const stamp = nowMs.toString(36);
  return parts.map((part, index) => ({
    id: `brief_${date}_${stamp}_${index + 1}`,
    runId: runId ?? 'brief',
    tokenId: 'brief',
    rule: 'daily-brief',
    severity: 'info',
    title: `provenance brief ${date}${parts.length > 1 ? ` (${index + 1}/${parts.length})` : ''}`,
    body: part,
    markdown: discordSafe(part),
    createdAt: new Date(nowMs).toISOString(),
    payload: { brief: true, part: index + 1, parts: parts.length, memeName: 'daily brief', recycleVerdict: 'n/a' },
  }));
}

/** Appends the brief to the GitHub step summary when running under Actions. */
export async function writeStepSummary(path: string | undefined, date: string, text: string): Promise<void> {
  if (!path) return;
  const body = text.replaceAll('```', "'''");
  await appendFile(path, `## provenance brief ${date}\n\n\`\`\`text\n${body}\n\`\`\`\n`, 'utf8');
}
