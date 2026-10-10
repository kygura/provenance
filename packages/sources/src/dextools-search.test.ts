import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { type AppConfig, type SourceConfig, loadConfig, silentLogger } from '@provenance/core';

import { DexToolsSource } from './dextools';
import { extractPairLinks } from './dextools-search';

const PAIR_A = '0x1111111111111111111111111111111111111111';
const PAIR_B = '0x2222222222222222222222222222222222222222';
const PAIR_BASE = '0x3333333333333333333333333333333333333333';
const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SOL_MINT = '9ZtbETDNjnST9Y2zs82FZYy49xUMPgqXRh46YjjRpump';
const SOL_PAIR = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

/** Links wrapped in a redirect with the target percent-encoded, as search pages serve them. */
const redirectPage = `<html><body>
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.dextools.io%2Fapp%2Fen%2Fether%2Fpair%2Dexplorer%2F${PAIR_A}&rut=x">AAA</a>
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.dextools.io%2Fapp%2Fen%2Fbase%2Fpair-explorer%2F${PAIR_BASE}">base</a>
  <a class="result__a" href="https://www.dextools.io/app/en/ether/pair-explorer/${PAIR_B}?t=1">BBB</a>
</body></html>`;

describe('extractPairLinks', () => {
  test('reads percent-encoded redirect targets, dedupes, keeps page order', () => {
    expect(extractPairLinks(redirectPage).map(({ chain, pairAddress }) => `${chain}:${pairAddress}`)).toEqual([
      `ethereum:${PAIR_A}`,
      `base:${PAIR_BASE}`,
      `ethereum:${PAIR_B}`,
    ]);
  });

  test('reads JSON-escaped links and Solana addresses', () => {
    const body = `{"href":"\\/app\\/en\\/solana\\/pair-explorer\\/${SOL_PAIR}"}`;
    expect(extractPairLinks(body)).toEqual([{ chain: 'solana', pairAddress: SOL_PAIR, rank: 1 }]);
  });

  test('ignores links without a known chain slug', () => {
    expect(extractPairLinks(`/app/en/notachain/pair-explorer/${PAIR_A}`)).toEqual([]);
  });
});

