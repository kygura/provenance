/**
 * The outcome step: label old scores by what happened next (docs/calibration.md).
 *
 * A trending token drops off the trending lists whether it thrives or dies, so
 * "absent from later snapshots" is not a label. Instead, a score whose run
 * started at least `OUTCOME_HORIZON_HOURS` ago is looked up again on
 * DexScreener: it survived when its deepest pool still holds at least half the
 * liquidity it had when scored. No pair at all is not surviving, recorded as
 * `pair_found = 0` so the two failure modes stay apart.
 *
 * One label per token per UTC day, from that day's latest scored run: at an
 * hourly cadence a token trending all day would otherwise count as 24
 * outcomes, and the fit would learn mostly about the tokens that trend longest.
 *
 * Runs at the end of a full run and as `cli.ts outcomes`. It measures the
 * pipeline rather than producing its output, so a failure here is a note in
 * `sourceErrors`, never a failed run.
 */
import type { AppConfig, Logger, OutcomeCandidate, OutcomeRecord, OutcomeStats, ProvenanceStore } from '@provenance/core';
import {
  chunk,
  DEXSCREENER_BASE_URL,
  DEXSCREENER_BATCH_SIZE,
  JsonClient,
  parseDexScreenerPairs,
  readJsonFixtures,
  type DexScreenerPairRow,
} from '@provenance/sources';

/** The `sourceErrors` entry this step writes. */
export const OUTCOMES_SOURCE = 'outcomes';

/** Survived = the deepest pool kept at least this share of its liquidity at score time. */
export const SURVIVAL_LIQUIDITY_RATIO = 0.5;

/** Raw `/latest/dex/tokens/<a,b,…>` payload for up to 30 addresses. */
export type PairFetcher = (addresses: string[]) => Promise<unknown>;

/** Same guard as the brief's ledger: an address goes into a URL path. */
const ADDRESS = /^[A-Za-z0-9]{20,64}$/;

export function emptyOutcomeStats(): OutcomeStats {
  return { pending: 0, measured: 0, survived: 0, notFound: 0 };
}

/**
 * The latest scored run per token per UTC day, newest first. Pure. Ties on
 * `scoredAt` keep the first row seen, which the store orders by run id.
 */
