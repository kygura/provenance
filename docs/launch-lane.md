# The launch lane

Provenance answers one question: **is this meme anchored in something real, or
is it being forced?** The answer is only worth having early. Waiting for a token
to trend before asking gets it backwards, because by then the market has
already answered. So tokens are judged when their first pool appears, and
trending lists become the outcome, recorded against the verdict.

The lane came from merging the `dexscanner` project, which scanned new
deployments, filtered out unsafe ones and checked whether the name meant
anything.

## Coverage

| Chain | Factories | Quotes |
|---|---|---|
| Ethereum | Uniswap V2, Uniswap V3 | WETH, USDC, USDT, DAI |
| Base | Uniswap V2, Uniswap V3, Aerodrome (V2-style pools) | WETH, USDC, VIRTUAL |

Base factory addresses and the Aerodrome `PoolCreated` topic were checked
against live Base logs in October 2026. Uniswap V4 pools (Clanker, Zora) emit
`Initialize` from the PoolManager rather than a factory event and aren't
covered.

Solana isn't covered: no pump.fun graduations, no Raydium or PumpSwap pools.
The trending lane still picks up Solana and Base tokens, but only once they
trend, which is too late for this lane's question. Adding Solana needs three
things this repo doesn't have yet: a new-pool source (program logs, or
GeckoTerminal `new_pools`), a sniping read over Solana transactions, and a
chain gate that doesn't reject every Solana pool for missing the EVM-only
reads.

## Flow

```
every 30 min (launches.yml, `run --lane launches`)

factory PairCreated / PoolCreated, last 6h
        │
market gate        liquidity known and ≥ floor            ── reject: retried next run
        │
chain analysis     holders, LP burn/lock, bytecode, owner
        │
chain gate         no live mint/blacklist/pause, LP secured,
        │          holder floor, top-10 ceiling,
        │          early-buying ceiling (sniping)         ── reject: retried next run
        │
anchor check       triage model, ≤3 searches:
        │          anchored / forced / unclear,
        │          anchor date vs. launch compared in code
        │
   ┌────┴──────────────────────┐
anchored                   forced / unclear / low confidence
   │                           │
full research, now         stored as `dismissed` (judged once)
(same question in depth;
 a confident disagreement
 overturns the fast verdict)
   │
watchlist `active` + "Anchored at launch" alert

twice daily (provenance.yml, full `run`)

trending lists → any judged token on them → `expressed`, hours since verdict
               → trending research as before (reuses a launch-time report)
```

The launch lane runs before the trending lane in a full run, so the verdict at
launch gets the LLM budget first. Both lanes share `LLM_MAX_COST_USD_PER_RUN`,
and `LLM_MAX_COST_USD_PER_DAY` when set.

## The verdict

| Verdict | Means | Examples of an anchor |
|---|---|---|
| `anchored` | The thing existed before the token and outside it | `historical-meme` (a known image, video, catchphrase), `cultural-artifact` (a film, character, public figure, brand), `inciting-event` (a news story or viral moment the token reacts to) |
| `forced` | The meme exists because the token does | Earliest mentions are the token's own site, launch posts or paid promotion |
| `unclear` | The evidence doesn't settle it | |

An inciting event doesn't need a Wikipedia page. It needs to have happened,
independently, before the token. The model reports the earliest independent
source and its date. `resolveAnchor` (`packages/research/src/anchor.ts`) then
compares that date to the pool's creation time. An `anchored` verdict whose
anchor is dated more than 24h after launch becomes `unclear`: whatever it is,
the token can't have been reacting to it. Dates are read at the precision
given, at the end of the period ("2013" is the end of 2013), so a source dated
only to the day can't make a same-day reaction look late. `high` confidence
needs at least one citation.

A `forced` verdict at medium or high confidence costs a report 25 points and
caps its tier at C, however good its lineage fields look.

## The sniping check

A sniped launch passes every other check. The snipers buy in the first block
or two, spread across fresh wallets, so no holder is large and the top-10
share looks normal. Neiro's perps twin in 2024 was flagged for exactly this.
What gives it away is timing.

The EVM analyser already replays the token's `Transfer` logs. Each
transfer from the pool to a wallet is a buy (`packages/chain/src/sniping.ts`):

- **Trading start** is the first block in which the pool sends tokens out,
  not the block liquidity went in. Deployers often fund the pool and enable
  trading later, and the snipe lands on the enable block.
- **Early buying** is what the pool sent to wallets in the first 36 seconds
  of trading: 3 blocks on Ethereum, the trading-start block included. Routers,
  burn addresses and protocol contracts don't count as buyers.
- **Still held** is what those wallets hold now, from the same replay. It
  also counts wallets they fed: any wallet that got at least 90% of its
  inbound tokens from the tracked set joins it, and chains (A to B to C) are
  followed, so moving tokens to a fresh wallet isn't read as a sale.

The result is stored as `ChainAnalysis.sniping` and drives three things:

