import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LibsqlStore } from './libsql-store';
import { MIGRATIONS } from './migrate';

describe('migrate', () => {
  test('two processes applying the same pending version at once both succeed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'provenance-migrate-'));
    const url = `file:${join(dir, 'race.db')}`;
    const latest = Math.max(...MIGRATIONS.map((m) => m.version));
    try {
      // A database one version behind: the newest migration is pending again.
      const setup = new LibsqlStore({ url });
      await setup.migrate();
      await setup.raw.execute({ sql: 'DELETE FROM schema_migrations WHERE version = ?', args: [latest] });
      await setup.close();

      const a = new LibsqlStore({ url });
      const b = new LibsqlStore({ url });
      await Promise.all([a.migrate(), b.migrate()]);
      const rows = await a.raw.execute('SELECT version FROM schema_migrations WHERE version = ' + latest);
      expect(rows.rows).toHaveLength(1);
      await a.close();
      await b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
