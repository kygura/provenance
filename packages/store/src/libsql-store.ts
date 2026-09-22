import { createClient, type Client, type InStatement, type Row } from '@libsql/client';
import type {
  Alert,
  AppConfig,
  ChainAnalysis,
  DeliveryResult,
  DossierQuery,
  Logger,
  MemeRecord,
  MemeSighting,
  ProvenanceReport,
  ProvenanceScore,
  ProvenanceStore,
  RunRecord,
  RunStats,
  RunStatus,
  TokenDossier,
  TokenSnapshot,
} from '@provenance/core';
import { createLogger, nowIso, silentLogger } from '@provenance/core';
import {
  alertRowArgs,
  chainRowArgs,
  EMPTY_STATS,
  provenanceRowArgs,
  rowToAlert,
  rowToChainAnalysis,
  rowToMeme,
  rowToMemeSighting,
  rowToProvenance,
  rowToRun,
  rowToScore,
  rowToSnapshot,
  scoreRowArgs,
  snapshotRowArgs,
  tokenRowArgs,
  text,
  type SqlRow,
} from './mappers';
import { applyLocalPragmas, isRemoteUrl, migrate } from './migrate';

export interface LibsqlStoreOptions {
  /** `file:./data/provenance.db`, `libsql://…turso.io` or `:memory:`. */
  url: string;
  /** Required for remote libSQL only. */
  authToken?: string;
  logger?: Logger;
  /** Pre-built client, for tests that want to observe the traffic. */
  client?: Client;
}

