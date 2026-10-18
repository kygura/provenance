/**
 * Two regime reads, both computed before the model sees anything:
 *
 *  - the meme regime, from this database alone (`labelMemeRegime`, pure);
 *  - the BTC regime, `regime.state` from hl-cycles' keyless vector.json.
 *    A failed fetch is a data gap in the brief, never a crash.
 */
import type { RegimeCounts } from './queries';

export type MemeRegime = 'hot' | 'warm' | 'cold';

export interface MemeRegimeInputs extends RegimeCounts {
  /** Tokens in the largest narrative cluster of the last 7 days (query G); 0 when none has 2+. */
  hottestCluster: number;
}

export interface MemeRegimeRead {
  label: MemeRegime;
  score: number;
  /** One line per signal that moved the score, for the run output. */
  reasons: string[];
}

/**
 * The rule, stated once so the run output can print it verbatim. Each signal
 * adds +1, −1 or 0; the sum decides the label.
 */
export const MEME_REGIME_RULE =
  'meme regime = sum of: S/A tokens 7d vs prior 7d (±20% → ±1); mean score 7d vs prior (±3 pts → ±1); ' +
  'alerts/day 7d vs prior (≥1.2x → +1, ≤0.8x → −1); anchored→expressed 30d (≥30% → +1, ≤10% → −1, needs 5 resolved); ' +
  'hottest cluster (≥4 tokens → +1, none with 2+ → −1). Sum ≥ 2 hot, ≤ −2 cold, else warm.';

/** Below this many resolved anchored entries, the conversion rate says nothing. */
export const MIN_RESOLVED_FOR_CONVERSION = 5;

function ratioSignal(cur: number, prev: number, up: number, down: number): -1 | 0 | 1 {
  if (prev <= 0) return cur > 0 ? 1 : 0;
  const ratio = cur / prev;
  if (ratio >= up) return 1;
  if (ratio <= down) return -1;
  return 0;
}

export function labelMemeRegime(input: MemeRegimeInputs): MemeRegimeRead {
  const reasons: string[] = [];
  let score = 0;
  const add = (points: number, reason: string) => {
    if (points === 0) return;
    score += points;
    reasons.push(`${points > 0 ? '+1' : '−1'} ${reason}`);
  };

  add(
    ratioSignal(input.saTokens7d, input.saTokensPrev7d, 1.2, 0.8),
    `S/A tokens ${input.saTokens7d} (7d) vs ${input.saTokensPrev7d} (prior 7d)`,
  );

  if (input.meanScore7d !== undefined && input.meanScorePrev7d !== undefined) {
    const delta = input.meanScore7d - input.meanScorePrev7d;
    add(
      delta >= 3 ? 1 : delta <= -3 ? -1 : 0,
      `mean score ${input.meanScore7d.toFixed(1)} vs ${input.meanScorePrev7d.toFixed(1)}`,
    );
  }

  add(
    ratioSignal(input.alerts7d, input.alertsPrev7d, 1.2, 0.8),
    `alerts/day ${(input.alerts7d / 7).toFixed(1)} vs ${(input.alertsPrev7d / 7).toFixed(1)}`,
  );

  const { expressed, dormant } = input.anchored30d;
  const resolved = expressed + dormant;
  if (resolved >= MIN_RESOLVED_FOR_CONVERSION) {
    const rate = expressed / resolved;
    add(rate >= 0.3 ? 1 : rate <= 0.1 ? -1 : 0, `anchored→expressed ${expressed}/${resolved} (30d)`);
  }

  add(
    input.hottestCluster >= 4 ? 1 : input.hottestCluster < 2 ? -1 : 0,
    input.hottestCluster < 2 ? 'no cluster with 2+ tokens (7d)' : `hottest cluster ${input.hottestCluster} tokens (7d)`,
  );

  const label: MemeRegime = score >= 2 ? 'hot' : score <= -2 ? 'cold' : 'warm';
  return { label, score, reasons };
}

// ---------------------------------------------------------------------------
// BTC regime (hl-cycles)
// ---------------------------------------------------------------------------

export const HL_CYCLES_VECTOR_URL = 'https://hl-cycles.vercel.app/api/vector.json';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface BtcRegime {
  /** e.g. `strong_risk_on`, `mild_risk_off`; undefined on a gap. */
  state?: string;
  /** YYYY-MM-DD of `regime.since`. */
  since?: string;
  /** YYYY-MM-DD of `asOf`. */
  asOf?: string;
  /** hl-cycles' own staleness flag. */
  stale?: boolean;
  riskOff: boolean;
  /** Set when the read failed: names the source and the reason. */
  gap?: string;
}

function isoDay(ms: unknown): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

/** Pure parser for vector.json. Anything without a string `regime.state` is a gap. */
export function parseBtcRegime(payload: unknown): BtcRegime {
  const record = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  const regime =
    typeof record.regime === 'object' && record.regime !== null ? (record.regime as Record<string, unknown>) : {};
  const state = typeof regime.state === 'string' && regime.state.trim() !== '' ? regime.state.trim() : undefined;
  if (!state) return { riskOff: false, gap: 'hl-cycles: no regime.state in vector.json' };
  return {
    state,
    since: isoDay(regime.since),
    asOf: isoDay(record.asOf),
    ...(typeof record.stale === 'boolean' ? { stale: record.stale } : {}),
    riskOff: /risk_off/i.test(state),
  };
}

export async function fetchBtcRegime(fetchImpl: FetchLike = fetch, timeoutMs = 15_000): Promise<BtcRegime> {
  try {
    const response = await fetchImpl(HL_CYCLES_VECTOR_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { riskOff: false, gap: `hl-cycles: HTTP ${response.status}` };
    return parseBtcRegime(await response.json());
  } catch (error) {
    return { riskOff: false, gap: `hl-cycles unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
