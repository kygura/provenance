import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type AppConfig, type SourceConfig, loadConfig, silentLogger } from '@provenance/core';

import { DexToolsSource } from './dextools';
import { extractDexToolsRaw, extractPairLinks } from './dextools-raw';

const capturedAt = '2026-10-09T12:00:00.000Z';
const xhr = readFileSync(join(import.meta.dir, '../../../fixtures/dextools/hot-pairs-xhr.json'), 'utf8');

const PAIR_A = '0x1111111111111111111111111111111111111111';
const PAIR_B = '0x2222222222222222222222222222222222222222';
const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SOL_PAIR = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

/** A shell page: no table, no state, just the links the app prints. */
const shell = `<html><body><app-root>
  <a href="/app/en/ether/pair-explorer/${PAIR_A}">A</a>
  <a href="/app/en/ether/pair-explorer/${PAIR_A}?t=1">A again</a>
  <a href="https://www.dextools.io/app/en/ether/pair-explorer/${PAIR_B}">B</a>
</app-root></body></html>`;

describe('extractDexToolsRaw', () => {
  test('a JSON body is parsed as rows', () => {
    const found = extractDexToolsRaw(xhr, { capturedAt });
    expect(found.entries.length).toBeGreaterThan(0);
    expect(found.entries[0]?.symbol).toBe('BONGO');
    expect(found.pairs).toEqual([]);
  });

  test('rows embedded as Angular transfer state are found', () => {
    const escaped = xhr.replace(/"/g, '&q;');
    const page = `<html><script id="serverApp-state" type="application/json">${escaped}</script></html>`;
    expect(extractDexToolsRaw(page, { capturedAt }).entries[0]?.symbol).toBe('BONGO');
  });

  test('a shell page falls back to pair links, deduped, in page order', () => {
    const found = extractDexToolsRaw(shell, { capturedAt });
    expect(found.entries).toEqual([]);
    expect(found.pairs).toEqual([
      { chain: 'ethereum', pairAddress: PAIR_A, rank: 1 },
      { chain: 'ethereum', pairAddress: PAIR_B, rank: 2 },
    ]);
  });

  test('JSON-escaped links and Solana addresses are read', () => {
    const body = `{"href":"\\/app\\/en\\/solana\\/pair-explorer\\/${SOL_PAIR}"}`;
    expect(extractPairLinks(body)).toEqual([{ chain: 'solana', pairAddress: SOL_PAIR, rank: 1 }]);
  });
});

describe('DexToolsSource raw lane', () => {
  let server: ReturnType<typeof Bun.serve>;
  const requests: string[] = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push(url.pathname + url.search);
        if (url.pathname === '/app/en/ether/hot-pairs') return new Response(shell, { headers: { 'content-type': 'text/html' } });
        if (url.pathname === `/latest/dex/pairs/ethereum/${PAIR_A},${PAIR_B}`) {
          return Response.json({
            pairs: [
              {
                chainId: 'ethereum',
                pairAddress: PAIR_A,
                baseToken: { address: TOKEN_A, symbol: 'AAA', name: 'Token A' },
                quoteToken: { symbol: 'WETH' },
                liquidity: { usd: 90_000 },
                volume: { h24: 250_000 },
              },
            ],
          });
        }
        return new Response('blocked', { status: 403 });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  function dextoolsConfig(app: AppConfig): SourceConfig {
    return { ...app.pipeline.sources.find((source) => source.id === 'dextools')!, rateLimitMs: 0 };
  }

  test('pair links from a plain GET are resolved to tokens without a browser', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const app = loadConfig({ PROVENANCE_CHAINS: 'ethereum' });
    const source = new DexToolsSource(dextoolsConfig(app), {
      baseUrl: base,
      dexscreenerBaseUrl: base,
      browser: false,
    });
    const entries = await source.fetchTrending({ config: dextoolsConfig(app), app, logger: silentLogger });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: 'dextools',
      chain: 'ethereum',
      tokenAddress: TOKEN_A,
      pairAddress: PAIR_A,
      symbol: 'AAA',
      rank: 1,
    });
    expect(entries[0]?.metrics.liquidityUsd).toBe(90_000);
    // The page answered, so the JSON endpoint was never needed.
    expect(requests.some((path) => path.startsWith('/shared/'))).toBe(false);
    expect(source.drainErrors()).toEqual([]);
  });

  test('when every raw URL is refused the errors are kept', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const app = loadConfig({ PROVENANCE_CHAINS: 'base' });
    const source = new DexToolsSource(dextoolsConfig(app), { baseUrl: base, dexscreenerBaseUrl: base, browser: false });
    const entries = await source.fetchTrending({ config: dextoolsConfig(app), app, logger: silentLogger });

    expect(entries).toEqual([]);
    const errors = source.drainErrors();
    expect(errors).toHaveLength(2);
    expect(errors[0]?.source).toBe('dextools:raw:base');
    expect(errors[0]?.error).toContain('403');
  });
});
