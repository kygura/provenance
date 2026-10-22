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
 * Those pools are reported as not determinable rather than as unlocked, unless
 * the caller passes a `V3LpScope` (see `measureV3Pool`), in which case a fresh
 * Uniswap V3 pool's positions are traced to their NFT owners.
 */

import type { Chain, PairInfo } from '@provenance/core';
import {
  decodeAddress,
  decodeUint256,
  encodeBalanceOf,
  encodeCall,
  isAddress,
  normalizeAddress,
  pctOf,
  quantityToNumber,
  SELECTORS,
  toQuantity,
  topicToAddress,
} from './abi';
import { EVM_BURN_ADDRESSES, EVM_LP_LOCKERS, EVM_V3_LP_LOCKERS, UNISWAP_V3_POSITION_MANAGERS } from './labels';
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
  | { status: 'concentrated'; pairAddress: string; note?: string }
  | { status: 'failed'; pairAddress: string; reason: string };

function wordOrUndefined(entry: JsonRpcResult | undefined): bigint | undefined {
  if (!entry || entry.error || typeof entry.result !== 'string') return undefined;
  try {
    return decodeUint256(entry.result);
  } catch {
    return undefined;
  }
}

/**
 * One batched round trip: totalSupply plus a balanceOf per sink. With `v3`, a
 * pool without fungible LP is retried as a Uniswap V3 pool (`measureV3Pool`).
 */
export async function measurePair(client: RpcClient, pair: PairInfo, v3?: V3LpScope): Promise<PairLpResult> {
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
  if (total === undefined || total === 0n) {
    if (!v3) return { status: 'concentrated', pairAddress: to };
    const measured = await measureV3Pool(client, to, v3);
    return measured.status === 'measured' && pair.liquidityUsd !== undefined
      ? { ...measured, liquidityUsd: pair.liquidityUsd }
      : measured;
  }

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
  for (const miss of concentrated) if (miss.note) notes.push(`V3 LP for pool ${miss.pairAddress}: ${miss.note}`);

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
  v3?: V3LpScope,
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
    results.push(await measurePair(client, pair, v3 ? { ...(budget ? { budget } : {}), ...v3 } : undefined));
  }
  const folded = aggregateLp(results);
  return { ...folded, notes: [...extra, ...folded.notes] };
}

// ---------------------------------------------------------------- Uniswap V3

// keccak256 of each signature, computed offline with a reference Keccak that
// also reproduces `TRANSFER_TOPIC0` and the ERC-20 selectors in abi.ts.

/** Pool `Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)` */
export const V3_MINT_TOPIC0 = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde';
/** NPM `IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)` */
export const V3_INCREASE_LIQUIDITY_TOPIC0 = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
/** `positions(uint256)` on the NPM; liquidity is return word 7. */
export const V3_POSITIONS_SELECTOR = '0x99fbab88';
/** ERC-721 `ownerOf(uint256)`; reverts for a burned token id. */
export const ERC721_OWNER_OF_SELECTOR = '0x6352211e';

/** Positions traced per pool. More than this is not a fresh launch pool. */
export const MAX_V3_MINTS = 20;

/** Where to look for a V3 pool's positions. */
export interface V3LpScope {
  chain: Chain;
  /** First block to scan for `Mint` logs. Must be at or before pool creation. */
  fromBlock: number;
  /** Last block; fetched with `eth_blockNumber` when omitted. */
  toBlock?: number;
  /** Blocks per `eth_getLogs` request (default 9 000, like the holder scan). */
  chunkBlocks?: number;
  /** `eth_getLogs` requests before giving up (default 4). */
  maxChunks?: number;
  budget?: Budget;
}

interface RpcLog {
  address?: string;
  topics?: string[];
  data?: string;
  transactionHash?: string;
  logIndex?: string;
}

interface MintRecord {
  owner: string;
  amount: bigint;
  txHash?: string;
  logIndex: number;
}

