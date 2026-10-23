/**
 * A small key/value cache for on-chain reads that cannot change: logs from
 * finalized blocks, chunked on fixed boundaries so the same range gets the
 * same key every run. GitHub Actions restores the directory between runs
 * (run-lane.yml), so a re-analysed token only asks the node for the blocks
 * that arrived since the last scan.
 *
 * Not exported from the package index: it touches the filesystem, and the
 * dashboard imports `@provenance/core`. Import `@provenance/core/cache`.
 */

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { hashKey } from './util';

export interface KvCache {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export interface FileCacheOptions {
  /** Entries older than this read as misses and are deleted by `prune`. */
  maxAgeMs: number;
  /** A value whose JSON is larger than this is not stored. */
  maxEntryBytes?: number;
  /** `prune` deletes oldest entries until the directory is under this. */
  maxTotalBytes?: number;
  now?: () => number;
}

const DEFAULT_MAX_ENTRY_BYTES = 16 * 1024 * 1024;
/** Restored and saved by every Actions run, so it stays small enough to move in seconds. */
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

/**
 * One gzipped JSON file per key, fanned out by hash prefix. Every failure is a
 * miss: a cache that can break a run is worse than no cache.
 */
export class FileCache implements KvCache {
  private readonly now: () => number;

  constructor(
    private readonly dir: string,
    private readonly options: FileCacheOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  private path(key: string): string {
    const hash = hashKey(key);
    return join(this.dir, hash.slice(0, 2), `${hash}.json.gz`);
  }

  async get<T>(key: string): Promise<T | undefined> {
    try {
      const file = this.path(key);
      const info = await stat(file);
      if (this.now() - info.mtimeMs > this.options.maxAgeMs) return undefined;
      const entry = JSON.parse(gunzipSync(await readFile(file)).toString('utf8')) as { key?: string; value?: T };
      // A hash collision on 128 bits is not a real risk; a renamed key format is.
      return entry.key === key ? entry.value : undefined;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: unknown): Promise<void> {
    try {
      const json = JSON.stringify({ key, value });
      if (json.length > (this.options.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES)) return;
      const file = this.path(key);
      await mkdir(join(file, '..'), { recursive: true });
      // Write then rename, so a run killed mid-write leaves no torn entry.
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, gzipSync(json));
      await rename(tmp, file);
    } catch {
      // A full disk or a read-only checkout costs a refetch next run, nothing more.
    }
  }

  /** Drops expired entries, then the oldest until under `maxTotalBytes`. Returns entries kept. */
  async prune(): Promise<{ kept: number; removed: number; bytes: number }> {
    const entries: { file: string; mtimeMs: number; size: number }[] = [];
    let removed = 0;
    try {
      for (const shard of await readdir(this.dir)) {
        const shardDir = join(this.dir, shard);
        for (const name of await readdir(shardDir).catch(() => [] as string[])) {
          const file = join(shardDir, name);
          const info = await stat(file).catch(() => undefined);
          if (!info?.isFile()) continue;
          if (name.endsWith('.tmp') || this.now() - info.mtimeMs > this.options.maxAgeMs) {
            await rm(file, { force: true });
            removed++;
          } else {
            entries.push({ file, mtimeMs: info.mtimeMs, size: info.size });
          }
        }
      }
    } catch {
      return { kept: 0, removed, bytes: 0 };
    }

    const cap = this.options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    let bytes = entries.reduce((sum, entry) => sum + entry.size, 0);
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    while (bytes > cap && entries.length > 0) {
      const oldest = entries.shift()!;
      await rm(oldest.file, { force: true });
      bytes -= oldest.size;
      removed++;
    }
    return { kept: entries.length, removed, bytes };
  }
}

/** For tests and for runs with the cache turned off. */
export class MemoryCache implements KvCache {
  readonly entries = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.entries.get(key) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.entries.set(key, JSON.parse(JSON.stringify(value)));
  }
}

/**
 * Start of the chunk ending at `end` on a fixed grid of `size` blocks, clipped
 * to `from`. Walking newest first, the head chunk is partial and every later
 * one is a full grid cell, so a range scanned today has the same bounds (and
 * cache key) tomorrow.
 */
export function alignedChunkStart(end: number, from: number, size: number): number {
  return Math.max(from, Math.floor(end / size) * size);
}

/** True when `[start, end]` is one full grid cell and sits at least `confirmations` below `head`. */
export function isFinalChunk(start: number, end: number, size: number, head: number, confirmations: number): boolean {
  return start % size === 0 && end === start + size - 1 && end <= head - confirmations;
}

/**
 * Blocks behind the head treated as final for caching. Ethereum finalizes in
 * two epochs (64 slots); the L2s and BSC reorg far less deep than this in
 * practice, and a wrong entry expires with the cache's max age.
 */
export const CACHE_CONFIRMATIONS: Record<string, number> = {
  ethereum: 96,
  base: 600,
  arbitrum: 4_800,
  bsc: 200,
  polygon: 600,
  avalanche: 600,
};

const OPEN = new Map<string, FileCache>();

/**
 * The process-wide chain-read cache for this config, or undefined when it is
 * off or the run replays fixtures. The first open prunes expired entries in
 * the background; a prune racing a read only turns a hit into a miss.
 */
export function openRpcCache(app: {
  rpcCache: { enabled: boolean; dir: string; maxAgeHours: number };
  pipeline: { useFixtures: boolean };
}): KvCache | undefined {
  if (!app.rpcCache.enabled || app.pipeline.useFixtures) return undefined;
  let cache = OPEN.get(app.rpcCache.dir);
  if (!cache) {
    cache = new FileCache(app.rpcCache.dir, { maxAgeMs: app.rpcCache.maxAgeHours * 3_600_000 });
    OPEN.set(app.rpcCache.dir, cache);
    void cache.prune().catch(() => undefined);
  }
  return cache;
}
