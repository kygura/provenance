/**
 * The setups ledger: status transitions, decided in code from observed market
 * cap and liquidity. The model proposes and may cancel; it never decides that a
 * setup triggered, hit or failed.
 *
 * Observations are one per brief, about 12 h apart, so a status reflects what
 * was seen at that moment, not the intraday path between two briefs.
 */
import { EXTREME_CONCENTRATION_PCT, SINGLE_HOLDER_DOMINANCE_PCT } from '@provenance/alerts';
import type { Setup, SetupKill } from '@provenance/core';
import { parseDexScreenerPairs } from '@provenance/sources';
import type { FetchLike } from './regime';

/** Kill thresholds, from the scoring code's own constants. */
export const DEFAULT_SETUP_KILL: SetupKill = {
  liquidityKillRatio: 0.5,
  maxTop10Pct: EXTREME_CONCENTRATION_PCT,
  maxSingleHolderPct: SINGLE_HOLDER_DOMINANCE_PCT,
};

export const SEVERE_ALERT_RULES = ['rug-risk', 'canonical-impostor'] as const;

export interface SetupObservation {
  mcapUsd?: number;
  liquidityUsd?: number;
  /** Where mcap/liquidity came from. */
  source: 'snapshot' | 'dexscreener' | 'none';
  top10Pct?: number;
  largestHolderPct?: number;
  mintActive?: boolean;
  freezeActive?: boolean;
  /** Severe alerts on the token: `{rule, createdAt}`. Only those after the setup's creation count. */
  severeAlerts: { rule: string; createdAt: string }[];
}

export function entryMid(setup: Pick<Setup, 'entryMcapLow' | 'entryMcapHigh'>): number {
  return (setup.entryMcapLow + setup.entryMcapHigh) / 2;
}

/**
 * R multiple of exiting at `exitMcap`, measured from the entry-zone midpoint
 * with the invalidation level as one R. Undefined when the levels make no risk
 * (invalidation at or above the midpoint).
 */
export function rMultiple(
  setup: Pick<Setup, 'entryMcapLow' | 'entryMcapHigh' | 'invalidationMcap'>,
  exitMcap: number,
): number | undefined {
  const mid = entryMid(setup);
  const risk = mid - setup.invalidationMcap;
  if (!(risk > 0) || !Number.isFinite(exitMcap)) return undefined;
  return Number(((exitMcap - mid) / risk).toFixed(2));
}

/** The first kill condition that holds, as a sentence; undefined when none does. */
export function killReason(setup: Setup, obs: SetupObservation): string | undefined {
  const kill = setup.kill;
  const created = kill.liquidityUsdAtCreation;
  if (created !== undefined && created > 0 && obs.liquidityUsd !== undefined) {
    if (obs.liquidityUsd < created * kill.liquidityKillRatio) {
      return `liquidity $${Math.round(obs.liquidityUsd).toLocaleString('en-US')} < ${Math.round(kill.liquidityKillRatio * 100)}% of $${Math.round(created).toLocaleString('en-US')} at creation`;
    }
  }
  if (obs.top10Pct !== undefined && obs.top10Pct >= kill.maxTop10Pct) {
    return `top-10 holders ${obs.top10Pct.toFixed(1)}% ≥ ${kill.maxTop10Pct}%`;
  }
  if (obs.largestHolderPct !== undefined && obs.largestHolderPct >= kill.maxSingleHolderPct) {
    return `single holder ${obs.largestHolderPct.toFixed(1)}% ≥ ${kill.maxSingleHolderPct}%`;
  }
  if (obs.mintActive === true) return 'mint authority active';
  if (obs.freezeActive === true) return 'freeze authority active';
  const alert = obs.severeAlerts.find(
    (item) => (SEVERE_ALERT_RULES as readonly string[]).includes(item.rule) && item.createdAt >= setup.createdAt,
  );
  if (alert) return `${alert.rule} alert at ${alert.createdAt}`;
  return undefined;
}

