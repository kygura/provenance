"""Data shapes carried through the pipeline.

Two families live here. The `Snapshot` types are what the scrapers produce: plain
facts, every field optional because every upstream API drops fields without notice.
The `Verdict` types are what the LLM produces: they are Pydantic models because the
Messages API validates the model's output against their JSON schema.
"""

from __future__ import annotations

from datetime import UTC, datetime

from pydantic import BaseModel, Field


def _utcnow() -> datetime:
    return datetime.now(UTC)


# --------------------------------------------------------------------------
# Scraped facts
# --------------------------------------------------------------------------


class TokenRef(BaseModel):
    """Identity of one token on one chain, plus the pool we saw it trending in."""

    chain: str
    address: str
    symbol: str | None = None
    name: str | None = None
    pair_address: str | None = None
    dex: str | None = None

    @property
    def key(self) -> str:
        return f"{self.chain}:{self.address.lower()}"

    def __str__(self) -> str:  # pragma: no cover - display only
        return f"{self.symbol or '???'} ({self.chain}:{self.address[:8]}…)"


class MarketSnapshot(BaseModel):
    price_usd: float | None = None
    fdv_usd: float | None = None
    market_cap_usd: float | None = None
    liquidity_usd: float | None = None
    volume_24h_usd: float | None = None
    volume_6h_usd: float | None = None
    volume_1h_usd: float | None = None
    price_change_24h_pct: float | None = None
    price_change_6h_pct: float | None = None
    price_change_1h_pct: float | None = None
    buys_24h: int | None = None
    sells_24h: int | None = None
    pair_created_at: datetime | None = None

    @property
    def age_hours(self) -> float | None:
        if self.pair_created_at is None:
            return None
        created = self.pair_created_at
        if created.tzinfo is None:
            created = created.replace(tzinfo=UTC)
        return (_utcnow() - created).total_seconds() / 3600.0

    @property
    def liquidity_to_fdv(self) -> float | None:
        """Thin float tell. Below ~1% means the quoted FDV is close to fictional."""
        if not self.liquidity_usd or not self.fdv_usd:
            return None
        return self.liquidity_usd / self.fdv_usd

    @property
    def volume_to_liquidity(self) -> float | None:
        """Churn. Very high with flat price is the classic wash-trading shape."""
        if not self.liquidity_usd or self.volume_24h_usd is None:
            return None
        return self.volume_24h_usd / self.liquidity_usd

    @property
    def buy_sell_ratio(self) -> float | None:
        if not self.sells_24h:
            return None
        return (self.buys_24h or 0) / self.sells_24h


class HolderSnapshot(BaseModel):
    """Distribution. The part that says who actually eats the loss."""

    holder_count: int | None = None
    top10_pct: float | None = None
    top50_pct: float | None = None
    gini: float | None = None
    creator_pct: float | None = None
    # Addresses we could identify as pools/locks/bridges and excluded from the
    # concentration figures above. Kept for auditability.
    excluded_addresses: list[str] = Field(default_factory=list)
    source: str | None = None


class SecuritySnapshot(BaseModel):
    mint_authority_active: bool | None = None
    freeze_authority_active: bool | None = None
    lp_locked_pct: float | None = None
    lp_burned: bool | None = None
    buy_tax_pct: float | None = None
    sell_tax_pct: float | None = None
    is_honeypot: bool | None = None
    flags: list[str] = Field(default_factory=list)
    source: str | None = None


class Socials(BaseModel):
    website: str | None = None
    twitter: str | None = None
    telegram: str | None = None
    discord: str | None = None
    other: list[str] = Field(default_factory=list)
    description: str | None = None

    def as_lines(self) -> list[str]:
        out = []
        for label, value in (
            ("site", self.website),
            ("x", self.twitter),
            ("tg", self.telegram),
            ("discord", self.discord),
        ):
            if value:
                out.append(f"{label}: {value}")
        out.extend(self.other)
        return out


class TokenDossier(BaseModel):
    """Everything the scrapers found for one token, before the LLM sees it."""

    ref: TokenRef
    market: MarketSnapshot = Field(default_factory=MarketSnapshot)
    holders: HolderSnapshot = Field(default_factory=HolderSnapshot)
    security: SecuritySnapshot = Field(default_factory=SecuritySnapshot)
    socials: Socials = Field(default_factory=Socials)
    sources: list[str] = Field(default_factory=list)
    trending_rank: int | None = None
    heuristic_score: float = 0.0
    heuristic_notes: list[str] = Field(default_factory=list)
    collected_at: datetime = Field(default_factory=_utcnow)


# --------------------------------------------------------------------------
# LLM output
# --------------------------------------------------------------------------


class Ancestor(BaseModel):
    """A prior meme this token appears to be a rerun of."""

    name: str = Field(description="The earlier project, meme, or narrative.")
    ticker: str | None = Field(default=None, description="Its ticker, if it had one.")
    era: str = Field(description="Roughly when it peaked, e.g. '2021 bull' or 'early 2024'.")
    peak_context: str = Field(
        description="What it reached and on what story. Numbers where known."
    )
    what_happened_next: str = Field(
        description="How it resolved. Drawdown, rug, slow bleed, or survival."
    )
    resemblance: str = Field(
        description="The specific link to the token under review: name, art, mechanic, "
        "founder, or community lineage."
    )
    evidence_urls: list[str] = Field(
        default_factory=list, description="Sources supporting this link."
    )


class ProvenanceVerdict(BaseModel):
    """The LLM's read on where a token's meme came from."""

    one_liner: str = Field(description="One sentence a trader could act on.")
    archetype: str = Field(
        description="The narrative family, e.g. 'dog coin', 'AI agent', 'political', "
        "'revival of a dead ticker', 'celebrity', 'infrastructure cosplay'."
    )
    origin_story: str = Field(
        description="Where this specific meme came from: who made it, from what, and when. "
        "Say plainly if the origin could not be established."
    )
    lineage: list[Ancestor] = Field(
        description="Prior memes this is a rerun of, strongest link first. Empty if genuinely novel."
    )
    novelty: str = Field(
        description="One of: pure-rerun, remix, novel. 'pure-rerun' means the same meme "
        "returning with a new contract; 'remix' means old meme, new mechanic or chain."
    )
    cycle_distance_years: float | None = Field(
        default=None,
        description="Years between the closest ancestor's peak and now. Null if no ancestor.",
    )
    recycle_confidence: int = Field(
        ge=0, le=100, description="Confidence that the lineage claim is correct, 0-100."
    )
    audience_read: str = Field(
        description="Who is buying and whether they plausibly remember the ancestor. "
        "Ground this in the holder and age data given, not vibes."
    )
    what_would_confirm: list[str] = Field(
        description="Observable events in the next days that would support the thesis."
    )
    what_would_kill_it: list[str] = Field(
        description="Observable events that would invalidate the thesis."
    )
    red_flags: list[str] = Field(
        description="Concrete risks from the supplied data: concentration, unlocked LP, "
        "live mint authority, wash-trade shape, unverifiable team."
    )
    open_questions: list[str] = Field(
        description="What could not be determined and would need a human to check."
    )


class Report(BaseModel):
    """One scheduled run."""

    run_id: str
    started_at: datetime
    finished_at: datetime | None = None
    entries: list[ReportEntry] = Field(default_factory=list)
    skipped: int = 0
    errors: list[str] = Field(default_factory=list)


class ReportEntry(BaseModel):
    dossier: TokenDossier
    verdict: ProvenanceVerdict | None = None
    research_notes: str | None = None
    citations: list[str] = Field(default_factory=list)
    error: str | None = None


Report.model_rebuild()
