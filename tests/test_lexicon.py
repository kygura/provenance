from provenance.lexicon import ARCHETYPES, classify, describe_hits


def test_explicit_revival_is_detected():
    hits = dict((a.key, m) for a, m in classify("Shiba Inu 2.0"))
    assert "explicit_revival" in hits
    assert "dog" in hits


def test_matches_report_text_not_regex():
    """The matches end up in a prompt; raw patterns there are noise."""
    _, matched = classify("PEPE 2.0")[0]
    assert all("\\b" not in m for m in matched)


def test_no_match_is_stated_explicitly():
    assert classify("Quorum Settlement Layer") == []
    assert "open" in describe_hits([]).lower()


def test_every_archetype_has_ancestors_and_patterns():
    for archetype in ARCHETYPES:
        assert archetype.patterns, archetype.key
        assert archetype.ancestors, archetype.key
        assert archetype.weight > 0


def test_patterns_compile():
    import re

    for archetype in ARCHETYPES:
        for pattern in archetype.patterns:
            re.compile(pattern)
