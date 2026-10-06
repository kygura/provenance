# Architecture

## Shape

A Bun workspace. `packages/core` holds every type and interface; nothing in core
imports from another package, and every other package depends only on core. That
keeps the pieces independently replaceable and lets them be built in parallel.

```
core  ←─  sources
      ←─  chain
      ←─  research
      ←─  store
      ←─  alerts
              ↑
         apps/worker  (composes all of them)
         apps/dashboard  (core + store only)
```

## Why these boundaries

**sources** owns "what is trending", and nothing else. It normalizes three
upstreams with different shapes, vocabularies and reliability into one
`TokenSnapshot` per token. Cross-source agreement is kept (`sourceCount`,
`bestRank`) because a token on two lists is a different observation from a token
on one.

The `launches` source is the one exception to "what is trending": it reads new
pools off DEX factory events, so the pipeline sees supply before demand.
`splitLanes` sends launch-only tokens down a separate lane with hard gates and
a watchlist; see `launch-lane.md`.

**chain** owns "who holds it". It is deliberately dependency-free — raw JSON-RPC
over `fetch` — because every wallet SDK that would make this convenient also
wants an API key or a paid endpoint. It never throws: an unsupported chain
returns `method: 'unavailable'` with a note.

**research** owns "where the meme came from". Two model calls: a research pass
with the web search server tool and no output constraint, then an extraction
pass with no tools and a forced tool call over its own notes. The split is the
point — a model filling a twelve-field schema starts optimising for the schema
partway through the search.

Search is server-side. An earlier version scraped Wikipedia, Know Your Meme,
Reddit and DuckDuckGo's HTML; those parsers broke whenever a site reflowed and
returned nothing rather than reporting that they had failed. What remains of the
collector layer is the zero-network one, which turns what the pipeline already
measured into evidence rows. `EvidenceCollector` is still injectable, so a
private corpus or a paid search API plugs in without touching the analyst.

Everything the deployer wrote, and everything a web page returned, reaches the
model inside a nonce-delimited block that the system prompt marks as evidence
and never as instruction. A token description is attacker-controlled text, and
it feeds the field the score weighs most.

**alerts** owns judgement — scoring and rules, and the launch lane's gates. Separated from delivery so the
scoring model can be tuned and tested without touching a network, and so rules
can be added without touching the pipeline.

**store** is the only thing that knows SQL. Both the worker and the dashboard go
through the `ProvenanceStore` interface, so swapping libSQL for something else is
one new implementation.

## Degradation policy

Every stage is allowed to return less, never to fail the run:

| Failure | Result |
|---|---|
| A scraper's selectors moved | that source contributes nothing, run continues on the other two |
| A public RPC refuses a heavy call | `holderCount` stays undefined, a note explains why |
| EVM log scan hits its bound | `method: 'partial'`, concentration from what was scanned |
| Every evidence collector fails | on-chain-only evidence, low model confidence |
| Web search unavailable or exhausted | notes from model recall alone, confidence scaled to 0.7x |
| A research turn stops with `pause_turn` | resumed up to 3 times, notes accumulate across resumes |
| No `ANTHROPIC_API_KEY` | market + chain score only, no provenance report |
| LLM cost ceiling hit mid-run | remaining tokens get a market-only score, recorded in run stats |
| One token throws | isolated, recorded, run continues |
| An Elfa feed fails, or no `ELFA_API_KEY` | no social sightings this run; recorded, but never enough to fail a run on its own |

The run's status ends up `ok`, `partial` or `failed`. The dashboard renders
partial data as a normal state, because it usually is one.

Two consequences worth stating plainly: a missing measurement is never treated as
a clean result — an unmeasured distribution scores neutral-to-low, not high — and
concentration statistics computed from a sampled top-N are labelled as samples
everywhere they appear, because presenting a sample as a population is how this
kind of dashboard usually lies.

## Cost control

Twice-daily runs over ~15 tokens would re-research the same tokens repeatedly, so:

- a token analysed within `REANALYSE_AFTER_HOURS` reuses its stored report and
  only recomputes the score against fresh market data,
- evidence pages are cached in the DB by URL hash,
- cumulative LLM spend is tracked per run against `LLM_MAX_COST_USD_PER_RUN`,
  after which the pipeline keeps collecting market and chain data but stops
  calling the model.

## Extending it

**A new source**: implement `TrendingSource` from `core/src/contracts.ts`, add it
to `createSources`, add a chain alias if it names chains differently, commit a
fixture and a parser test.

**A new chain**: implement `ChainAnalyzer`, add the chain to `CHAINS` and
`CHAIN_ALIASES`, add its RPC list to `ChainRpcConfig`.

**A new evidence source**: implement `EvidenceCollector` and add it in
`defaultCollectors`. Give it an honest `sourceQuality` — it directly weights how
much the model trusts it. Whatever it returns is fenced as untrusted before it
reaches a prompt.

**A new archetype**: add a row to `packages/research/src/lexicon.ts`. It is a
cheap prior handed to the research pass as a hypothesis, never as a source —
patterns must not carry `/g`, which would make `classify()` order-dependent.

**A new alert**: implement `AlertRule` and add it to `defaultRules`. Rules get
`history`, so deltas across runs are available.

**A new scoring component**: add it to `ScoreComponents`, write the pure
component function and its weight, keep the weights summing to 1.

## Testing

Every parser is tested against a committed fixture, and the whole pipeline runs
offline with `--fixtures`. This is not only a convenience: the sandbox this was
built in has no outbound access to any data host, so fixtures are the only
contract the parsers were ever checked against. The selectors and payload shapes
for the scraped sources are informed guesses until a live run confirms them —
`bun run apps/worker/src/cli.ts discover` is the first thing to run against the
real internet.
