# Calibration

Every weight and bonus in `packages/alerts/src/scoring.ts` was set by hand.
This is the loop that checks them against what happened: label old scores
by outcome, fit the components to the labels, and print a suggestion a
person can apply. Nothing here changes the score on its own.

## The label

A trending token drops off the trending lists whether it thrives or dies, so
"absent from later snapshots" says nothing. The label is a forward look
instead (`apps/worker/src/outcomes.ts`):

- One label per token per UTC day, from that day's latest scored run. At an
  hourly cadence a token trending all day would otherwise be 24 outcomes.
  A token-day becomes a candidate only once the whole UTC day ended at least
  `OUTCOME_HORIZON_HOURS` (default 72) ago, so the day's last run is there
  to pick rather than its first to cross the horizon.
- Nothing older than 1.5 × horizon + 24 h (132 h at 72) is a candidate. The
  day rule needs the extra day; the half horizon covers missed runs. Every
  day stays reachable for 36 h at the default, which spans at least three
  full runs at the base cadence.
- Full-lane runs only: a launch-lane score is of a pool minutes old, a
  different population.
- DexScreener's `/latest/dex/tokens/` is asked for the token's pairs, 30
  addresses a request. A token missing from a batch is asked again alone
  before it is called dead, because the batch response is capped in pairs.
- **Survived** = the deepest pair's liquidity now is at least half of the
  deepest pair's liquidity in that run's snapshot (`pairs_json`, falling
  back to the snapshot's `liquidityUsd`), so both sides measure the same
  thing. No pair at all is not survived, and
  is stored with `pair_found = 0` so a delisted token and a drained one stay
  apart. Snapshots with no liquidity reading are never candidates.
- A failed request leaves the tokens pending for the next run. A network
  error is not a dead token.
- Addresses are URL-encoded rather than pattern-checked, so TON and Sui
  addresses go through. Only an empty one, or one with whitespace, is
  skipped, and counted as `skipped` in the run's stats.

Stored in `outcomes` (migration 6), one row per `(token_id, run_id,
horizon_h)`, with `liq_at_score`, `liq_now`, `price_at_score`, `price_now`,
`scored_at` and `measured_at`.

### What the label is biased by

- **It measures the pool, not the holder.** A token can keep its liquidity
  and still lose 90% in price; `price_now` is stored so a price label can be
  added later without re-fetching.
- **Only tokens we scored.** The population is tokens that reached a
  trending list and cleared the filters. It says nothing about the score's
  value on tokens that never trended.
- **No backlog.** Scores from before the step was switched on are never
  labelled: a label taken weeks late is a different horizon. Labels start
  accruing from deploy, so the gate takes a few weeks to pass. A labelled
  row's real horizon is `measured_at - scored_at`, between the horizon and
  1.5 × horizon + 24 h; `calibrate` drops anything later.
- **Liquidity can be pulled and re-added**, and a migrated token (new pool
  under a new address) reads as dead.

## Collection

The last step of every full run, after alerts are dispatched. Off on the
launch lane, in `--dry-run`, and with `OUTCOMES_ENABLED=false`. In
`--fixtures` it reads the recorded DexScreener payloads instead of the
network. A failure is a `sourceErrors` entry with source `outcomes`: the run
can be `partial` because of it, never `failed`.

`cli.ts outcomes` runs the step on its own (`--dry-run` only counts what is
pending).

## The fit

`cli.ts calibrate` reads the labels and prints a report; `--json` prints it
as JSON. It reads only: no migrate, no writes. The maths is
`packages/alerts/src/calibrate.ts`, pure and deterministic.

- **One row per token.** A token labelled on ten days is one outcome
  observed ten times. Every table, the gate and the fits use each token's
  earliest label; the report shows both rows and tokens.
- **Gate.** At least `CALIBRATION_MIN_ROWS` (default 200) distinct tokens
  and 30 in each class. Below it the report is `insufficient`: counts and survival
  tables only, no fit, nothing suggested.
- **Per component:** a univariate logistic fit (coefficient per SD) and the
  AUC, sorted by AUC. 0.5 is no signal; below 0.5 the component points the
  wrong way. A component with no variance is reported as "not measured" and
  gets no weight.
- **Weights:** an L2 logistic regression on the six standardised
  components, by plain gradient descent from a fixed start. Coefficients are
  converted back to per-point (β / SD), because the weights multiply raw
  0–100 components. Negative ones get zero, the rest are normalised to sum
  to 1, rounded to 0.01, and the rounding residual goes to the largest so
  `assertWeights` passes.
- **Survival by organic verdict and by tier.** The manufactured penalty
  (−20, tier C cap) claims staged tokens end worse. If `manufactured` does
  not survive less than `organic` here, with enough rows, the penalty is a
  belief rather than a finding. Rows on pre-v4 reports show as `unread`.

The report a score was computed on is the token's latest provenance row
written at or before the score: the same run's when the report was fresh,
an earlier one when the worker reused it.

## Generation decay

`scoreRecycling` adds a bonus by `recycle_generation`: 0, 7, 10, 10, 6 for
generations 0, 1, 2, 3, 4+ ("gen 2–3 is the sweet spot, past that the meme
is fatigued"). The report tests that curve:

- Survival per generation bucket, Laplace-smoothed ((s + 1) / (n + 2)), for
  all rows and split into `organic` and `manufactured` carriers. A meme that
  decays only on its staged carriers is a different finding from one that
  decays on both.
- **Suggested table**, only from buckets with 100+ tokens, and only when the
  best and worst of them are distinguishable: their Wilson 95% intervals
  must not overlap. Otherwise the status is `no-signal` with the reason. A
  fitted bucket moves by the absolute effect,
  `bonus = clamp(round(current + 25 × (rate − overall rate)), 0, 15)`, so a
  10-point survival edge is worth 2.5 points and noise stays small. A
  min–max rescale would stretch any difference, noise included, to the full
  0–10. Thinner buckets keep their current value and are marked `kept`.
- **Per meme** (`lower(meme_name)`), for memes with 3+ generations of 5+
  labels each: the meme's rate over all memes' rate at the same generation.
  Above 1, the meme decays slower than memes in general. Reported only; the
  score does not read it.

## Applying a suggestion

Never automatic. Copy the `apply:` line from the report into the
environment of the workflow that scores (`provenance.yml`, `launches.yml`):

```
SCORE_WEIGHTS='{"recycling":0.25,"memetic":0.15,"distribution":0.25,"liquidity":0.15,"momentum":0.05,"authenticity":0.15}'
GENERATION_BONUS='[0,7,10,10,6]'
```

- `SCORE_WEIGHTS` is a full `ScoreWeights` object: all six components, each
  ≥ 0, summing to 1. `GENERATION_BONUS` is 5 numbers in 0..15.
- An invalid value is refused whole with a warning, and the defaults score.
  Half a weight vector is worse than the hand-set one.
- Unset, scoring is byte-identical to the defaults.
- Scores before and after the change are not comparable. `score-surge` and
  the brief's score deltas compare against the previous run, so expect one
  run of noise after switching.
- `calibrate` shows the active overrides as "current", so a second fit
  reads against what is live.