/**
 * Burned/locked share of a fresh Uniswap V3 pool's liquidity.
 *
 * 1. Every pool `Mint` from `fromBlock` to head (all of them, or it gives up).
 * 2. Mints owned by the chain's NonfungiblePositionManager are resolved to a
 *    token id through the NPM `IncreaseLiquidity` log in the same receipt.
 * 3. Each token id's current liquidity (`positions`) and holder (`ownerOf`):
 *    held by a burn address counts as burned, by a V3 locker as locked.
 * 4. Mints straight to some other owner can't be shown locked, so their minted
 *    `amount` counts as unsecured. It is the amount at mint, not now: if that
 *    owner already withdrew, the unsecured share is overstated (safe side).
 *
 * Liquidity units are only strictly comparable between positions on the same
 * tick range; a full-range and a narrow position with equal `liquidity` hold
 * different amounts of tokens. Launch pools usually have one or two full-range
 * positions, where this is exact enough; for anything busier the figure is
 * approximate, and past `MAX_V3_MINTS` positions it is not attempted.
 *
 * Never throws: anything incomplete returns `concentrated` with a note, which
 * the launch gate treats as "LP could not be measured".
 */
export async function measureV3Pool(client: RpcClient, pool: string, scope: V3LpScope): Promise<PairLpResult> {
  const pairAddress = normalizeAddress(pool);
  const give = (note: string): PairLpResult => ({ status: 'concentrated', pairAddress, note });
  const npm = UNISWAP_V3_POSITION_MANAGERS[scope.chain];
  if (!npm) return give(`no Uniswap V3 position manager known for ${scope.chain}`);
  const budget = scope.budget;

  try {
    // --- 1. Mint logs, oldest first, all or nothing --------------------------
    const head = scope.toBlock ?? quantityToNumber(await client.call<string>('eth_blockNumber', []));
    const wide = Math.max(1, scope.chunkBlocks ?? 9_000);
    const narrow = Math.max(1, Math.floor(wide / 8));
    const maxChunks = scope.maxChunks ?? 4;
    let chunk = wide;
    let chunks = 0;
    const mints: MintRecord[] = [];
    const seen = new Set<string>();
    for (let start = Math.max(0, scope.fromBlock); start <= head; ) {
      if (budget?.expired()) return give('analysis budget ran out during the Mint log scan');
      if (chunks >= maxChunks) return give(`Mint log scan did not reach head within ${maxChunks} request(s)`);
      const end = Math.min(head, start + chunk - 1);
      let logs: RpcLog[];
      try {
        logs =
          (await client.call<RpcLog[]>('eth_getLogs', [
            { address: pairAddress, topics: [V3_MINT_TOPIC0], fromBlock: toQuantity(start), toBlock: toQuantity(end) },
          ])) ?? [];
      } catch (error) {
        if (chunk > narrow) {
          chunk = narrow;
          continue;
        }
        return give(`Mint log scan failed at block ${start}: ${(error as Error).message}`);
      }
      chunks += 1;
      for (const log of logs) {
        const ownerTopic = log.topics?.[1];
        if (log.topics?.[0]?.toLowerCase() !== V3_MINT_TOPIC0 || !ownerTopic || !log.data) continue;
        const key = `${log.transactionHash ?? ''}:${log.logIndex ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        mints.push({
          owner: topicToAddress(ownerTopic),
          amount: decodeUint256(log.data, 1),
          ...(log.transactionHash ? { txHash: log.transactionHash } : {}),
          logIndex: log.logIndex ? quantityToNumber(log.logIndex) : 0,
        });
      }
      if (mints.length > MAX_V3_MINTS) return give(`more than ${MAX_V3_MINTS} positions minted; not a fresh launch pool`);
      start = end + 1;
    }
    if (mints.length === 0) return give('no Mint logs found since the scan start; positions untraceable');

    // --- 2. NPM mints → token ids ------------------------------------------
    const viaNpm = mints.filter((mint) => mint.owner === npm);
    const direct = mints.filter((mint) => mint.owner !== npm);
    const txs = [...new Set(viaNpm.map((mint) => mint.txHash))];
    if (txs.some((tx) => tx === undefined)) return give('a Mint log carried no transaction hash');
    const tokenIds = new Set<bigint>();
    if (txs.length > 0) {
      if (budget?.expired()) return give('analysis budget ran out before receipts were read');
      const receipts = await client.callMany(
        txs.map((tx) => ({ method: 'eth_getTransactionReceipt', params: [tx] })),
      );
      const logsByTx = new Map<string, RpcLog[]>();
      for (const [index, tx] of txs.entries()) {
        const receipt = receipts[index]?.result as { logs?: RpcLog[] } | null | undefined;
        if (!receipt?.logs) return give(`receipt for ${tx} unavailable`);
        logsByTx.set(tx as string, receipt.logs);
      }
      for (const mint of viaNpm) {
        const increases = (logsByTx.get(mint.txHash as string) ?? []).filter(
          (log) =>
            log.address?.toLowerCase() === npm &&
            log.topics?.[0]?.toLowerCase() === V3_INCREASE_LIQUIDITY_TOPIC0 &&
            log.topics[1] !== undefined &&
            log.data !== undefined &&
            decodeUint256(log.data, 0) === mint.amount,
        );
        // The NPM emits IncreaseLiquidity right after the pool's Mint.
        const match =
          increases.find((log) => (log.logIndex ? quantityToNumber(log.logIndex) : -1) > mint.logIndex) ?? increases[0];
        if (!match?.topics?.[1]) return give(`no IncreaseLiquidity log matches the Mint in ${mint.txHash}`);
        tokenIds.add(decodeUint256(match.topics[1]));
      }
    }

    // --- 3. Current liquidity and holder per token id ------------------------
    const burnSinks = new Set(EVM_BURN_ADDRESSES);
    const lockers = new Set(EVM_V3_LP_LOCKERS.map((entry) => entry.address));
    let burned = 0n;
    let locked = 0n;
    let total = 0n;
    const ids = [...tokenIds];
    if (ids.length > 0) {
      if (budget?.expired()) return give('analysis budget ran out before positions were read');
      const call = (selector: string, id: bigint) => ({
        method: 'eth_call',
        params: [{ to: npm, data: encodeCall(selector, [{ type: 'uint256', value: id }]) }, 'latest'],
      });
      const reads = await client.callMany(
        ids.flatMap((id) => [call(V3_POSITIONS_SELECTOR, id), call(ERC721_OWNER_OF_SELECTOR, id)]),
      );
      for (const [index, id] of ids.entries()) {
        const position = reads[index * 2];
        const holder = reads[index * 2 + 1];
        // A burned NFT reverts on both: NPM `burn` requires zero liquidity.
        if (position?.error && holder?.error) continue;
        if (typeof position?.result !== 'string' || typeof holder?.result !== 'string') {
          return give(`positions/ownerOf unreadable for token id ${id}`);
        }
        const liquidity = decodeUint256(position.result, 7);
        const owner = decodeAddress(holder.result);
        total += liquidity;
        if (burnSinks.has(owner)) burned += liquidity;
        else if (lockers.has(owner)) locked += liquidity;
      }
    }

    // --- 4. Direct mints: unsecured unless minted to a burn address ----------
    for (const mint of direct) {
      total += mint.amount;
      if (burnSinks.has(mint.owner)) burned += mint.amount;
    }

    if (total === 0n) return give('every traced position has been withdrawn');
    return {
      status: 'measured',
      pairAddress,
      burnedPct: Math.min(100, pctOf(burned, total)),
      lockedPct: Math.min(100, pctOf(locked, total)),
    };
  } catch (error) {
    return give(`trace failed: ${(error as Error).message}`);
  }
}