function fmtMcap(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${Math.round(value)}`;
}

/**
 * One observation applied to one setup. Pure. Returns the setup unchanged
 * (same object) when nothing moved, so the caller can tell by identity.
 *
 * Order matters and is deliberate:
 *  1. a triggered setup at its first target (and no kill) is a hit, even past expiry;
 *  2. expiry next: otherwise an observation after `expiresAt` describes a dead plan;
 *  3. kill conditions: they hold regardless of where the price is;
 *  4. then the levels.
 */
export function updateSetup(setup: Setup, obs: SetupObservation, nowIso: string): Setup {
  if (setup.status !== 'watching' && setup.status !== 'triggered') return setup;
  const close = (status: Setup['status'], note: string, rResult?: number): Setup => {
    const next: Setup = { ...setup, status, statusNote: note, updatedAt: nowIso };
    if (rResult !== undefined) next.rResult = rResult;
    else delete next.rResult;
    return next;
  };
  const mcap = obs.mcapUsd;
  const killed = killReason(setup, obs);
  const target = setup.targets[0];

  // A triggered plan seen at its target is a hit even when this observation
  // lands after expiry: briefs are ~12 h apart, so expiry can fall between them.
  if (setup.status === 'triggered' && !killed && mcap !== undefined && target !== undefined && mcap >= target) {
    return close('target_hit', `mcap ${fmtMcap(mcap)} reached first target ${fmtMcap(target)}`, rMultiple(setup, target));
  }

  if (nowIso > setup.expiresAt) {
    // A triggered plan that ran out of time is marked to market when we can see it.
    const r = setup.status === 'triggered' && mcap !== undefined ? rMultiple(setup, mcap) : undefined;
    return close('expired', `expired ${setup.expiresAt}${mcap !== undefined ? ` at mcap ${fmtMcap(mcap)}` : ''}`, r === undefined ? undefined : Math.max(-1, r));
  }

  if (killed) return close('invalidated', `kill: ${killed}`, setup.status === 'triggered' ? -1 : undefined);

  if (mcap === undefined) return setup;

  if (setup.status === 'watching') {
    if (mcap < setup.invalidationMcap) {
      return close('invalidated', `mcap ${fmtMcap(mcap)} below invalidation ${fmtMcap(setup.invalidationMcap)} before trigger`);
    }
    if (mcap >= setup.entryMcapLow && mcap <= setup.entryMcapHigh) {
      return { ...setup, status: 'triggered', statusNote: `mcap ${fmtMcap(mcap)} inside entry zone`, updatedAt: nowIso };
    }
    return setup;
  }

  // triggered
  if (mcap <= setup.invalidationMcap) {
    return close('invalidated', `mcap ${fmtMcap(mcap)} at or below invalidation ${fmtMcap(setup.invalidationMcap)}`, -1);
  }
  return setup;
}

export interface SetupStats {
  open: number;
  resolved90d: number;
  hits90d: number;
  /** hits / resolved, undefined with nothing resolved. */
  hitRate?: number;
  avgR?: number;
}

/** 90-day record over setups that resolved with an R (triggered first). */
export function setupStats(setups: readonly Setup[], nowMs: number): SetupStats {
  const since = new Date(nowMs - 90 * 86_400_000).toISOString();
  const open = setups.filter((setup) => setup.status === 'watching' || setup.status === 'triggered').length;
  const resolved = setups.filter(
    (setup) => setup.rResult !== undefined && setup.updatedAt >= since && setup.status !== 'watching' && setup.status !== 'triggered',
  );
  const hits = resolved.filter((setup) => setup.status === 'target_hit').length;
  const avgR =
    resolved.length > 0
      ? Number((resolved.reduce((sum, setup) => sum + (setup.rResult ?? 0), 0) / resolved.length).toFixed(2))
      : undefined;
  return {
    open,
    resolved90d: resolved.length,
    hits90d: hits,
    ...(resolved.length > 0 ? { hitRate: hits / resolved.length } : {}),
    ...(avgR !== undefined ? { avgR } : {}),
  };
}

// ---------------------------------------------------------------------------
// Market reads for tokens not in the current run
// ---------------------------------------------------------------------------

export const DEXSCREENER_TOKENS_URL = 'https://api.dexscreener.com/latest/dex/tokens/';

export interface MarketRead {
  mcapUsd?: number;
  liquidityUsd?: number;
  /** Set when the read failed. */
  gap?: string;
}

/** Pure: the max-liquidity pair whose base token is `address` (and on `chain`, when given). */
export function pickDexScreenerPair(payload: unknown, address: string, chain?: string): MarketRead {
  const wanted = address.toLowerCase();
  const rows = parseDexScreenerPairs(payload).filter(
    (row) => row.tokenAddress.toLowerCase() === wanted && (!chain || row.chain === chain),
  );
  let best: (typeof rows)[number] | undefined;
  for (const row of rows) {
    if (!best || (row.metrics.liquidityUsd ?? 0) > (best.metrics.liquidityUsd ?? 0)) best = row;
  }
  if (!best) return { gap: `dexscreener: no pair for ${address}` };
  return {
    mcapUsd: best.metrics.marketCapUsd ?? best.metrics.fdvUsd,
    liquidityUsd: best.metrics.liquidityUsd,
  };
}

/** Keyless DexScreener tokens endpoint. Never throws: a failure is a gap. */
export async function fetchDexScreenerMarket(
  address: string,
  chain: string | undefined,
  fetchImpl: FetchLike = fetch,
  timeoutMs = 15_000,
): Promise<MarketRead> {
  if (!/^[A-Za-z0-9]{20,64}$/.test(address)) return { gap: `dexscreener: refusing malformed address` };
  try {
    const response = await fetchImpl(`${DEXSCREENER_TOKENS_URL}${address}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { gap: `dexscreener: HTTP ${response.status}` };
    return pickDexScreenerPair(await response.json(), address, chain);
  } catch (error) {
    return { gap: `dexscreener unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
