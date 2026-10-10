/**
 * One-off: delete the rows that only record an OpenRouter HTTP 402
 * ("out of credits") instead of a real verdict.
 *
 *   - watchlist: launch-lane tokens dismissed because the anchor check failed.
 *     Deleting them lets the launch lane judge them again.
 *   - provenance: trending-lane reports with no research in them. Deleting
 *     them stops the next runs reusing them until the TTL expires.
 *
 * Writes a JSON backup of every deleted row first. Dry run by default.
 *
 *   bun packages/store/cleanup-402.ts            # count and back up, delete nothing
 *   bun packages/store/cleanup-402.ts --apply    # back up, then delete
 *
 * Needs DATABASE_URL and DATABASE_AUTH_TOKEN in the environment, and
 * `bun install` done. The backup lands in the current directory.
 */
import { createClient } from '@libsql/client';
import { writeFileSync } from 'node:fs';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const db = createClient({ url, authToken: process.env.DATABASE_AUTH_TOKEN });
const apply = process.argv.includes('--apply');

const ERROR = '%openrouter /chat/completions HTTP 402%';
const WATCH = `json_extract(entry_json, '$.anchor.summary') LIKE '${ERROR}'`;
const REPORT = `json_extract(report_json, '$.anchor.summary') LIKE '${ERROR}'`;

const watchlist = (await db.execute(`SELECT * FROM watchlist WHERE ${WATCH}`)).rows;
const provenance = (await db.execute(`SELECT * FROM provenance WHERE ${REPORT}`)).rows;

const backup = `bad-rows-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(backup, JSON.stringify({ watchlist, provenance }, null, 2));
console.log(`found ${watchlist.length} watchlist and ${provenance.length} provenance rows; backup: ${backup}`);

if (!apply) {
  console.log('dry run: nothing deleted. Re-run with --apply to delete.');
} else {
  const [w, p] = await db.batch(
    [`DELETE FROM watchlist WHERE ${WATCH}`, `DELETE FROM provenance WHERE ${REPORT}`],
    'write',
  );
  console.log(`deleted ${w?.rowsAffected ?? 0} watchlist and ${p?.rowsAffected ?? 0} provenance rows`);
}
