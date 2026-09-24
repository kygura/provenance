/**
 * LP burn / lock measurement for Uniswap-V2-style pairs.
 *
 * A V2 pair is its own ERC-20: liquidity providers hold its LP token, and
 * whoever holds LP can withdraw the pool. So "is the rug primitive gone" is a
 * question about the *pair's* supply, not the token's — LP sent to a burn
 * address is gone for good, LP held by a locker contract is gone until the
 * lock expires. Token supply sitting at 0x…dead is a separate fact and belongs
 * in `supply.burnedPct`.
 *
 * Concentrated-liquidity pools (Uniswap V3 and forks) mint an NFT per position
 * and have no fungible LP supply, so `totalSupply()` reverts or reads zero.
 * Those pools are reported as not determinable rather than as unlocked.
 */

import type { PairInfo } from '@provenance/core';
import { decodeUint256, encodeBalanceOf, encodeCall, isAddress, normalizeAddress, pctOf, SELECTORS } from './abi';
import { EVM_BURN_ADDRESSES, EVM_LP_LOCKERS } from './labels';
import type { Budget, JsonRpcResult, RpcClient } from './rpc';

/** Pairs measured per token; the deepest pools carry the answer. */
export const MAX_LP_PAIRS = 3;

export interface LpMeasurement {
  lpBurnedPct?: number;
  lpLockedPct?: number;
  notes: string[];
}

export type PairLpResult =
  | { status: 'measured'; pairAddress: string; liquidityUsd?: number; burnedPct: number; lockedPct: number }
  | { status: 'concentrated'; pairAddress: string }
  | { status: 'failed'; pairAddress: string; reason: string };

function wordOrUndefined(entry: JsonRpcResult | undefined): bigint | undefined {
  if (!entry || entry.error || typeof entry.result !== 'string') return undefined;
  try {
    return decodeUint256(entry.result);
  } catch {
    return undefined;
  }
}

/** One batched round trip: totalSupply plus a balanceOf per sink. */
export async function measurePair(client: RpcClient, pair: PairInfo): Promise<PairLpResult> {
  const pairAddress = pair.pairAddress;
  // Uniswap V4 identifies pools by a bytes32 id, not a contract address.
  if (!isAddress(pairAddress)) return { status: 'concentrated', pairAddress };
  const to = normalizeAddress(pairAddress);

  const burnSinks = [...EVM_BURN_ADDRESSES];
  const lockSinks = EVM_LP_LOCKERS.map((entry) => entry.address);
  const call = (data: string) => ({ method: 'eth_call', params: [{ to, data }, 'latest'] });

  let results: JsonRpcResult[];
  try {
    results = await client.callMany([
      call(encodeCall(SELECTORS.totalSupply)),
      ...burnSinks.map((sink) => call(encodeBalanceOf(sink))),
      ...lockSinks.map((sink) => call(encodeBalanceOf(sink))),
    ]);
  } catch (error) {
    return { status: 'failed', pairAddress: to, reason: (error as Error).message };
  }

  const total = wordOrUndefined(results[0]);
  if (total === undefined || total === 0n) return { status: 'concentrated', pairAddress: to };

  const balances = results.slice(1).map(wordOrUndefined);
  if (balances.some((value) => value === undefined)) {
    return { status: 'failed', pairAddress: to, reason: 'balanceOf reverted or was unreadable' };
  }
  const values = balances as bigint[];
  const burned = values.slice(0, burnSinks.length).reduce((sum, value) => sum + value, 0n);
  const locked = values.slice(burnSinks.length).reduce((sum, value) => sum + value, 0n);

  return {
    status: 'measured',
    pairAddress: to,
    ...(pair.liquidityUsd !== undefined ? { liquidityUsd: pair.liquidityUsd } : {}),
    burnedPct: Math.min(100, pctOf(burned, total)),
    lockedPct: Math.min(100, pctOf(locked, total)),
  };
}

function hasWeight(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

/**
 * Folds per-pair results into one figure. Liquidity-weighted when every
 * measured pair has a liquidity figure; otherwise the deepest (or first)
 * measured pair stands in, because averaging a known pool with an unweighted
 * one would invent a weighting.
 */
export function aggregateLp(results: readonly PairLpResult[]): LpMeasurement {
  const notes: string[] = [];
  const measured = results.filter((result) => result.status === 'measured');
  const concentrated = results.filter((result) => result.status === 'concentrated');
  const failed = results.filter((result) => result.status === 'failed');

  for (const miss of failed) notes.push(`LP read failed for pair ${miss.pairAddress}: ${miss.reason}`);

  if (measured.length === 0) {
    if (concentrated.length > 0) {
      notes.push(
        'LP lock is not determinable for concentrated-liquidity pools (positions are NFTs, not a fungible LP token); ' +
          'lpBurnedPct/lpLockedPct left undefined.',
      );
    }
    return { notes };
  }

  let burned: number;
  let locked: number;
  if (measured.every((result) => hasWeight(result.liquidityUsd))) {
    const weight = measured.reduce((sum, result) => sum + (result.liquidityUsd ?? 0), 0);
    burned = measured.reduce((sum, result) => sum + result.burnedPct * (result.liquidityUsd ?? 0), 0) / weight;
    locked = measured.reduce((sum, result) => sum + result.lockedPct * (result.liquidityUsd ?? 0), 0) / weight;
  } else {
    // Strict `>` keeps the first pair on ties, including "no liquidity known".
    const pick = measured.reduce((best, result) =>
      (result.liquidityUsd ?? -1) > (best.liquidityUsd ?? -1) ? result : best,
    );
    burned = pick.burnedPct;
    locked = pick.lockedPct;
    if (measured.length > 1) notes.push(`LP figures taken from pair ${pick.pairAddress} alone: pair liquidity was not available to weight them.`);
  }

  if (concentrated.length > 0 || failed.length > 0) {
    notes.push(
      `LP burn/lock covers ${measured.length} of ${results.length} pair(s); ` +
        'concentrated-liquidity or unreadable pools are not included.',
    );
  }
  notes.push(
    `Lockers checked: ${EVM_LP_LOCKERS.map((entry) => entry.label).join(', ')}. LP locked elsewhere is not counted.`,
  );

  return { lpBurnedPct: burned, lpLockedPct: locked, notes };
}

/**
 * Measures up to `MAX_LP_PAIRS` pairs, deepest first. Never throws; stops
 * early (with a note) when the analysis budget runs out.
 */
export async function measureLp(
  client: RpcClient,
  pairs: readonly PairInfo[],
  budget?: Budget,
): Promise<LpMeasurement> {
  const ordered = [...pairs].sort((a, b) => (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1)).slice(0, MAX_LP_PAIRS);
  const results: PairLpResult[] = [];
  const extra: string[] = [];
  if (ordered.length === 0) extra.push('No pairs listed for this token; LP burn/lock not measured.');
  for (const pair of ordered) {
    if (budget?.expired()) {
      extra.push('Analysis budget exhausted before every pair was checked for LP burn/lock.');
      break;
    }
    results.push(await measurePair(client, pair));
  }
  const folded = aggregateLp(results);
  return { ...folded, notes: [...extra, ...folded.notes] };
}
