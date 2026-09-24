/**
 * Privileged-function detection from deployed bytecode.
 *
 * Reading the dispatch table needs no explorer key and works on unverified
 * contracts, which are exactly the ones worth inspecting. Solidity's
 * dispatcher compares the calldata selector against a `PUSH4 <selector>` per
 * external function, so a linear disassembly that collects every PUSH4
 * immediate recovers the function list.
 *
 * Limits, stated rather than hidden:
 *  - A PUSH4 is also how outbound call selectors are built, so a contract that
 *    *calls* `pause()` elsewhere would match. The table below deliberately
 *    omits selectors a token routinely calls out to (router and pair
 *    functions, e.g. the pair's `mint(address)`), which keeps this rare.
 *  - A name match is not an access-control finding: `mint(address,uint256)`
 *    may be owner-gated, role-gated or disabled. Flags weigh it against
 *    `ownerRenounced`, nothing more.
 *  - A proxy's own code holds the delegate logic, not the token's, so proxies
 *    are reported as not inspected rather than as "none found".
 *
 * Everything here is pure except `readPrivilegedFunctions`, the one RPC call.
 */

import type { PrivilegedFunction } from '@provenance/core';
import { strip0x } from './abi';
import type { RpcClient } from './rpc';

/**
 * Selector → kind. Each selector is the first four bytes of keccak256 of the
 * signature in its comment, computed with @noble/hashes and cross-checked with
 * js-sha3 at authoring time (neither is a dependency); `bytecode.test.ts` pins
 * a few against published values.
 */
export const PRIVILEGED_SELECTORS: Readonly<Record<string, PrivilegedFunction>> = {
  // ---- mint
  '40c10f19': 'mint', // mint(address,uint256)
  a0712d68: 'mint', // mint(uint256)
  '449a52f8': 'mint', // mintTo(address,uint256)

  // ---- blacklist / bot lists / per-account freeze
  f9f92be4: 'blacklist', // blacklist(address)
  '44337ea1': 'blacklist', // addToBlacklist(address)
  '153b0d1e': 'blacklist', // setBlacklist(address,bool)
  '455a4396': 'blacklist', // blacklistAddress(address,bool)
  ffecf516: 'blacklist', // addBot(address)
  d34628cc: 'blacklist', // addBots(address[])
  '9c0db5f3': 'blacklist', // setBots(address[],bool)
  '00b8cf2a': 'blacklist', // blockBots(address[])
  '342aa8b5': 'blacklist', // setBot(address,bool)
  '8d1fdf2f': 'blacklist', // freeze(address)

  // ---- pause
  '8456cb59': 'pause', // pause()
  '16c38b3c': 'pause', // setPaused(bool)

  // ---- fee / tax setters
  '69fe0e2d': 'fee', // setFee(uint256)
  '0b78f9c0': 'fee', // setFees(uint256,uint256)
  c647b20e: 'fee', // setTaxes(uint256,uint256)
  '0cc835a3': 'fee', // setBuyFee(uint256)
  '8b4cee08': 'fee', // setSellFee(uint256)
  '6db79437': 'fee', // updateFees(uint256,uint256)
  '8095d564': 'fee', // updateBuyFees(uint256,uint256,uint256)
  c17b5b8c: 'fee', // updateSellFees(uint256,uint256,uint256)
  '061c82d0': 'fee', // setTaxFeePercent(uint256)

  // ---- max transaction / max wallet
  ec28438a: 'max-tx', // setMaxTxAmount(uint256)
  ea1644d5: 'max-tx', // setMaxWalletSize(uint256)
  d543dbeb: 'max-tx', // setMaxTxPercent(uint256)
  '203e727e': 'max-tx', // updateMaxTxnAmount(uint256)
  c18bc195: 'max-tx', // updateMaxWalletAmount(uint256)
  '5d0044ca': 'max-tx', // setMaxWallet(uint256)
};

/** Mandatory ERC-20 entry points; their absence means this is not the token's logic. */
export const ERC20_CORE_SELECTORS = {
  /** transfer(address,uint256) */
  transfer: 'a9059cbb',
  /** balanceOf(address) */
  balanceOf: '70a08231',
} as const;

/** Output order, so the stored array is stable across runs. */
const KIND_ORDER: readonly PrivilegedFunction[] = ['mint', 'blacklist', 'pause', 'fee', 'max-tx'];

const OP_PUSH1 = 0x60;
const OP_PUSH4 = 0x63;
const OP_PUSH32 = 0x7f;
const OP_DELEGATECALL = 0xf4;

/** Below this there is no room for an ERC-20 dispatcher plus its bodies. */
export const MIN_TOKEN_CODE_BYTES = 64;

// EIP-1167: 10-byte prefix, 20-byte implementation, 15-byte suffix.
const EIP1167_PREFIX = '363d3d373d3d3d363d73';
const EIP1167_SUFFIX = '5af43d82803e903d91602b57fd5bf3';

