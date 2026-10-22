/**
 * Known-address table.
 *
 * Every entry here changes how a balance is interpreted, so the table is kept
 * deliberately small and deliberately separate: adding a row is a one-line
 * change, and a wrong row silently launders a real concentration risk into
 * "that's just the pool".
 *
 * Confidence note: these are widely published program IDs and pool authorities,
 * not values fetched at runtime. They were not verifiable against a live RPC in
 * the build sandbox — see the package README notes. Anything uncertain was left
 * out; the analysers fall back to labelling pool addresses from
 * `TokenSnapshot.pairs`, which comes from the market sources and is the
 * authoritative per-token source of LP addresses.
 */

import type { Chain } from '@provenance/core';

/** Label prefixes that remove an address from concentration maths. */
export const EXCLUDED_LABEL_PREFIXES: readonly string[] = [
  'liquidity-pool',
  'burn',
  'protocol:',
  'bonding-curve',
];

export interface KnownAddress {
  address: string;
  label: string;
  /** Why this address holds tokens; shown in notes, not persisted. */
  note?: string;
}

/** True when a label means "not a real holder" for concentration purposes. */
export function labelIsExcluded(label: string | undefined): boolean {
  if (!label) return false;
  return EXCLUDED_LABEL_PREFIXES.some((prefix) => label === prefix || label.startsWith(prefix));
}

// ---------------------------------------------------------------- Solana

/** The SPL incinerator. Tokens sent here are unrecoverable. */
export const SOLANA_INCINERATOR = '1nc1nerator11111111111111111111111111111111';

/**
 * Pool authorities, AMM program IDs and launchpad programs. On Solana a pool's
 * token vault is owned either by a fixed program authority (Raydium AMM v4) or
 * by a pool PDA (Orca Whirlpools, Meteora), so both the token-account address
 * and its resolved owner are checked against this table *and* against the
 * token's own `pairs` list.
 */
