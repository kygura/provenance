# cron-trigger

A Cloudflare Worker that starts the pipeline lanes on time. GitHub's
`schedule` trigger is best-effort: over the week to 29 Oct 2026 the
30-minute launch lane ran about 41 times instead of 336, and full runs landed
hours off their slots. A `repository_dispatch` from outside starts a run
within seconds.

| Cron (UTC) | Event | Workflow |
|---|---|---|
| `15,45 * * * *` | `launches` | `launches.yml` |
| `0 2,6,10,14,18,22 * * *` | `full-run` | `provenance.yml`, through the cadence gate (`docs/cadence.md`) |

Each dispatch is at least one billed Actions minute on a private repo, so the
ticks are sparse: the launch lane every 30 minutes at :15 and :45 (off the full run's slots),
and the gate's 4-hour slots (hourly only matters at `peak`; see
`docs/cadence.md`). After changing them, redeploy with `npx wrangler@4 deploy`.

The GitHub crons stay in place as a fallback. A duplicate tick costs one
queued job: both workflows share the `provenance-run` concurrency group, the
full run's gate skips a slot that already ran in the last 30 minutes, and a
launch already judged is never re-judged.

## Setup

1. Create a fine-grained GitHub token limited to `kygura/provenance` with
   **Contents: read and write** (what `repository_dispatch` needs). Nothing
   else.
2. From this directory:

   ```bash
   npx wrangler@4 deploy
   ```

   ```bash
   npx wrangler@4 secret put GITHUB_TOKEN
   ```

3. Check the first ticks in the Actions tab (event `repository_dispatch`) or
   with `npx wrangler@4 tail`.

Cloudflare's free plan covers this: two cron triggers, about 30 requests a
day.

To stop it, `npx wrangler@4 delete`; the GitHub crons carry on alone.
