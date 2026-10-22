/**
 * Early-block buying, from the pool's own Transfer logs.
 *
 * A sniped launch looks clean to every other check: the snipers bought in the
 * first block or two, across many fresh wallets, so no holder is large and the
 * top-10 share is unremarkable. What gives it away is timing. So this counts
 * what the pool sent out in the first few blocks of trading, and how much of
 * it those wallets still hold.
 *
 * Trading start is the first block the pool sends tokens OUT, not the block
 * liquidity went in: deployers often fund the pool and enable trading later,
 * and the snipe lands on the enable block.
 *
 * Wallet funding clusters (many buyers funded from one source in the same
 * block) need native-transfer tracing, which plain `eth_getLogs` cannot give.
 * Not attempted here.
 */
import type { LaunchSniping } from '@provenance/core';

/** Seconds of trading counted as "early": three Ethereum blocks. */
export const SNIPE_WINDOW_SECONDS = 36;

/**
 * A wallet fed this share of its total inbound tokens by the tracked set joins
 * it. Not 100%: a forward wallet that also bought a crumb from the pool to look
 * organic still counts.
 */
export const FORWARD_INBOUND_SHARE = 0.9;

/** Hops from an early buyer that tokens are followed. */
export const MAX_FORWARD_HOPS = 3;

export interface PoolTransfer {
  block: number;
  from: string;
  to: string;
  value: bigint;
}

export interface SnipingInput {
  /** Every Transfer of this token with a pool on either side, any order. */
  transfers: readonly PoolTransfer[];
  /** Lowercase pool addresses. */
  pools: ReadonlySet<string>;
  totalRaw: bigint;
  /** Reconstructed balances, when the scan covered the token's whole life. */
  balances?: ReadonlyMap<string, bigint>;
  /**
   * Every Transfer of this token in the scan. With `balances`, early buyers'
   * tokens are followed into wallets they fed, so moving them to a fresh wallet
   * does not look like a sale.
   */
  walletTransfers?: readonly PoolTransfer[];
  blockSeconds: number;
  /** Recipients that are not buyers: burn, routers, protocol contracts. */
  isExcluded?: (address: string) => boolean;
  /**
   * Contracts are never followed into: a second pool, a deposit or vesting
   * contract is not a wallet the buyer still holds through. Unset means no check.
   */
  isContract?: (address: string) => boolean;
}

export function snipeWindowBlocks(blockSeconds: number): number {
  return Math.max(1, Math.ceil(SNIPE_WINDOW_SECONDS / Math.max(blockSeconds, 0.01)));
}

function pctOf(raw: bigint, total: bigint): number {
  return total > 0n ? Number((raw * 1_000_000n) / total) / 10_000 : 0;
}

/**
 * Undefined when the logs cannot show the start of trading: no buy at all, or
 * a buy before any liquidity went in, which means the scan began mid-life.
 */
export function measureSniping(input: SnipingInput): LaunchSniping | undefined {
  return analyse(input, input.isContract ?? (() => false))?.sniping;
}

/**
 * Wallets `measureSniping` could follow into, ignoring `isContract`: a superset
 * of what it will follow, so callers can code-check just these.
 */
export function forwardCandidates(input: SnipingInput): string[] {
  return analyse(input, () => false)?.forwarded ?? [];
}

function analyse(
  input: SnipingInput,
  isContract: (address: string) => boolean,
): { sniping: LaunchSniping; forwarded: string[] } | undefined {
  const { pools, totalRaw } = input;
  if (totalRaw <= 0n || pools.size === 0) return undefined;
  const excluded = input.isExcluded ?? (() => false);

  let firstFunding = Number.POSITIVE_INFINITY;
  let tradingStart = Number.POSITIVE_INFINITY;
  for (const t of input.transfers) {
    if (pools.has(t.to) && !pools.has(t.from)) firstFunding = Math.min(firstFunding, t.block);
    if (pools.has(t.from) && !pools.has(t.to)) tradingStart = Math.min(tradingStart, t.block);
  }
  if (!Number.isFinite(tradingStart) || !(firstFunding <= tradingStart)) return undefined;

  const windowBlocks = snipeWindowBlocks(input.blockSeconds);
  const last = tradingStart + windowBlocks - 1;
  const bought = new Map<string, bigint>();
  const sameBlock = new Set<string>();
  for (const t of input.transfers) {
    if (t.block < tradingStart || t.block > last) continue;
    if (!pools.has(t.from) || pools.has(t.to) || excluded(t.to)) continue;
    bought.set(t.to, (bought.get(t.to) ?? 0n) + t.value);
    if (t.block === tradingStart) sameBlock.add(t.to);
  }

  const boughtRaw = [...bought.values()].reduce((sum, v) => sum + v, 0n);
  const sniping: LaunchSniping = {
    tradingStartBlock: tradingStart,
    windowBlocks,
    earlyBuyers: bought.size,
    sameBlockBuyers: sameBlock.size,
    earlyBuyPct: pctOf(boughtRaw, totalRaw),
  };
  let forwarded: ReadonlySet<string> = new Set();
  if (input.balances) {
    const tracked = new Set(bought.keys());
    forwarded = tracked;
    if (input.walletTransfers) {
      const inbound = new Map<string, bigint>();
      for (const t of input.walletTransfers) inbound.set(t.to, (inbound.get(t.to) ?? 0n) + t.value);
      const share = BigInt(Math.round(FORWARD_INBOUND_SHARE * 100));
      for (let hop = 0, grew = true; grew && hop < MAX_FORWARD_HOPS; hop++) {
        grew = false;
        const fed = new Map<string, bigint>();
        for (const t of input.walletTransfers) {
          if (!tracked.has(t.from) || tracked.has(t.to) || pools.has(t.to) || excluded(t.to) || isContract(t.to)) continue;
          fed.set(t.to, (fed.get(t.to) ?? 0n) + t.value);
        }
        for (const [wallet, fromTracked] of fed) {
          const total = inbound.get(wallet) ?? 0n;
          if (fromTracked > 0n && fromTracked * 100n >= total * share) {
            tracked.add(wallet);
            grew = true;
          }
        }
      }
      sniping.forwardedWallets = tracked.size - bought.size;
    }
    let held = 0n;
    for (const w of tracked) {
      const balance = input.balances.get(w) ?? 0n;
      if (balance > 0n) held += balance;
    }
    sniping.stillHeldPct = pctOf(held, totalRaw);
  }
  return { sniping, forwarded: [...forwarded].filter((w) => !bought.has(w)) };
}
