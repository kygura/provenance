"""GoPlus token security: keyless, covers EVM chains and Solana, and returns
holder distribution and contract risk in one call.

This is the primary source for the "who owns it / can they rug it" half of the
dossier. The EVM and Solana endpoints return different shapes, so they are
parsed separately.
"""

from __future__ import annotations

import logging

from provenance.http import Fetcher, as_float, as_int, dig
from provenance.models import HolderSnapshot, SecuritySnapshot
from provenance.sources.base import EVM_CHAINS

BASE = "https://api.gopluslabs.io/api/v1"
NAME = "goplus"

log = logging.getLogger(__name__)


def fetch(fetcher: Fetcher, chain: str, address: str) -> dict | None:
    if chain == "solana":
        url = f"{BASE}/solana/token_security"
        params = {"contract_addresses": address}
    else:
        chain_id = EVM_CHAINS.get(chain)
        if chain_id is None:
            return None
        url = f"{BASE}/token_security/{chain_id}"
        params = {"contract_addresses": address.lower()}

    payload = fetcher.get_json(url, params=params)
    result = dig(payload, "result")
    if not isinstance(result, dict):
        return None
    # The key is echoed with the provider's own casing; match case-insensitively.
    for key, value in result.items():
        if key.lower() == address.lower() and isinstance(value, dict):
            return value
    # Solana echoes the address verbatim and is the only entry when one address
    # was requested.
    if len(result) == 1:
        only = next(iter(result.values()))
        return only if isinstance(only, dict) else None
    return None


