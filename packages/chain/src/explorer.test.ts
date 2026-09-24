import { describe, expect, test } from 'bun:test';
import { loadConfig, type AppConfig, type Chain } from '@provenance/core';
import { checkContractVerified, ETHERSCAN_CHAIN_IDS } from './explorer';

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
