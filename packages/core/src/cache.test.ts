import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { alignedChunkStart, FileCache, isFinalChunk, openRpcCache } from './cache';
import { loadConfig } from './config';

describe('FileCache', () => {
  test('round-trips a value and misses a key it never saw', async () => {
    const cache = new FileCache(mkdtempSync(join(tmpdir(), 'rpc-cache-')), { maxAgeMs: 60_000 });
    await cache.set('logs:a', [{ topics: ['0x1'], data: '0x2' }]);
    expect(await cache.get<unknown>('logs:a')).toEqual([{ topics: ['0x1'], data: '0x2' }]);
    expect(await cache.get('logs:b')).toBeUndefined();
  });

  test('expired entries read as misses and prune deletes them', async () => {
    let clock = Date.now();
    const dir = mkdtempSync(join(tmpdir(), 'rpc-cache-'));
    const cache = new FileCache(dir, { maxAgeMs: 1_000, now: () => clock });
    await cache.set('old', 1);
    clock += 5_000;
    expect(await cache.get('old')).toBeUndefined();
    expect((await cache.prune()).removed).toBe(1);
    expect(readdirSync(dir).flatMap((shard) => readdirSync(join(dir, shard)))).toEqual([]);
  });

  test('prune keeps the newest entries under the size cap', async () => {
    const cache = new FileCache(mkdtempSync(join(tmpdir(), 'rpc-cache-')), { maxAgeMs: 60_000, maxTotalBytes: 1 });
    await cache.set('a', 'x'.repeat(1_000));
    const result = await cache.prune();
    expect(result.kept).toBe(0);
    expect(await cache.get('a')).toBeUndefined();
  });

  test('an oversized value is skipped, and an unwritable directory is a miss, not a throw', async () => {
    const cache = new FileCache(mkdtempSync(join(tmpdir(), 'rpc-cache-')), { maxAgeMs: 60_000, maxEntryBytes: 10 });
    await cache.set('big', 'x'.repeat(100));
    expect(await cache.get('big')).toBeUndefined();

    const broken = new FileCache('/proc/not-writable', { maxAgeMs: 60_000 });
    await broken.set('k', 1);
    expect(await broken.get('k')).toBeUndefined();
  });
});

describe('chunk grid', () => {
  test('chunks below the head start on multiples of the size', () => {
    expect(alignedChunkStart(1_001_500, 990_000, 2000)).toBe(1_000_000);
    expect(alignedChunkStart(999_999, 990_000, 2000)).toBe(998_000);
    expect(alignedChunkStart(999_999, 998_500, 2000)).toBe(998_500);
  });

  test('only a full cell past the confirmation depth is final', () => {
    expect(isFinalChunk(998_000, 999_999, 2000, 1_000_200, 96)).toBe(true);
    expect(isFinalChunk(998_000, 999_999, 2000, 1_000_050, 96)).toBe(false);
    expect(isFinalChunk(998_500, 999_999, 2000, 1_100_000, 96)).toBe(false);
    expect(isFinalChunk(1_000_000, 1_001_500, 2000, 1_100_000, 96)).toBe(false);
  });
});

describe('openRpcCache', () => {
  test('is off in fixture mode and when RPC_CACHE=false', () => {
    expect(openRpcCache(loadConfig({ USE_FIXTURES: '1' }))).toBeUndefined();
    expect(openRpcCache(loadConfig({ RPC_CACHE: 'false' }))).toBeUndefined();
  });
});