def _truthy(value: object) -> bool | None:
    """GoPlus encodes booleans as the strings "0"/"1", and omits unknowns."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return value
    text = str(value).strip().lower()
    if text in ("1", "true", "yes"):
        return True
    if text in ("0", "false", "no"):
        return False
    return None


def _pct(value: object) -> float | None:
    """Holder percentages arrive as fractions ("0.0431"); report them as percent."""
    raw = as_float(value)
    return raw * 100 if raw is not None else None


def holders_from_evm(data: dict) -> HolderSnapshot:
    holders = data.get("holders")
    rows = [h for h in holders if isinstance(h, dict)] if isinstance(holders, list) else []

    # Locked positions and the pools themselves are not float in anyone's hands.
    # Excluding them stops a burned-LP token from reading as insider-controlled.
    excluded: list[str] = []
    circulating: list[float] = []
    for row in rows:
        pct = _pct(row.get("percent"))
        if pct is None:
            continue
        if _truthy(row.get("is_locked")) or str(row.get("tag", "")).lower() in (
            "burn",
            "burn address",
            "null address",
            "lock",
        ):
            excluded.append(str(row.get("address", ""))[:12])
            continue
        circulating.append(pct)

    circulating.sort(reverse=True)
    return HolderSnapshot(
        holder_count=as_int(data.get("holder_count")),
        top10_pct=round(sum(circulating[:10]), 2) if circulating else None,
        top50_pct=round(sum(circulating[:50]), 2) if circulating else None,
        gini=_gini(circulating),
        creator_pct=_pct(data.get("creator_percent")),
        excluded_addresses=excluded,
        source=NAME,
    )


def holders_from_solana(data: dict) -> HolderSnapshot:
    holders = data.get("holders")
    rows = [h for h in holders if isinstance(h, dict)] if isinstance(holders, list) else []
    excluded: list[str] = []
    circulating: list[float] = []
    for row in rows:
        pct = _pct(row.get("percent"))
        if pct is None:
            continue
        if _truthy(row.get("is_locked")):
            excluded.append(str(row.get("account", row.get("token_account", "")))[:12])
            continue
        circulating.append(pct)
    circulating.sort(reverse=True)

    creators = data.get("creators")
    creator_pct = None
    if isinstance(creators, list):
        shares = [_pct(dig(c, "share")) for c in creators if isinstance(c, dict)]
        shares = [s for s in shares if s is not None]
        creator_pct = round(sum(shares), 2) if shares else None

    return HolderSnapshot(
        holder_count=as_int(data.get("holder_count")),
        top10_pct=round(sum(circulating[:10]), 2) if circulating else None,
        top50_pct=round(sum(circulating[:50]), 2) if circulating else None,
        gini=_gini(circulating),
        creator_pct=creator_pct,
        excluded_addresses=excluded,
        source=NAME,
    )


def security_from_evm(data: dict) -> SecuritySnapshot:
    flags: list[str] = []
    checks = {
        "is_honeypot": "flagged honeypot",
        "cannot_sell_all": "cannot sell entire balance",
        "transfer_pausable": "transfers pausable",
        "is_blacklisted": "blacklist function present",
        "hidden_owner": "hidden owner",
        "can_take_back_ownership": "ownership reclaimable",
        "is_mintable": "mintable",
        "owner_change_balance": "owner can change balances",
        "selfdestruct": "selfdestruct present",
        "is_proxy": "proxy contract",
    }
    for field, label in checks.items():
        if _truthy(data.get(field)):
            flags.append(label)
    if _truthy(data.get("is_open_source")) is False:
        flags.append("source not verified")

    lp_holders = data.get("lp_holders")
    lp_locked = None
    lp_burned = None
    if isinstance(lp_holders, list):
        locked = 0.0
        for row in lp_holders:
            if not isinstance(row, dict):
                continue
            pct = _pct(row.get("percent")) or 0.0
            tag = str(row.get("tag", "")).lower()
            if _truthy(row.get("is_locked")):
                locked += pct
            elif "burn" in tag or "null" in tag:
                locked += pct
                lp_burned = True
        lp_locked = round(locked, 2) if lp_holders else None

    return SecuritySnapshot(
        lp_locked_pct=lp_locked,
        lp_burned=lp_burned,
        buy_tax_pct=_pct(data.get("buy_tax")),
        sell_tax_pct=_pct(data.get("sell_tax")),
        is_honeypot=_truthy(data.get("is_honeypot")),
        flags=flags,
        source=NAME,
    )


def security_from_solana(data: dict) -> SecuritySnapshot:
    mintable = _truthy(dig(data, "mintable", "status"))
    freezable = _truthy(dig(data, "freezable", "status"))
    flags: list[str] = []
    if mintable:
        flags.append("mint authority live")
    if freezable:
        flags.append("freeze authority live")
    if _truthy(dig(data, "closable", "status")):
        flags.append("account closable")
    if _truthy(dig(data, "non_transferable")):
        flags.append("non-transferable")
    if _truthy(dig(data, "default_account_state_upgradable", "status")):
        flags.append("default account state upgradable")

    transfer_fee = as_float(dig(data, "transfer_fee", "current_fee_rate"))
    if transfer_fee:
        flags.append(f"transfer fee {transfer_fee}")

    if _truthy(dig(data, "metadata_mutable", "status")):
        # Mutable metadata is how a token changes which meme it claims to be
        # after launch - directly relevant to provenance.
        flags.append("metadata mutable")

    return SecuritySnapshot(
        mint_authority_active=mintable,
        freeze_authority_active=freezable,
        flags=flags,
        source=NAME,
    )


def _gini(percentages: list[float]) -> float | None:
    """Gini over the holders we can see.

    This is the coefficient of the visible top-N slice, not the whole holder
    base - GoPlus returns at most the largest holders. It is comparable between
    tokens because the slice size is the same, and it is not a population
    statistic. Callers should present it as such.
    """
    values = sorted(v for v in percentages if v > 0)
    n = len(values)
    if n < 2:
        return None
    total = sum(values)
    if total <= 0:
        return None
    weighted = sum((i + 1) * v for i, v in enumerate(values))
    return round((2 * weighted) / (n * total) - (n + 1) / n, 3)
