/**
 * Solana holder concentration straight from RPC, when a Helius key is present.
 *
 * GoPlus is the default source; this exists because GoPlus sometimes returns an
 * empty holders array for very new mints, which is exactly the case the project
 * cares about most.
 *
 * `getTokenLargestAccounts` returns the top 20 token accounts, so the derived
 * figures describe the visible top 20 and nothing beyond it.
 */

import { asFloat, asObjectList, dig, type Fetcher } from "../http.js";
import { emptyHolders, type HolderSnapshot } from "../models.js";

export const NAME = "helius";

export async function fetchHolders(
  fetcher: Fetcher,
  apiKey: string,
  mint: string,
): Promise<HolderSnapshot | null> {
  const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

  const supply = await fetcher.postJson(url, {
    jsonrpc: "2.0",
    id: "supply",
    method: "getTokenSupply",
    params: [mint],
  });
  const total = asFloat(dig(supply, "result", "value", "uiAmount"));
  if (!total) return null;

  const largest = await fetcher.postJson(url, {
    jsonrpc: "2.0",
    id: "largest",
    method: "getTokenLargestAccounts",
    params: [mint],
  });

  const amounts = asObjectList(dig(largest, "result", "value"))
    .map((row) => asFloat(row.uiAmount))
    .filter((a): a is number => a !== null && a > 0)
    .sort((a, b) => b - a);

  if (amounts.length === 0) return null;

  const share = (slice: number[]) =>
    Math.round((slice.reduce((a, b) => a + b, 0) / total) * 10_000) / 100;

  return {
    ...emptyHolders(),
    top10Pct: share(amounts.slice(0, 10)),
    top50Pct: share(amounts),
    source: `${NAME} (top ${amounts.length} accounts)`,
  };
}
