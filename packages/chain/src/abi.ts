/**
 * Minimal hand-rolled ABI codec.
 *
 * Provenance deliberately has no ethers/viem dependency: the EVM analyser only
 * ever calls four zero/one-argument view functions and decodes single-word
 * returns, which is a few dozen lines of hex arithmetic. Pulling in a 2 MB
 * wallet library for that would be the tail wagging the dog.
 *
 * Everything raw is a `bigint`. Floats appear only at the display boundary
 * (`formatUnits`, `shareOf`), because an 18-decimal token with a 10^12 supply
 * has a raw amount around 10^30 and silently loses ~14 significant digits the
 * moment it touches a double.
 */

export class AbiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AbiError';
  }
}

/**
 * Function selectors, i.e. the first four bytes of keccak256 of the canonical
 * signature. Hard-coded rather than computed so the package does not need a
 * keccak implementation; the signature each one came from is in the comment and
 * asserted in `abi.test.ts` against the published ERC-20 values.
 */
export const SELECTORS = {
  /** totalSupply() */
  totalSupply: '0x18160ddd',
  /** decimals() */
  decimals: '0x313ce567',
  /** owner() — Ownable, not part of ERC-20; absent contracts revert. */
  owner: '0x8da5cb5b',
  /** balanceOf(address) */
  balanceOf: '0x70a08231',
  /** symbol() */
  symbol: '0x95d89b41',
} as const;

/** keccak256("Transfer(address,address,uint256)") — ERC-20 and ERC-721 share it. */
export const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** The canonical "dead" sink. Compared case-insensitively; EIP-55 form is 0x…dEaD. */
export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';

export const BURN_ADDRESSES: readonly string[] = [ZERO_ADDRESS, DEAD_ADDRESS];

const HEX_ADDRESS = /^0x[0-9a-f]{40}$/;

export function strip0x(hex: string): string {
  return hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex;
}

export function isAddress(value: string): boolean {
  return HEX_ADDRESS.test(value.toLowerCase());
}

/** Lower-cases and validates. Addresses are compared as lowercase everywhere. */
export function normalizeAddress(value: string): string {
  const lower = value.trim().toLowerCase();
  if (!HEX_ADDRESS.test(lower)) throw new AbiError(`not a 20-byte address: ${value}`);
  return lower;
}

export function isZeroAddress(value: string): boolean {
  return value.trim().toLowerCase() === ZERO_ADDRESS;
}

export function isBurnAddress(value: string): boolean {
  const lower = value.trim().toLowerCase();
  return BURN_ADDRESSES.includes(lower);
}

// ---------------------------------------------------------------- encoding

/** Left-pads a hex body (no 0x) to one 32-byte ABI word. */
export function padWord(body: string): string {
  const clean = strip0x(body).toLowerCase();
  if (clean.length > 64) throw new AbiError(`value wider than one word: 0x${clean}`);
  return clean.padStart(64, '0');
}

export function encodeAddressArg(address: string): string {
  return padWord(strip0x(normalizeAddress(address)));
}

export function encodeUint256Arg(value: bigint): string {
  if (value < 0n) throw new AbiError(`uint256 cannot be negative: ${value}`);
  return padWord(value.toString(16));
}

export type AbiArg = { type: 'address'; value: string } | { type: 'uint256'; value: bigint };

/** selector + one word per argument. Only static types, which is all we need. */
export function encodeCall(selector: string, args: readonly AbiArg[] = []): string {
  const sel = strip0x(selector).toLowerCase();
  if (sel.length !== 8) throw new AbiError(`selector must be 4 bytes: ${selector}`);
  const body = args
    .map((arg) => (arg.type === 'address' ? encodeAddressArg(arg.value) : encodeUint256Arg(arg.value)))
    .join('');
  return `0x${sel}${body}`;
}

export function encodeBalanceOf(address: string): string {
  return encodeCall(SELECTORS.balanceOf, [{ type: 'address', value: address }]);
}

