# Provenance

Pulls the trending tokens twice a day, gathers the market, holder and contract
data for the ones worth a look, then has Claude research where each token's meme
actually came from — and, more to the point, what earlier thing it is a rerun of.

## Why

Most tokens that trend are not new stories. They are old stories running again in
front of an audience that was not there the first time. A narrative that already
paid once is easier to sell than one that has to be explained, and the marginal
buyer here is usually new, in a hurry, and not checking.

So the useful question about a token going up is not "what is this". It is "what
is this a copy of, and how did the original end". That question is tedious to
answer by hand for thirty tokens a day and easy to answer with search. Hence this.

## What a run does

```
trending feeds  →  cheap filters  →  holder + contract data  →  Claude + web search  →  alerts
   ~60 tokens        ~15 tokens           top 18                    top 6
```

Each stage is narrower than the one before it, because each stage costs more.
Collection is batched and nearly free. Holder data is one request per token.
Research is an LLM call with web search, so only the top of the shortlist gets one.

The output per token is a verdict with a named lineage: which prior memes this
one descends from, what each peaked at, how each resolved, and how far back the
closest ancestor is. Plus the on-chain read — concentration, mint authority, LP
state, volume-to-liquidity — stated plainly rather than softened.

## Setup

```bash
uv sync --extra dev
cp .env.example .env    # fill in ANTHROPIC_API_KEY at minimum
uv run provenance run --dry-run
```

`--dry-run` scrapes, filters and ranks without calling the model or sending
anything. It prints the queue and why each token is on it, which is the fastest
way to tune `config/provenance.toml`.

A real run:

```bash
uv run provenance run              # markdown report to stdout, alerts sent
uv run provenance run --limit 2    # cap the LLM calls
uv run provenance history          # what has been alerted before
uv run provenance lexicon          # the archetype table
```

## Data sources

| What | Source | Key needed |
|---|---|---|
| Trending, promoted | DexScreener boosts | no |
| Trending, organic | GeckoTerminal trending pools | no |
| Trending, hot pools | DEXTools v2 | yes, paid |
| Price, depth, age, socials | DexScreener pairs | no |
| Holders, distribution, contract risk | GoPlus | no |
| Solana holders (fallback) | Helius RPC | yes, free tier |

It runs on the keyless sources alone. DEXTools is the source the project was
specified around and it is wired in, but it needs a subscription, and the free
feeds surface substantially the same tokens. If `DEXTOOLS_API_KEY` is unset the
run says so once and carries on.

Every source is best-effort. A dead endpoint degrades one field of one dossier;
it does not end the run.

## Scheduling

`.github/workflows/provenance.yml` runs at 06:00 and 18:00 UTC. Before the
European session and after the US open — the two points where something that
moved overnight is visible but not yet done.

Set these as repository secrets. Only the first is required:

- `ANTHROPIC_API_KEY`
- `DEXTOOLS_API_KEY`, `HELIUS_API_KEY` — better data if you have them
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`, `DISCORD_WEBHOOK_URL` — where alerts go

Every run writes `reports/YYYY-MM-DD-HHMM.md` and commits it. With no push
channel configured, that committed report plus a GitHub issue per run is the
whole alert system, which is enough to start.

Dedupe history lives in a SQLite file cached between runs. If the cache is
evicted you get one repeated alert, nothing worse.

## Tuning

`config/provenance.toml` holds the dials. The two that matter:

- `research.max_tokens_per_run` — the cost ceiling. Six tokens × two runs a day
  is twelve research calls, each with up to eight web searches.
- `filters.*` — the floors. Raising `min_liquidity_usd` is the bluntest way to
  cut noise; `max_age_hours` is what stops the report filling up with things that
  are no longer narratives, just charts.

`src/provenance/lexicon.py` is the seed table of archetypes and their known
ancestors — dog coins back to 2013, yield mechanisms back to SafeMoon, the AI
pitch back to 2017. It is a cheap first pass that runs over every token for free
and gives the model a hypothesis to confirm or reject instead of a blank page.
It is meant to be edited. Add rows as metas come back around.

## What it does not do

No trading, no signals, no price targets. The prompt forbids recommendations and
the output is a provenance claim with sources attached. Lineage claims are model
output; check the citations before acting on any of them.

Token names and descriptions are deployer-controlled text. They reach the model
inside a fenced block marked as evidence rather than instruction, and an attempt
to address the model through that channel is reported as a finding.

## Layout

```
src/provenance/
  sources/     trending feeds, one adapter each, merged by aggregate.py
  enrich/      holders and contract risk (GoPlus, Helius)
  research/    the prompt (prompts.py) and the two-phase LLM call (analyst.py)
  alerts/      rendering and delivery
  lexicon.py   archetypes and their ancestors
  scoring.py   filters and ranking
  pipeline.py  the run
```

`research/prompts.py` is where the thesis lives. Everything else moves data.

## Tests

```bash
uv run pytest -q
uv run ruff check src tests
```

The pipeline tests run the real adapters, enrichment, scoring, state and
rendering against recorded fixtures, stubbing only the network and the model.
