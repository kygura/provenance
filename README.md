# Provenance

Trending tokens, traced back to where their meme came from.

Twice a day Provenance scrapes the trending lists on DexTools, DexScreener and
GeckoTerminal, pulls holder distribution and token economics off free public
RPCs, and has Claude research each token's **memetic provenance** — the origin of
the meme, everything that already monetised it, and whether this particular token
is the instance the meme's audience would call canonical. It scores the result,
fires alerts, and renders everything on a dashboard.

## The thesis

Recycled narratives are new participants rediscovering the metas of old.

There is no particular reason novelty should drive a wave of speculation. A
narrative that already worked carries its own proof, and the marginal participant
is neither informed enough nor careful enough to tell a revival from an
invention. That makes the *simplicity of an established narrative* the asset, and
it makes provenance measurable: a meme with dated prior cycles, a known peak, and
a recognisable audience is a different object from a meme invented last Tuesday,
even when the two look identical on a chart.

So the system does not ask "is this new?" It asks:

- What is the meme, and what year did it enter culture?
- How many times has it been tokenised before, and what happened each time?
- Is this a **revival**, a **derivative**, a **copycat**, or genuinely **original**?
- Which generation of the recycle is this — the first revival, or a revival of a revival?
- Is this the token the meme's audience accepts, or a latecomer wearing the name?

Those answers, plus distribution health and liquidity depth, become a 0-100 score
and a tier. A copycat of a live meme scores badly. A clean revival of a proven
meme with untouched mint authority and distributed holders scores well. A great
story on a token whose mint authority is still live gets flagged, not promoted.

## Two lanes

Provenance also watches supply, not only demand. The launch lane (merged in from
the `dexscanner` project) reads new Uniswap pools straight off the factory
contracts and gates them hard: liquidity, burned or locked LP, no live
mint/blacklist/pause functions in the bytecode, holder spread. Then one cheap
model call asks whether the name refers to anything outside crypto. Survivors go
on a watchlist. When a watchlisted token later shows up on a trending list, the
run marks it `expressed` and records how many hours that took. See
[`docs/launch-lane.md`](docs/launch-lane.md).

## What runs where

| Piece | Runs on | Cost |
|---|---|---|
| Discovery + analysis + LLM + alerts | GitHub Actions cron, twice daily | free tier |
| Database | libSQL / Turso (or a local SQLite file) | free tier |
| Dashboard | Vercel | free tier |
| LLM | Anthropic API | the only paid credential |

No paid market-data API keys. DexScreener and GeckoTerminal publish free keyless
endpoints. DexTools has no free API, so it is scraped with Playwright driving
headless Chromium.

## Pipeline

```
discover ─┬─ dextools      (playwright, XHR interception w/ DOM fallback)
          ├─ dexscreener   (free public API: boosts, profiles, pairs)
          ├─ geckoterminal (free public API: trending pools)
          └─ launches      (factory PairCreated/PoolCreated over public RPC)
                │
          split lanes         launch-only tokens → launch lane (docs/launch-lane.md)
                │             watchlisted tokens seen trending → expressed
          merge + triage      cross-source agreement, liquidity/volume/age filters
                │
          chain analysis      holders, concentration, supply, authorities, LP,
                │             risk flags — free RPCs only
          evidence            on-chain + listing metadata, no network
                │
          research pass       Claude with the web search server tool, no output
                │             constraint — prose notes and citations
                │
          extraction pass     the same notes, no tools, forced tool call →
                │             a schema-validated ProvenanceReport
                │
          scoring             recycling · memetic · distribution · liquidity ·
                │             momentum · authenticity, with penalties and
                │             hard tier ceilings for critical risk flags
          alerts              telegram · discord · webhook · file · console
                │
          store               libSQL  →  dashboard
```

Research is two calls on purpose. The first searches with no schema in front of
it, so the model can follow a lead and find it wrong; the second structures
those notes with no tools and nothing new to look up. Asked to do both at once,
a model starts writing to the schema partway through the search, and the
lineage — the field the score weighs most — is the first thing to suffer.

Every stage degrades rather than fails. A dead source, an RPC that refuses
`getProgramAccounts`, a scraper whose selectors moved, a missing API key — each
produces partial data with an explicit note, never an aborted run.

## Quick start

```bash
bun install
cp .env.example .env          # ANTHROPIC_API_KEY is the only one needed to start

bun run apps/worker/src/cli.ts migrate
bun run apps/worker/src/cli.ts seed          # demo data, no network needed
bun run apps/worker/src/cli.ts run --fixtures --dry-run   # full pipeline, offline

cd apps/dashboard && bun run dev
```

Live run:

```bash
bun run apps/worker/src/cli.ts discover                 # smoke-test the scrapers
bun run apps/worker/src/cli.ts launches                 # smoke-test the launch scan
bun run apps/worker/src/cli.ts watchlist                # what was caught at launch, and what became of it
bun run apps/worker/src/cli.ts analyze solana:<mint>    # one token, full treatment
bun run apps/worker/src/cli.ts run
```

## Layout

```
packages/core       contracts, types, config, logging, utilities
packages/sources    trending + launch discovery, normalization, merge, lanes
packages/chain      holder distribution, supply, authorities, risk flags
packages/research   evidence collection + LLM provenance synthesis
packages/store      libSQL persistence
packages/alerts     scoring model, alert rules, delivery channels
apps/worker         pipeline orchestration + CLI
apps/dashboard      Next.js dashboard on Vercel
fixtures/           recorded upstream payloads — every parser is tested offline
```

## Deployment

See [`docs/deploy.md`](docs/deploy.md) for the Turso, GitHub Actions and Vercel
setup, and [`docs/architecture.md`](docs/architecture.md) for how the pieces fit
and where to extend them.

## Scope and honesty

Provenance describes structure. It does not tell you what to buy, and a high
score is a statement about a token's narrative lineage and distribution, not a
prediction. The LLM's provenance claims are grounded in the evidence collected
alongside them and carry an explicit confidence; where the model leans on its own
knowledge it has to say so. Treat `unclear` as the honest answer it is.