// ---------------------------------------------------------------- decoding

/** The `index`-th 32-byte word of a return payload, as a 64-char hex body. */
export function wordAt(data: string, index = 0): string {
  const clean = strip0x(data).toLowerCase();
  const start = index * 64;
  if (clean.length < start + 64) {
    throw new AbiError(`return data too short for word ${index}: 0x${clean || '<empty>'}`);
  }
  return clean.slice(start, start + 64);
}

export function decodeUint256(data: string, index = 0): bigint {
  return BigInt(`0x${wordAt(data, index)}`);
}

/**
 * ERC-20 `decimals()` is uint8, but plenty of contracts return a full uint256
 * word and a few return uint256 values far outside a sane range. Anything above
 * 36 is treated as corrupt rather than silently producing a 10^255 divisor.
 */
export function decodeUint8(data: string, index = 0): number {
  const value = decodeUint256(data, index);
  if (value > 36n) throw new AbiError(`implausible decimals value: ${value}`);
  return Number(value);
}

export function decodeAddress(data: string, index = 0): string {
  const word = wordAt(data, index);
  if (/[^0]/.test(word.slice(0, 24))) throw new AbiError(`word ${index} is not an address: 0x${word}`);
  return `0x${word.slice(24)}`;
}

export function decodeBool(data: string, index = 0): boolean {
  return decodeUint256(data, index) !== 0n;
}

/** An indexed address topic is the address right-aligned in a 32-byte word. */
export function topicToAddress(topic: string): string {
  return decodeAddress(topic, 0);
}

// ---------------------------------------------------------------- quantities

/** JSON-RPC "quantity": minimal-length hex, no leading zeroes, `0x0` for zero. */
export function toQuantity(value: number | bigint): string {
  const big = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
  if (big < 0n) throw new AbiError(`quantity cannot be negative: ${value}`);
  return `0x${big.toString(16)}`;
}

export function quantityToBigInt(hex: string): bigint {
  const clean = strip0x(String(hex)).toLowerCase();
  if (clean.length === 0 || /[^0-9a-f]/.test(clean)) throw new AbiError(`not a hex quantity: ${hex}`);
  return BigInt(`0x${clean}`);
}

export function quantityToNumber(hex: string): number {
  const value = quantityToBigInt(hex);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AbiError(`quantity exceeds safe integer range: ${hex}`);
  }
  return Number(value);
}

// ---------------------------------------------------------------- scaling

/**
 * Raw base units → a display float, keeping the integer part exact for any
 * amount below 2^53 whole tokens. `Number(raw) / 10 ** decimals` would lose the
 * low digits of the integer part first, which is the part anyone actually reads.
 */
export function formatUnits(raw: bigint, decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new AbiError(`unsupported decimals: ${decimals}`);
  }
  if (decimals === 0) return Number(raw);
  const base = 10n ** BigInt(decimals);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const value = Number(abs / base) + Number(abs % base) / Number(base);
  return negative ? -value : value;
}

/** Exact decimal string for the raw amount — no float anywhere in the path. */
export function formatUnitsExact(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toString();
  const base = 10n ** BigInt(decimals);
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const frac = (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${abs / base}${frac ? `.${frac}` : ''}`;
}

const SHARE_SCALE = 1_000_000_000_000n; // 1e12 — 12 exact digits, well inside a double

/**
 * `part / total` as a 0..1 float, computed in bigint so a 10^30 numerator does
 * not round before the division. Truncates at 1e-12, i.e. it can understate by
 * at most a hundred-millionth of a percent.
 */
export function shareOf(part: bigint, total: bigint): number {
  if (total === 0n) return 0;
  return Number((part * SHARE_SCALE) / total) / Number(SHARE_SCALE);
}

/** `shareOf` expressed as a 0..100 percentage, matching the repo convention. */
export function pctOf(part: bigint, total: bigint): number {
  return shareOf(part, total) * 100;
}

export function sumBigInt(values: Iterable<bigint>): bigint {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}