/** Everything one token accumulated during a run, written as a single unit. */
export interface TokenBundle {
  snapshot: TokenSnapshot;
  chain?: ChainAnalysis;
  provenance?: ProvenanceReport;
  score?: ProvenanceScore;
  alerts?: { alert: Alert; deliveries: DeliveryResult[] }[];
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
/** SQLite's default parameter ceiling is 999; stay well under it per statement. */
const ID_CHUNK = 200;

/**
 * ORDER BY is the one place a query builder is tempted to interpolate. It never
 * does here: the caller's `orderBy` is a key into this frozen map and nothing
 * else, so an unexpected value degrades to the documented default instead of
 * reaching SQL.
 */
const ORDER_BY: Record<NonNullable<DossierQuery['orderBy']>, string> = {
  // `IS NULL` first keeps unscored tokens at the bottom; SQLite has no NULLS LAST.
  score: 'sc.total IS NULL, sc.total DESC, sn.best_rank ASC, sn.token_id ASC',
  capturedAt: 'sn.captured_at DESC, sn.best_rank ASC, sn.token_id ASC',
  rank: 'sn.best_rank ASC, sn.captured_at DESC, sn.token_id ASC',
};

const SNAPSHOT_COLUMNS = `sn.token_id AS token_id, sn.captured_at AS captured_at, sn.best_rank AS best_rank,
    sn.source_count AS source_count, sn.metrics_json AS metrics_json, sn.pairs_json AS pairs_json,
    sn.appearances_json AS appearances_json, t.id AS id, t.chain AS chain, t.address AS address,
    t.symbol AS symbol, t.name AS name, t.image_url AS image_url, t.description AS description,
    t.socials_json AS socials_json`;

/**
 * `TokenSnapshot` identity is upserted into `tokens`; the measurement goes to
 * `snapshots`. min()/max() on the ISO strings mean a late-arriving backfill can
 * only ever widen the [first_seen_at, last_seen_at] window, never reset it.
 */
const TOKEN_UPSERT = `INSERT INTO tokens
    (id, chain, address, symbol, name, image_url, description, socials_json, first_seen_at, last_seen_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    chain = excluded.chain,
    address = excluded.address,
    symbol = excluded.symbol,
    name = excluded.name,
    image_url = COALESCE(excluded.image_url, tokens.image_url),
    description = COALESCE(excluded.description, tokens.description),
    socials_json = excluded.socials_json,
    first_seen_at = MIN(tokens.first_seen_at, excluded.first_seen_at),
    last_seen_at = MAX(tokens.last_seen_at, excluded.last_seen_at)`;

const SNAPSHOT_UPSERT = `INSERT INTO snapshots
    (id, run_id, token_id, captured_at, best_rank, source_count, metrics_json, pairs_json, appearances_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(run_id, token_id) DO UPDATE SET
    captured_at = excluded.captured_at,
    best_rank = excluded.best_rank,
    source_count = excluded.source_count,
    metrics_json = excluded.metrics_json,
    pairs_json = excluded.pairs_json,
    appearances_json = excluded.appearances_json`;

const CHAIN_UPSERT = `INSERT INTO chain_analysis
    (id, run_id, token_id, created_at, method, top10_pct, holder_count, data_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(run_id, token_id) DO UPDATE SET
    created_at = excluded.created_at,
    method = excluded.method,
    top10_pct = excluded.top10_pct,
    holder_count = excluded.holder_count,
    data_json = excluded.data_json`;

const MEME_UPSERT = `INSERT INTO memes
    (id, display_name, narrative_cluster, first_seen_at, last_seen_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    last_seen_at = excluded.last_seen_at,
    -- The display name and cluster are NOT overwritten. The first resolution
    -- wins, so a later run that reports "NYAN CAT" or reclassifies the cluster
    -- cannot rewrite the canonical row underneath every report already
    -- pointing at it. first_seen_at is likewise left alone.
    narrative_cluster = memes.narrative_cluster`;

/**
 * Tokens previously seen running a meme, newest first, with their latest score.
 *
 * Joined through `provenance` rather than a token column, because a token's
 * meme is a finding of the research pass, not a property of the contract — and
 * the same token can be re-researched into a different meme.
 */
const MEME_HISTORY = `SELECT
    t.id AS token_id, t.chain, t.symbol, t.name,
    t.first_seen_at, t.last_seen_at,
    p.recycle_verdict,
    sc.total AS score, sc.tier AS tier
  FROM (
    SELECT token_id, recycle_verdict, MAX(created_at) AS created_at
    FROM provenance WHERE meme_id = ? GROUP BY token_id
  ) p
  JOIN tokens t ON t.id = p.token_id
  LEFT JOIN (
    SELECT token_id, total, tier, MAX(computed_at) AS computed_at
    FROM scores GROUP BY token_id
  ) sc ON sc.token_id = p.token_id
  WHERE t.id IS NOT NULL`;

const PROVENANCE_UPSERT = `INSERT INTO provenance
    (id, run_id, token_id, created_at, meme_name, narrative_cluster, recycle_verdict,
     recycle_generation, confidence, model, prompt_version, report_json, meme_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(run_id, token_id) DO UPDATE SET
    created_at = excluded.created_at,
    meme_name = excluded.meme_name,
    narrative_cluster = excluded.narrative_cluster,
    recycle_verdict = excluded.recycle_verdict,
    recycle_generation = excluded.recycle_generation,
    confidence = excluded.confidence,
    model = excluded.model,
    prompt_version = excluded.prompt_version,
    report_json = excluded.report_json,
    meme_id = excluded.meme_id`;

const SCORE_UPSERT = `INSERT INTO scores
    (id, run_id, token_id, computed_at, total, tier, components_json, penalties_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(run_id, token_id) DO UPDATE SET
    computed_at = excluded.computed_at,
    total = excluded.total,
    tier = excluded.tier,
    components_json = excluded.components_json,
    penalties_json = excluded.penalties_json`;

const ALERT_UPSERT = `INSERT INTO alerts
    (id, run_id, token_id, rule, severity, title, body, markdown, created_at, payload_json, deliveries_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    rule = excluded.rule,
    severity = excluded.severity,
    title = excluded.title,
    body = excluded.body,
    markdown = excluded.markdown,
    created_at = excluded.created_at,
    payload_json = excluded.payload_json,
    deliveries_json = excluded.deliveries_json`;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

/** LIKE wildcards in user input are literal, not operators. */
function likeTerm(search: string): string {
  const escaped = search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

function ageHours(fetchedAt: string, now: number): number {
  const then = Date.parse(fetchedAt);
  if (!Number.isFinite(then)) return Number.POSITIVE_INFINITY;
  // Clock skew between the worker and the reader can make a row look like it was
  // fetched in the future; treat that as fresh rather than as infinitely stale.
  return Math.max(0, (now - then) / 3_600_000);
}

/**
 * libSQL-backed `ProvenanceStore`. One class covers all three deployments —
 * the Bun worker on a local file, the Vercel dashboard on remote Turso over
 * HTTP, and `:memory:` in tests — because `@libsql/client` hides the transport
 * behind one API. The only behavioural difference is pragmas (see migrate.ts).
 */
export class LibsqlStore implements ProvenanceStore {
  private readonly client: Client;
  private readonly logger: Logger;
  private readonly url: string;
  private readied: Promise<void> | null = null;
  private isClosed = false;

  constructor(options: LibsqlStoreOptions) {
    this.url = options.url;
    this.logger = (options.logger ?? silentLogger).child('store');
    this.client =
      options.client ??
      createClient(
        options.authToken && isRemoteUrl(options.url)
          ? { url: options.url, authToken: options.authToken }
          : { url: options.url },
      );
  }

  /** Escape hatch for the seed script and for tests; not part of the contract. */
  get raw(): Client {
    return this.client;
  }

  private ready(): Promise<void> {
    this.readied ??= applyLocalPragmas(this.client, this.url).catch((error) => {
      // A store that cannot set pragmas is still a usable store.
      this.logger.warn('could not apply local pragmas', { error: String(error) });
    });
    return this.readied;
  }

  private async all(stmt: InStatement): Promise<Row[]> {
    await this.ready();
    const result = await this.client.execute(stmt);
    return result.rows;
  }

  private async one(stmt: InStatement): Promise<Row | null> {
    const rows = await this.all(stmt);
    return rows[0] ?? null;
  }

  private async write(stmts: InStatement[]): Promise<void> {
    await this.ready();
    if (stmts.length === 0) return;
    if (stmts.length === 1) {
      // `batch` would wrap a single statement in a pointless transaction.
      await this.client.execute(stmts[0] as InStatement);
      return;
    }
    await this.client.batch(stmts, 'write');
  }

  // -------------------------------------------------------------------------
  // schema
  // -------------------------------------------------------------------------

  async migrate(): Promise<void> {
    await this.ready();
    await migrate(this.client, this.logger);
  }

  // -------------------------------------------------------------------------
  // runs
  // -------------------------------------------------------------------------

  async startRun(id: string): Promise<RunRecord> {
    const run: RunRecord = {
      id,
      startedAt: new Date().toISOString(),
      status: 'running',
      stats: { ...EMPTY_STATS },
    };
    await this.write([
      {
        sql: `INSERT INTO runs (id, started_at, finished_at, status, stats_json, error)
              VALUES (?, ?, NULL, ?, ?, NULL)
              ON CONFLICT(id) DO UPDATE SET
                started_at = excluded.started_at,
                finished_at = NULL,
                status = excluded.status,
                stats_json = excluded.stats_json,
                error = NULL`,
        args: [run.id, run.startedAt, run.status, JSON.stringify(run.stats)],
      },
    ]);
    return run;
  }

  async finishRun(id: string, status: RunStatus, stats: RunStats, error?: string): Promise<void> {
    await this.write([
      {
        sql: `UPDATE runs SET finished_at = ?, status = ?, stats_json = ?, error = ? WHERE id = ?`,
        args: [new Date().toISOString(), status, JSON.stringify(stats), error ?? null, id],
      },
    ]);
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const row = await this.one({ sql: 'SELECT * FROM runs WHERE id = ?', args: [id] });
    return row ? rowToRun(row as SqlRow, this.logger) : null;
  }

  async latestRun(): Promise<RunRecord | null> {
    const row = await this.one('SELECT * FROM runs ORDER BY started_at DESC, id DESC LIMIT 1');
    return row ? rowToRun(row as SqlRow, this.logger) : null;
  }

  async listRuns(limit = 20): Promise<RunRecord[]> {
    const rows = await this.all({
      sql: 'SELECT * FROM runs ORDER BY started_at DESC, id DESC LIMIT ?',
      args: [Math.max(1, Math.trunc(limit))],
    });
    return rows.map((row) => rowToRun(row as SqlRow, this.logger));
  }

  // -------------------------------------------------------------------------
  // writes
  // -------------------------------------------------------------------------

  async saveSnapshot(runId: string, snapshot: TokenSnapshot): Promise<void> {
    // Two statements, one transaction: a token row without its snapshot (or the
    // reverse) would show up in the dashboard as a half-written token.
    await this.write([
      { sql: TOKEN_UPSERT, args: tokenRowArgs(snapshot) },
      { sql: SNAPSHOT_UPSERT, args: snapshotRowArgs(runId, snapshot) },
    ]);
  }

  async saveChainAnalysis(runId: string, analysis: ChainAnalysis): Promise<void> {
    await this.write([{ sql: CHAIN_UPSERT, args: chainRowArgs(runId, analysis) }]);
  }

  async saveProvenance(runId: string, report: ProvenanceReport): Promise<void> {
    await this.write([{ sql: PROVENANCE_UPSERT, args: provenanceRowArgs(runId, report) }]);
  }

  async resolveMeme(input: {
    id: string;
    displayName: string;
    narrativeCluster: string;
  }): Promise<MemeRecord> {
    const now = nowIso();
    await this.write([
      { sql: MEME_UPSERT, args: [input.id, input.displayName, input.narrativeCluster, now, now] },
    ]);
    const rows = await this.all({ sql: 'SELECT * FROM memes WHERE id = ?', args: [input.id] });
    const row = rows[0];
    if (row === undefined) {
      // The upsert just ran; a miss here means the write did not land.
      throw new Error(`meme "${input.id}" vanished between upsert and read`);
    }
    return rowToMeme(row as SqlRow);
  }

  async memeHistory(
    memeId: string,
    options: { excludeTokenId?: string; limit?: number } = {},
  ): Promise<MemeSighting[]> {
    if (memeId === '') return [];
    const limit = Math.min(50, Math.max(1, Math.trunc(options.limit ?? 10)));
    const args: (string | number)[] = [memeId];
    let sql = MEME_HISTORY;
    if (options.excludeTokenId !== undefined) {
      sql += ' AND t.id != ?';
      args.push(options.excludeTokenId);
    }
    sql += ' ORDER BY t.last_seen_at DESC LIMIT ?';
    args.push(limit);
    const rows = await this.all({ sql, args });
    return rows.map((row) => rowToMemeSighting(row as SqlRow));
  }

  async saveScore(runId: string, score: ProvenanceScore): Promise<void> {
    await this.write([{ sql: SCORE_UPSERT, args: scoreRowArgs(runId, score) }]);
  }

  async saveAlert(alert: Alert, deliveries: DeliveryResult[]): Promise<void> {
    await this.write([{ sql: ALERT_UPSERT, args: alertRowArgs(alert, deliveries) }]);
  }

  /**
   * Everything a run learned about one token, committed atomically. Preferred
   * over the per-entity setters inside the pipeline: a crash mid-token leaves
   * the token entirely absent rather than scored but unexplained.
   */
  async saveTokenBundle(runId: string, bundle: TokenBundle): Promise<void> {
    const stmts: InStatement[] = [
      { sql: TOKEN_UPSERT, args: tokenRowArgs(bundle.snapshot) },
      { sql: SNAPSHOT_UPSERT, args: snapshotRowArgs(runId, bundle.snapshot) },
    ];
    if (bundle.chain) stmts.push({ sql: CHAIN_UPSERT, args: chainRowArgs(runId, bundle.chain) });
    if (bundle.provenance) stmts.push({ sql: PROVENANCE_UPSERT, args: provenanceRowArgs(runId, bundle.provenance) });
    if (bundle.score) stmts.push({ sql: SCORE_UPSERT, args: scoreRowArgs(runId, bundle.score) });
    for (const entry of bundle.alerts ?? []) {
      stmts.push({ sql: ALERT_UPSERT, args: alertRowArgs(entry.alert, entry.deliveries) });
    }
    await this.write(stmts);
  }

  // -------------------------------------------------------------------------
  // per-token history
  // -------------------------------------------------------------------------

  async latestProvenance(tokenId: string): Promise<ProvenanceReport | null> {
    const row = await this.one({
      sql: 'SELECT * FROM provenance WHERE token_id = ? ORDER BY created_at DESC LIMIT 1',
      args: [tokenId],
    });
    return row ? rowToProvenance(row as SqlRow, this.logger) : null;
  }

  async scoreHistory(tokenId: string, limit = 50): Promise<ProvenanceScore[]> {
    // Most recent N, returned oldest first — the shape delta rules want.
    const rows = await this.all({
      sql: `SELECT * FROM (
              SELECT * FROM scores WHERE token_id = ? ORDER BY computed_at DESC LIMIT ?
            ) ORDER BY computed_at ASC`,
      args: [tokenId, Math.max(1, Math.trunc(limit))],
    });
    return rows.map((row) => rowToScore(row as SqlRow, this.logger));
  }

  async listAlerts(limit = 50): Promise<Alert[]> {
    const rows = await this.all({
      sql: 'SELECT * FROM alerts ORDER BY created_at DESC, id DESC LIMIT ?',
      args: [Math.max(1, Math.trunc(limit))],
    });
    return rows.map((row) => rowToAlert(row as SqlRow, this.logger));
  }

  // -------------------------------------------------------------------------
  // dossiers
  // -------------------------------------------------------------------------

  async listDossiers(query: DossierQuery = {}): Promise<TokenDossier[]> {
    const runId = query.runId ?? (await this.latestRunId());
    if (!runId) return [];

    // Step 1 — one "spine" query decides which tokens appear and in what order.
    // scores and provenance are joined here because every filter and every sort
    // key lives in a promoted column on one of them.
    const where: string[] = ['sn.run_id = ?'];
    const args: (string | number)[] = [runId];

    if (query.chain) {
      where.push('t.chain = ?');
      args.push(query.chain);
    }
    if (typeof query.minScore === 'number') {
      where.push('sc.total >= ?');
      args.push(query.minScore);
    }
    if (query.tier) {
      where.push('sc.tier = ?');
      args.push(query.tier);
    }
    if (query.verdict) {
      where.push('p.recycle_verdict = ?');
      args.push(query.verdict);
    }
    if (query.search && query.search.trim() !== '') {
      const term = likeTerm(query.search.trim());
      where.push(`(
        lower(t.symbol) LIKE ? ESCAPE '\\'
        OR lower(t.name) LIKE ? ESCAPE '\\'
        OR lower(COALESCE(p.meme_name, '')) LIKE ? ESCAPE '\\'
      )`);
      args.push(term, term, term);
    }

    // Whitelist lookup, never interpolation: an unknown key falls back silently.
    const orderKey = query.orderBy && query.orderBy in ORDER_BY ? query.orderBy : 'score';
    const order = ORDER_BY[orderKey];
    const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.trunc(query.limit ?? DEFAULT_LIST_LIMIT)));
    const offset = Math.max(0, Math.trunc(query.offset ?? 0));

    const spine = await this.all({
      sql: `SELECT sn.token_id AS token_id
            FROM snapshots sn
            JOIN tokens t ON t.id = sn.token_id
            LEFT JOIN scores sc ON sc.run_id = sn.run_id AND sc.token_id = sn.token_id
            LEFT JOIN provenance p ON p.run_id = sn.run_id AND p.token_id = sn.token_id
            WHERE ${where.join(' AND ')}
            ORDER BY ${order}
            LIMIT ? OFFSET ?`,
      args: [...args, limit, offset],
    });

    const tokenIds = spine.map((row) => text((row as SqlRow).token_id)).filter((id) => id !== '');
    return this.stitch(runId, tokenIds);
  }

