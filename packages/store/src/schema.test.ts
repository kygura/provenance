import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { MIGRATIONS, buildSchemaSql, migrate } from './migrate';

const schemaPath = new URL('./schema.sql', import.meta.url).pathname;

describe('schema.sql', () => {
  /**
   * migrate.ts has always claimed this file guards the artefact; it did not
   * exist, so `schema.sql` could drift from MIGRATIONS indefinitely and the
   * only sign would be a confused reader.
   */
  test('matches MIGRATIONS', () => {
    const onDisk = readFileSync(schemaPath, 'utf8');
    expect(onDisk).toBe(buildSchemaSql());
  });
});

describe('MIGRATIONS', () => {
  test('versions are unique and consecutive from 1', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect(versions).toEqual(versions.map((_, i) => i + 1));
  });

  test('every migration is named and does something', () => {
    for (const migration of MIGRATIONS) {
      expect(migration.name.length).toBeGreaterThan(0);
      expect(migration.statements.length).toBeGreaterThan(0);
    }
  });
});

describe('applying every migration to an empty database', () => {
  async function migratedClient() {
    const client = createClient({ url: ':memory:' });
    const applied = await migrate(client);
    return { client, applied };
  }

  test('runs clean and records each version', async () => {
    const { client, applied } = await migratedClient();
    expect(applied).toBe(MIGRATIONS.length);

    const rows = await client.execute('SELECT version FROM schema_migrations ORDER BY version');
    expect(rows.rows.map((r) => Number(r.version))).toEqual(MIGRATIONS.map((m) => m.version));
    client.close();
  });

  test('is idempotent — a second call applies nothing', async () => {
    const { client } = await migratedClient();
    expect(await migrate(client)).toBe(0);
    client.close();
  });

  test('creates the memes table and the provenance link column', async () => {
    const { client } = await migratedClient();

    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    expect(tables.rows.map((r) => String(r.name))).toContain('memes');

    const columns = await client.execute('PRAGMA table_info(provenance)');
    expect(columns.rows.map((r) => String(r.name))).toContain('meme_id');
    client.close();
  });

  test('a provenance row can be written with no meme, and with one', async () => {
    const { client } = await migratedClient();
    await client.execute(
      "INSERT INTO runs (id, started_at, status, stats_json) VALUES ('r1', '2026-01-01', 'ok', '{}')",
    );
    for (const id of ['solana:a', 'solana:b']) {
      await client.execute({
        sql: `INSERT INTO tokens (id, chain, address, symbol, name, first_seen_at, last_seen_at)
              VALUES (?, 'solana', ?, 'NYAN', 'Nyan', '2026-01-01', '2026-01-01')`,
        args: [id, id.split(':')[1] as string],
      });
    }
    await client.execute(
      "INSERT INTO memes (id, display_name, narrative_cluster, first_seen_at, last_seen_at) VALUES ('nyan-cat', 'Nyan Cat', 'cat', '2026-01-01', '2026-01-01')",
    );

    const insert = (id: string, tokenId: string, memeId: string | null) =>
      client.execute({
        sql: `INSERT INTO provenance
                (id, run_id, token_id, created_at, meme_name, narrative_cluster, recycle_verdict,
                 recycle_generation, confidence, model, prompt_version, report_json, meme_id)
              VALUES (?, 'r1', ?, '2026-01-01', 'Nyan Cat', 'cat', 'revival', 1, 0.8, 'm', 'v', '{}', ?)`,
        args: [id, tokenId, memeId],
      });

    // Unlinked is the normal case for an unidentifiable meme, not an error.
    await insert('p1', 'solana:a', null);
    await insert('p2', 'solana:b', 'nyan-cat');

    const rows = await client.execute('SELECT id, meme_id FROM provenance ORDER BY id');
    expect(rows.rows.map((r) => r.meme_id)).toEqual([null, 'nyan-cat']);
    client.close();
  });
});
