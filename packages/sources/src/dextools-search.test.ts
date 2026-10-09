import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { type AppConfig, type SourceConfig, loadConfig, silentLogger } from '@provenance/core';

import { DexToolsSource } from './dextools';
import { extractPairLinks } from './dextools-search';

const PAIR_A = '0x1111111111111111111111111111111111111111';
const PAIR_B = '0x2222222222222222222222222222222222222222';
const PAIR_BASE = '0x3333333333333333333333333333333333333333';
const TOKEN_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SOL_PAIR = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

/** DuckDuckGo's HTML results: targets percent-encoded inside a redirect, and shown as text. */
const duckduckgo = `<html><body>
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.dextools.io%2Fapp%2Fen%2Fether%2Fpair%2Dexplorer%2F${PAIR_A}&rut=x">AAA</a>
  <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.dextools.io%2Fapp%2Fen%2Fbase%2Fpair-explorer%2F${PAIR_BASE}">base</a>
  <a class="result__a" href="https://www.dextools.io/app/en/ether/pair-explorer/${PAIR_B}?t=1">BBB</a>
</body></html>`;

describe('extractPairLinks', () => {
  test('reads percent-encoded redirect targets, dedupes, keeps page order', () => {
    expect(extractPairLinks(duckduckgo).map(({ chain, pairAddress }) => `${chain}:${pairAddress}`)).toEqual([
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

describe('DexToolsSource search lane', () => {
  let server: ReturnType<typeof Bun.serve>;
  let requests: string[] = [];
  let ddgStatus = 200;

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        requests.push(url.pathname + url.search);
        if (url.pathname === '/ddg') {
          return ddgStatus === 200 ? new Response(duckduckgo, { headers: { 'content-type': 'text/html' } }) : new Response('anomaly', { status: ddgStatus });
        }
        if (url.pathname === '/bing') return new Response(`<a href="https://www.dextools.io/app/en/ether/pair-explorer/${PAIR_B}">B</a>`);
        if (url.pathname === `/latest/dex/pairs/ethereum/${PAIR_A},${PAIR_B}` || url.pathname === `/latest/dex/pairs/ethereum/${PAIR_B}`) {
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

  function source(): DexToolsSource {
    const base = `http://127.0.0.1:${server.port}`;
    return new DexToolsSource(dextoolsConfig(loadConfig({})), {
      dexscreenerBaseUrl: base,
      searchUrls: [`${base}/ddg?q={q}`, `${base}/bing?q={q}`],
      browser: false,
    });
  }

  test('result links are resolved to tokens, other chains dropped, no second engine needed', async () => {
    requests = [];
    ddgStatus = 200;
    const app = loadConfig({ PROVENANCE_CHAINS: 'ethereum' });
    const dextools = source();
    const entries = await dextools.fetchTrending({ config: dextoolsConfig(app), app, logger: silentLogger });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: 'dextools',
      chain: 'ethereum',
      tokenAddress: TOKEN_A,
      pairAddress: PAIR_A,
      symbol: 'AAA',
      rank: 1,
      url: `https://www.dextools.io/app/en/ether/pair-explorer/${PAIR_A}`,
    });
    expect(requests[0]).toBe(`/ddg?q=${encodeURIComponent('site:dextools.io inurl:pair-explorer ether')}`);
    expect(requests.some((path) => path.startsWith('/bing'))).toBe(false);
    expect(requests.some((path) => path.includes(PAIR_BASE))).toBe(false);
    expect(dextools.drainErrors()).toEqual([]);
  });

  test('a refusing engine falls through to the next', async () => {
    requests = [];
    ddgStatus = 403;
    const app = loadConfig({ PROVENANCE_CHAINS: 'ethereum' });
    const dextools = source();
    const entries = await dextools.fetchTrending({ config: dextoolsConfig(app), app, logger: silentLogger });

    expect(requests.some((path) => path.startsWith('/bing'))).toBe(true);
    expect(requests).toContain(`/latest/dex/pairs/ethereum/${PAIR_B}`);
    // The stand-in answers for PAIR_A only, so nothing resolves; the point is the fall-through.
    expect(entries).toEqual([]);
  });

  test('when every engine refuses the errors are kept', async () => {
    ddgStatus = 403;
    const base = `http://127.0.0.1:${server.port}`;
    const app = loadConfig({ PROVENANCE_CHAINS: 'base' });
    const dextools = new DexToolsSource(dextoolsConfig(app), {
      dexscreenerBaseUrl: base,
      searchUrls: [`${base}/ddg?q={q}`],
      browser: false,
    });
    const entries = await dextools.fetchTrending({ config: dextoolsConfig(app), app, logger: silentLogger });

    expect(entries).toEqual([]);
    const errors = dextools.drainErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.source).toBe('dextools:search:base');
    expect(errors[0]?.error).toContain('403');
  });
});