  async getDossier(tokenId: string, runId?: string): Promise<TokenDossier | null> {
    let resolved = runId;
    if (!resolved) {
      // No run given: the newest run that actually saw this token, which is not
      // necessarily the newest run overall.
      const row = await this.one({
        sql: 'SELECT run_id FROM snapshots WHERE token_id = ? ORDER BY captured_at DESC LIMIT 1',
        args: [tokenId],
      });
      resolved = row ? text((row as SqlRow).run_id) : undefined;
    }
    if (!resolved) return null;
    const [dossier] = await this.stitch(resolved, [tokenId]);
    return dossier ?? null;
  }

  /**
   * The no-N+1 core. Given a run and an already-ordered set of token ids, every
   * table is read exactly once (chunked only to stay under SQLite's parameter
   * limit) and the five result sets are joined in memory. The whole thing is one
   * `batch(…, 'read')`, i.e. a single round trip — which is what makes the
   * dashboard tolerable against a remote Turso database.
   */
  private async stitch(runId: string, tokenIds: readonly string[]): Promise<TokenDossier[]> {
    if (tokenIds.length === 0) return [];
    await this.ready();

    type Kind = 'snapshot' | 'chain' | 'provenance' | 'score' | 'alert';
    const stmts: InStatement[] = [];
    const kinds: Kind[] = [];
    const push = (kind: Kind, sql: string, args: (string | number)[]) => {
      stmts.push({ sql, args });
      kinds.push(kind);
    };

    for (const ids of chunk(tokenIds, ID_CHUNK)) {
      const ph = placeholders(ids.length);
      push(
        'snapshot',
        `SELECT ${SNAPSHOT_COLUMNS}
         FROM snapshots sn JOIN tokens t ON t.id = sn.token_id
         WHERE sn.run_id = ? AND sn.token_id IN (${ph})`,
        [runId, ...ids],
      );
      push('chain', `SELECT * FROM chain_analysis WHERE run_id = ? AND token_id IN (${ph})`, [runId, ...ids]);
      push('provenance', `SELECT * FROM provenance WHERE run_id = ? AND token_id IN (${ph})`, [runId, ...ids]);
      push('score', `SELECT * FROM scores WHERE run_id = ? AND token_id IN (${ph})`, [runId, ...ids]);
      push(
        'alert',
        `SELECT * FROM alerts WHERE run_id = ? AND token_id IN (${ph}) ORDER BY created_at DESC, id DESC`,
        [runId, ...ids],
      );
    }

    const results = await this.client.batch(stmts, 'read');

    const snapshots = new Map<string, TokenSnapshot>();
    const chains = new Map<string, ChainAnalysis>();
    const reports = new Map<string, ProvenanceReport>();
    const scores = new Map<string, ProvenanceScore>();
    const alerts = new Map<string, Alert[]>();

    results.forEach((result, index) => {
      const kind = kinds[index];
      for (const row of result.rows) {
        const sqlRow = row as SqlRow;
        const id = text(sqlRow.token_id);
        if (id === '') continue;
        switch (kind) {
          case 'snapshot':
            snapshots.set(id, rowToSnapshot(sqlRow, sqlRow, this.logger));
            break;
          case 'chain':
            chains.set(id, rowToChainAnalysis(sqlRow, this.logger));
            break;
          case 'provenance':
            reports.set(id, rowToProvenance(sqlRow, this.logger));
            break;
          case 'score':
            scores.set(id, rowToScore(sqlRow, this.logger));
            break;
          case 'alert': {
            const list = alerts.get(id);
            if (list) list.push(rowToAlert(sqlRow, this.logger));
            else alerts.set(id, [rowToAlert(sqlRow, this.logger)]);
            break;
          }
          default:
            break;
        }
      }
    });

    const dossiers: TokenDossier[] = [];
    for (const id of tokenIds) {
      const snapshot = snapshots.get(id);
      if (!snapshot) continue; // token not in this run; nothing to render
      dossiers.push({
        snapshot,
        chain: chains.get(id),
        provenance: reports.get(id),
        score: scores.get(id),
        alerts: alerts.get(id) ?? [],
        runId,
      });
    }
    return dossiers;
  }

