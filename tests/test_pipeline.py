"""End-to-end with the network and the model stubbed out.

The fake fetcher answers by URL so the real source adapters, enrichment,
scoring, state and rendering all run; only the two things that cost money are
replaced.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from provenance import pipeline
from provenance.alerts.render import render_report_markdown
from provenance.config import AlertConfig, Config, FilterConfig, ResearchConfig, SourceConfig
from provenance.models import ProvenanceVerdict
from provenance.research.analyst import ResearchResult
from tests.conftest import load

TOKEN = "TOKEN111111111111111111111111111111111111111"


class FakeFetcher:
    """Routes on substrings of the URL. Anything unrecognised returns None, which
    is exactly how a real dead endpoint behaves here."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.posts: list[tuple[str, dict]] = []

    def get_json(self, url: str, **kwargs):
        self.calls.append(url)
        if "token-boosts" in url:
            return [{"chainId": "solana", "tokenAddress": TOKEN, "amount": 500}]
        if "/tokens/v1/" in url or "/latest/dex/tokens/" in url:
            return [load("dexscreener_pair")]
        if "trending_pools" in url:
            return {"data": [load("geckoterminal_pool")]}
        if "solana/token_security" in url:
            return {"result": {TOKEN: load("goplus_solana")}}
        if "token_security/" in url:
            return {"result": {TOKEN.lower(): load("goplus_evm")}}
        return None

    def post_json(self, url: str, payload, **kwargs):
        self.posts.append((url, payload))
        return {"ok": True, "html_url": "https://example.invalid/issues/1"}

    def close(self) -> None:
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return None


def sample_verdict(confidence: int = 80) -> ProvenanceVerdict:
    return ProvenanceVerdict(
        one_liner="A 2023 dog meme relaunched with a new contract.",
        archetype="dog coin",
        origin_story="Re-uses the 2023 dogwifhat image and naming.",
        lineage=[
            {
                "name": "dogwifhat",
                "ticker": "WIF",
                "era": "2023-24",
                "peak_context": "Reached roughly $4B FDV on the hat image alone.",
                "what_happened_next": "Drew down heavily through 2025.",
                "resemblance": "Same image, same naming convention, new mint.",
                "evidence_urls": ["https://example.invalid/wif"],
            }
        ],
        novelty="pure-rerun",
        cycle_distance_years=2.0,
        recycle_confidence=confidence,
        audience_read="Holder base is young and mostly new wallets.",
        what_would_confirm=["holder count keeps climbing without the price stalling"],
        what_would_kill_it=["the original community publicly disavows it"],
        red_flags=["freeze authority is still live"],
        open_questions=["deployer identity is unestablished"],
    )


@pytest.fixture
def config(tmp_path) -> Config:
    cfg = Config(
        sources=SourceConfig(chains=["solana"], dextools_enabled=False, per_source_limit=5),
        filters=FilterConfig(),
        research=ResearchConfig(max_tokens_per_run=2),
        alerts=AlertConfig(reports_dir=str(tmp_path / "reports")),
    )
    cfg.state_path = str(tmp_path / "state.sqlite3")
    cfg.secrets.anthropic_api_key = "test-key"
    cfg.secrets.telegram_bot_token = None
    cfg.secrets.telegram_chat_id = None
    cfg.secrets.discord_webhook_url = None
    cfg.secrets.github_token = None
    cfg.secrets.github_repository = None
    return cfg


@pytest.fixture
def stubbed(monkeypatch):
    fetcher = FakeFetcher()
    monkeypatch.setattr(pipeline, "Fetcher", lambda *a, **k: fetcher)
    return fetcher


def test_dry_run_makes_no_model_calls(config, stubbed, monkeypatch):
    def explode(*_a, **_k):
        raise AssertionError("dry run must not construct an Analyst")

    monkeypatch.setattr(pipeline, "Analyst", explode)
    report = pipeline.run(config, dry_run=True)
    assert report.entries
    assert all(entry.verdict is None for entry in report.entries)


def test_full_run_researches_and_reports(config, stubbed, monkeypatch):
    class StubAnalyst:
        def __init__(self, *_a, **_k):
            self.seen = []

        def investigate(self, dossier):
            self.seen.append(dossier.ref.key)
            return ResearchResult(
                notes="notes", citations=["https://example.invalid/wif"], verdict=sample_verdict()
            )

    monkeypatch.setattr(pipeline, "Analyst", StubAnalyst)
    report = pipeline.run(config)

    assert report.entries, "expected at least one researched token"
    assert report.errors == []
    entry = report.entries[0]
    assert entry.verdict is not None
    assert entry.verdict.lineage[0].name == "dogwifhat"
    # Enrichment ran: the Solana GoPlus fixture sets a live freeze authority.
    assert entry.dossier.security.freeze_authority_active is True
    assert entry.dossier.holders.holder_count == 1290


def test_research_failure_is_contained(config, stubbed, monkeypatch):
    class BrokenAnalyst:
        def __init__(self, *_a, **_k):
            pass

        def investigate(self, dossier):
            raise RuntimeError("upstream 529")

    monkeypatch.setattr(pipeline, "Analyst", BrokenAnalyst)
    report = pipeline.run(config)

    assert report.entries
    assert report.entries[0].error is not None
    assert report.errors
    # A failed entry still renders rather than crashing the report.
    assert "Research failed" in render_report_markdown(report)


def test_low_confidence_is_reported_but_not_alerted(config, stubbed, monkeypatch):
    config.alerts.min_recycle_confidence = 90
    sent: list = []

    class StubAnalyst:
        def __init__(self, *_a, **_k):
            pass

        def investigate(self, dossier):
            return ResearchResult(notes="n", verdict=sample_verdict(confidence=40))

    monkeypatch.setattr(pipeline, "Analyst", StubAnalyst)
    monkeypatch.setattr(
        pipeline, "dispatch", lambda report, entries, cfg, f: sent.append(entries) or ["file:x"]
    )
    report = pipeline.run(config)

    assert report.entries and report.entries[0].verdict is not None
    assert sent == [[]], "a low-confidence verdict belongs in the report, not in an alert"


def test_realert_window_suppresses_a_second_run(config, stubbed, monkeypatch):
    class StubAnalyst:
        calls = 0

        def __init__(self, *_a, **_k):
            pass

        def investigate(self, dossier):
            StubAnalyst.calls += 1
            return ResearchResult(notes="n", verdict=sample_verdict())

    monkeypatch.setattr(pipeline, "Analyst", StubAnalyst)
    pipeline.run(config)
    first = StubAnalyst.calls
    assert first > 0

    pipeline.run(config)
    assert StubAnalyst.calls == first, "the same token should not be researched twice in a row"


def test_report_is_written_and_is_valid_markdown(config, stubbed, monkeypatch):
    class StubAnalyst:
        def __init__(self, *_a, **_k):
            pass

        def investigate(self, dossier):
            return ResearchResult(notes="n", citations=["https://x.invalid"], verdict=sample_verdict())

    monkeypatch.setattr(pipeline, "Analyst", StubAnalyst)
    report = pipeline.run(config)

    written = sorted(Path(config.alerts.reports_dir).glob("*.md"))
    assert written, "the run should leave a report on disk"
    text = written[0].read_text()
    assert "# Provenance" in text
    assert "dogwifhat" in text
    assert "is a recommendation" in text  # the disclaimer footer
    # The report must round-trip as JSON too, for --json.
    json.dumps(report.model_dump(mode="json"), default=str)
