/**
 * GoPlus token security: keyless, covers EVM chains and Solana, and returns
 * holder distribution and contract risk in one call.
 *
 * This is the primary source for the "who owns it / can they rug it" half of
 * the dossier. The EVM and Solana endpoints return different shapes, so they
 * are parsed separately.
 */

import { asFloat, asInt, asObjectList, dig, type Fetcher } from "../http.js";
import { emptyHolders, emptySecurity, type HolderSnapshot, type SecuritySnapshot } from "../models.js";
import { EVM_CHAINS } from "../sources/chains.js";

const BASE = "https://api.gopluslabs.io/api/v1";
export const NAME = "goplus";

export async function fetchSecurity(
  fetcher: Fetcher,
  chain: string,
  address: string,
): Promise<Record<string, unknown> | null> {
  let url: string;
  let params: Record<string, string>;

  if (chain === "solana") {
    url = `${BASE}/solana/token_security`;
    params = { contract_addresses: address };
  } else {
    const chainId = EVM_CHAINS[chain];
    if (chainId === undefined) return null;
    url = `${BASE}/token_security/${chainId}`;
    params = { contract_addresses: address.toLowerCase() };
  }

  const result = dig(await fetcher.getJson(url, { params }), "result");
  if (typeof result !== "object" || result === null) return null;

  const table = result as Record<string, unknown>;
  // The key is echoed with the provider's own casing; match case-insensitively.
  for (const [key, value] of Object.entries(table)) {
    if (key.toLowerCase() === address.toLowerCase() && typeof value === "object" && value !== null) {
      return value as Record<string, unknown>;
    }
  }
  // Solana echoes the address verbatim and is the only entry when one address
  // was requested.
  const entries = Object.values(table);
  if (entries.length === 1) {
    const only = entries[0];
    return typeof only === "object" && only !== null ? (only as Record<string, unknown>) : null;
  }
  return null;
}

/** GoPlus encodes booleans as the strings "0"/"1", and omits unknowns. */
export function truthy(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes"].includes(text)) return true;
  if (["0", "false", "no"].includes(text)) return false;
  return null;
}

