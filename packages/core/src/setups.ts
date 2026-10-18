/**
 * The brief routine's setups ledger: conditional watch plans for a human,
 * written by `cli.ts brief`. Levels are market caps, the natural unit for
 * memecoins. No size, no orders: a setup is a claim the next brief grades.
 *
 * - watching:    proposed, market cap not yet inside the entry zone
 * - triggered:   market cap was observed inside the entry zone
 * - invalidated: observed below the invalidation level, or a kill condition held
 * - target_hit:  triggered, then observed at or above the first target
 * - expired:     past `expiresAt` while still watching or triggered
 * - cancelled:   withdrawn by a later brief, with a reason
 */
export type SetupStatus = 'watching' | 'triggered' | 'invalidated' | 'target_hit' | 'expired' | 'cancelled';

export const SETUP_STATUSES: readonly SetupStatus[] = [
  'watching',
  'triggered',
  'invalidated',
  'target_hit',
  'expired',
  'cancelled',
];

/** Statuses a later brief still updates. */
export const OPEN_SETUP_STATUSES: readonly SetupStatus[] = ['watching', 'triggered'];

export type SetupConviction = 'low' | 'medium' | 'high';

/** Kill thresholds captured when the setup was created, so a later config change cannot move them. */
export interface SetupKill {
  /** Liquidity when the setup was written; the kill fires below `liquidityKillRatio` of it. */
  liquidityUsdAtCreation?: number;
  liquidityKillRatio: number;
  maxTop10Pct: number;
  maxSingleHolderPct: number;
}

export interface Setup {
  /** `${symbol}-${YYYYMMDD}-${n}` */
  id: string;
  tokenId: string;
  chain: string;
  address: string;
  symbol: string;
  thesis: string;
  trigger: string;
  conviction: SetupConviction;
  /** Meme and BTC regime at creation. */
  regime: Record<string, unknown>;
  entryMcapLow: number;
  entryMcapHigh: number;
  invalidationMcap: number;
  /** Market caps, ascending. */
  targets: number[];
  kill: SetupKill;
  status: SetupStatus;
  statusNote?: string;
  /** R multiple once resolved: −1 on invalidation after trigger, target R on a hit. */
  rResult?: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}
