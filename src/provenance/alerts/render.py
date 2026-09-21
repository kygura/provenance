"""Turning a verdict into something readable.

Two renderings: full markdown for the committed report, and a short form for
chat, where anything longer than a screen gets ignored.
"""

from __future__ import annotations

from provenance.models import Report, ReportEntry, TokenDossier

CHART_URL = "https://dexscreener.com/{chain}/{pair}"


def chart_link(dossier: TokenDossier) -> str | None:
    if not dossier.ref.pair_address:
        return None
    return CHART_URL.format(chain=dossier.ref.chain, pair=dossier.ref.pair_address)


def _usd(value: float | None) -> str:
    if value is None:
        return "?"
    if value >= 1_000_000:
        return f"${value / 1_000_000:.2f}M"
    if value >= 1_000:
        return f"${value / 1_000:.0f}K"
    return f"${value:.2f}"


def _headline(dossier: TokenDossier) -> str:
    ref = dossier.ref
    label = ref.symbol or ref.name or ref.address[:10]
    return f"{label} · {ref.chain}"


def render_entry_markdown(entry: ReportEntry) -> str:
    d = entry.dossier
    v = entry.verdict
    lines: list[str] = [f"## {_headline(d)}", ""]

    if entry.error:
        lines += [f"> Research failed: {entry.error}", ""]

    if v:
        lines += [
            f"**{v.one_liner}**",
            "",
            f"- **Archetype**: {v.archetype}",
            f"- **Novelty**: {v.novelty}"
            + (
                f" · closest ancestor peaked ~{v.cycle_distance_years:.1f}y ago"
                if v.cycle_distance_years is not None
                else ""
            ),
            f"- **Confidence in the lineage claim**: {v.recycle_confidence}/100",
            "",
            "### Origin",
            v.origin_story,
            "",
        ]

        if v.lineage:
            lines.append("### Lineage")
            for ancestor in v.lineage:
                ticker = f" (${ancestor.ticker})" if ancestor.ticker else ""
                lines += [
                    f"**{ancestor.name}{ticker}** — {ancestor.era}",
                    f"- Peak: {ancestor.peak_context}",
                    f"- Resolved: {ancestor.what_happened_next}",
                    f"- Link to this token: {ancestor.resemblance}",
                ]
                if ancestor.evidence_urls:
                    sources = ", ".join(f"[src]({u})" for u in ancestor.evidence_urls[:4])
                    lines.append(f"- Sources: {sources}")
                lines.append("")
        else:
            lines += ["### Lineage", "No ancestor established.", ""]

        lines += ["### Who is holding it", v.audience_read, ""]

        for title, items in (
            ("Would confirm", v.what_would_confirm),
            ("Would kill it", v.what_would_kill_it),
            ("Red flags", v.red_flags),
            ("Open questions", v.open_questions),
        ):
            if items:
                lines.append(f"### {title}")
                lines += [f"- {item}" for item in items]
                lines.append("")

    lines += ["### Data", "", _data_table(d), ""]

    link = chart_link(d)
    if link:
        lines += [f"[Chart]({link}) · `{d.ref.address}`", ""]
    else:
        lines += [f"`{d.ref.address}`", ""]

    if entry.citations:
        lines.append("<details><summary>Sources consulted</summary>")
        lines.append("")
        lines += [f"- {url}" for url in entry.citations[:25]]
        lines += ["", "</details>", ""]

    return "\n".join(lines)


def _data_table(d: TokenDossier) -> str:
    m, h, s = d.market, d.holders, d.security
    age = f"{m.age_hours:.0f}h" if m.age_hours is not None else "?"
    vtl = f"{m.volume_to_liquidity:.1f}x" if m.volume_to_liquidity is not None else "?"
    rows = [
        ("Liquidity", _usd(m.liquidity_usd)),
        ("FDV", _usd(m.fdv_usd)),
        ("24h volume", _usd(m.volume_24h_usd)),
        ("Volume / liquidity", vtl),
        ("24h change", f"{m.price_change_24h_pct:+.1f}%" if m.price_change_24h_pct is not None else "?"),
        ("Pool age", age),
        ("Holders", str(h.holder_count) if h.holder_count is not None else "?"),
        ("Top-10 share", f"{h.top10_pct:.1f}%" if h.top10_pct is not None else "?"),
        ("Contract flags", ", ".join(s.flags) if s.flags else "none"),
        ("Surfaced by", ", ".join(d.sources) or "?"),
        ("Heuristic score", f"{d.heuristic_score:.0f}"),
    ]
    out = ["| | |", "|---|---|"]
    out += [f"| {k} | {v} |" for k, v in rows]
    return "\n".join(out)


def render_report_markdown(report: Report) -> str:
    stamp = report.started_at.strftime("%Y-%m-%d %H:%M UTC")
    lines = [
        f"# Provenance — {stamp}",
        "",
        f"Researched {len(report.entries)} token(s); {report.skipped} filtered out before research.",
        "",
    ]

    researched = [e for e in report.entries if e.verdict]
    if researched:
        lines += ["| Token | Archetype | Novelty | Confidence | Read |", "|---|---|---|---|---|"]
        for entry in researched:
            v = entry.verdict
            assert v is not None
            lines.append(
                f"| {_headline(entry.dossier)} | {v.archetype} | {v.novelty} | "
                f"{v.recycle_confidence} | {v.one_liner} |"
            )
        lines.append("")

    for entry in report.entries:
        lines.append(render_entry_markdown(entry))
        lines.append("---")
        lines.append("")

    if report.errors:
        lines += ["## Run errors", ""] + [f"- {e}" for e in report.errors] + [""]

    lines += [
        "",
        "_Provenance is a research tool. Nothing here is a recommendation, and the "
        "lineage claims are model output — check the sources before acting on any of it._",
    ]
    return "\n".join(lines)


def render_entry_short(entry: ReportEntry, limit: int = 3500) -> str:
    """Chat-length version. Leads with the lineage, because that is the point."""
    d = entry.dossier
    v = entry.verdict
    head = f"*{_headline(d)}*"
    if not v:
        return f"{head}\nResearch failed: {entry.error or 'unknown error'}"

    parts = [
        head,
        v.one_liner,
        "",
        f"Archetype: {v.archetype} · {v.novelty} · confidence {v.recycle_confidence}/100",
    ]
    if v.lineage:
        top = v.lineage[0]
        parts.append(f"Runs as: {top.name} ({top.era}) — {top.what_happened_next}")
    if v.red_flags:
        parts.append("Flags: " + "; ".join(v.red_flags[:3]))

    m, h = d.market, d.holders
    parts.append(
        f"Liq {_usd(m.liquidity_usd)} · Vol24h {_usd(m.volume_24h_usd)} · "
        f"FDV {_usd(m.fdv_usd)}"
        + (f" · top10 {h.top10_pct:.0f}%" if h.top10_pct is not None else "")
    )
    link = chart_link(d)
    if link:
        parts.append(link)
    parts.append(f"`{d.ref.address}`")

    text = "\n".join(parts)
    return text if len(text) <= limit else text[: limit - 1] + "…"
