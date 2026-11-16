# box

The pipeline on a server (the Hetzner box, next to Hypertrade, in Coolify) instead of GitHub Actions. One
always-running process, `apps/worker/src/box/scheduler.ts`, runs the same commands the workflows ran, at the same
UTC slots:

| Job | Slots (UTC) | Steps | Time limit |
|---|---|---|---|
| `launches` | every hour at :30 | `migrate`, `run --lane launches` | 20 min |
| `full-run` | 02, 06, 10, 14, 18, 22 at :00 | `cadence --exit-code` (skips when not due), `migrate`, `run` | 45 min |
| `brief` | 06:40, 18:40 | `migrate`, `brief` | 15 min |

The launch lane and the full run never overlap: the later one waits, as on the old `provenance-run` concurrency
group. A job never overlaps itself. The database stays in Turso. A tick costs no Actions minutes, so the GitHub
schedules and `ops/cron-trigger` are retired; the workflows stay for a run by hand.

## Coolify

On the project that holds Hypertrade:

1. **New resource → Private repository (GitHub App)**, repo `kygura/provenance`, branch `main`, build pack
   **Dockerfile**, Dockerfile location `/ops/box/Dockerfile`, base directory `/`.
2. No domain and no port: it serves nothing. Turn Coolify's HTTP health check off; the image has its own (the
   heartbeat in `data/box-scheduler.json`).
3. **Persistent storage**: a volume at `/app/data`. It holds the chain-read cache (`data/rpc-cache`, up to
   256 MB), the alert file and the heartbeat.
4. **Environment variables**: copy them from the repo's Actions secrets and variables (the lists in
   `.github/workflows/run-lane.yml` and `brief.yml`). At least `DATABASE_URL`, `DATABASE_AUTH_TOKEN`, the model
   keys you use (`ANTHROPIC_API_KEY`, `MOONSHOT_API_KEY`, …) and the alert channels (`TELEGRAM_BOT_TOKEN`,
   `TELEGRAM_CHAT_ID`, `DISCORD_WEBHOOK_URL`, `ALERT_WEBHOOK_URL`). Then whatever you tuned: `LLM_*`, `RPC_*`,
   `ETHERSCAN_API_KEY`, `EXA_API_KEY`, `ELFA_*`, the full-run filters, `LAUNCHES_*`, `CADENCE_MODE`, `LOG_LEVEL`.
   A keyed RPC URL carries its key, so keep it secret.
5. For the first deploy, `BOX_RUN_ON_START=launches` shows a run in the logs at once (`launches: ok`). Remove it
   afterwards.

Then delete the Cloudflare Worker: `npx wrangler@4 delete` from `ops/cron-trigger`.

Optional: `BOX_LAUNCHES_SLOTS`, `BOX_FULL_RUN_SLOTS`, `BOX_BRIEF_SLOTS` (comma-separated `HH:MM` or `*:MM`, UTC;
`BOX_FULL_RUN_SLOTS=*:00` for `peak`, see `docs/cadence.md`), `BOX_DISABLE` (job names to leave off).

Locally: `bun run apps/worker/src/box/scheduler.ts` from the repo root, with the same env.