export function hexToBytes(hex: string): Uint8Array {
  const clean = strip0x(hex.trim());
  if (clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error(`not an even-length hex string: ${hex.slice(0, 24)}…`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** The implementation address when `code` is an EIP-1167 minimal proxy. */
export function minimalProxyTarget(code: string): string | undefined {
  const clean = strip0x(code.trim()).toLowerCase();
  if (clean.length !== 90) return undefined;
  if (!clean.startsWith(EIP1167_PREFIX) || !clean.endsWith(EIP1167_SUFFIX)) return undefined;
  return `0x${clean.slice(EIP1167_PREFIX.length, EIP1167_PREFIX.length + 40)}`;
}

const METADATA_KEYS = ['ipfs', 'bzzr0', 'bzzr1', 'solc', 'vyper'];

/**
 * Length of the body before solc's CBOR metadata trailer. The trailer is data
 * (an IPFS hash among other things), so walking it as code could turn a hash
 * byte of 0x63 into a phantom PUSH4. Solidity writes the CBOR length in the
 * last two bytes; the trailer starts with a CBOR map header (0xa1..0xa5) and
 * names one of the known keys. Requiring the key keeps two arbitrary final
 * bytes of metadata-free code from truncating real instructions.
 */
export function codeBodyLength(bytes: Uint8Array): number {
  const n = bytes.length;
  if (n < 2) return n;
  const trailer = ((bytes[n - 2] ?? 0) << 8) | (bytes[n - 1] ?? 0);
  const start = n - 2 - trailer;
  if (trailer === 0 || start < 0) return n;
  const head = bytes[start] ?? 0;
  if (head < 0xa1 || head > 0xa5) return n;
  const text = String.fromCharCode(...bytes.subarray(start, n - 2));
  return METADATA_KEYS.some((key) => text.includes(key)) ? start : n;
}

export interface Disassembly {
  /** Every PUSH4 immediate, lowercase hex without 0x, in first-seen order. */
  push4: string[];
  hasDelegateCall: boolean;
}

/**
 * Linear sweep. PUSH1..PUSH32 immediates are skipped as a unit, so a data
 * byte that happens to equal 0x63 is never read as an opcode — the classic
 * false positive of a naive `63xxxxxxxx` substring search.
 */
export function disassemble(code: string | Uint8Array): Disassembly {
  const bytes = typeof code === 'string' ? hexToBytes(code) : code;
  const end = codeBodyLength(bytes);
  const seen = new Set<string>();
  const push4: string[] = [];
  let hasDelegateCall = false;

  let pc = 0;
  while (pc < end) {
    const op = bytes[pc] ?? 0;
    if (op >= OP_PUSH1 && op <= OP_PUSH32) {
      const width = op - OP_PUSH1 + 1;
      // A PUSH truncated by the end of code is padded with zeroes by the EVM;
      // it cannot be a real selector comparison, so it is not collected.
      if (op === OP_PUSH4 && pc + 4 < end) {
        let hex = '';
        for (let i = 1; i <= 4; i += 1) hex += (bytes[pc + i] ?? 0).toString(16).padStart(2, '0');
        if (!seen.has(hex)) {
          seen.add(hex);
          push4.push(hex);
        }
      }
      pc += 1 + width;
      continue;
    }
    if (op === OP_DELEGATECALL) hasDelegateCall = true;
    pc += 1;
  }

  return { push4, hasDelegateCall };
}

export interface PrivilegedScan {
  /** Undefined when the code could not honestly be inspected; see `note`. */
  privilegedFunctions?: PrivilegedFunction[];
  /** Matched selectors, for notes and debugging. */
  matches: Array<{ selector: string; kind: PrivilegedFunction }>;
  note?: string;
}

/** Classifies runtime bytecode as returned by `eth_getCode`. */
export function scanPrivilegedFunctions(code: string): PrivilegedScan {
  const clean = strip0x(code.trim()).toLowerCase();
  if (clean.length === 0) {
    return { matches: [], note: 'No contract code at the token address; privileged functions not determined.' };
  }

  const target = minimalProxyTarget(clean);
  if (target) {
    return {
      matches: [],
      note: `Token is an EIP-1167 minimal proxy to ${target}; the implementation was not inspected, so privileged functions are not determined.`,
    };
  }

  if (clean.length / 2 < MIN_TOKEN_CODE_BYTES) {
    return {
      matches: [],
      note: `Token code is only ${clean.length / 2} bytes, too short to be the token logic; privileged functions not determined.`,
    };
  }

  let disassembly: Disassembly;
  try {
    disassembly = disassemble(clean);
  } catch (error) {
    return { matches: [], note: `Token bytecode unreadable: ${(error as Error).message}` };
  }

  const selectors = new Set(disassembly.push4);
  if (!selectors.has(ERC20_CORE_SELECTORS.transfer) || !selectors.has(ERC20_CORE_SELECTORS.balanceOf)) {
    // Reporting "none found" here would be a clean bill of health for code we
    // did not actually read — a proxy's logic lives at another address.
    return {
      matches: [],
      note: disassembly.hasDelegateCall
        ? 'Token code delegates calls and has no ERC-20 dispatch of its own (likely an upgradeable proxy); privileged functions not determined.'
        : 'Token code has no transfer/balanceOf dispatch; privileged functions not determined.',
    };
  }

  const matches: PrivilegedScan['matches'] = [];
  for (const selector of disassembly.push4) {
    const kind = PRIVILEGED_SELECTORS[selector];
    if (kind) matches.push({ selector: `0x${selector}`, kind });
  }
  const kinds = new Set(matches.map((match) => match.kind));
  return { privilegedFunctions: KIND_ORDER.filter((kind) => kinds.has(kind)), matches };
}

/**
 * Fetches the code and classifies it. Never throws: an RPC failure is a note
 * and an undefined result, same as an uninspectable proxy.
 */
export async function readPrivilegedFunctions(client: RpcClient, address: string): Promise<PrivilegedScan> {
  const code = await client.tryCall<string>('eth_getCode', [address, 'latest']);
  if (!code.ok) {
    return { matches: [], note: `Could not read token bytecode: ${code.error.message}` };
  }
  if (typeof code.value !== 'string') {
    return { matches: [], note: 'eth_getCode returned a non-string result; privileged functions not determined.' };
  }
  return scanPrivilegedFunctions(code.value);
}
