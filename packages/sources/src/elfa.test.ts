import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { type AppConfig, loadConfig, silentLogger } from '@provenance/core';

import { elfaTimeWindow, fetchSocialTrending, parseElfaTrendingCas } from './elfa';

const AT = '2026-10-06T12:00:00.000Z';
const SHREK = '0x5b3e7F2A9C14D8E06b71a4c2F9D3e8b1a7C50d42';

describe('parseElfaTrendingCas', () => {
  test('reads the documented envelope and keys EVM addresses lowercase', () => {
    const body = {
      success: true,
      data: { page: 1, pageSize: 50, total: 1, data: [{ contractAddress: SHREK, chain: 'ethereum', mentionCount: 41 }] },
    };
    const { sightings, skipped } = parseElfaTrendingCas(body, 'twitter', AT);
    expect(skipped).toBe(0);
    expect(sightings).toEqual([
      {
        tokenId: `ethereum:${SHREK.toLowerCase()}`,
        chain: 'ethereum',
        tokenAddress: SHREK,
        platform: 'twitter',
        mentionCount: 41,
        seenAt: AT,
      },
    ]);
  });

  test('drops rows with no address or an unknown chain, and never throws', () => {
    const body = {
      data: {
        data: [
          { chain: 'ethereum', mentionCount: 3 },
          { contractAddress: '0xabc', chain: 'zksync-era-legacy', mentionCount: 9 },
          'garbage',
        ],
      },
    };
    expect(parseElfaTrendingCas(body, 'twitter', AT)).toEqual({ sightings: [], skipped: 3 });
    expect(parseElfaTrendingCas(null, 'twitter', AT)).toEqual({ sightings: [], skipped: 0 });
    expect(parseElfaTrendingCas('nope', 'telegram', AT).sightings).toEqual([]);
  });

  test('accepts a bare array and keeps the highest count for a repeated contract', () => {
    const body = [
      { contractAddress: SHREK, chain: 'eth', mentionCount: 6 },
      { contractAddress: SHREK.toLowerCase(), chain: 'ethereum', mentionCount: '11' },
    ];
    const { sightings } = parseElfaTrendingCas(body, 'telegram', AT);
    expect(sightings).toHaveLength(1);
    expect(sightings[0]?.mentionCount).toBe(11);
  });

  test('solana addresses keep their case', () => {
    const address = 'BonG9kRThz5vQ1pXmY7wLd3cJf8sNqA4eV6uZtP1rKx';
    const { sightings } = parseElfaTrendingCas({ data: [{ contractAddress: address, chain: 'solana' }] }, 'twitter', AT);
    expect(sightings[0]?.tokenId).toBe(`solana:${address}`);
    expect(sightings[0]?.mentionCount).toBe(0);
  });
});

describe('elfaTimeWindow', () => {
  test('rounds the fetch interval up to whole hours, at least one', () => {
    expect(elfaTimeWindow(6)).toBe('6h');
    expect(elfaTimeWindow(0.5)).toBe('1h');
    expect(elfaTimeWindow(2.1)).toBe('3h');
    expect(elfaTimeWindow(Number.NaN)).toBe('1h');
  });
});

function config(env: Record<string, string> = {}): AppConfig {
  return loadConfig({ ELFA_RATE_MS: '0', ...env });
}

describe('fetchSocialTrending', () => {
  test('fixture mode reads both feeds, filtered by ELFA_PLATFORMS', async () => {
    const both = await fetchSocialTrending(config({ USE_FIXTURES: '1' }), silentLogger);
    expect(both.errors).toEqual([]);
    expect(both.sightings.map((s) => `${s.platform}:${s.tokenId}`).sort()).toEqual([
      'telegram:ethereum:0x5b3e7f2a9c14d8e06b71a4c2f9d3e8b1a7c50d42',
      'telegram:ethereum:0xe41d6a9b3c72f05e8d1a6b4c93f27e0d5a8c1b76',
      'twitter:ethereum:0x5b3e7f2a9c14d8e06b71a4c2f9d3e8b1a7c50d42',
      'twitter:solana:BonG9kRThz5vQ1pXmY7wLd3cJf8sNqA4eV6uZtP1rKx',
    ]);

    const telegram = await fetchSocialTrending(config({ USE_FIXTURES: '1', ELFA_PLATFORMS: 'telegram' }), silentLogger);
    expect(new Set(telegram.sightings.map((s) => s.platform))).toEqual(new Set(['telegram']));
  });

  test('no key, no request', async () => {
    expect(await fetchSocialTrending(config(), silentLogger)).toEqual({ sightings: [], errors: [] });
  });

  describe('over HTTP', () => {
    const requests: { path: string; key: string | null }[] = [];
    let server: ReturnType<typeof Bun.serve>;

    beforeAll(() => {
      server = Bun.serve({
        port: 0,
        fetch(request) {
          const url = new URL(request.url);
          requests.push({ path: `${url.pathname}${url.search}`, key: request.headers.get('x-elfa-api-key') });
          if (url.pathname.endsWith('/telegram')) return new Response('nope', { status: 403 });
          return Response.json({ success: true, data: { data: [{ contractAddress: SHREK, chain: 'ethereum', mentionCount: 8 }] } });
        },
      });
    });

    afterAll(() => {
      server.stop(true);
    });

    test('sends the key and window, and one failing feed does not sink the other', async () => {
      const result = await fetchSocialTrending(
        config({ ELFA_API_KEY: 'elfa_test', ELFA_MIN_INTERVAL_HOURS: '6', ELFA_MIN_MENTIONS: '3' }),
        silentLogger,
        { baseUrl: `http://localhost:${server.port}` },
      );

      expect(result.sightings.map((s) => s.tokenId)).toEqual([`ethereum:${SHREK.toLowerCase()}`]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.source).toBe('elfa:telegram');

      const twitter = requests.find((r) => r.path.includes('/twitter'));
      expect(twitter?.key).toBe('elfa_test');
      expect(twitter?.path).toContain('/v2/aggregations/trending-cas/twitter?');
      expect(twitter?.path).toContain('timeWindow=6h');
      expect(twitter?.path).toContain('minMentions=3');
      // 403 is not retried: it would not get better, and it is not charged.
      expect(requests.filter((r) => r.path.includes('/telegram'))).toHaveLength(1);
    });
  });
});
