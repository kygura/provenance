from provenance.models import ProvenanceVerdict
from provenance.state import Store
from tests.conftest import make_dossier


def verdict() -> ProvenanceVerdict:
    return ProvenanceVerdict(
        one_liner="A 2023 meme relaunched for people who missed it.",
        archetype="dog coin",
        origin_story="Derived from the 2023 dogwifhat image.",
        lineage=[],
        novelty="pure-rerun",
        cycle_distance_years=2.0,
        recycle_confidence=78,
        audience_read="Mostly new wallets.",
        what_would_confirm=["holder count keeps climbing"],
        what_would_kill_it=["the original account disavows it"],
        red_flags=["freeze authority live"],
        open_questions=["who deployed it"],
    )


def test_dedupe_window(tmp_path):
    with Store(tmp_path / "s.sqlite3") as store:
        dossier = make_dossier()
        assert not store.alerted_recently(dossier.ref.key, 72)
        store.record_alert(dossier, verdict(), "run1")
        assert store.alerted_recently(dossier.ref.key, 72)
        # A window of zero hours means nothing is ever considered recent.
        assert not store.alerted_recently(dossier.ref.key, 0)


def test_repeat_sightings_accumulate(tmp_path):
    with Store(tmp_path / "s.sqlite3") as store:
        dossier = make_dossier()
        store.record_sighting(dossier, "run1")
        store.record_sighting(dossier, "run2")
        store.record_sighting(dossier, "run2")  # same run is idempotent
        assert store.sighting_count(dossier.ref.key) == 2
        assert store.first_seen(dossier.ref.key) is not None


def test_recent_alerts_round_trip(tmp_path):
    with Store(tmp_path / "s.sqlite3") as store:
        store.record_alert(make_dossier(), verdict(), "run1")
        rows = store.recent_alerts()
        assert len(rows) == 1
        assert rows[0]["novelty"] == "pure-rerun"
        assert rows[0]["confidence"] == 78
