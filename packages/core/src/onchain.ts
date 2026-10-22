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

/**
 * Who bought in the first blocks of trading. Snipers and bundlers take supply
 * before anyone outside the launch can see the pool, then spread it across
 * fresh wallets so no single holder looks large — which is exactly what a
 * top-10 ceiling misses. Measured from the pool's own Transfer logs.
 */
export interface LaunchSniping {
  /** First block in which the pool sent tokens out: trading opened. */
  tradingStartBlock: number;
  /** Blocks counted as "early", trading-start block included. */
  windowBlocks: number;
  /** Distinct wallets that bought in the window. */
  earlyBuyers: number;
  /** Of those, wallets that bought in the trading-start block itself. */
  sameBlockBuyers: number;
  /** Share of total supply bought in the window, percent. */
  earlyBuyPct: number;
  /** Share of total supply the early buyers, and wallets they fed, still hold, percent. */
  stillHeldPct?: number;
  /** Extra wallets counted in `stillHeldPct`: fed by the early buyers. Set when forwards were followed. */
  forwardedWallets?: number;
}

/**
 * Wallets that bought early and trace back to one funding source. A cabal
 * that buys over several minutes, or across many blocks, slips past the
 * timing read in `LaunchSniping`, but each wallet still had to be funded with
 * gas from somewhere, and fresh wallets are usually funded from one place.
 */
export interface FundingCluster {
  /** The shared funder: the address that sent each wallet its first native funds. */
  funder: string;
  /** Early buyers in this cluster. */
  wallets: number;
  /** Share of total supply these wallets bought in the window, percent. */
  boughtPct: number;
  /** Share of total supply they still hold, percent. */
  stillHeldPct?: number;
}

export interface LaunchFunding {
  /** Blocks counted from trading start, trading-start block included. */
  windowBlocks: number;
  /** Early buyers whose first funding was found. */
  traced: number;
  /** Early buyers looked up whose funding could not be read. */
  untraced: number;
  /** Clusters of 2+ buyers sharing a funder, largest `boughtPct` first. Hubs excluded. */
  clusters: FundingCluster[];
  /** Sum of `boughtPct` over `clusters`, percent. */
  clusteredPct: number;
}

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
  /** EVM: early-block buying, when the scan reached the start of trading. */
  sniping?: LaunchSniping;
  /** EVM: early buyers grouped by funding source. Needs `ETHERSCAN_API_KEY`. */
  funding?: LaunchFunding;
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
