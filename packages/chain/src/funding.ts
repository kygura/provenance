/**
 * Early buyers grouped by who funded their wallet.
 *
 * The timing read (`sniping.ts`, 36 s) misses a cabal that buys across several
 * minutes. What ties those wallets together is the first native transfer each
 * one received: one funder fanning out to many buyers. So this takes the first
 * 30 minutes of trading, the largest buyers in it, and their traced funders,
 * and merges wallets that share a funder (directly, or through a chain where a
 * buyer funds another buyer) into clusters.
 *
 * Pure: the funder lookups themselves (native-transfer tracing) happen in the
 * caller. Exchange hot wallets and bridges fund everyone, so the caller marks
 * them as hubs and they never link two wallets.
 */
import type { LaunchFunding, FundingCluster } from '@provenance/core';
import type { PoolTransfer } from './sniping';

/** Seconds of trading counted for funding: the first half hour. */
export const FUNDING_WINDOW_SECONDS = 1800;
/** Buyers traced per token; each costs a funding lookup. */
export const MAX_TRACED_BUYERS = 20;

export interface EarlyBuyer {
  address: string;
  boughtRaw: bigint;
}

export interface FundingInput {
  buyers: readonly EarlyBuyer[];
  /** buyer -> funder. Missing key = not looked up (ignored). Value undefined = looked up, not found. */
  funders: ReadonlyMap<string, string | undefined>;
  /** Funders that serve everyone (exchange hot wallets, bridges): never a cluster edge. */
  isHub?: (address: string) => boolean;
  totalRaw: bigint;
  balances?: ReadonlyMap<string, bigint>;
  windowBlocks: number;
}

export function fundingWindowBlocks(blockSeconds: number): number {
  return Math.max(1, Math.ceil(FUNDING_WINDOW_SECONDS / Math.max(blockSeconds, 0.01)));
}

function pctOf(raw: bigint, total: bigint): number {
  return total > 0n ? Number((raw * 1_000_000n) / total) / 10_000 : 0;
}

/** Largest buyers first; a buy is pool -> non-pool, summed per wallet. */
export function selectEarlyBuyers(input: {
  transfers: readonly PoolTransfer[];
  pools: ReadonlySet<string>;
  tradingStartBlock: number;
  windowBlocks: number;
  isExcluded?: (address: string) => boolean;
  max?: number;
}): EarlyBuyer[] {
  const { pools, tradingStartBlock } = input;
  const last = tradingStartBlock + input.windowBlocks - 1;
  const excluded = input.isExcluded ?? (() => false);
  const bought = new Map<string, bigint>();
  for (const t of input.transfers) {
    if (t.block < tradingStartBlock || t.block > last) continue;
    if (!pools.has(t.from) || pools.has(t.to) || excluded(t.to)) continue;
    bought.set(t.to, (bought.get(t.to) ?? 0n) + t.value);
  }
  return [...bought]
    .map(([address, boughtRaw]) => ({ address, boughtRaw }))
    .sort((a, b) => (a.boughtRaw === b.boughtRaw ? (a.address < b.address ? -1 : 1) : a.boughtRaw > b.boughtRaw ? -1 : 1))
    .slice(0, input.max ?? MAX_TRACED_BUYERS);
}

export function clusterFunding(input: FundingInput): LaunchFunding {
  const { funders, totalRaw } = input;
  const isHub = input.isHub ?? (() => false);
  const looked = input.buyers.filter((b) => funders.has(b.address));
  const traced = looked.filter((b) => funders.get(b.address) !== undefined);

  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let root = a;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(a, root);
    return root;
  };
  for (const b of traced) {
    const f = funders.get(b.address)!;
    if (f === b.address || isHub(f)) continue;
    parent.set(find(b.address), find(f));
  }

  const groups = new Map<string, EarlyBuyer[]>();
  for (const b of looked) {
    const root = find(b.address);
    groups.set(root, [...(groups.get(root) ?? []), b]);
  }

  const clusters: FundingCluster[] = [];
  let clusteredRaw = 0n;
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const votes = new Map<string, number>();
    for (const m of members) {
      const f = funders.get(m.address);
      if (f && f !== m.address && !isHub(f)) votes.set(f, (votes.get(f) ?? 0) + 1);
    }
    const funder = [...votes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
    const raw = members.reduce((s, m) => s + m.boughtRaw, 0n);
    clusteredRaw += raw;
    const cluster: FundingCluster = { funder, wallets: members.length, boughtPct: pctOf(raw, totalRaw) };
    if (input.balances) {
      let held = 0n;
      for (const m of members) {
        const bal = input.balances.get(m.address) ?? 0n;
        if (bal > 0n) held += bal;
      }
      cluster.stillHeldPct = pctOf(held, totalRaw);
    }
    clusters.push(cluster);
  }
  clusters.sort((a, b) => b.boughtPct - a.boughtPct || (a.funder < b.funder ? -1 : 1));

  return {
    windowBlocks: input.windowBlocks,
    traced: traced.length,
    untraced: looked.length - traced.length,
    clusters,
    clusteredPct: pctOf(clusteredRaw, totalRaw),
  };
}
