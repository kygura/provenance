"""DexScreener: keyless, generous rate limit, and the only free source that
exposes paid promotion directly.

Boosts matter here beyond being a trending proxy: a token whose visibility was
bought is a different object from one that surfaced on volume, and the LLM is
told which it is.
"""

from __future__ import annotations

from datetime import UTC, datetime

from provenance.http import Fetcher, as_float, as_int, dig
from provenance.models import MarketSnapshot, Socials, TokenRef
from provenance.sources.base import canonical_chain

BASE = "https://api.dexscreener.com"
NAME = "dexscreener"


class DexScreenerSource:
    name = NAME

    def fetch(self, fetcher: Fetcher, chains: list[str], limit: int) -> list[TokenRef]:
        wanted = set(chains)
        seen: set[str] = set()
        refs: list[TokenRef] = []

        for endpoint in ("token-boosts/top/v1", "token-boosts/latest/v1"):
            payload = fetcher.get_json(f"{BASE}/{endpoint}")
            for item in _as_list(payload):
                chain = canonical_chain(dig(item, "chainId"))
                address = dig(item, "tokenAddress")
                if not chain or not address or chain not in wanted:
                    continue
                key = f"{chain}:{address.lower()}"
                if key in seen:
                    continue
                seen.add(key)
                refs.append(TokenRef(chain=chain, address=address))
                if len(refs) >= limit:
                    return refs
        return refs


def _as_list(payload: object) -> list[dict]:
    """The boosts endpoints have returned both a bare array and {"data": [...]}."""
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    if isinstance(payload, dict):
        for key in ("data", "pairs", "results"):
            inner = payload.get(key)
            if isinstance(inner, list):
                return [x for x in inner if isinstance(x, dict)]
    return []


def fetch_pairs(fetcher: Fetcher, chain: str, addresses: list[str]) -> dict[str, dict]:
    """Best pair per token address, keyed by lowercased address.

    "Best" is deepest liquidity: that is the pool whose price and depth actually
    describe the token, rather than whichever pool happened to rank.
    """
    out: dict[str, dict] = {}
    for batch in _chunks(addresses, 30):
        joined = ",".join(batch)
        payload = fetcher.get_json(f"{BASE}/tokens/v1/{chain}/{joined}")
        pairs = _as_list(payload)
        if not pairs:
            # Older multichain route; same pair objects under "pairs".
            payload = fetcher.get_json(f"{BASE}/latest/dex/tokens/{joined}")
            pairs = _as_list(payload)
        for pair in pairs:
            address = dig(pair, "baseToken", "address")
            if not address:
                continue
            key = address.lower()
            current = out.get(key)
            if current is None or _liquidity(pair) > _liquidity(current):
                out[key] = pair
    return out


def _liquidity(pair: dict) -> float:
    return as_float(dig(pair, "liquidity", "usd")) or 0.0


def _chunks(items: list[str], size: int):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def market_from_pair(pair: dict) -> MarketSnapshot:
    created_ms = as_float(pair.get("pairCreatedAt"))
    created = (
        datetime.fromtimestamp(created_ms / 1000, tz=UTC) if created_ms else None
    )
    return MarketSnapshot(
        price_usd=as_float(pair.get("priceUsd")),
        fdv_usd=as_float(pair.get("fdv")),
        market_cap_usd=as_float(pair.get("marketCap")),
        liquidity_usd=as_float(dig(pair, "liquidity", "usd")),
        volume_24h_usd=as_float(dig(pair, "volume", "h24")),
        volume_6h_usd=as_float(dig(pair, "volume", "h6")),
        volume_1h_usd=as_float(dig(pair, "volume", "h1")),
        price_change_24h_pct=as_float(dig(pair, "priceChange", "h24")),
        price_change_6h_pct=as_float(dig(pair, "priceChange", "h6")),
        price_change_1h_pct=as_float(dig(pair, "priceChange", "h1")),
        buys_24h=as_int(dig(pair, "txns", "h24", "buys")),
        sells_24h=as_int(dig(pair, "txns", "h24", "sells")),
        pair_created_at=created,
    )


def ref_from_pair(pair: dict) -> TokenRef | None:
    chain = canonical_chain(pair.get("chainId"))
    address = dig(pair, "baseToken", "address")
    if not chain or not address:
        return None
    return TokenRef(
        chain=chain,
        address=address,
        symbol=dig(pair, "baseToken", "symbol"),
        name=dig(pair, "baseToken", "name"),
        pair_address=pair.get("pairAddress"),
        dex=pair.get("dexId"),
    )


def socials_from_pair(pair: dict) -> Socials:
    info = pair.get("info") or {}
    socials = Socials(description=info.get("description"))
    websites = info.get("websites")
    if isinstance(websites, list) and websites:
        first = websites[0]
        socials.website = first.get("url") if isinstance(first, dict) else str(first)
    for entry in info.get("socials") or []:
        if not isinstance(entry, dict):
            continue
        kind = (entry.get("type") or entry.get("platform") or "").lower()
        url = entry.get("url")
        if not url:
            continue
        if kind in ("twitter", "x"):
            socials.twitter = socials.twitter or url
        elif kind == "telegram":
            socials.telegram = socials.telegram or url
        elif kind == "discord":
            socials.discord = socials.discord or url
        else:
            socials.other.append(f"{kind or 'link'}: {url}")
    return socials


def fetch_profile(fetcher: Fetcher, chain: str, address: str) -> dict | None:
    """The token-profiles feed carries the team's own blurb - the primary text
    where a project states what it claims to be descended from."""
    payload = fetcher.get_json(f"{BASE}/token-profiles/latest/v1")
    for item in _as_list(payload):
        if (
            canonical_chain(dig(item, "chainId")) == chain
            and str(dig(item, "tokenAddress", default="")).lower() == address.lower()
        ):
            return item
    return None
