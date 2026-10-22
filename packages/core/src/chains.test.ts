import { describe, expect, test } from 'bun:test';

import { type Chain, isTokenAddress } from './chains';

describe('isTokenAddress', () => {
  const cases: [Chain, string, boolean][] = [
    // EVM: 0x + 40 hex
    ['ethereum', '0x' + 'a'.repeat(40), true],
    ['base', '0x7a2b19cd4e5f60781b9c3ad2e4f5061728394ab0', true],
    ['bsc', '  0x7a2b19cd4e5f60781b9c3ad2e4f5061728394ab0  ', true],
    ['arbitrum', '0x7', false],
    ['polygon', '0x' + 'a'.repeat(39), false],
    ['avalanche', '0x' + 'g'.repeat(40), false],
    ['blast', 'So11111111111111111111111111111111111111112', false],
    // Solana: base58, 32-44 chars
    ['solana', 'So11111111111111111111111111111111111111112', true],
    ['solana', 'BonG9kRThz5vQ1pXmY7wLd3cJf8sNqA4eV6uZtP1rKx', true],
    ['solana', 'short', false],
    ['solana', 'O'.repeat(40), false], // 'O' is not in base58
    ['solana', '0x' + 'a'.repeat(40), false],
    // Sui coin type
    ['sui', '0x2::sui::SUI', true],
    ['sui', '0x' + 'ab'.repeat(32) + '::coin::COIN', true],
    ['sui', '0x2::sui', false],
    ['sui', '0x2', false],
    ['sui', '0x' + 'a'.repeat(65) + '::coin::COIN', false],
    // TON: user-friendly (48 chars) or raw workchain:hex
    ['ton', 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', true],
    ['ton', '0:' + 'a'.repeat(64), true],
    ['ton', '-1:' + 'F'.repeat(64), true],
    ['ton', 'short', false],
    ['ton', '0:' + 'a'.repeat(63), false],
    // Hyperliquid: 0x + 32 or 40 hex
    ['hyperliquid', '0x' + 'a'.repeat(32), true],
    ['hyperliquid', '0x' + 'a'.repeat(40), true],
    ['hyperliquid', '0x' + 'a'.repeat(36), false],
    ['hyperliquid', '0x7', false],
    // Unknown chain never validates
    ['unknown', '0x' + 'a'.repeat(40), false],
    ['unknown', '0x7', false],
    ['unknown', 'So11111111111111111111111111111111111111112', false],
  ];

  test.each(cases)('%s %s -> %p', (chain, address, expected) => {
    expect(isTokenAddress(chain, address)).toBe(expected);
  });

  test('unknown:0x7 style ids are rejected', () => {
    expect(isTokenAddress('unknown', '0x7')).toBe(false);
    expect(isTokenAddress('unknown', '0xe')).toBe(false);
  });
});
