/**
 * Fill in the parts of a dossier that the trending feeds do not carry:
 * distribution, contract risk, and the project's own self-description.
 */

import type { Config } from "../config.js";
import type { Fetcher } from "../http.js";
import type { TokenDossier } from "../models.js";
import * as goplus from "./goplus.js";
import * as helius from "./helius.js";

export { goplus, helius };

export async function enrich(
  fetcher: Fetcher,
  dossier: TokenDossier,
  config: Config,
): Promise<TokenDossier> {
  const { chain, address } = dossier.ref;

  const data = await goplus.fetchSecurity(fetcher, chain, address);
  if (data) {
    if (chain === "solana") {
      dossier.holders = goplus.holdersFromSolana(data);
      dossier.security = goplus.securityFromSolana(data);
    } else {
      dossier.holders = goplus.holdersFromEvm(data);
      dossier.security = goplus.securityFromEvm(data);
    }
    dossier.sources.push(goplus.NAME);
  }

  const key = config.secrets.heliusApiKey;
  if (chain === "solana" && key && dossier.holders.top10Pct == null) {
    const fallback = await helius.fetchHolders(fetcher, key, address);
    if (fallback) {
      // Keep whatever GoPlus did give us (holder count, creator share).
      fallback.holderCount = dossier.holders.holderCount;
      fallback.creatorPct = dossier.holders.creatorPct;
      dossier.holders = fallback;
      dossier.sources.push(helius.NAME);
    }
  }

  return dossier;
}
