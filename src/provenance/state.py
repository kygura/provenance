"""Run history in SQLite.

Two jobs: stop the same token being alerted twice in a row, and keep enough
history that a token trending again months later can be recognised as a repeat -
which is itself the pattern this project is looking for.

On GitHub Actions the file is restored from the cache at the start of a run and
saved at the end, so history survives across runs without a database server.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from datetime import UTC, datetime, timedelta
from pathlib import Path

from provenance.models import ProvenanceVerdict, TokenDossier

SCHEMA = """
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
"""


def _now() -> str:
    return datetime.now(UTC).isoformat()


class Store:
    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        with closing(self.conn.cursor()) as cur:
            cur.executescript(SCHEMA)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> Store:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # -- writes ----------------------------------------------------------

    def record_sighting(self, dossier: TokenDossier, run_id: str) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO sightings "
            "(token_key, seen_at, run_id, chain, address, symbol, name, "
            " liquidity_usd, volume_24h, fdv_usd, score) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                dossier.ref.key,
                _now(),
                run_id,
                dossier.ref.chain,
                dossier.ref.address,
                dossier.ref.symbol,
                dossier.ref.name,
                dossier.market.liquidity_usd,
                dossier.market.volume_24h_usd,
                dossier.market.fdv_usd,
                dossier.heuristic_score,
            ),
        )
        self.conn.commit()

    def record_alert(
        self, dossier: TokenDossier, verdict: ProvenanceVerdict, run_id: str
    ) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO alerts "
            "(token_key, alerted_at, run_id, novelty, confidence, one_liner, verdict) "
            "VALUES (?,?,?,?,?,?,?)",
            (
                dossier.ref.key,
                _now(),
                run_id,
                verdict.novelty,
                verdict.recycle_confidence,
                verdict.one_liner,
                json.dumps(verdict.model_dump(mode="json")),
            ),
        )
        self.conn.commit()

    # -- reads -----------------------------------------------------------

    def alerted_recently(self, token_key: str, within_hours: float) -> bool:
        cutoff = (datetime.now(UTC) - timedelta(hours=within_hours)).isoformat()
        row = self.conn.execute(
            "SELECT 1 FROM alerts WHERE token_key = ? AND alerted_at > ? LIMIT 1",
            (token_key, cutoff),
        ).fetchone()
        return row is not None

    def sighting_count(self, token_key: str) -> int:
        row = self.conn.execute(
            "SELECT COUNT(*) AS n FROM sightings WHERE token_key = ?", (token_key,)
        ).fetchone()
        return int(row["n"]) if row else 0

    def first_seen(self, token_key: str) -> str | None:
        row = self.conn.execute(
            "SELECT MIN(seen_at) AS t FROM sightings WHERE token_key = ?", (token_key,)
        ).fetchone()
        return row["t"] if row and row["t"] else None

    def recent_alerts(self, limit: int = 25) -> list[sqlite3.Row]:
        return list(
            self.conn.execute(
                "SELECT * FROM alerts ORDER BY alerted_at DESC LIMIT ?", (limit,)
            )
        )
