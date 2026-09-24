-- Provenance store schema.
--
-- GENERATED from MIGRATIONS in migrate.ts — do not hand-edit.
--   bun run packages/store/src/migrate.ts --emit-schema
-- packages/store/src/schema.test.ts fails if this file drifts from the code.
--
-- Kept as a readable artefact: `sqlite3 provenance.db < schema.sql` gives a
-- database identical to a fully migrated one, minus the schema_migrations rows.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

-- ===== migration 001: initial =====

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_runs_status ON runs (status, started_at DESC);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  image_url TEXT,
  description TEXT,
  socials_json TEXT NOT NULL DEFAULT '{}',
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tokens_chain ON tokens (chain);

CREATE INDEX IF NOT EXISTS idx_tokens_first_seen_at ON tokens (first_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_tokens_last_seen_at ON tokens (last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_tokens_symbol_lower ON tokens (lower(symbol));

CREATE INDEX IF NOT EXISTS idx_tokens_name_lower ON tokens (lower(name));

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  token_id TEXT NOT NULL REFERENCES tokens (id) ON DELETE CASCADE,
  captured_at TEXT NOT NULL,
  best_rank INTEGER NOT NULL,
  source_count INTEGER NOT NULL,
  metrics_json TEXT NOT NULL,
  pairs_json TEXT NOT NULL,
  appearances_json TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_run_token ON snapshots (run_id, token_id);

CREATE INDEX IF NOT EXISTS idx_snapshots_run_rank ON snapshots (run_id, best_rank);

CREATE INDEX IF NOT EXISTS idx_snapshots_run_captured ON snapshots (run_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_snapshots_token_captured ON snapshots (token_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS chain_analysis (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  token_id TEXT NOT NULL REFERENCES tokens (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  method TEXT NOT NULL,
  top10_pct REAL,
  holder_count INTEGER,
  data_json TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_chain_analysis_run_token ON chain_analysis (run_id, token_id);

CREATE INDEX IF NOT EXISTS idx_chain_analysis_token_created ON chain_analysis (token_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_chain_analysis_method ON chain_analysis (method);

CREATE INDEX IF NOT EXISTS idx_chain_analysis_top10 ON chain_analysis (top10_pct);

CREATE TABLE IF NOT EXISTS provenance (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  token_id TEXT NOT NULL REFERENCES tokens (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  meme_name TEXT NOT NULL,
  narrative_cluster TEXT NOT NULL,
  recycle_verdict TEXT NOT NULL,
  recycle_generation INTEGER NOT NULL,
  confidence REAL NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  report_json TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provenance_run_token ON provenance (run_id, token_id);

CREATE INDEX IF NOT EXISTS idx_provenance_token_created ON provenance (token_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_provenance_verdict ON provenance (recycle_verdict);

CREATE INDEX IF NOT EXISTS idx_provenance_cluster ON provenance (narrative_cluster);

CREATE INDEX IF NOT EXISTS idx_provenance_confidence ON provenance (confidence DESC);

CREATE INDEX IF NOT EXISTS idx_provenance_meme_lower ON provenance (lower(meme_name));

CREATE TABLE IF NOT EXISTS scores (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  token_id TEXT NOT NULL REFERENCES tokens (id) ON DELETE CASCADE,
  computed_at TEXT NOT NULL,
  total REAL NOT NULL,
  tier TEXT NOT NULL,
  components_json TEXT NOT NULL,
  penalties_json TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scores_run_token ON scores (run_id, token_id);

CREATE INDEX IF NOT EXISTS idx_scores_run_total ON scores (run_id, total DESC);

CREATE INDEX IF NOT EXISTS idx_scores_token_computed ON scores (token_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_scores_tier ON scores (tier, total DESC);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  token_id TEXT NOT NULL REFERENCES tokens (id) ON DELETE CASCADE,
  rule TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  markdown TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  deliveries_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alerts_created_at ON alerts (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alerts_run_created ON alerts (run_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alerts_token_created ON alerts (token_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alerts_rule ON alerts (rule, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts (severity, created_at DESC);

CREATE TABLE IF NOT EXISTS evidence_cache (
  key TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  content TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_cache_fetched_at ON evidence_cache (fetched_at DESC);

-- ===== migration 002: watchlist =====

CREATE TABLE IF NOT EXISTS watchlist (
  token_id TEXT PRIMARY KEY,
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  launched_at TEXT,
  expressed_at TEXT,
  lead_hours REAL,
  referent TEXT,
  referent_confidence TEXT,
  updated_at TEXT NOT NULL,
  entry_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_watchlist_status ON watchlist (status, first_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_watchlist_first_seen_at ON watchlist (first_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_watchlist_expressed_at ON watchlist (expressed_at DESC);

-- ===== migration 003: meme-identity =====

CREATE TABLE IF NOT EXISTS memes (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  narrative_cluster TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memes_cluster ON memes (narrative_cluster);

CREATE INDEX IF NOT EXISTS idx_memes_last_seen_at ON memes (last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_memes_display_lower ON memes (lower(display_name));

ALTER TABLE provenance ADD COLUMN meme_id TEXT REFERENCES memes (id);

CREATE INDEX IF NOT EXISTS idx_provenance_meme ON provenance (meme_id, created_at DESC);
