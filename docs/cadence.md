# Full-run cadence

The full run's cron in `provenance.yml` ticks every 4 hours on the slots below
(02, 06, 10, 14, 18, 22 UTC), and the first step of each scheduled job asks
`cli.ts cadence` whether this slot is due. The answer comes
from the stored runs, so the cadence follows the meme market without anyone
having to call when the next cycle starts. A skipped hour writes no run row
and costs only the job's install step.

| Level | Slots (UTC) | Runs/day |
|---|---|---|
| `base` | 06:00, 18:00 | 2 (the old schedule) |
| `elevated` | every 4 h from 06:00 (02, 06, 10, 14, 18, 22) | 6 |
| `peak` | every hour | 24 |

Slots are anchored on 06:00, so the brief (`brief.yml`, 06:40 and 18:40)
always has a fresh run to read.

## The signals

All three come from `runs.stats_json` over the trailing seven days
(`apps/worker/src/cadence.ts`):

| Signal | Elevated | Peak |
|---|---|---|
| Trending tokens clearing the filters, mean per full run (`afterFilter`) | ≥ 10 | ≥ 20 |
| Anchored launches catalogued per day (launch lane) | ≥ 6 | ≥ 15 |
| Alerts fired per day (both lanes) | ≥ 6 | ≥ 15 |

- A level needs two of the three, so one noisy source can't move it.
- **Hysteresis.** Moving up happens as soon as the quorum is met. Stepping
  down waits until the signals fall below 70% of the current level's
  thresholds. The current level comes from the gap between the last two full
  runs (≤ 1.5 h peak, ≤ 5 h elevated), so no extra state is stored.
- Counts are divided by the whole week, so a new database reads low and stays
  at base until it has a week of history.

## Triggers

GitHub's `schedule` trigger is best-effort. In the week to 29 Oct 2026 the
30-minute launch lane ran about 41 times instead of 336, and full runs landed
hours off their slots, kept going only by the overdue rule below.
`ops/cron-trigger` is a Cloudflare Worker that sends a `repository_dispatch`
on time: `launches` every 30 minutes at :15 and :45, `full-run` every 4 hours on the
elevated slots. A `full-run` tick
asks the gate exactly like the schedule does. The GitHub crons stay as the
fallback.

## Timing rules

- **Due:** the hour is one of the level's slots and no full run started in
  the last 30 minutes. The 30-minute check stops a late cron and a manual
  dispatch from both running the same slot.
- **Overdue:** the last full run is more than one step plus an hour old (13 h
  at base), for example because GitHub fired so late that the slot hour
  passed. The gate then runs off-slot.
- **Failed runs count for timing.** A pipeline that keeps failing is retried
  at the next slot, not every hour.
- **Database unreadable:** the gate falls back to the base slots.
- **Manual dispatch** skips the gate and always runs.

## Settings (repository variables)

| Variable | Default | Effect |
|---|---|---|
| `LLM_MAX_COST_USD_PER_DAY` | `0` (off) | Caps spend over the trailing 24 h across both lanes. Each run gets the smaller of this and `LLM_MAX_COST_USD_PER_RUN`. **Auto mode stays at base until this is set**, because at peak the per-run ceiling alone allows 24× the spend. |
| `CADENCE_MODE` | `auto` | `base`, `elevated` or `peak` pins the level and ignores the signals and the interlock above. |

The research reuse window (`REANALYSE_AFTER_HOURS`, 72 h) means most hourly
runs only re-snapshot and re-score tokens that already have reports. LLM spend
tracks new tokens, not the number of runs.

## The brief

At a faster cadence, the brief's `PREV` run is the latest full run at least
11 h before `CUR`, not the one just before it (`SQL_A_FULL_RUNS` in
`apps/worker/src/brief/queries.ts`, query A in `CLAUDE.md`). Score and tier
deltas therefore still compare across about half a day, not one hour.

## Actions minutes

Each skipped tick still checks out, installs (cached) and runs the gate, and
GitHub bills every job at least a minute. On a private repository hourly
ticks cost about 700 minutes a month against the free 2,000, and a 15-minute
launch lane about 2,900 more; together they used the whole allowance by the
12th in November 2026. So `full-run` now ticks only on the 4-hour slots, which covers `base` and
`elevated`. `peak` needs hourly ticks again (`provenance.yml` and
`ops/cron-trigger`), and only becomes reachable once
`LLM_MAX_COST_USD_PER_DAY` is set or `CADENCE_MODE=peak` is pinned. The launch
lane runs every 30 minutes at :15 and :45, about 1,440 minutes a month, which
leaves little room under 2,000 on a private repository. Public repositories
aren't billed.