| Where | What |
|---|---|
| Flags | `sniped-launch` warns at 15% of supply bought early and is critical at 30%. `bundled-launch` warns when 3+ wallets bought in the opening block. |
| Chain gate | Rejects when early buying is above `LAUNCHES_MAX_SNIPED_PCT`, or when it couldn't be measured (the scan didn't reach trading start, or nobody has bought yet). |
| Research prompt | The `early_buying` line reaches the organic read as a measured fact. |

The read only counts when the log scan covered the token's whole life, which
is the normal case for a launch a few hours old. A scan that starts after the
launch sees buys with no liquidity add before them and returns nothing rather
than a wrong number.

## Funding clusters

Timing misses a cabal that buys a few minutes in, or a few wallets per
block. Their wallets still had to be funded with gas from somewhere, and
fresh wallets are usually funded from one place. `eth_getLogs` can't show
native transfers, so this read uses the explorer (`packages/chain/src/funding.ts`,
`lookupFirstFunders` in `packages/chain/src/explorer.ts`):

- **Window**: the first 30 minutes of trading (150 blocks on Ethereum),
  counted from the same trading-start block as the sniping read. Only runs
  when the sniping read did.
- **Traced**: the 20 largest buyers in that window. For each, the first
  incoming transaction with value on Etherscan V2 `txlist`, else
  `txlistinternal`. Funding that came through a disperse contract is
  attributed to the EOA that called it.
- **Hubs**: a funder shared by two or more buyers is dropped as a hub when it
  is a labelled protocol address, a contract, an EOA that has sent 1,000+
  transactions, or can't be checked. Two strangers withdrawing from Binance
  share a funder, not an owner. If the budget runs out before the check, the
  read is dropped rather than guessed.
- **Clusters**: buyers joined through shared funders, chains included (A funds
  B, B funds C). A cluster is 2+ buyers; `clusteredPct` is the supply they
  bought in the window.

Stored as `ChainAnalysis.funding`:

| Where | What |
|---|---|
| Flags | `funded-cluster` warns at 10% of supply bought by clustered wallets and is critical at 25%. |
| Chain gate | Rejects above `LAUNCHES_MAX_CLUSTERED_PCT` (15). Not traced is not a rejection: the read needs a key. |
| Research prompt | The `funding_clusters` line reaches the organic read as a measured fact. |

It needs `ETHERSCAN_API_KEY`. Etherscan's free tier doesn't cover every
chain, and a refusal leaves `funding` unset with a note. A cabal that funds
each wallet through a different exchange withdrawal, a bridge or a mixer
still gets past it, and older wallets whose first funding predates the
token add noise rather than false clusters. Solana has neither read yet.

## What carried over, and what changed

| Dexscanner | Merged form | Why the change |
|---|---|---|
| Transfer-from-zero logs via Etherscan | Factory `PairCreated`/`PoolCreated` via public RPC (`packages/sources/src/launches.ts`) | Any mint looks like a deployment in Transfer logs. A pool creation says a token is tradeable. No key needed. |
| Liquidity in ETH from DexScreener | `liquidityUsd` from the same DexScreener hydration the trending source uses | One unit across both lanes. |
| LP lock via Ethplorer top holders of the pair | `lpBurnedPct`/`lpLockedPct` read over RPC: pair `totalSupply` and `balanceOf` for burn addresses, Unicrypt and Team Finance; Uniswap V3 pools by tracing each position NFT's owner (`packages/chain/src/lp.ts`) | Keyless. It also fixed a bug where token-supply burn was being reported as LP burn. |
| Substring search of verified source for "mint", "pause", "blacklist" | PUSH4 selector scan of deployed bytecode (`packages/chain/src/bytecode.ts`), weighed against owner renouncement | Works on unverified contracts. A substring match on "pause" also hits comments and OpenZeppelin imports. |
| Reject unverified contracts | `contractVerified` via Etherscan V2 when `ETHERSCAN_API_KEY` is set; rejects only on an explicit `false` | Verification is the one check that needs a key, so it's optional. |
| Holder count and top-10 share via Ethplorer | The EVM analyser's Transfer-log reconstruction | Already in Provenance. |
| One-shot JSON cultural validation ("does the name mean anything?"), four providers | `AnchorChecker`: anchored/forced/unclear with a dated earliest source, search pass then forced tool call, on `LLM_TRIAGE_MODEL` (`packages/research/src/anchor.ts`) | "Recognised outside crypto" missed fresh inciting events and never asked which came first. The two-pass split is Provenance's answer to JSON that fails to parse after a search turn. |
| SQLite `tokens` table, status `active/dormant/expressed` | `watchlist` table (migrations 2–3): those three plus `dismissed`, the verdict as real columns, `expressedAt`, `leadHours`, `expressedOn` | Dexscanner defined `expressed` but never set it. Dexscanner also dropped rejected tokens and re-checked them every run; a verdict is now stored whatever it is. |
| Telegram message "New Candidate Added" | `launch-anchored` (verdict first, lineage when researched) and `launch-expressed` alerts through the existing channels | |
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
| `LAUNCHES_LOOKBACK_HOURS` | `6` | Factory-event window per run; a launch that fails the gate is retried while inside it |
| `LAUNCHES_MAX_CANDIDATES` | `40` | New pools hydrated per run |
| `LAUNCHES_MAX_CATALOG_PER_RUN` | `8` | Launches given chain analysis and an anchor check per run |
| `LAUNCHES_MIN_LIQUIDITY_USD` | `40000` | Roughly dexscanner's 15 ETH |
| `LAUNCHES_MIN_HOLDERS` | `50` | Lower than dexscanner's 100 so the verdict doesn't wait on distribution |
| `LAUNCHES_MAX_TOP10_PCT` | `40` | Top-10 share excluding LP and burn |
| `LAUNCHES_MAX_SNIPED_PCT` | `20` | Supply bought in the first 36 s of trading; unmeasured rejects |
| `LAUNCHES_REQUIRE_LP_SECURED` | `true` | Reject when LP burn/lock can't be measured (V4 pools, V3 forks, busy or untraceable V3 pools) |
| `LAUNCHES_MIN_LP_SECURED_PCT` | `90` | Burned plus locked LP share |
| `LAUNCHES_DORMANT_AFTER_HOURS` | `168` | `active` → `dormant` |
| `LAUNCHES_MAX_ANCHOR_SEARCHES` | `3` | Web searches per fast anchor check |
| `LAUNCHES_RESEARCH_ANCHORED` | `true` | Run the full research on anchored launches, at launch |
| `LAUNCHES_MAX_CLUSTERED_PCT` | 15 | Ceiling on supply bought by early wallets sharing a funder |
| `ETHERSCAN_API_KEY` | unset | Optional; enables `contractVerified` and funding clusters |
| `ELFA_API_KEY` | unset | Optional; records each entry's lead over crypto-social (`socialLeadHours`, see `docs/social.md`) |

