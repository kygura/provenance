from datetime import UTC, datetime, timedelta

import pytest

from provenance.config import FilterConfig
from provenance.models import HolderSnapshot, SecuritySnapshot
from provenance.scoring import passes_filters, rank, score
from tests.conftest import make_dossier


@pytest.fixture
def filters() -> FilterConfig:
    return FilterConfig()


class TestFilters:
    def test_healthy_token_passes(self, dossier, filters):
        ok, reason = passes_filters(dossier, filters)
        assert ok and reason is None

    def test_thin_liquidity_dropped(self, dossier, filters):
        dossier.market.liquidity_usd = 100
        ok, reason = passes_filters(dossier, filters)
        assert not ok and "liquidity" in reason

    def test_too_new_dropped(self, dossier, filters):
        dossier.market.pair_created_at = datetime.now(UTC) - timedelta(minutes=10)
        ok, reason = passes_filters(dossier, filters)
        assert not ok and "not yet meaningful" in reason

    def test_too_old_dropped(self, dossier, filters):
        dossier.market.pair_created_at = datetime.now(UTC) - timedelta(days=90)
        ok, reason = passes_filters(dossier, filters)
        assert not ok and "no longer a new narrative" in reason

    def test_concentration_dropped(self, dossier, filters):
        dossier.holders.top10_pct = 97.0
        ok, reason = passes_filters(dossier, filters)
        assert not ok and "top-10" in reason

    def test_unknown_metrics_are_not_grounds_to_drop(self, filters):
        """A source that returned nothing should not silently filter a token out -
        the LLM is better placed to judge a blank than a threshold is."""
        bare = make_dossier()
        bare.market.liquidity_usd = None
        bare.market.volume_24h_usd = None
        bare.market.pair_created_at = None
        bare.holders = HolderSnapshot()
        ok, _ = passes_filters(bare, filters)
        assert ok


class TestScore:
    def test_revival_name_scores_above_plain_name(self):
        revival = make_dossier()
        plain = make_dossier()
        plain.ref.symbol = "QQQ"
        plain.ref.name = "Quorum Protocol"
        plain.socials.description = "a protocol"
        assert score(revival)[0] > score(plain)[0]

    def test_honeypot_is_heavily_penalised(self, dossier):
        before = score(dossier)[0]
        dossier.security = SecuritySnapshot(is_honeypot=True, flags=["flagged honeypot"])
        assert score(dossier)[0] < before - 30

    def test_wash_trade_shape_penalised(self, dossier):
        before = score(dossier)[0]
        dossier.market.volume_24h_usd = dossier.market.liquidity_usd * 200
        after, notes = score(dossier)
        assert after < before
        assert any("wash-trade" in n for n in notes)

    def test_nominal_valuation_penalised(self, dossier):
        before = score(dossier)[0]
        dossier.market.fdv_usd = dossier.market.liquidity_usd * 500
        after, notes = score(dossier)
        assert after < before
        assert any("nominal" in n for n in notes)

    def test_concentration_penalised(self, dossier):
        before = score(dossier)[0]
        dossier.holders.top10_pct = 85.0
        assert score(dossier)[0] < before


class TestRank:
    def test_ranks_and_reports_drops(self, filters):
        good = make_dossier()
        bad = make_dossier()
        bad.market.liquidity_usd = 10
        kept, dropped = rank([bad, good], filters)
        assert [d.ref.symbol for d in kept] == ["WIF2"]
        assert len(dropped) == 1
        assert kept[0].heuristic_notes

    def test_sorted_descending(self, filters):
        strong = make_dossier()
        weak = make_dossier()
        weak.ref.symbol = "ZZZ"
        weak.ref.name = "Zed"
        weak.socials.description = None
        weak.socials.twitter = None
        kept, _ = rank([weak, strong], filters)
        assert kept[0].heuristic_score >= kept[1].heuristic_score
