"""Fill in the parts of a dossier that the trending feeds do not carry:
distribution, contract risk, and the project's own self-description."""

from __future__ import annotations

import logging

from provenance.config import Config
from provenance.enrich import goplus, helius
from provenance.http import Fetcher
from provenance.models import TokenDossier

log = logging.getLogger(__name__)


def enrich(fetcher: Fetcher, dossier: TokenDossier, config: Config) -> TokenDossier:
    chain = dossier.ref.chain
    address = dossier.ref.address

    data = goplus.fetch(fetcher, chain, address)
    if data:
        if chain == "solana":
            dossier.holders = goplus.holders_from_solana(data)
            dossier.security = goplus.security_from_solana(data)
        else:
            dossier.holders = goplus.holders_from_evm(data)
            dossier.security = goplus.security_from_evm(data)
        dossier.sources.append(goplus.NAME)

    key = config.secrets.helius_api_key
    if chain == "solana" and key and dossier.holders.top10_pct is None:
        fallback = helius.fetch_holders(fetcher, key, address)
        if fallback:
            # Keep whatever GoPlus did give us (holder_count, creator share).
            fallback.holder_count = dossier.holders.holder_count
            fallback.creator_pct = dossier.holders.creator_pct
            dossier.holders = fallback
            dossier.sources.append(helius.NAME)

    return dossier


__all__ = ["enrich"]
