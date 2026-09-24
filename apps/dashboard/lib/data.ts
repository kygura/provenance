import {
  loadConfig,
  type Alert,
  type AppConfig,
  type DossierQuery,
  type ProvenanceScore,
  type ProvenanceStore,
  type RunRecord,
  type TokenDossier,
  type WatchEntry,
  type WatchQuery,
} from '@provenance/core';

/**
 * The single seam between the dashboard and `@provenance/store`.
 *
 * The store package is built in parallel with this app, so the import is dynamic
 * and the absence of `createStore` is treated as a configuration state rather
 * than a crash: every page renders a setup screen instead of a stack trace, and
 * swapping in the finished store needs no change anywhere but this file.
 */

export type ProblemKind =
  | 'no-database-url'
  | 'store-unavailable'
  | 'connect-failed'
  | 'query-failed';

export interface Problem {
  kind: ProblemKind;
  /** One line, shown as the setup screen's headline. */
  title: string;
  /** What the operator has to do about it. */
  hint: string;
  /** Raw error text, shown in a details block. Never rendered as markup. */
  detail?: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; problem: Problem };

function fail<T>(problem: Problem): Result<T> {
  return { ok: false, problem };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

type StoreFactory = (app: AppConfig) => ProvenanceStore;

interface StoreModule {
  createStore?: unknown;
}

/**
 * One store per server process. Vercel gives each lambda its own module scope, so
 * this is a per-instance connection pool rather than a global.
 */
let cached: Promise<Result<ProvenanceStore>> | undefined;

async function openStore(): Promise<Result<ProvenanceStore>> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    return fail({
      kind: 'no-database-url',
      title: 'DATABASE_URL is not set',
      hint:
        'Point the dashboard at the libSQL database the worker writes to. ' +
        'Set DATABASE_URL (and DATABASE_AUTH_TOKEN for a hosted Turso database) ' +
        'in the Vercel project environment, then redeploy.',
    });
  }

  let mod: StoreModule;
  try {
    mod = (await import('@provenance/store')) as StoreModule;
  } catch (error) {
    return fail({
      kind: 'store-unavailable',
      title: 'The @provenance/store package could not be loaded',
      hint: 'Build the workspace at the repo root so the store package resolves.',
      detail: errorText(error),
    });
  }

  if (typeof mod.createStore !== 'function') {
    return fail({
      kind: 'store-unavailable',
      title: '@provenance/store does not export createStore() yet',
      hint:
        'The dashboard reads through the ProvenanceStore interface from ' +
        '@provenance/core. Once the store package exports createStore(config), ' +
        'this screen is replaced by live data with no other change.',
    });
  }

  try {
    const store = (mod.createStore as StoreFactory)(loadConfig());
    return { ok: true, value: store };
  } catch (error) {
    return fail({
      kind: 'connect-failed',
      title: 'Could not connect to the database',
      hint: 'Check DATABASE_URL and DATABASE_AUTH_TOKEN, and that the schema has been migrated (`bun run db:migrate`).',
      detail: errorText(error),
    });
  }
}

function store(): Promise<Result<ProvenanceStore>> {
  cached ??= openStore().catch((error: unknown) =>
    fail<ProvenanceStore>({
      kind: 'connect-failed',
      title: 'Could not connect to the database',
      hint: 'Check DATABASE_URL and DATABASE_AUTH_TOKEN, and that the schema has been migrated (`bun run db:migrate`).',
      detail: errorText(error),
    }),
  );
  return cached;
}

/**
 * Runs one store call. A thrown query — a missing table on a database that was
 * never migrated, a dropped connection — becomes a Problem, never a 500.
 */
async function query<T>(
  label: string,
  fn: (s: ProvenanceStore) => Promise<T>,
): Promise<Result<T>> {
  const opened = await store();
  if (!opened.ok) return opened;
  try {
    return { ok: true, value: await fn(opened.value) };
  } catch (error) {
    return fail({
      kind: 'query-failed',
      title: `The database rejected the ${label} query`,
      hint:
        'The schema is probably missing or out of date. Run `bun run db:migrate` ' +
        'against this database, then reload.',
      detail: errorText(error),
    });
  }
}

export function latestRun(): Promise<Result<RunRecord | null>> {
  return query('latest run', (s) => s.latestRun());
}

export function listRuns(limit = 50): Promise<Result<RunRecord[]>> {
  return query('run history', (s) => s.listRuns(limit));
}

export function listDossiers(q: DossierQuery = {}): Promise<Result<TokenDossier[]>> {
  return query('token list', (s) => s.listDossiers(q));
}

export function getDossier(
  tokenId: string,
  runId?: string,
): Promise<Result<TokenDossier | null>> {
  return query('token dossier', (s) => s.getDossier(tokenId, runId));
}

export function listAlerts(limit = 100): Promise<Result<Alert[]>> {
  return query('alert list', (s) => s.listAlerts(limit));
}

export function listWatch(q: WatchQuery = {}): Promise<Result<WatchEntry[]>> {
  return query('watchlist', (s) => s.listWatch(q));
}

export function scoreHistory(
  tokenId: string,
  limit = 60,
): Promise<Result<ProvenanceScore[]>> {
  return query('score history', (s) => s.scoreHistory(tokenId, limit));
}
