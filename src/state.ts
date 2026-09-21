/**
 * Run history in SQLite, via Node's built-in driver - no native dependency.
 *
 * Two jobs: stop the same token being alerted twice in a row, and keep enough
 * history that a token trending again months later can be recognised as a
 * repeat, which is itself the pattern this project is looking for.
 *
 * On GitHub Actions the file is restored from the cache at the start of a run
 * and saved at the end, so history survives across runs without a database
 * server.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { tokenKey, type ProvenanceVerdict, type TokenDossier } from "./models.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sightings (
    token_key     TEXT NOT NULL,
    seen_at       TEXT NOT NULL,
    run_id        TEXT NOT NULL,
    chain         TEXT,
    address       TEXT,
    symbol        TEXT,
    name          TEXT,
    liquidity_usd REAL,
    volume_24h    REAL,
    fdv_usd       REAL,
    score         REAL,
    PRIMARY KEY (token_key, run_id)
);

CREATE TABLE IF NOT EXISTS alerts (
    token_key   TEXT NOT NULL,
    alerted_at  TEXT NOT NULL,
    run_id      TEXT NOT NULL,
    novelty     TEXT,
    confidence  INTEGER,
    one_liner   TEXT,
    verdict     TEXT,
    PRIMARY KEY (token_key, run_id)
);

CREATE INDEX IF NOT EXISTS idx_sightings_token ON sightings(token_key, seen_at);
CREATE INDEX IF NOT EXISTS idx_alerts_token ON alerts(token_key, alerted_at);
`;

export interface AlertRow {
  token_key: string;
  alerted_at: string;
  run_id: string;
  novelty: string | null;
  confidence: number | null;
  one_liner: string | null;
  verdict: string | null;
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // -- writes ----------------------------------------------------------

  recordSighting(dossier: TokenDossier, runId: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sightings
         (token_key, seen_at, run_id, chain, address, symbol, name,
          liquidity_usd, volume_24h, fdv_usd, score)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        tokenKey(dossier.ref),
        new Date().toISOString(),
        runId,
        dossier.ref.chain,
        dossier.ref.address,
        dossier.ref.symbol ?? null,
        dossier.ref.name ?? null,
        dossier.market.liquidityUsd ?? null,
        dossier.market.volume24hUsd ?? null,
        dossier.market.fdvUsd ?? null,
        dossier.heuristicScore,
      );
  }

  recordAlert(dossier: TokenDossier, verdict: ProvenanceVerdict, runId: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO alerts
         (token_key, alerted_at, run_id, novelty, confidence, one_liner, verdict)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        tokenKey(dossier.ref),
        new Date().toISOString(),
        runId,
        verdict.novelty,
        verdict.recycle_confidence,
        verdict.one_liner,
        JSON.stringify(verdict),
      );
  }

  // -- reads -----------------------------------------------------------

  alertedRecently(key: string, withinHours: number): boolean {
    const cutoff = new Date(Date.now() - withinHours * 3_600_000).toISOString();
    const row = this.db
      .prepare("SELECT 1 AS hit FROM alerts WHERE token_key = ? AND alerted_at > ? LIMIT 1")
      .get(key, cutoff);
    return row !== undefined;
  }

  sightingCount(key: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM sightings WHERE token_key = ?")
      .get(key) as { n: number } | undefined;
    return row ? Number(row.n) : 0;
  }

  firstSeen(key: string): string | null {
    const row = this.db
      .prepare("SELECT MIN(seen_at) AS t FROM sightings WHERE token_key = ?")
      .get(key) as { t: string | null } | undefined;
    return row?.t ?? null;
  }

  recentAlerts(limit = 25): AlertRow[] {
    return this.db
      .prepare("SELECT * FROM alerts ORDER BY alerted_at DESC LIMIT ?")
      .all(limit) as unknown as AlertRow[];
  }
}
