"""Chain-name normalisation and the trending-source interface.

Every provider spells the same chain differently - DEXTools says "ether",
GeckoTerminal says "eth", DexScreener says "ethereum". Everything inside this
project uses the DexScreener spelling as canonical, and each adapter translates
at its own edge.
"""

from __future__ import annotations

from typing import Protocol

from provenance.http import Fetcher
from provenance.models import TokenRef

CANONICAL = {
    "eth": "ethereum",
    "ether": "ethereum",
    "ethereum": "ethereum",
    "sol": "solana",
    "solana": "solana",
    "base": "base",
    "bsc": "bsc",
    "bnb": "bsc",
    "binance-smart-chain": "bsc",
    "arbitrum": "arbitrum",
    "arb": "arbitrum",
    "polygon": "polygon",
    "polygon_pos": "polygon",
    "matic": "polygon",
    "avalanche": "avalanche",
    "avax": "avalanche",
    "blast": "blast",
    "sui": "sui",
    "ton": "ton",
    "hyperliquid": "hyperevm",
    "hyperevm": "hyperevm",
}

# canonical -> per-provider spelling
GECKOTERMINAL_SLUGS = {
    "ethereum": "eth",
    "solana": "solana",
    "base": "base",
    "bsc": "bsc",
    "arbitrum": "arbitrum",
    "polygon": "polygon_pos",
    "avalanche": "avax",
    "blast": "blast",
    "sui": "sui",
    "ton": "ton",
    "hyperevm": "hyperevm",
}

DEXTOOLS_SLUGS = {
    "ethereum": "ether",
    "solana": "solana",
    "base": "base",
    "bsc": "bsc",
    "arbitrum": "arbitrum",
    "polygon": "polygon",
    "avalanche": "avalanche",
    "blast": "blast",
    "ton": "ton",
}

EVM_CHAINS = {
    "ethereum": 1,
    "bsc": 56,
    "polygon": 137,
    "base": 8453,
    "arbitrum": 42161,
    "avalanche": 43114,
    "blast": 81457,
}


def canonical_chain(raw: str | None) -> str | None:
    if not raw:
        return None
    return CANONICAL.get(raw.strip().lower())


class TrendingSource(Protocol):
    """Anything that can name tokens currently getting attention."""

    name: str

    def fetch(self, fetcher: Fetcher, chains: list[str], limit: int) -> list[TokenRef]:
        ...
