import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from provenance.models import (
    HolderSnapshot,
    MarketSnapshot,
    SecuritySnapshot,
    Socials,
    TokenDossier,
    TokenRef,
)

FIXTURES = Path(__file__).parent / "fixtures"


def load(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


@pytest.fixture
def dexscreener_pair() -> dict:
    return load("dexscreener_pair")


@pytest.fixture
def geckoterminal_pool() -> dict:
    return load("geckoterminal_pool")


@pytest.fixture
def goplus_evm() -> dict:
    return load("goplus_evm")


@pytest.fixture
def goplus_solana() -> dict:
    return load("goplus_solana")


def make_dossier(**overrides) -> TokenDossier:
    """A plausible mid-sized token, 12 hours old, with room to be made worse."""
    market = MarketSnapshot(
        price_usd=0.001,
        fdv_usd=5_000_000,
        liquidity_usd=250_000,
        volume_24h_usd=1_000_000,
        price_change_24h_pct=40.0,
        buys_24h=1000,
        sells_24h=900,
        pair_created_at=datetime.now(UTC) - timedelta(hours=12),
    )
    dossier = TokenDossier(
        ref=TokenRef(
            chain="solana",
            address="TOKEN111111111111111111111111111111111111111",
            symbol="WIF2",
            name="dogwifhat 2.0",
            pair_address="PAIR1",
            dex="raydium",
        ),
        market=market,
        holders=HolderSnapshot(holder_count=2000, top10_pct=25.0, source="goplus"),
        security=SecuritySnapshot(source="goplus"),
        socials=Socials(twitter="https://x.com/x", description="the hat is back"),
        sources=["dexscreener", "geckoterminal"],
        trending_rank=2,
    )
    for key, value in overrides.items():
        setattr(dossier, key, value)
    return dossier


@pytest.fixture
def dossier() -> TokenDossier:
    return make_dossier()
