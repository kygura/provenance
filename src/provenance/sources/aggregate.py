"""Fan out across the trending sources and merge what comes back.

A token that several independent sources surface at once is more interesting
than one that tops a single list, so cross-source agreement is recorded on the
dossier and feeds the heuristic score.
"""

from __future__ import annotations

import logging
from collections import defaultdict

from provenance.config import Config
from provenance.http import Fetcher
from provenance.models import TokenDossier, TokenRef
from provenance.sources import dexscreener
from provenance.sources.dexscreener import DexScreenerSource
from provenance.sources.dextools import DexToolsSource
from provenance.sources.geckoterminal import GeckoTerminalSource

log = logging.getLogger(__name__)


def build_sources(config: Config) -> list:
    sources = []
    key = config.secrets.dextools_api_key
    if config.sources.dextools_enabled and key:
        sources.append(DexToolsSource(key, config.sources.dextools_plan))
    elif config.sources.dextools_enabled:
        log.info("DEXTOOLS_API_KEY not set - falling back to the keyless sources")
    if config.sources.dexscreener_enabled:
        sources.append(DexScreenerSource())
    if config.sources.geckoterminal_enabled:
        sources.append(GeckoTerminalSource())
    return sources


def collect_trending(fetcher: Fetcher, config: Config) -> list[TokenDossier]:
    """Return one dossier per distinct trending token, market data filled in."""
    chains = config.sources.chains
    limit = config.sources.per_source_limit

    merged: dict[str, TokenRef] = {}
    hits: dict[str, list[str]] = defaultdict(list)
    first_rank: dict[str, int] = {}

    for source in build_sources(config):
        try:
            refs = source.fetch(fetcher, chains, limit)
        except Exception as exc:  # noqa: BLE001 - one bad source must not end the run
            log.warning("source %s failed: %s", source.name, exc)
            continue
        log.info("source %s returned %d refs", source.name, len(refs))
        for rank, ref in enumerate(refs):
            existing = merged.get(ref.key)
            if existing is None:
                merged[ref.key] = ref
                first_rank[ref.key] = rank
            else:
                # Keep whichever spelling carries more identity.
                merged[ref.key] = TokenRef(
                    chain=existing.chain,
                    address=existing.address,
                    symbol=existing.symbol or ref.symbol,
                    name=existing.name or ref.name,
                    pair_address=existing.pair_address or ref.pair_address,
                    dex=existing.dex or ref.dex,
                )
                first_rank[ref.key] = min(first_rank[ref.key], rank)
            hits[ref.key].append(source.name)

    return _enrich_market(fetcher, merged, hits, first_rank)


def _enrich_market(
    fetcher: Fetcher,
    merged: dict[str, TokenRef],
    hits: dict[str, list[str]],
    first_rank: dict[str, int],
) -> list[TokenDossier]:
    """One batched DexScreener lookup per chain fills price, depth and age.

    DexScreener is used for this regardless of which source surfaced the token:
    it batches 30 addresses per call and returns the same pair shape for every
    chain, which keeps the enrichment step to a handful of requests.
    """
    by_chain: dict[str, list[str]] = defaultdict(list)
    for ref in merged.values():
        by_chain[ref.chain].append(ref.address)

    pairs: dict[str, dict] = {}
    for chain, addresses in by_chain.items():
        pairs.update(dexscreener.fetch_pairs(fetcher, chain, addresses))

    dossiers: list[TokenDossier] = []
    for key, ref in merged.items():
        pair = pairs.get(ref.address.lower())
        dossier = TokenDossier(
            ref=ref,
            sources=sorted(set(hits[key])),
            trending_rank=first_rank.get(key),
        )
        if pair:
            enriched = dexscreener.ref_from_pair(pair)
            if enriched:
                dossier.ref = TokenRef(
                    chain=ref.chain,
                    address=ref.address,
                    symbol=enriched.symbol or ref.symbol,
                    name=enriched.name or ref.name,
                    pair_address=enriched.pair_address or ref.pair_address,
                    dex=enriched.dex or ref.dex,
                )
            dossier.market = dexscreener.market_from_pair(pair)
            dossier.socials = dexscreener.socials_from_pair(pair)
        dossiers.append(dossier)

    log.info("collected %d distinct tokens", len(dossiers))
    return dossiers
