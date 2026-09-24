import { describe, expect, test } from 'bun:test';
import type { WatchEntry } from '@provenance/core';
import { LibsqlStore } from './libsql-store';

function entry(overrides: Partial<WatchEntry> = {}): WatchEntry {
  return {
    tokenId: 'ethereum:0x1111111111111111111111111111111111111111',
    chain: 'ethereum',
    tokenAddress: '0x1111111111111111111111111111111111111111',
    symbol: 'MARIO',
    name: 'Super Mario',
    status: 'active',
    firstSeenAt: '2026-09-20T08:00:00.000Z',
    launchedAt: '2026-09-19T20:00:00.000Z',
    liquidityUsdAtCatalog: 52_000,
    referent: {
      validated: true,
      referent: 'Nintendo video game character',
      summary: 'Recognised worldwide since 1981.',
      confidence: 'high',
      model: 'test',
      checkedAt: '2026-09-20T08:00:00.000Z',
      citations: ['https://en.wikipedia.org/wiki/Mario'],
    },
    gate: { passed: true, reasons: [] },
    updatedAt: '2026-09-20T08:00:00.000Z',
    ...overrides,
  };
}

async function freshStore(): Promise<LibsqlStore> {
  const store = new LibsqlStore({ url: ':memory:' });
  await store.migrate();
  return store;
}

describe('watchlist', () => {
  test('round-trips an entry, including the fields that live only in the JSON blob', async () => {
    const store = await freshStore();
    await store.saveWatch(entry());
    const got = await store.getWatch(entry().tokenId);
    expect(got).toEqual(entry());
    await store.close();
  });

  test('upsert keeps the first catalogue time and the first expression', async () => {
    const store = await freshStore();
    await store.saveWatch(entry());
    await store.saveWatch(
      entry({
        status: 'expressed',
        firstSeenAt: '2026-09-22T08:00:00.000Z',
        expressedAt: '2026-09-21T08:00:00.000Z',
        leadHours: 24,
        expressedOn: ['dexscreener'],
        updatedAt: '2026-09-21T08:00:00.000Z',
      }),
    );
    // A later write claiming a different expression must not move the first one.
    await store.saveWatch(
      entry({
        status: 'expressed',
        expressedAt: '2026-09-23T08:00:00.000Z',
        leadHours: 72,
        updatedAt: '2026-09-23T08:00:00.000Z',
      }),
    );
    const got = await store.getWatch(entry().tokenId);
    expect(got?.status).toBe('expressed');
    expect(got?.firstSeenAt).toBe('2026-09-20T08:00:00.000Z');
    expect(got?.expressedAt).toBe('2026-09-21T08:00:00.000Z');
    expect(got?.leadHours).toBe(24);
    await store.close();
  });

  test('lists by status, newest catalogue first', async () => {
    const store = await freshStore();
    await store.saveWatch(entry());
    await store.saveWatch(
      entry({
        tokenId: 'ethereum:0x2222222222222222222222222222222222222222',
        tokenAddress: '0x2222222222222222222222222222222222222222',
        firstSeenAt: '2026-09-21T08:00:00.000Z',
      }),
    );
    await store.saveWatch(
      entry({
        tokenId: 'ethereum:0x3333333333333333333333333333333333333333',
        tokenAddress: '0x3333333333333333333333333333333333333333',
        status: 'dormant',
      }),
    );
    const active = await store.listWatch({ status: 'active' });
    expect(active.map((row) => row.tokenAddress)).toEqual([
      '0x2222222222222222222222222222222222222222',
      '0x1111111111111111111111111111111111111111',
    ]);
    expect(await store.listWatch()).toHaveLength(3);
    await store.close();
  });

  test('a corrupt JSON blob degrades to the promoted columns', async () => {
    const store = await freshStore();
    await store.saveWatch(entry());
    await store.raw.execute({
      sql: 'UPDATE watchlist SET entry_json = ? WHERE token_id = ?',
      args: ['{not json', entry().tokenId],
    });
    const got = await store.getWatch(entry().tokenId);
    expect(got?.symbol).toBe('MARIO');
    expect(got?.referent.referent).toBe('Nintendo video game character');
    expect(got?.referent.validated).toBe(false);
    await store.close();
  });
});