  private async latestRunId(): Promise<string | null> {
    const row = await this.one('SELECT id FROM runs ORDER BY started_at DESC, id DESC LIMIT 1');
    return row ? text((row as SqlRow).id) || null : null;
  }

  // -------------------------------------------------------------------------
  // evidence cache
  // -------------------------------------------------------------------------

  async getCachedEvidence(key: string, maxAgeHours: number): Promise<string | null> {
    const row = await this.one({
      sql: 'SELECT content, fetched_at FROM evidence_cache WHERE key = ?',
      args: [key],
    });
    if (!row) return null;
    const sqlRow = row as SqlRow;
    // TTL is evaluated here rather than in SQL: ISO-8601 strings and SQLite's
    // julianday() disagree about fractional seconds and trailing `Z`.
    if (ageHours(text(sqlRow.fetched_at), Date.now()) > maxAgeHours) return null;
    return text(sqlRow.content);
  }

  async putCachedEvidence(key: string, url: string, content: string): Promise<void> {
    await this.write([
      {
        sql: `INSERT INTO evidence_cache (key, url, fetched_at, content)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET
                url = excluded.url,
                fetched_at = excluded.fetched_at,
                content = excluded.content`,
        args: [key, url, new Date().toISOString(), content],
      },
    ]);
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    try {
      this.client.close();
    } catch (error) {
      this.logger.warn('error closing client', { error: String(error) });
    }
  }
}

/**
 * The one constructor other packages use. `databaseUrl` alone covers all three
 * deployments; `databaseAuthToken` is read only when the URL is remote, so a
 * stray token in the environment cannot confuse a local file database.
 */
export function createStore(app: AppConfig): ProvenanceStore {
  return new LibsqlStore({
    url: app.databaseUrl,
    authToken: app.databaseAuthToken,
    logger: createLogger(app.logLevel, 'store'),
  });
}
