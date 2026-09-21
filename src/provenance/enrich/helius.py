"""Solana holder concentration straight from RPC, when a Helius key is present.

GoPlus is the default source; this exists because GoPlus sometimes returns an
empty holders array for very new mints, which is exactly the case the project
cares about most.

`getTokenLargestAccounts` returns the top 20 token accounts, so the derived
figures describe the visible top 20 and nothing beyond it.
"""

from __future__ import annotations

import logging

from provenance.http import Fetcher, as_float, dig
from provenance.models import HolderSnapshot

NAME = "helius"
log = logging.getLogger(__name__)


def fetch_holders(fetcher: Fetcher, api_key: str, mint: str) -> HolderSnapshot | None:
    url = f"https://mainnet.helius-rpc.com/?api-key={api_key}"

    supply = fetcher.post_json(
        url,
        {"jsonrpc": "2.0", "id": "supply", "method": "getTokenSupply", "params": [mint]},
    )
    total = as_float(dig(supply, "result", "value", "uiAmount"))
    if not total:
        return None

    largest = fetcher.post_json(
        url,
        {
            "jsonrpc": "2.0",
            "id": "largest",
            "method": "getTokenLargestAccounts",
            "params": [mint],
        },
    )
    rows = dig(largest, "result", "value")
    if not isinstance(rows, list) or not rows:
        return None

    amounts = sorted(
        (a for a in (as_float(dig(r, "uiAmount")) for r in rows) if a),
        reverse=True,
    )
    if not amounts:
        return None

    return HolderSnapshot(
        top10_pct=round(sum(amounts[:10]) / total * 100, 2),
        top50_pct=round(sum(amounts) / total * 100, 2),
        source=f"{NAME} (top {len(amounts)} accounts)",
    )