export const SOLANA_KNOWN_ADDRESSES: readonly KnownAddress[] = [
  { address: SOLANA_INCINERATOR, label: 'burn', note: 'SPL incinerator' },
  { address: '11111111111111111111111111111111', label: 'burn', note: 'System program / null owner' },

  {
    address: '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
    label: 'protocol:raydium',
    note: 'Raydium AMM v4 pool authority — owns every v4 pool vault',
  },
  { address: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', label: 'protocol:raydium', note: 'Raydium Liquidity Pool v4 program' },
  { address: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', label: 'protocol:raydium', note: 'Raydium CLMM program' },
  { address: 'GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL', label: 'protocol:raydium', note: 'Raydium CPMM pool authority' },

  { address: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', label: 'protocol:orca', note: 'Orca Whirlpools program' },

  { address: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', label: 'protocol:meteora', note: 'Meteora DLMM program' },
  { address: 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', label: 'protocol:meteora', note: 'Meteora dynamic AMM pools program' },
  { address: '24Uqj9JCLxUeoC3hGfh5W3s9FM9uCHDS2SG3LYwBpyTi', label: 'protocol:meteora', note: 'Meteora vault program' },

  {
    address: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
    label: 'bonding-curve',
    note: 'Pump.fun bonding-curve program — pre-migration supply sits here',
  },
  { address: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', label: 'protocol:pumpswap', note: 'PumpSwap AMM program' },

  // Custodial venues. Labelled but NOT excluded: a CEX wallet is a real
  // concentration of float even though it is not one person's bag.
  { address: '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9', label: 'cex:binance' },
  { address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', label: 'cex:binance' },
  { address: 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS', label: 'cex:coinbase' },
  { address: 'GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE', label: 'cex:coinbase' },
];

const SOLANA_INDEX = new Map(SOLANA_KNOWN_ADDRESSES.map((entry) => [entry.address, entry]));

export function lookupSolanaAddress(address: string): KnownAddress | undefined {
  return SOLANA_INDEX.get(address.trim());
}

// ---------------------------------------------------------------- EVM

/** Checked lowercase. `0x…dEaD` is the EIP-55 spelling of the second one. */
export const EVM_BURN_ADDRESSES: readonly string[] = [
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
];

export const EVM_KNOWN_ADDRESSES: readonly KnownAddress[] = [
  { address: '0x0000000000000000000000000000000000000000', label: 'burn', note: 'Null address / mint source' },
  { address: '0x000000000000000000000000000000000000dead', label: 'burn', note: 'Conventional dead address' },
  { address: '0x7a250d5630b4cf539739df2c5dacb4c659f2488d', label: 'protocol:uniswap', note: 'Uniswap V2 router 02' },
  { address: '0xe592427a0aece92de3edee1f18e0157c05861564', label: 'protocol:uniswap', note: 'Uniswap V3 router' },
  { address: '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45', label: 'protocol:uniswap', note: 'Uniswap V3 router 02' },
  { address: '0x000000000004444c5dc75cb358380d2e3de08a90', label: 'protocol:uniswap', note: 'Uniswap V4 PoolManager (holds every v4 pool on Ethereum)' },
  { address: '0x10ed43c718714eb63d5aa57b78b54704e256024e', label: 'protocol:pancakeswap', note: 'PancakeSwap V2 router' },
];

/**
 * LP-token lockers. An LP balance held here counts toward `lpLockedPct`.
 *
 * Kept out of `EVM_KNOWN_ADDRESSES` on purpose: Team Finance also vests team
 * allocations of the token itself, and a vesting balance is real float that
 * unlocks later, so it must not be excluded from holder concentration.
 *
 * Provenance: both addresses are the Ethereum-mainnet deployments carried over
 * from dexscanner's constants, not verified on-chain from this sandbox. They
 * are queried on every EVM chain because an address that is not a locker there
 * simply reports a zero balance; a lock held by a chain-specific locker
 * deployment is missed, which understates `lpLockedPct` — the safe direction.
 */
export const EVM_LP_LOCKERS: readonly KnownAddress[] = [
  { address: '0x663a5c229c09b049e36dcc11a9b0d4a8eb9db214', label: 'locker:unicrypt', note: 'UniCrypt V2 liquidity locker' },
  { address: '0xe2fe530c047f2d85298b07d9333c05737f1435fb', label: 'locker:team-finance', note: 'Team Finance token/LP lock' },
];

/**
 * Uniswap V3 NonfungiblePositionManager per chain. V3 positions minted through
 * it are ERC-721s, so "LP burned/locked" is a question about who owns each NFT.
 * Both verified on-chain: code present and `name()` = "Uniswap V3 Positions NFT-V1".
 * Positions minted through a fork's manager (Sushi, Pancake V3) are counted as
 * unverifiable, i.e. unsecured.
 */
export const UNISWAP_V3_POSITION_MANAGERS: Partial<Record<Chain, string>> = {
  ethereum: '0xc36442b4a4522e871399cd717abdd847ab11fe88',
  base: '0x03a520b32c04bf3beef7beb72e919cf822ed34f1',
};

/**
 * Contracts that hold V3 position NFTs under lock. Team Finance's lock contract
 * (Ethereum; code present, upgradeable proxy) locks NFTs as well as ERC-20 LP.
 * UNCX's V3 locker is left out: the candidate deployments expose no `name()`,
 * so their identity could not be confirmed. A position locked there reads as
 * unsecured, which understates `lpLockedPct` — the safe direction.
 */
export const EVM_V3_LP_LOCKERS: readonly KnownAddress[] = [
  { address: '0xe2fe530c047f2d85298b07d9333c05737f1435fb', label: 'locker:team-finance', note: 'Team Finance lock (holds V3 position NFTs)' },
];

const EVM_INDEX = new Map(EVM_KNOWN_ADDRESSES.map((entry) => [entry.address, entry]));

export function lookupEvmAddress(address: string): KnownAddress | undefined {
  return EVM_INDEX.get(address.trim().toLowerCase());
}

export function isEvmBurnAddress(address: string): boolean {
  return EVM_BURN_ADDRESSES.includes(address.trim().toLowerCase());
}

/** Chain-aware lookup used by both analysers. */
export function lookupAddress(chain: Chain, address: string): KnownAddress | undefined {
  return chain === 'solana' ? lookupSolanaAddress(address) : lookupEvmAddress(address);
}