export function onePerTokenDay(candidates: readonly OutcomeCandidate[]): OutcomeCandidate[] {
  const best = new Map<string, OutcomeCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.tokenId}|${candidate.scoredAt.slice(0, 10)}`;
    const held = best.get(key);
    if (!held || candidate.scoredAt > held.scoredAt) best.set(key, candidate);
  }
  return [...best.values()].sort((a, b) => (a.scoredAt < b.scoredAt ? 1 : a.scoredAt > b.scoredAt ? -1 : 0));
}

/** The deepest pair whose base token is this token on this chain. */
export function deepestPair(rows: readonly DexScreenerPairRow[], chain: string, address: string): DexScreenerPairRow | undefined {
  const wanted = address.toLowerCase();
  let best: DexScreenerPairRow | undefined;
  for (const row of rows) {
    if (row.chain !== chain || row.tokenAddress.toLowerCase() !== wanted) continue;
    if (!best || (row.metrics.liquidityUsd ?? 0) > (best.metrics.liquidityUsd ?? 0)) best = row;
  }
  return best;
}

/** One candidate's label from a successful lookup. Pure. */
export function labelOutcome(
  candidate: OutcomeCandidate,
  rows: readonly DexScreenerPairRow[],
  horizonH: number,
  measuredAt: string,
): OutcomeRecord {
  const pair = deepestPair(rows, candidate.chain, candidate.address);
  const liqNow = pair?.metrics.liquidityUsd;
  const priceNow = pair?.metrics.priceUsd;
  return {
    tokenId: candidate.tokenId,
    runId: candidate.runId,
    horizonH,
    scoredAt: candidate.scoredAt,
    measuredAt,
    liqAtScore: candidate.liqAtScore,
    ...(liqNow !== undefined ? { liqNow } : {}),
    ...(candidate.priceAtScore !== undefined ? { priceAtScore: candidate.priceAtScore } : {}),
    ...(priceNow !== undefined ? { priceNow } : {}),
    pairFound: pair !== undefined,
    survived: pair !== undefined && (liqNow ?? 0) >= SURVIVAL_LIQUIDITY_RATIO * candidate.liqAtScore,
  };
}

/** DexScreener over the network, on the trending source's rate limit and retry policy. */
export function createPairFetcher(app: AppConfig, logger: Logger): PairFetcher {
  if (app.pipeline.useFixtures) {
    // Every recorded hydration payload at once; labelling filters by address.
    return async () => {
      const files = await readJsonFixtures('dexscreener');
      const pairs = files.flatMap((file) => {
        const data = file.data as { pairs?: unknown };
        return Array.isArray(data?.pairs) ? data.pairs : [];
      });
      return { pairs };
    };
  }
  const source = app.pipeline.sources.find((s) => s.id === 'dexscreener');
  const client = new JsonClient({
    baseUrl: DEXSCREENER_BASE_URL,
    rateLimitMs: source?.rateLimitMs ?? 1200,
    logger,
  });
  return (addresses) => client.getJson(`/latest/dex/tokens/${addresses.join(',')}`);
}

export interface OutcomeResult {
  stats: OutcomeStats;
  errors: { source: string; error: string }[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Labels up to `maxPerRun` pending scores, newest first so steady-state
 * labels are taken close to the nominal horizon; a backlog drains behind
 * them. A batch that fails leaves its tokens pending for the next run: a
 * network error is not a dead token.
 */
export async function collectOutcomes(
  app: AppConfig,
  store: ProvenanceStore,
  fetchPairs: PairFetcher,
  log: Logger,
  now: Date = new Date(),
): Promise<OutcomeResult> {
  const { horizonHours, maxPerRun } = app.outcomes;
  const stats = emptyOutcomeStats();
  const errors: OutcomeResult['errors'] = [];

  const pending = onePerTokenDay(await store.outcomeCandidates({ horizonHours, now: now.toISOString() })).filter(
    (candidate) => ADDRESS.test(candidate.address),
  );
  stats.pending = pending.length;
  const picked = pending.slice(0, Math.max(0, Math.trunc(maxPerRun)));
  if (picked.length === 0) return { stats, errors };

  // One lookup per token, however many days of it are pending.
  const tokens = new Map<string, OutcomeCandidate>();
  for (const candidate of picked) if (!tokens.has(candidate.tokenId)) tokens.set(candidate.tokenId, candidate);

  const answered = new Map<string, DexScreenerPairRow[]>();
  for (const batch of chunk([...tokens.values()], DEXSCREENER_BATCH_SIZE)) {
    let rows: DexScreenerPairRow[];
    try {
      rows = parseDexScreenerPairs(await fetchPairs(batch.map((c) => c.address)), now);
    } catch (error) {
      errors.push({ source: OUTCOMES_SOURCE, error: `dexscreener batch of ${batch.length}: ${errorMessage(error)}` });
      log.warn('outcome batch failed; left pending', { size: batch.length, error: errorMessage(error) });
      continue;
    }
    for (const candidate of batch) {
      if (deepestPair(rows, candidate.chain, candidate.address) || batch.length === 1) {
        answered.set(candidate.tokenId, rows);
        continue;
      }
      // The batch response is capped in pairs, so a token with busy
      // neighbours can be crowded out. Ask once alone before calling it dead.
      try {
        answered.set(candidate.tokenId, parseDexScreenerPairs(await fetchPairs([candidate.address]), now));
      } catch (error) {
        errors.push({ source: OUTCOMES_SOURCE, error: `dexscreener ${candidate.tokenId}: ${errorMessage(error)}` });
      }
    }
  }

  const measuredAt = now.toISOString();
  const records: OutcomeRecord[] = [];
  for (const candidate of picked) {
    const rows = answered.get(candidate.tokenId);
    if (!rows) continue;
    const record = labelOutcome(candidate, rows, horizonHours, measuredAt);
    records.push(record);
    if (record.survived) stats.survived += 1;
    if (!record.pairFound) stats.notFound += 1;
  }
  await store.saveOutcomes(records);
  stats.measured = records.length;
  log.info('outcomes labelled', { ...stats, horizonHours });
  return { stats, errors };
}
