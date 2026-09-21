/** Chains Provenance knows how to discover and analyse. */
export const CHAINS = [
  'solana',
  'ethereum',
  'base',
  'bsc',
  'arbitrum',
  'polygon',
  'avalanche',
  'sui',
  'ton',
  'blast',
  'hyperliquid',
  'unknown',
] as const;

export type Chain = (typeof CHAINS)[number];

export function isChain(value: string): value is Chain {
  return (CHAINS as readonly string[]).includes(value);
}

/** Chains that speak the EVM JSON-RPC dialect. */
export const EVM_CHAINS: readonly Chain[] = [
  'ethereum',
  'base',
  'bsc',
  'arbitrum',
  'polygon',
  'avalanche',
  'blast',
];

export function isEvm(chain: Chain): boolean {
  return EVM_CHAINS.includes(chain);
}

/**
 * Slug translation between our canonical chain names and the identifiers each
 * upstream source uses. Sources add rows here rather than inventing their own map.
 */
export const CHAIN_ALIASES: Record<string, Chain> = {
  sol: 'solana',
  solana: 'solana',
  eth: 'ethereum',
  ether: 'ethereum',
  ethereum: 'ethereum',
  base: 'base',
  bsc: 'bsc',
  bnb: 'bsc',
  'binance-smart-chain': 'bsc',
  arbitrum: 'arbitrum',
  arbitrum_one: 'arbitrum',
  arb: 'arbitrum',
  polygon: 'polygon',
  polygon_pos: 'polygon',
  matic: 'polygon',
  avalanche: 'avalanche',
  avax: 'avalanche',
  sui: 'sui',
  'sui-network': 'sui',
  ton: 'ton',
  blast: 'blast',
  hyperliquid: 'hyperliquid',
};

export function normalizeChain(raw: string | null | undefined): Chain {
  if (!raw) return 'unknown';
  const key = raw.trim().toLowerCase();
  return CHAIN_ALIASES[key] ?? (isChain(key) ? key : 'unknown');
}

/** Canonical token id used as the primary key everywhere: `chain:address`. */
export function tokenId(chain: Chain, address: string): string {
  return `${chain}:${isEvm(chain) ? address.toLowerCase() : address}`;
}

export function parseTokenId(id: string): { chain: Chain; address: string } {
  const idx = id.indexOf(':');
  if (idx === -1) return { chain: 'unknown', address: id };
  return {
    chain: normalizeChain(id.slice(0, idx)),
    address: id.slice(idx + 1),
  };
}
