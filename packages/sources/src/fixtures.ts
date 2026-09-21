import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FixtureFile<T> {
  name: string;
  path: string;
  data: T;
}

/**
 * Fixture mode is how the whole pipeline is demoed offline (`USE_FIXTURES=1`),
 * so the root has to resolve without any config: env override first, then the
 * repo's `fixtures/` directory found relative to this module.
 */
export function fixturesRoot(): string {
  const override = process.env.PROVENANCE_FIXTURES_DIR;
  if (override && override.trim() !== '') return resolve(override.trim());
  // .../packages/sources/src/fixtures.ts -> repo root
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..', '..', 'fixtures');
}

export function fixtureDir(source: string): string {
  return join(fixturesRoot(), source);
}

async function listFiles(source: string, extension: string): Promise<string[]> {
  const dir = fixtureDir(source);
  try {
    const names = await readdir(dir);
    return names
      .filter((name) => name.toLowerCase().endsWith(extension))
      .sort() // deterministic ordering: fixture runs must be reproducible
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

/** Reads every `*.json` fixture for a source. Unparseable files are skipped. */
export async function readJsonFixtures(source: string): Promise<FixtureFile<unknown>[]> {
  const paths = await listFiles(source, '.json');
  const out: FixtureFile<unknown>[] = [];
  for (const path of paths) {
    try {
      const text = await readFile(path, 'utf8');
      out.push({ name: path.split('/').pop() ?? path, path, data: JSON.parse(text) as unknown });
    } catch {
      // A corrupt fixture must not fail a run; the source just sees fewer rows.
    }
  }
  return out;
}

export async function readTextFixtures(source: string, extension = '.html'): Promise<FixtureFile<string>[]> {
  const paths = await listFiles(source, extension);
  const out: FixtureFile<string>[] = [];
  for (const path of paths) {
    try {
      out.push({ name: path.split('/').pop() ?? path, path, data: await readFile(path, 'utf8') });
    } catch {
      // ignore
    }
  }
  return out;
}
