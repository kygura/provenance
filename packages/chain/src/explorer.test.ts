import { describe, expect, test } from 'bun:test';
import { loadConfig, type AppConfig, type Chain } from '@provenance/core';
import { checkContractVerified, ETHERSCAN_CHAIN_IDS, lookupFirstFunders } from './explorer';

const KEY = 'SECRETKEY123';
const ADDRESS = '0x9f2c4b1ea7d0ab3e6c5f81d2a94b7e03cd15a8fe';

function config(overrides: { key?: string; fixtures?: boolean } = {}): AppConfig {
  const base = loadConfig({});
  return {
    ...base,
    ...(overrides.key !== undefined ? { etherscanApiKey: overrides.key } : {}),
    pipeline: { ...base.pipeline, useFixtures: overrides.fixtures ?? false },
  };
}

function fakeFetch(respond: (url: URL) => Response | Promise<Response>) {
  const seen: URL[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    seen.push(url);
    return respond(url);
  }) as typeof fetch;
  return { impl, seen };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function check(respond: Parameters<typeof fakeFetch>[0], chain: Chain = 'ethereum', app = config({ key: KEY })) {
  const notes: string[] = [];
  const fetch = fakeFetch(respond);
  const verified = await checkContractVerified({ app, chain, address: ADDRESS, notes, fetchImpl: fetch.impl });
  return { verified, notes, seen: fetch.seen };
}

describe('checkContractVerified', () => {
  test('verified source reads true, and the request is the documented V2 call', async () => {
    const { verified, seen } = await check(
      () => json({ status: '1', message: 'OK', result: [{ SourceCode: 'contract X {}', ABI: '[]' }] }),
      'base',
    );
    expect(verified).toBe(true);
    const url = seen[0];
    expect(url?.origin + (url?.pathname ?? '')).toBe('https://api.etherscan.io/v2/api');
    expect(url?.searchParams.get('chainid')).toBe('8453');
    expect(url?.searchParams.get('module')).toBe('contract');
    expect(url?.searchParams.get('action')).toBe('getsourcecode');
    expect(url?.searchParams.get('address')).toBe(ADDRESS);
    expect(url?.searchParams.get('apikey')).toBe(KEY);
  });

  test('empty SourceCode reads false', async () => {
    const { verified } = await check(() =>
      json({ status: '1', message: 'OK', result: [{ SourceCode: '', ABI: 'Contract source code not verified' }] }),
    );
    expect(verified).toBe(false);
  });

  test('an Etherscan error body is undetermined, with the key redacted from the note', async () => {
    const { verified, notes } = await check(() =>
      json({ status: '0', message: 'NOTOK', result: `Invalid API Key (#err2)|${KEY}` }),
    );
    expect(verified).toBeUndefined();
    expect(notes.join(' ')).toContain('Invalid API Key');
    expect(notes.join(' ')).not.toContain(KEY);
  });

  test('HTTP errors and thrown fetches are notes, never throws', async () => {
    expect((await check(() => json({}, 503))).verified).toBeUndefined();
    const thrown = await check(() => {
      throw new Error(`connect failed for apikey=${KEY}`);
    });
    expect(thrown.verified).toBeUndefined();
    expect(thrown.notes.join(' ')).not.toContain(KEY);
  });

  test('an unexpected shape is undetermined', async () => {
    expect((await check(() => json({ status: '1', result: [{}] }))).verified).toBeUndefined();
  });

  test('no key, fixture mode and a chain without an id never touch the network', async () => {
    for (const [app, chain] of [
      [config(), 'ethereum'],
      [config({ key: KEY, fixtures: true }), 'ethereum'],
      [config({ key: KEY }), 'solana'],
    ] as const) {
      const { verified, notes, seen } = await check(() => json({}), chain, app);
      expect(verified).toBeUndefined();
      expect(seen).toHaveLength(0);
      expect(notes).toHaveLength(1);
    }
  });

  test('chain ids cover every EVM chain', () => {
    expect(ETHERSCAN_CHAIN_IDS).toEqual({
      ethereum: 1,
      base: 8453,
      bsc: 56,
      arbitrum: 42161,
      polygon: 137,
      avalanche: 43114,
      blast: 81457,
    });
  });
});

