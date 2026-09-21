"""GeckoTerminal: keyless trending pools, 30 requests/minute.

Its trending ranking is computed from pool activity rather than paid placement,
so it and the DexScreener boosts feed disagree in a useful way - a token on both
is trending *and* promoted.
"""

from __future__ import annotations

from datetime import UTC, datetime

from provenance.http import Fetcher, as_float, as_int, dig
from provenance.models import MarketSnapshot, TokenRef
from provenance.sources.base import GECKOTERMINAL_SLUGS, canonical_chain

BASE = "https://api.geckoterminal.com/api/v2"
NAME = "geckoterminal"


class GeckoTerminalSource:
    name = NAME

    def fetch(self, fetcher: Fetcher, chains: list[str], limit: int) -> list[TokenRef]:
        refs: list[TokenRef] = []
        seen: set[str] = set()
        per_chain = max(1, limit // max(1, len(chains)))

        for chain in chains:
            slug = GECKOTERMINAL_SLUGS.get(chain)
            if not slug:
                continue
            payload = fetcher.get_json(
                f"{BASE}/networks/{slug}/trending_pools",
                params={"include": "base_token,dex", "page": 1, "duration": "24h"},
            )
            for pool in _pools(payload):
                ref = _ref_from_pool(pool, chain)
                if ref is None or ref.key in seen:
                    continue
                seen.add(ref.key)
                refs.append(ref)
                if len(refs) >= limit:
                    return refs
                if sum(1 for r in refs if r.chain == chain) >= per_chain:
                    break
        return refs


def _pools(payload: object) -> list[dict]:
    data = dig(payload, "data")
    if isinstance(data, list):
        return [p for p in data if isinstance(p, dict)]
    return []


def _ref_from_pool(pool: dict, chain: str) -> TokenRef | None:
    # relationships.base_token.data.id is "<network>_<address>" - the address is
    # everything after the first underscore, because Solana addresses are
    # base58 and EVM addresses are hex, but network slugs can contain "_" too
    # (polygon_pos), so split from the right of the known slug instead.
    token_id = dig(pool, "relationships", "base_token", "data", "id")
    if not isinstance(token_id, str) or "_" not in token_id:
        return None
    network, _, address = token_id.partition("_")
    resolved = canonical_chain(network) or chain
    name = dig(pool, "attributes", "name") or ""
    symbol = name.split("/")[0].strip() if "/" in name else None
    return TokenRef(
        chain=resolved,
        address=address,
        symbol=symbol or None,
        pair_address=dig(pool, "attributes", "address"),
        dex=dig(pool, "relationships", "dex", "data", "id"),
    )


def market_from_pool(pool: dict) -> MarketSnapshot:
    attrs = pool.get("attributes") or {}
    created_raw = attrs.get("pool_created_at")
    created = None
    if isinstance(created_raw, str):
        try:
            created = datetime.fromisoformat(created_raw.replace("Z", "+00:00"))
        except ValueError:
            created = None
        if created and created.tzinfo is None:
            created = created.replace(tzinfo=UTC)
    return MarketSnapshot(
        price_usd=as_float(attrs.get("base_token_price_usd")),
        fdv_usd=as_float(attrs.get("fdv_usd")),
        market_cap_usd=as_float(attrs.get("market_cap_usd")),
        liquidity_usd=as_float(attrs.get("reserve_in_usd")),
        volume_24h_usd=as_float(dig(attrs, "volume_usd", "h24")),
        volume_6h_usd=as_float(dig(attrs, "volume_usd", "h6")),
        volume_1h_usd=as_float(dig(attrs, "volume_usd", "h1")),
        price_change_24h_pct=as_float(dig(attrs, "price_change_percentage", "h24")),
        price_change_6h_pct=as_float(dig(attrs, "price_change_percentage", "h6")),
        price_change_1h_pct=as_float(dig(attrs, "price_change_percentage", "h1")),
        buys_24h=as_int(dig(attrs, "transactions", "h24", "buys")),
        sells_24h=as_int(dig(attrs, "transactions", "h24", "sells")),
        pair_created_at=created,
    )
