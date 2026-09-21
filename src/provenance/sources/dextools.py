"""DEXTools hot pools. Requires a paid key; skipped silently without one.

This is the source the project was specified around. It is kept optional because
the keyless sources cover the same tokens, and a run that quietly degrades is
better than a run that dies on a lapsed subscription.
"""

from __future__ import annotations

import logging

from provenance.http import Fetcher, dig
from provenance.models import TokenRef
from provenance.sources.base import DEXTOOLS_SLUGS, canonical_chain

BASE = "https://public-api.dextools.io"
NAME = "dextools"

log = logging.getLogger(__name__)


class DexToolsSource:
    name = NAME

    def __init__(self, api_key: str, plan: str = "trial") -> None:
        self.api_key = api_key
        self.plan = plan

    def fetch(self, fetcher: Fetcher, chains: list[str], limit: int) -> list[TokenRef]:
        headers = {"X-API-KEY": self.api_key, "accept": "application/json"}
        refs: list[TokenRef] = []
        seen: set[str] = set()

        for chain in chains:
            slug = DEXTOOLS_SLUGS.get(chain)
            if not slug:
                continue
            for ranking in ("hotpools", "gainers"):
                payload = fetcher.get_json(
                    f"{BASE}/{self.plan}/v2/ranking/{slug}/{ranking}", headers=headers
                )
                rows = dig(payload, "data")
                if not isinstance(rows, list):
                    if payload is not None:
                        log.info("dextools %s/%s: unexpected payload", slug, ranking)
                    continue
                for row in rows:
                    ref = _ref_from_row(row, chain)
                    if ref is None or ref.key in seen:
                        continue
                    seen.add(ref.key)
                    refs.append(ref)
                    if len(refs) >= limit:
                        return refs
        return refs


def _ref_from_row(row: object, chain: str) -> TokenRef | None:
    if not isinstance(row, dict):
        return None
    token = row.get("mainToken") or row.get("token") or {}
    address = dig(token, "address") or dig(row, "address")
    if not address:
        return None
    return TokenRef(
        chain=canonical_chain(dig(row, "chain")) or chain,
        address=address,
        symbol=dig(token, "symbol"),
        name=dig(token, "name"),
        pair_address=dig(row, "pair", "address") or dig(row, "address"),
        dex=dig(row, "exchange", "name"),
    )
