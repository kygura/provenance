import { describe, expect, test } from 'bun:test';
import { type TokenSnapshot, selectByChain } from './market';

function snap(chain: string, symbol: string): TokenSnapshot {
  return { tokenId: `${chain}:${symbol}`, chain, symbol } as unknown as TokenSnapshot;
}

describe('selectByChain', () => {
  const triaged = [
    snap('solana', 'S1'),
    snap('solana', 'S2'),
    snap('solana', 'S3'),
    snap('solana', 'S4'),
    snap('ethereum', 'E1'),
    snap('ethereum', 'E2'),
  ];
  const symbols = (xs: TokenSnapshot[]) => xs.map((x) => x.symbol);

  test('a chain sorted below the cap still gets its share', () => {
    expect(symbols(selectByChain(triaged, 4))).toEqual(['S1', 'E1', 'S2', 'E2']);
  });

  test('a short chain leaves its slots to the rest', () => {
    expect(symbols(selectByChain(triaged, 5))).toEqual(['S1', 'E1', 'S2', 'E2', 'S3']);
    expect(selectByChain(triaged, 99)).toHaveLength(6);
  });

  test('priority chains go first and win a cut mid-round', () => {
    expect(symbols(selectByChain(triaged, 3, ['ethereum', 'solana']))).toEqual(['E1', 'S1', 'E2']);
    expect(symbols(selectByChain(triaged, 1, ['ethereum']))).toEqual(['E1']);
  });

  test('order within a chain is kept; zero cap selects nothing', () => {
    expect(symbols(selectByChain(triaged, 1))).toEqual(['S1']);
    expect(selectByChain(triaged, 0)).toEqual([]);
  });
});
