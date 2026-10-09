# Provenance

Is this meme anchored in something real, or is it being forced?

That is the one question Provenance answers, and it answers it at launch.
Every 30 minutes it reads new Uniswap pools straight off the factory
contracts, drops anything unsafe, and asks Claude to find the earliest source
about the thing the token points at that does not mention the token.

- **anchored**: the thing existed before the token and outside it. An old
  internet meme, a film or character, a public figure, or an inciting event
  from the news that the token is reacting to.
- **forced**: the meme exists because the token does. The earliest mentions are
  the deployer's own posts, paid shills, or nothing.
- **unclear**: the evidence doesn't settle it.

The order of events decides it, and the code compares the dates, not the model.
An anchored launch gets the full research straight away: lineage, prior
cycles, and whether this token is the one the meme's audience will accept.
Trending lists (DexTools, DexScreener, GeckoTerminal, twice a day) are the
outcome, recorded against a verdict that came first. They are not the trigger.

## Why lineage matters to the verdict

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

The **launch lane** is where tokens are judged. It gates new pools on
liquidity, burned or locked LP, no live mint/blacklist/pause functions in the
bytecode, and holder spread. Then it runs the fast anchor check (triage model, a
few searches), and runs the full research on anything anchored. Every verdict is
stored, forced ones included, so a token is judged once and a forced meme that
pumps anyway is on record as exactly that.

The **trending lane** is the original twice-daily scan. It still researches
whatever trends, and it marks a judged token `expressed` when that token shows
up on a list. See [`docs/launch-lane.md`](docs/launch-lane.md).

## What runs where

| Piece | Runs on | Cost |
|---|---|---|
| Launch lane: new pools, gate, verdict, research | GitHub Actions cron, every 30 min | ~1.5–3k Actions min/month: free on a public repo, over the 2k private quota |
| Trending lane: lists, analysis, research | GitHub Actions cron, twice daily | free tier |
| Database | libSQL / Turso (or a local SQLite file) | free tier |
| Dashboard | Vercel | free tier |
| LLM | Anthropic API | the only paid credential |
| Social yardstick (optional) | Elfa trending-CA feeds, `ELFA_API_KEY` | free tier; ~720 of 1,000 monthly credits ([docs/social.md](docs/social.md)) |

No paid market-data API keys. DexScreener and GeckoTerminal publish free keyless
endpoints. DexTools has no free API and sits behind Cloudflare, so it is read
through Exa search (`EXA_API_KEY`): results restricted to its `pair-explorer`
pages, resolved to tokens through DexScreener, with Playwright and headless
Chromium as the fallback when search finds nothing.

## Pipeline

```
discover ─┬─ dextools      (exa search for pair pages, playwright fallback)
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
cp .env.example .env          # one LLM key is all you need; ANTHROPIC_API_KEY by default

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