describe('DexToolsSource Exa lane', () => {
  let server: ReturnType<typeof Bun.serve>;
  let searches: { apiKey: string | null; body: Record<string, unknown> }[] = [];
  let hydrations: string[] = [];
  let exaStatus = 200;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === '/search' && request.method === 'POST') {
          searches.push({ apiKey: request.headers.get('x-api-key'), body: (await request.json()) as Record<string, unknown> });
          if (exaStatus !== 200) return new Response('{"error":"nope"}', { status: exaStatus });
          return Response.json({
            results: [
              { url: `https://www.dextools.io/app/en/ether/pair-explorer/${PAIR_A}` },
              { url: `https://www.dextools.io/app/en/base/pair-explorer/${PAIR_BASE}` },
              { url: 'https://www.dextools.io/app/en/ether/hot-pairs' },
              { url: `https://www.dextools.io/app/en/ether/pair-explorer/${PAIR_A}?t=2` },
              { url: `https://www.dextools.io/app/solana/pair-explorer/${SOL_MINT}` },
            ],
            costDollars: { total: 0.005 },
          });
        }
        if (url.pathname.startsWith('/latest/dex/pairs/solana/')) {
          hydrations.push(url.pathname);
          return Response.json({ pairs: null });
        }
        if (url.pathname.startsWith('/latest/dex/tokens/')) {
          hydrations.push(url.pathname);
          const pair = (pairAddress: string, usd: number) => ({
            chainId: 'solana',
            pairAddress,
            baseToken: { address: SOL_MINT, symbol: 'MINT', name: 'Mint' },
            quoteToken: { symbol: 'SOL' },
            liquidity: { usd },
          });
          return Response.json({ pairs: [pair('ShallowPool1111111111111111111111111111111', 50), pair('DeepPool11111111111111111111111111111111111', 40_000)] });
        }
        if (url.pathname.startsWith('/latest/dex/pairs/')) {
          hydrations.push(url.pathname);
          return Response.json({
            pairs: [
              {
                chainId: 'ethereum',
                pairAddress: PAIR_A,
                baseToken: { address: TOKEN_A, symbol: 'AAA', name: 'Token A' },
                quoteToken: { symbol: 'WETH' },
                liquidity: { usd: 90_000 },
              },
            ],
          });
        }
        return new Response('not found', { status: 404 });
      },
    });
  });

  afterAll(() => {
    server.stop(true);
  });

  function dextoolsConfig(app: AppConfig): SourceConfig {
    return { ...app.pipeline.sources.find((source) => source.id === 'dextools')!, rateLimitMs: 0 };
  }

  function source(app: AppConfig): DexToolsSource {
    const base = `http://127.0.0.1:${server.port}`;
    return new DexToolsSource(dextoolsConfig(app), { exaBaseUrl: base, dexscreenerBaseUrl: base });
  }

  test('Exa result URLs become tokens: own chain only, deduped, hydrated through DexScreener', async () => {
    searches = [];
    hydrations = [];
    exaStatus = 200;
    const app = loadConfig({ PROVENANCE_CHAINS: 'ethereum', EXA_API_KEY: 'exa-key' });
    const dextools = source(app);
    const entries = await dextools.fetchTrending({ config: dextoolsConfig(app), app, logger: silentLogger });

    expect(searches).toHaveLength(1);
    expect(searches[0]?.apiKey).toBe('exa-key');
    expect(searches[0]?.body).toMatchObject({ includeDomains: ['dextools.io'], type: 'auto' });
    expect(String(searches[0]?.body.query)).toContain('ethereum');
    expect(hydrations).toEqual([`/latest/dex/pairs/ethereum/${PAIR_A}`]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: 'dextools',
      chain: 'ethereum',
      tokenAddress: TOKEN_A,
      pairAddress: PAIR_A,
      symbol: 'AAA',
      rank: 1,
    });
    expect(dextools.drainErrors()).toEqual([]);
  });

  test('a pair link that carries a token mint is resolved as a token, on its deepest pool', async () => {
    hydrations = [];
    exaStatus = 200;
    const app = loadConfig({ PROVENANCE_CHAINS: 'solana', EXA_API_KEY: 'exa-key' });
    const dextools = source(app);
    const entries = await dextools.fetchTrending({ config: dextoolsConfig(app), app, logger: silentLogger });

    expect(hydrations).toEqual([`/latest/dex/pairs/solana/${SOL_MINT}`, `/latest/dex/tokens/${SOL_MINT}`]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ chain: 'solana', tokenAddress: SOL_MINT, pairAddress: 'DeepPool11111111111111111111111111111111111' });
    expect(dextools.drainErrors()).toEqual([]);
  });

  test('without EXA_API_KEY nothing is searched and the gap is reported', async () => {
    searches = [];
    const app = loadConfig({ PROVENANCE_CHAINS: 'ethereum' });
    const dextools = source(app);
    const entries = await dextools.fetchTrending({ config: dextoolsConfig(app), app, logger: silentLogger });

    expect(entries).toEqual([]);
    expect(searches).toEqual([]);
    expect(dextools.drainErrors()[0]?.error).toContain('EXA_API_KEY');
  });

  test('an Exa refusal is kept as an error', async () => {
    exaStatus = 401;
    const app = loadConfig({ PROVENANCE_CHAINS: 'base', EXA_API_KEY: 'bad' });
    const dextools = source(app);
    const entries = await dextools.fetchTrending({ config: dextoolsConfig(app), app, logger: silentLogger });

    expect(entries).toEqual([]);
    const errors = dextools.drainErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.source).toBe('dextools:search:base');
    expect(errors[0]?.error).toContain('401');
  });
});
