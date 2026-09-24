import type { Chain } from './chains';

export type RiskSeverity = 'info' | 'warn' | 'critical';

export interface RiskFlag {
  code: string;
  severity: RiskSeverity;
  detail: string;
}

export interface HolderRow {
  address: string;
  balance: number;
  pct: number;
  /** e.g. "liquidity-pool", "burn", "creator", "cex:binance", "bonding-curve". */
  label?: string;
  /** Excluded from concentration maths when true (LP, burn address, etc.). */
  excludedFromConcentration?: boolean;
}

export interface TokenSupply {
  total: number;
  circulating?: number;
  decimals: number;
  burnedPct?: number;
}

/**
 * Privileged entry points found in the deployed bytecode's dispatch table.
 * Read from the code itself, so it works on unverified contracts; whether the
 * function is still callable depends on who owns the contract.
 */
export type PrivilegedFunction = 'mint' | 'blacklist' | 'pause' | 'fee' | 'max-tx';

export type AnalysisMethod = 'rpc' | 'explorer' | 'indexer' | 'partial' | 'unavailable';

/**
 * Holder distribution and token economics, gathered from free RPC endpoints and
 * public explorer pages. Missing fields mean "not determined", never "zero".
 */
export interface ChainAnalysis {
  tokenId: string;
  chain: Chain;
  tokenAddress: string;
  method: AnalysisMethod;
  supply?: TokenSupply;
  holderCount?: number;
  /** Concentration after excluding LP/burn/known-protocol addresses. */
  top10Pct?: number;
  top20Pct?: number;
  top50Pct?: number;
  /**
   * Largest single non-excluded holder as a share of that same ex-LP basis,
   * clamped to 100.
   *
   * On the contract, not derived per consumer: `HolderRow.pct` is a share of
   * TOTAL supply and is not clamped — EVM balances reconstructed from a bounded
   * window of Transfer logs can overshoot supply when the window misses the
   * offsetting burns. Anything reading the largest holder must read this.
   */
  largestHolderPct?: number;
  /** Herfindahl-Hirschman index over holder shares, 0..1. Higher = tighter. */
  herfindahl?: number;
  /** Gini coefficient over the sampled holder set, 0..1. */
  gini?: number;
  creatorAddress?: string;
  creatorHoldingPct?: number;
  lpBurnedPct?: number;
  lpLockedPct?: number;
  /** Solana: mint authority still able to inflate supply. */
  mintAuthorityActive?: boolean;
  /** Solana: freeze authority still able to lock holder accounts. */
  freezeAuthorityActive?: boolean;
  /** EVM: ownership renounced on the token contract. */
  ownerRenounced?: boolean;
  /** EVM: contract source verified on the public explorer. */
  contractVerified?: boolean;
  /**
   * EVM: privileged functions present in the bytecode. An empty array means
   * the code was read and none were found; undefined means it was not read.
   */
  privilegedFunctions?: PrivilegedFunction[];
  /** Buy/sell tax in percent where detectable. */
  buyTaxPct?: number;
  sellTaxPct?: number;
  topHolders: HolderRow[];
  flags: RiskFlag[];
  /** Human-readable notes about what could not be determined and why. */
  notes: string[];
  fetchedAt: string;
  /** Wall-clock cost of the analysis, for budget tuning. */
  durationMs?: number;
}