describe('lookupFirstFunders', () => {
  const W1 = '0x1111111111111111111111111111111111111111';
  const W2 = '0x2222222222222222222222222222222222222222';
  const FUNDER = '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa';
  const ok = (result: unknown[]) => json({ status: result.length ? '1' : '0', message: result.length ? 'OK' : 'No transactions found', result });

  async function run(
    respond: Parameters<typeof fakeFetch>[0],
    extra: Partial<Parameters<typeof lookupFirstFunders>[0]> = {},
    addresses: string[] = [W1],
    app = config({ key: KEY }),
  ) {
    const notes: string[] = [];
    const fetch = fakeFetch(respond);
    const funders = await lookupFirstFunders({
      app, chain: 'base', addresses, notes, fetchImpl: fetch.impl, rateLimitMs: 0, ...extra,
    });
    return { funders, notes, seen: fetch.seen };
  }

  test('first inbound tx with value gives the lowercase funder; request is the documented call', async () => {
    const { funders, seen } = await run(() => ok([{ from: FUNDER, to: W1.toUpperCase().replace('0X', '0x'), value: '1000', hash: '0x1' }]));
    expect(funders.get(W1)).toBe(FUNDER.toLowerCase());
    expect(seen).toHaveLength(1);
    const p = seen[0]!.searchParams;
    expect(p.get('chainid')).toBe('8453');
    expect(p.get('module')).toBe('account');
    expect(p.get('action')).toBe('txlist');
    expect(p.get('sort')).toBe('asc');
    expect(p.get('address')).toBe(W1);
    expect(p.get('apikey')).toBe(KEY);
  });

  test('zero-value and outgoing entries are skipped', async () => {
    const { funders } = await run(() =>
      ok([
        { from: W1, to: '0x9999999999999999999999999999999999999999', value: '5' },
        { from: '0xbad0000000000000000000000000000000000000', to: W1, value: '0' },
        { from: FUNDER, to: W1, value: '7' },
      ]),
    );
    expect(funders.get(W1)).toBe(FUNDER.toLowerCase());
  });

  test('internal fallback resolves the parent tx sender', async () => {
    const { funders, seen } = await run(
      (url) =>
        url.searchParams.get('action') === 'txlist'
          ? ok([])
          : ok([{ from: '0xd15perse00000000000000000000000000000000', to: W1, value: '9', hash: '0xabc' }]),
      { txSender: async (h) => (h === '0xabc' ? FUNDER : undefined) },
    );
    expect(funders.get(W1)).toBe(FUNDER.toLowerCase());
    expect(seen.map((u) => u.searchParams.get('action'))).toEqual(['txlist', 'txlistinternal']);
    expect(seen[1]!.searchParams.get('sort')).toBe('asc');
  });

  test('txSender throwing falls back to the internal entry sender', async () => {
    const { funders } = await run(
      (url) => (url.searchParams.get('action') === 'txlist' ? ok([]) : ok([{ from: FUNDER, to: W1, value: '9', hash: '0xabc' }])),
      { txSender: async () => { throw new Error('rpc down'); } },
    );
    expect(funders.get(W1)).toBe(FUNDER.toLowerCase());
  });

  test('no transactions at all is looked up but not found', async () => {
    const { funders, notes } = await run(() => ok([]));
    expect(funders.has(W1)).toBe(true);
    expect(funders.get(W1)).toBeUndefined();
    expect(notes).toHaveLength(0);
  });

  test('a systemic status 0 stops the lookup, keeps earlier results, redacts the key', async () => {
    let n = 0;
    const { funders, notes, seen } = await run(
      () => (++n === 1 ? ok([{ from: FUNDER, to: W1, value: '1' }]) : json({ status: '0', message: 'NOTOK', result: `Invalid API Key|${KEY}` })),
      {},
      [W1, W2, '0x3333333333333333333333333333333333333333'],
    );
    expect(funders.get(W1)).toBe(FUNDER.toLowerCase());
    expect(funders.has(W2)).toBe(false);
    expect(seen).toHaveLength(2);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('Invalid API Key');
    expect(notes.join(' ')).not.toContain(KEY);
  });

  test('HTTP 500 on one address continues with the next and leaves one summary note', async () => {
    const { funders, notes } = await run(
      (url) => (url.searchParams.get('address') === W1 ? json({}, 500) : ok([{ from: FUNDER, to: W2, value: '1' }])),
      {},
      [W1, W2],
    );
    expect(funders.has(W1)).toBe(true);
    expect(funders.get(W1)).toBeUndefined();
    expect(funders.get(W2)).toBe(FUNDER.toLowerCase());
    expect(notes).toEqual(['funding lookup: 1 of 2 wallet(s) failed: Etherscan answered HTTP 500']);
  });

  test('no key, fixtures and unsupported chains return an empty map without fetching', async () => {
    for (const [app, chain] of [
      [config(), 'base'],
      [config({ key: KEY, fixtures: true }), 'base'],
      [config({ key: KEY }), 'solana'],
    ] as const) {
      const { funders, notes, seen } = await run(() => json({}), { chain }, [W1], app);
      expect(funders.size).toBe(0);
      expect(seen).toHaveLength(0);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toStartWith('funding not traced:');
    }
  });
});
