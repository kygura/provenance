# The launch lane (dexscanner, merged)

Provenance started from demand. It reads trending lists and asks where a
token's meme came from. Dexscanner started from supply. It read new ERC-20
deployments, threw out anything unsafe, and asked whether the name points at
something people outside crypto would recognise.

Both projects were looking at the same tokens, just at opposite ends of their
lives. So the merged pipeline runs both, and it records the moment they agree:
a token caught at launch that later turns up on a trending list.

## Flow

```
discover ─┬─ dextools / dexscreener / geckoterminal     demand
          └─ launches  (Uniswap V2 PairCreated,          supply
                        V3 PoolCreated, public RPC)
                │
          merge → splitLanes
                │
   ┌────────────┴─────────────────────────────┐
trending lane                              launch lane
   │                                          │
reconcile watchlist ◄──── same token ────  market gate     liquidity known and ≥ floor
   │   (active/dormant → expressed,           │
   │    lead time recorded)                chain analysis   holders, LP, bytecode, owner
   │                                          │
filter → triage → chain → research         chain gate      hard rejects, no scoring
   → score → rules                            │
   │                                       referent check  triage model, ≤3 searches
   │                                          │
   │                                       watchlist (active) + "catalogued" alert
   └──────────────┬───────────────────────────┘
            dormancy sweep → dispatch alerts → store
```

The trending lane runs first, so the LLM budget pays for full research before
it pays for referent checks. Both lanes draw on the same
`LLM_MAX_COST_USD_PER_RUN` ceiling.

## What carried over, and what changed

| Dexscanner | Merged form | Why the change |
|---|---|---|
| Transfer-from-zero logs via Etherscan | Factory `PairCreated`/`PoolCreated` via public RPC (`packages/sources/src/launches.ts`) | Any mint looks like a deployment in Transfer logs. A pool creation says a token is tradeable. No key needed. |
| Liquidity in ETH from DexScreener | `liquidityUsd` from the same DexScreener hydration the trending source uses | One unit across both lanes. |
| LP lock via Ethplorer top holders of the pair | `lpBurnedPct`/`lpLockedPct` read over RPC: pair `totalSupply` and `balanceOf` for burn addresses, Unicrypt and Team Finance (`packages/chain/src/lp.ts`) | Keyless. It also fixed a bug where token-supply burn was being reported as LP burn. |
| Substring search of verified source for "mint", "pause", "blacklist" | PUSH4 selector scan of deployed bytecode (`packages/chain/src/bytecode.ts`), weighed against owner renouncement | Works on unverified contracts. A substring match on "pause" also hits comments and OpenZeppelin imports. |
| Reject unverified contracts | `contractVerified` via Etherscan V2 when `ETHERSCAN_API_KEY` is set; rejects only on an explicit `false` | Verification is the one check that needs a key, so it's optional. |
| Holder count and top-10 share via Ethplorer | The EVM analyser's Transfer-log reconstruction | Already in Provenance. |
| One-shot JSON cultural validation, four providers | `ReferentChecker`: search pass, then a forced tool call, on `LLM_TRIAGE_MODEL` (`packages/research/src/referent.ts`) | The two-pass split is Provenance's answer to JSON that fails to parse after a search turn. |
| SQLite `tokens` table, status `active/dormant/expressed` | `watchlist` table (migration 2), same three statuses, plus `expressedAt`, `leadHours`, `expressedOn` | Dexscanner defined `expressed` but never set it. The trending lane now sets it. |
| Telegram message "New Candidate Added" | `launch-catalogued` and `launch-expressed` alerts through the existing channels | |
| `inquirer` TUI and `scanner.config.json` | `LAUNCHES_*` env vars (`packages/core/src/config.ts`) | Provenance runs in GitHub Actions; every knob is already an env var. |
| OpenAI, Gemini and DeepSeek providers | Not carried over | Provenance's research depends on Anthropic's server-side search, `pause_turn` handling and forced tool calls. Porting four providers into that would double the surface for one gate. The dexscanner repo still has them if they're needed. |

The gate inverts the trending lane's missing-data policy on purpose. On the
trending side an unknown number is kept for the chain stage to resolve. On the
launch side the chain stage has already run, so an unknown is "could not be
shown safe", and that rejects.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `LAUNCHES_ENABLED` | `true` | Run the launch source and lane |
| `LAUNCHES_LOOKBACK_HOURS` | `24` | Factory-event window per run |
| `LAUNCHES_MAX_CANDIDATES` | `40` | New pools hydrated per run |
| `LAUNCHES_MAX_CATALOG_PER_RUN` | `8` | Launches given chain analysis and a referent check |
| `LAUNCHES_MIN_LIQUIDITY_USD` | `40000` | Roughly dexscanner's 15 ETH |
| `LAUNCHES_MIN_HOLDERS` | `100` | |
| `LAUNCHES_MAX_TOP10_PCT` | `40` | Top-10 share excluding LP and burn |
| `LAUNCHES_REQUIRE_LP_SECURED` | `true` | Reject when LP burn/lock can't be measured (V3 pools) |
| `LAUNCHES_MIN_LP_SECURED_PCT` | `90` | Burned plus locked LP share |
| `LAUNCHES_DORMANT_AFTER_HOURS` | `168` | `active` → `dormant` |
| `LAUNCHES_MAX_REFERENT_SEARCHES` | `3` | Web searches per referent check |
| `ETHERSCAN_API_KEY` | unset | Optional; enables `contractVerified` |

`LAUNCHES_REQUIRE_LP_SECURED=true` means Uniswap V3 launches never pass, because
V3 liquidity positions are NFTs and "LP burned" has no single number there.
Dexscanner had the same limit without saying so.

## Commands

```bash
bun run apps/worker/src/cli.ts launches            # launch source only, with market-gate verdicts
bun run apps/worker/src/cli.ts watchlist           # everything catalogued
bun run apps/worker/src/cli.ts watchlist --status expressed
```

`run` prints a `launches:` line with the lane's counters.

## What still needs a live run

The build sandbox has no route to any RPC or data host, so everything here was
checked against fixtures only:

- factory topic hashes and log layouts against a real Ethereum node,
- the locker addresses (taken from dexscanner's constants, not read on-chain),
- whether public nodes accept a 2,000-block `eth_getLogs` range on the factories,
- the referent prompt on real names, where the interesting failures are
  generic words and crypto-native jokes that happen to have a Wikipedia page.