/** Holder percentages arrive as fractions ("0.0431"); report them as percent. */
export function pct(value: unknown): number | null {
  const raw = asFloat(value);
  return raw === null ? null : raw * 100;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

/**
 * Gini over the holders we can see.
 *
 * This is the coefficient of the visible top-N slice, not the whole holder
 * base - GoPlus returns at most the largest holders. It is comparable between
 * tokens because the slice size is the same, and it is not a population
 * statistic. Callers should present it as such.
 */
export function gini(percentages: number[]): number | null {
  const values = percentages.filter((v) => v > 0).sort((a, b) => a - b);
  const n = values.length;
  if (n < 2) return null;
  const total = sum(values);
  if (total <= 0) return null;
  const weighted = values.reduce((acc, v, i) => acc + (i + 1) * v, 0);
  return round((2 * weighted) / (n * total) - (n + 1) / n, 3);
}

const LOCKED_TAGS = new Set(["burn", "burn address", "null address", "lock"]);

export function holdersFromEvm(data: Record<string, unknown>): HolderSnapshot {
  // Locked positions and the pools themselves are not float in anyone's hands.
  // Excluding them stops a burned-LP token from reading as insider-controlled.
  const excluded: string[] = [];
  const circulating: number[] = [];

  for (const row of asObjectList(data.holders)) {
    const share = pct(row.percent);
    if (share === null) continue;
    if (truthy(row.is_locked) || LOCKED_TAGS.has(String(row.tag ?? "").toLowerCase())) {
      excluded.push(String(row.address ?? "").slice(0, 12));
      continue;
    }
    circulating.push(share);
  }
  circulating.sort((a, b) => b - a);

  return {
    ...emptyHolders(),
    holderCount: asInt(data.holder_count),
    top10Pct: circulating.length ? round(sum(circulating.slice(0, 10)), 2) : null,
    top50Pct: circulating.length ? round(sum(circulating.slice(0, 50)), 2) : null,
    gini: gini(circulating),
    creatorPct: pct(data.creator_percent),
    excludedAddresses: excluded,
    source: NAME,
  };
}

export function holdersFromSolana(data: Record<string, unknown>): HolderSnapshot {
  const excluded: string[] = [];
  const circulating: number[] = [];

  for (const row of asObjectList(data.holders)) {
    const share = pct(row.percent);
    if (share === null) continue;
    if (truthy(row.is_locked)) {
      excluded.push(String(row.account ?? row.token_account ?? "").slice(0, 12));
      continue;
    }
    circulating.push(share);
  }
  circulating.sort((a, b) => b - a);

  const shares = asObjectList(data.creators)
    .map((c) => pct(c.share))
    .filter((s): s is number => s !== null);

  return {
    ...emptyHolders(),
    holderCount: asInt(data.holder_count),
    top10Pct: circulating.length ? round(sum(circulating.slice(0, 10)), 2) : null,
    top50Pct: circulating.length ? round(sum(circulating.slice(0, 50)), 2) : null,
    gini: gini(circulating),
    creatorPct: shares.length ? round(sum(shares), 2) : null,
    excludedAddresses: excluded,
    source: NAME,
  };
}

const EVM_CHECKS: [string, string][] = [
  ["is_honeypot", "flagged honeypot"],
  ["cannot_sell_all", "cannot sell entire balance"],
  ["transfer_pausable", "transfers pausable"],
  ["is_blacklisted", "blacklist function present"],
  ["hidden_owner", "hidden owner"],
  ["can_take_back_ownership", "ownership reclaimable"],
  ["is_mintable", "mintable"],
  ["owner_change_balance", "owner can change balances"],
  ["selfdestruct", "selfdestruct present"],
  ["is_proxy", "proxy contract"],
];

export function securityFromEvm(data: Record<string, unknown>): SecuritySnapshot {
  const flags: string[] = [];
  for (const [field, label] of EVM_CHECKS) {
    if (truthy(data[field])) flags.push(label);
  }
  if (truthy(data.is_open_source) === false) flags.push("source not verified");

  const lpRows = asObjectList(data.lp_holders);
  let lpLocked: number | null = null;
  let lpBurned: boolean | null = null;

  if (lpRows.length > 0) {
    let locked = 0;
    for (const row of lpRows) {
      const share = pct(row.percent) ?? 0;
      const tag = String(row.tag ?? "").toLowerCase();
      if (truthy(row.is_locked)) {
        locked += share;
      } else if (tag.includes("burn") || tag.includes("null")) {
        locked += share;
        lpBurned = true;
      }
    }
    lpLocked = round(locked, 2);
  }

  return {
    ...emptySecurity(),
    lpLockedPct: lpLocked,
    lpBurned,
    buyTaxPct: pct(data.buy_tax),
    sellTaxPct: pct(data.sell_tax),
    isHoneypot: truthy(data.is_honeypot),
    flags,
    source: NAME,
  };
}

export function securityFromSolana(data: Record<string, unknown>): SecuritySnapshot {
  const mintable = truthy(dig(data, "mintable", "status"));
  const freezable = truthy(dig(data, "freezable", "status"));
  const flags: string[] = [];

  if (mintable) flags.push("mint authority live");
  if (freezable) flags.push("freeze authority live");
  if (truthy(dig(data, "closable", "status"))) flags.push("account closable");
  if (truthy(data.non_transferable)) flags.push("non-transferable");
  if (truthy(dig(data, "default_account_state_upgradable", "status"))) {
    flags.push("default account state upgradable");
  }

  const transferFee = asFloat(dig(data, "transfer_fee", "current_fee_rate"));
  if (transferFee) flags.push(`transfer fee ${transferFee}`);

  // Mutable metadata is how a token changes which meme it claims to be after
  // launch - directly relevant to provenance.
  if (truthy(dig(data, "metadata_mutable", "status"))) flags.push("metadata mutable");

  return {
    ...emptySecurity(),
    mintAuthorityActive: mintable,
    freezeAuthorityActive: freezable,
    flags,
    source: NAME,
  };
}

