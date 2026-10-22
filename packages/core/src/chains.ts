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

/**
 * Whether `address` is a well-formed token address for `chain`. Malformed ids from
 * scraped links (e.g. `unknown:0x7`) reached the store, so every ingest path checks this.
 */
const TON_FRIENDLY = /^[A-Za-z0-9_-]{48}$/;
const TON_RAW = /^-?\d+:[0-9a-fA-F]{64}$/;
const SUI_COIN_TYPE = /^0x[0-9a-fA-F]{1,64}::\w+::\w+$/;
const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HYPERLIQUID_TOKEN = /^0x[0-9a-fA-F]{32}$|^0x[0-9a-fA-F]{40}$/;

export function isTokenAddress(chain: Chain, address: string): boolean {
  const value = address.trim();
  if (isEvm(chain)) return EVM_ADDRESS.test(value);
  switch (chain) {
    case 'solana':
      return SOLANA_MINT.test(value);
    case 'sui':
      return SUI_COIN_TYPE.test(value);
    case 'ton':
      return TON_FRIENDLY.test(value) || TON_RAW.test(value);
    case 'hyperliquid':
      return HYPERLIQUID_TOKEN.test(value);
    default:
      return false;
  }
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