**V3 LP.** Uniswap V3 positions are NFTs, so there is no LP supply to divide.
For a fresh V3 pool on Ethereum or Base, `measureV3Pool` reads every pool
`Mint` since the scan start, maps each one minted through the
NonfungiblePositionManager to its token id (the `IncreaseLiquidity` log in the
same receipt), then reads that position's current liquidity and `ownerOf`. An
NFT held by a burn address counts as burned, one held by Team Finance as
locked; a mint straight to any other owner counts as unsecured at its minted
amount. Liquidity on different tick ranges isn't strictly comparable, so the
share is approximate beyond one or two full-range positions. A pool with more
than 20 mints, a scan that doesn't reach head, or a missing receipt stays
unmeasured and, with `LAUNCHES_REQUIRE_LP_SECURED=true`, is rejected. So are
V3 forks (their managers aren't listed) and positions locked with UNCX, whose
V3 locker isn't in the table yet. Dexscanner rejected every V3 launch
without saying so.

## Commands

```bash
bun run apps/worker/src/cli.ts run --lane launches      # what the 30-minute cron runs
bun run apps/worker/src/cli.ts launches                 # launch source only, with market-gate results
bun run apps/worker/src/cli.ts watchlist                # every verdict, and each verdict's trend record
bun run apps/worker/src/cli.ts watchlist --verdict forced
```

`run` prints a `launches:` line with the lane's counters. The fixture pools are
up to 21h old, so an offline demo needs `LAUNCHES_LOOKBACK_HOURS=48 ... run
--fixtures --dry-run`.

## Known gaps

- Funding clusters need `ETHERSCAN_API_KEY` and stop at exchanges, bridges
  and mixers. A cabal funded through separate exchange withdrawals gets past
  both the timing and the funding read.
- A launch with liquidity but no buys yet is rejected as "not measured" and
  retried on the next run, like a launch below the holder floor.

- `unclear` is stored as `dismissed` and never re-checked. An inciting event
  that only gets written up a day after the token launched stays unclear. A
  re-check of recent unclear verdicts is the obvious next step.
- The fast check and the full research share one definition of the verdict
  (`ANCHOR_RULES`) but not one model; the triage model decides what gets
  researched.
- At 30-minute cadence the launch cron uses ~1,500–3,000 GitHub Actions
  minutes a month, which is over the free quota on a private repository.

## What still needs a live run

The build sandbox has no route to any RPC or data host, so everything here was
checked against fixtures only:

- factory topic hashes and log layouts against a real Ethereum node (Base
  was checked live: factories, topics and the Aerodrome layout),
- the locker addresses (taken from dexscanner's constants, not read on-chain),
- whether public nodes accept a 2,000-block `eth_getLogs` range on the factories,
- the anchor prompts on real launches, where the interesting failures are
  generic words, crypto-native jokes with a Wikipedia page, and news events
  written up only after the token.
