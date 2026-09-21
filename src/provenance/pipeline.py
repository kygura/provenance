"""The run.

Order matters here and it is all about cost. Collection and market data are
cheap and batched, so everything trending gets them. Holder and contract data is
one request per token, so only the shortlist gets it. Research is an LLM call
with web search, so only the top of the shortlist gets that. Each stage is
narrower than the one before it.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from provenance.alerts import dispatch
from provenance.config import Config
from provenance.enrich import enrich
from provenance.http import Fetcher
from provenance.models import Report, ReportEntry, TokenDossier
from provenance.research import Analyst
from provenance.scoring import passes_filters, rank, score
from provenance.sources import collect_trending
from provenance.state import Store

log = logging.getLogger(__name__)

# How many tokens get the per-token enrichment calls, as a multiple of the
# research budget. Enough that holder data can reorder the shortlist.
ENRICH_MULTIPLE = 3


def run(config: Config, *, dry_run: bool = False, limit: int | None = None) -> Report:
    run_id = uuid.uuid4().hex[:12]
    report = Report(run_id=run_id, started_at=datetime.now(UTC))
    budget = limit if limit is not None else config.research.max_tokens_per_run

    with Fetcher() as fetcher, Store(config.resolved_state_path()) as store:
        # 1. Who is trending, with market data.
        dossiers = collect_trending(fetcher, config)
        if not dossiers:
            report.errors.append("no trending tokens returned by any source")
            report.finished_at = datetime.now(UTC)
            return report

        # 2. Cheap filters and a first ranking.
        shortlist, dropped = rank(dossiers, config.filters)
        report.skipped = len(dropped)
        for d, reason in dropped[:20]:
            log.info("dropped %s: %s", d.ref, reason)

        for dossier in dossiers:
            store.record_sighting(dossier, run_id)

        # 3. Holder and contract data for the plausible ones only.
        candidates = shortlist[: max(budget * ENRICH_MULTIPLE, budget)]
        for dossier in candidates:
            try:
                enrich(fetcher, dossier, config)
            except Exception as exc:  # noqa: BLE001
                log.warning("enrichment failed for %s: %s", dossier.ref, exc)
            dossier.heuristic_score, dossier.heuristic_notes = score(dossier)

        # 4. Re-filter now that distribution is known, then re-rank.
        rescored: list[TokenDossier] = []
        for dossier in candidates:
            ok, reason = passes_filters(dossier, config.filters)
            if ok:
                rescored.append(dossier)
            else:
                report.skipped += 1
                log.info("dropped after enrichment %s: %s", dossier.ref, reason)
        rescored.sort(key=lambda d: d.heuristic_score, reverse=True)

        # 5. Don't spend a research call on something alerted hours ago.
        queue: list[TokenDossier] = []
        for dossier in rescored:
            if store.alerted_recently(dossier.ref.key, config.alerts.realert_after_hours):
                log.info("skipping %s - alerted within the re-alert window", dossier.ref)
                continue
            queue.append(dossier)
            if len(queue) >= budget:
                break

        log.info(
            "%d trending -> %d past filters -> %d enriched -> %d queued for research",
            len(dossiers),
            len(shortlist),
            len(candidates),
            len(queue),
        )

        if dry_run:
            report.entries = [ReportEntry(dossier=d) for d in queue]
            report.finished_at = datetime.now(UTC)
            return report

        # 6. Research.
        analyst = Analyst(config.secrets.anthropic_api_key, config.research)
        for dossier in queue:
            log.info("researching %s (score %.0f)", dossier.ref, dossier.heuristic_score)
            entry = ReportEntry(dossier=dossier)
            try:
                result = analyst.investigate(dossier)
                entry.research_notes = result.notes
                entry.citations = result.citations
                entry.verdict = result.verdict
                log.info("  %d search(es), %d source(s)", result.searches_run, len(result.citations))
            except Exception as exc:  # noqa: BLE001 - one failure must not end the run
                log.exception("research failed for %s", dossier.ref)
                entry.error = f"{type(exc).__name__}: {exc}"
                report.errors.append(f"{dossier.ref}: {entry.error}")
            report.entries.append(entry)

        # 7. Alert on what clears the bar; the rest stays in the report.
        alertable = [e for e in report.entries if _should_alert(e, config)]
        for entry in alertable:
            assert entry.verdict is not None
            store.record_alert(entry.dossier, entry.verdict, run_id)

        report.finished_at = datetime.now(UTC)
        channels = dispatch(report, alertable, config, fetcher)
        log.info("alerted %d token(s) via %s", len(alertable), ", ".join(channels) or "nothing")

    return report


def _should_alert(entry: ReportEntry, config: Config) -> bool:
    verdict = entry.verdict
    if verdict is None:
        return False
    if verdict.recycle_confidence < config.alerts.min_recycle_confidence:
        return False
    return verdict.novelty in config.alerts.novelty_allowlist
