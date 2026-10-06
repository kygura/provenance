# Social yardstick

Provenance judges a meme at its token's first pool. The launch lane already
records one outcome against that verdict: `leadHours`, the time until the token
reached a DEX trending list. This adds a second: `socialLeadHours`, the time
until crypto-social noticed it.

That is the number that says whether the lane is early. A verdict that comes
before the crowd finds the token is worth having. A verdict that comes after
the token is already being passed around on X and Telegram is just commentary.

## What it measures, and what it doesn't

The source is Elfa's trending contract-address feeds
(`/v2/aggregations/trending-cas/{twitter,telegram}`). They are matched by exact
contract address, not by ticker, so a sighting is unambiguous.

Nothing here feeds a verdict, a score or an alert. The feeds count mentions,
which is consensus attention: by the time a contract trends there, it is
already loud. That makes them a poor input for finding tokens early. It also
makes them the right baseline for checking whether something else found the
token earlier. Elfa publishes no evidence that its counts predict price, and
the research on social-attention signals in crypto finds small, short-lived
effects that often reverse. So the feed is used to measure our own lead, not
as a signal.

## How it works

Each run (`apps/worker/src/social.ts`):

1. **Collect.** This runs before the launch lane, and only when `ELFA_API_KEY`
   is set and `ELFA_MIN_INTERVAL_HOURS` has passed since the last run that
   fetched. It pulls one page of each feed. Every row goes into
   `social_sightings`, one row per token and platform. The earliest
   `first_seen_at` is kept on upsert. The table covers every contract the
   feeds list, not only watched tokens, so a launch judged after the crowd
   found it can still be matched.
2. **Reconcile.** This runs after the launch lane. Each watchlist entry
   without a sighting yet is looked up. On a match it gets:
   - `socialAt`: the first sighting.
   - `socialLeadHours`: signed hours from `firstSeenAt` to `socialAt`.
   - `socialOn`: the platforms it has trended on.

   Every status is eligible, `dismissed` included. A forced meme the crowd
   picks up anyway is the pairing the verdict most needs checking against.

The sign matters. **Positive** means we judged the token before crypto-social
listed it. **Negative** means it was already trending when we judged it. The
CLI's `watchlist` table shows this as `TO SOCIAL`; the dashboard's watchlist
shows it as "To social".

## Budget

Elfa's free plan has 1,000 credits a month at 60 requests a minute. Each feed
page costs one credit. The launch lane runs every 30 minutes, so fetching on
every run would spend about 2,900 credits a month. The interval is what keeps
it inside the plan:

| `ELFA_MIN_INTERVAL_HOURS` | Fetches/month | Credits (both feeds) |
|---|---|---|
| 6 | ~120 | ~240 |
| 3 | ~240 | ~480 |
| 2 (default) | ~360 | ~720 |
| 1 | ~720 | ~1,440: over the free plan |

The key is meant to be shared with hypertrade, whose Elfa collector spends
about 90 a month at its default 8h interval. At the 2h default the two come
to about 810 of the 1,000. Lower this only if hypertrade gets its own key or
is turned down.

GitHub Actions jobs keep no state, so the interval is measured from the
`social.fetchedAt` recorded in past runs' stats. A run up to 10 minutes short
of the interval still fetches (`THROTTLE_SLACK_HOURS`). Without that, cron
drift on the 30-minute schedule would push a 2h interval to 2.5h in practice.
At worst the slack adds one fetch a day, about 60 credits a month at the 2h
default.

Each fetch asks for a window equal to the interval, rounded up to whole hours.
Back-to-back fetches overlap slightly instead of leaving gaps, and the
earliest-sighting upsert makes the overlap harmless.

Resolution is the interval. With the 2-hour default, `socialAt` can trail the
true first trend by up to 2 hours. That biases `socialLeadHours` upward by up
to the same amount. Read leads under 2 hours as roughly even.

## Failure

A feed that fails becomes an `elfa:<platform>` entry in `sourceErrors`, and
the other feed still counts. If every feed fails, no `fetchedAt` is recorded,
so the next run retries; an unauthorised request costs no credits. These
errors can turn a run `partial`. They can never make a quiet run `failed`: the
step measures the pipeline, it isn't output.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ELFA_API_KEY` | unset | Off when blank. Fixture runs (`--fixtures`) read `fixtures/elfa/` instead |
| `ELFA_MIN_INTERVAL_HOURS` | `2` | Minimum hours between fetches, across runs. `0` fetches every run |
| `ELFA_MIN_MENTIONS` | `5` | Elfa's `minMentions` |
| `ELFA_PAGE_SIZE` | `50` | Rows per feed per fetch |
| `ELFA_PLATFORMS` | both | `twitter`, `telegram` or both |
| `ELFA_RATE_MS` | `1100` | Spacing between the two requests |

## Reading the numbers

Once a few weeks of entries have a `socialLeadHours`:

- **Median lead for `anchored` entries.** If it is positive, the launch lane is
  ahead of the crowd. If it is near zero or negative, it is not.
- **Share of `dismissed` (forced) entries that reach social at all.** A high
  share means forced memes get crowd attention anyway. That is the
  pump-and-dump pattern, and it argues for keeping the verdict away from
  attention signals.
- **`leadHours` against `socialLeadHours` for the same entry.** This shows
  which comes first for a launch, DEX trending or social trending.
