# Is Jev the right classifier here?

Status: assessment, 2026-09-24. No code depends on it yet.

Jev (TypeSafe's System One model, `jev-1.13.0`) is already wired into Hyperion's
strategy runtime. The facts below come from Hyperion's
`docs/jev/RESEARCH.md`, which cites TypeSafe's docs directly. This note asks a
narrower question: does Jev fit the *time-phase* and *sub-type* classification
this pipeline needs? Narrative classification is a separate question.

## What Jev is, in the terms that matter here

- It answers typed questions about a `state` object: `noul` (a yes/no
  probability), `choice` (pick one label, with a probability per label) and
  `score` (2–10 ordered levels).
- It can't search, call tools or write text. It only reads the state you give it.
- It's cheap and fast: $0.042 per million input tokens, output free, median
  about 130 ms. At ~700 tokens a call, classifying every token on every run
  costs fractions of a cent.
- TypeSafe's own docs say it is "not a calculator". It struggles with numeric
  precision, date comparison and multi-hop lookups. It reads named buckets
  (`"liquidity_trend": "rising_fast"`) much better than raw floats.
- It does not treat state as hostile. Text from a deployer or a web page is a
  prompt-injection path straight into the answer.
- It has no published calibration on market data. Its `confidence` is a
  statistic of how the probabilities are spread, not a measured accuracy.

## Narrative classification: no

Working out what a name refers to, when the meme started and how many times it
has already been tokenised means finding facts that aren't in the input. Jev
can't search, and a lineage is generated text. The two Claude passes stay: the
referent check at launch and the full provenance research once a token trends.

## Time-phase classification: yes, with the numbers done in code

By "time-phase" I mean: where in its attention cycle is this token right now?
The merged pipeline now asks that of every watchlisted token on every run:

| Phase | Plain meaning |
|---|---|
| `pre_expression` | Launched and gated, no trending appearance, flat activity |
| `igniting` | Still off the lists, but holders and turnover are accelerating |
| `expressing` | On one or more trending lists, volume rising |
| `distributing` | Trending, but concentration rising while price stalls |
| `fading` | Off the lists, activity decaying |
| `none_of_these` | Explicit "other", because a `choice` must pick something |

That shape fits Jev. It's a closed label set, the input is structured, and
the answer is needed often and cheaply. A frontier model is overkill at twice a
day and unaffordable if the watchlist gets polled every few minutes.

It only works if the worker computes every number and sends Jev labels next to
them:

```jsonc
{
  "age": { "hours_since_launch": 31, "bucket": "day_1_to_3" },
  "listing": { "trending_sources_now": 0, "trending_sources_24h_ago": 0, "bucket": "unlisted" },
  "holders": { "count": 412, "change_24h_pct": 64, "bucket": "rising_fast" },
  "turnover": { "vol_to_liq_24h": 3.1, "bucket": "high" },
  "concentration": { "top10_pct": 28, "change_24h_pts": -6, "bucket": "dispersing" },
  "price": { "change_24h_pct": 41, "bucket": "up_strong" }
}
```

Three questions go in one call:

- `phase` (choice): the table above, with `{what, examples}` criteria for each label.
- `expressing_now` (noul): "Is this token currently drawing trending-list attention?"
  This one is nearly deterministic. Keep it anyway, so disagreement with the
  arithmetic shows up.
- `momentum_quality` (score, 3 levels): organic breadth vs. a few wallets churning.

Never put the token's name, description or social links in this state. None of
them help with phase, and all of them are attacker-written.

## Sub-type classification: useful as a cross-check

`recycleVerdict` (original/revival/derivative/copycat/unclear) and
`narrativeCluster` are closed label sets too. Jev could re-classify them from
the research pass's notes as a second opinion on the extraction pass. When the
two disagree, the report gets flagged for its confidence to be cut. The catch is
that those notes are built from web pages, so they're untrusted text. Only
fence-free, model-written summaries should go in, and they should be kept short.
Worth it after phase classification works, not before.

## Why now is the right time to measure, and not yet to switch

The blocker Hyperion's research names is calibration: nobody has shown how
Jev's confidence tracks accuracy on market state. The merged pipeline produces
the labels needed to find out. Every watchlist entry ends as `expressed` (with
a lead time) or `dormant`. After a few weeks of runs there is a labelled set of
per-run states with known outcomes.

The order to do it in:

1. Compute the bucketed state above in the worker and store it per watchlist
   entry per run. That is useful on its own for the dashboard, and it's the
   training/eval set.
2. Write a deterministic rules classifier over the same buckets as the baseline.
3. Run Jev in shadow mode beside it. Log both answers; act on neither.
4. Once a few hundred states have outcomes, plot Jev's confidence against
   agreement with outcome, as TypeSafe's consistency cookbook does. Pick the
   auto threshold from that curve, not from the illustrative 0.6–0.9 bands in
   the docs.
5. Pin `jev-1.13.0`. `jev-latest` moves without notice and invalidates thresholds.

Keep the rules classifier as the fallback. TypeSafe's rate limits and
availability are still "adjusting dynamically", and OpenRouter's System One
route showed 33% three-day availability in mid-September.

## Integration cost

Provenance is TypeScript and Hyperion's Jev client is Go, so there's nothing to
share at the code level. The HTTP surface is one endpoint
(`POST https://api.typesafe.ai/v1/systemone`, bearer `TYPESAFE_API_KEY`), which
is a ~100-line client with retries on 408/429/5xx. That would add a second paid
credential. It's cheap, but it breaks the "Anthropic key is the only paid
credential" line in `SPEC.md`, so it should stay optional the same way
`ETHERSCAN_API_KEY` is.
