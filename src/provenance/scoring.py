"""Filtering and ranking, so the LLM only sees tokens worth paying to research.

Two stages. `passes_filters` drops what is structurally uninteresting - too thin
to trade, too new to measure, too concentrated to be anything but a distribution
event. `score` then ranks what survives, and the top `max_tokens_per_run` go to
the model.

The score is not a prediction. It orders a queue.
"""

from __future__ import annotations

from provenance.config import FilterConfig
from provenance.lexicon import Archetype, classify
from provenance.models import TokenDossier


def searchable_text(dossier: TokenDossier) -> str:
    parts = [
        dossier.ref.symbol or "",
        dossier.ref.name or "",
        dossier.socials.description or "",
    ]
    parts.extend(dossier.socials.as_lines())
    return " ".join(p for p in parts if p)


def passes_filters(dossier: TokenDossier, filters: FilterConfig) -> tuple[bool, str | None]:
    """Return (kept, reason_if_dropped)."""
    market = dossier.market

    if market.liquidity_usd is not None and market.liquidity_usd < filters.min_liquidity_usd:
        return False, f"liquidity ${market.liquidity_usd:,.0f} below floor"
    if (
        market.volume_24h_usd is not None
        and market.volume_24h_usd < filters.min_volume_24h_usd
    ):
        return False, f"24h volume ${market.volume_24h_usd:,.0f} below floor"

    age = market.age_hours
    if age is not None:
        if age < filters.min_age_hours:
            return False, f"only {age:.1f}h old - metrics not yet meaningful"
        if filters.max_age_hours is not None and age > filters.max_age_hours:
            return False, f"{age / 24:.0f} days old - no longer a new narrative"

    if (
        filters.max_top10_pct is not None
        and dossier.holders.top10_pct is not None
        and dossier.holders.top10_pct > filters.max_top10_pct
    ):
        return False, f"top-10 hold {dossier.holders.top10_pct:.0f}%"

    if filters.require_socials and not dossier.socials.as_lines():
        return False, "no socials published"

    return True, None


def score(dossier: TokenDossier) -> tuple[float, list[str]]:
    """Rank by how likely this is a recycled narrative worth a research call.

    Weighted toward narrative signal, because that is what the run is for. Market
    quality only breaks ties and penalises the obviously fake.
    """
    points = 0.0
    notes: list[str] = []
    market = dossier.market

    # --- narrative signal -------------------------------------------------
    hits = classify(searchable_text(dossier))
    for archetype, matched in hits:
        gain = 12.0 * archetype.weight
        points += gain
        notes.append(f"{archetype.label}: matched {len(matched)} pattern(s)")

    # --- corroboration ----------------------------------------------------
    distinct = {s for s in dossier.sources if s in ("dextools", "dexscreener", "geckoterminal")}
    if len(distinct) > 1:
        points += 8.0 * (len(distinct) - 1)
        notes.append(f"trending on {len(distinct)} independent sources")
    if dossier.trending_rank is not None and dossier.trending_rank < 10:
        points += 5.0
        notes.append(f"ranked #{dossier.trending_rank + 1} on its source")

    # --- attention shape --------------------------------------------------
    age = market.age_hours
    if age is not None and 6 <= age <= 24 * 7:
        # The window where a narrative has formed but has not finished paying out.
        points += 10.0
        notes.append(f"{age:.0f}h old - inside the attention window")

    vtl = market.volume_to_liquidity
    if vtl is not None:
        if 1.0 <= vtl <= 20.0:
            points += 6.0
            notes.append(f"volume/liquidity {vtl:.1f}x - real turnover")
        elif vtl > 60.0:
            points -= 12.0
            notes.append(f"volume/liquidity {vtl:.0f}x - wash-trade shape")

    ltf = market.liquidity_to_fdv
    if ltf is not None and ltf < 0.01:
        points -= 8.0
        notes.append(f"liquidity is {ltf * 100:.2f}% of FDV - the valuation is nominal")

    if market.price_change_24h_pct is not None and market.price_change_24h_pct > 50:
        points += 4.0
        notes.append(f"+{market.price_change_24h_pct:.0f}% on the day")

    # --- distribution and contract risk -----------------------------------
    top10 = dossier.holders.top10_pct
    if top10 is not None:
        if top10 > 70:
            points -= 14.0
            notes.append(f"top-10 hold {top10:.0f}% - distribution event, not a market")
        elif top10 < 30:
            points += 6.0
            notes.append(f"top-10 hold {top10:.0f}% - genuinely distributed")

    if dossier.security.is_honeypot:
        points -= 40.0
        notes.append("flagged as a honeypot")
    if dossier.security.mint_authority_active:
        points -= 10.0
        notes.append("mint authority still live")
    if dossier.security.freeze_authority_active:
        points -= 8.0
        notes.append("freeze authority still live")
    for flag in dossier.security.flags:
        if flag not in ("mint authority live", "freeze authority live"):
            points -= 3.0
    if dossier.security.flags:
        notes.append(f"{len(dossier.security.flags)} contract flag(s)")

    if dossier.socials.as_lines():
        points += 3.0
    else:
        points -= 4.0
        notes.append("no socials - provenance will be hard to establish")

    return round(points, 2), notes


def rank(dossiers: list[TokenDossier], filters: FilterConfig) -> tuple[list[TokenDossier], list[tuple[TokenDossier, str]]]:
    """Score the survivors, highest first, alongside what was dropped and why."""
    kept: list[TokenDossier] = []
    dropped: list[tuple[TokenDossier, str]] = []

    for dossier in dossiers:
        ok, reason = passes_filters(dossier, filters)
        if not ok:
            dropped.append((dossier, reason or "filtered"))
            continue
        dossier.heuristic_score, dossier.heuristic_notes = score(dossier)
        kept.append(dossier)

    kept.sort(key=lambda d: d.heuristic_score, reverse=True)
    return kept, dropped


def top_archetype(dossier: TokenDossier) -> Archetype | None:
    hits = classify(searchable_text(dossier))
    if not hits:
        return None
    return max(hits, key=lambda h: h[0].weight * len(h[1]))[0]
