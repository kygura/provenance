# Deployment

Three pieces: a database, a scheduled runner, and the dashboard. All three sit on
free tiers. The only recurring cost is the Anthropic API.

## 1. Database — Turso (libSQL)

The worker writes and the dashboard reads, so the database has to be reachable
from both. Local SQLite works for development; a hosted libSQL database is what
makes the Vercel dashboard able to see what the cron job wrote.

```bash
curl -sSfL https://get.tur.so/install.sh | bash
turso auth login
turso db create provenance
turso db show provenance --url          # → DATABASE_URL   (libsql://...)
turso db tokens create provenance       # → DATABASE_AUTH_TOKEN
```

Apply the schema once:

```bash
DATABASE_URL=libsql://... DATABASE_AUTH_TOKEN=... \
  bun run apps/worker/src/cli.ts migrate
```

Local development instead: leave `DATABASE_URL` at its default
(`file:./data/provenance.db`), run `migrate`, then `seed` for demo data.

## 2. Scheduled runner — GitHub Actions

`.github/workflows/provenance.yml` runs the pipeline on a cron and on manual
dispatch. Add the secrets under **Settings → Secrets and variables → Actions**:

| Secret | Required | What it is |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | the only paid credential in the system |
| `DATABASE_URL` | yes | Turso database URL |
| `DATABASE_AUTH_TOKEN` | yes | Turso token |
| `TELEGRAM_BOT_TOKEN` | no | from @BotFather |
| `TELEGRAM_CHAT_ID` | no | your chat or channel id |
| `DISCORD_WEBHOOK_URL` | no | channel webhook |
| `ALERT_WEBHOOK_URL` | no | any JSON endpoint |

Tuning knobs (`MAX_TOKENS_PER_RUN`, `MIN_LIQUIDITY_USD`,
`ALERT_SCORE_THRESHOLD`, `LLM_MAX_COST_USD_PER_RUN`, …) belong in **Variables**
rather than Secrets; every one is listed in `.env.example`.

Two things to know about the GitHub scheduler: it is best-effort and routinely
fires late under load, and it stops running on repositories with no activity for
60 days. If exact timing matters, trigger the same workflow from an external
scheduler via `workflow_dispatch`.

Verify the credentials without waiting for a scheduled run:

```bash
bun run apps/worker/src/cli.ts alerts:test
```

## 3. Dashboard — Vercel

Import the repository, then set:

- **Root directory**: `apps/dashboard`
- **Framework preset**: Next.js
- **Install command**: run at the workspace root so the monorepo resolves
  (see `vercel.json`)
- **Environment variables**: `DATABASE_URL`, `DATABASE_AUTH_TOKEN`

The dashboard only reads. It needs no Anthropic key and no RPC configuration.

Give the Turso token used by Vercel read-only scope where possible — the
dashboard has no reason to be able to write, and a public dashboard with a
read-write database token is the obvious way to get this wrong.

## Running it somewhere else

The worker is a plain Bun process with a CLI, so anything that can run a
container on a schedule works: a VPS with cron, Fly.io, Railway, a Raspberry Pi.
Two requirements: Chromium for the DexTools scraper (`bunx playwright install
--with-deps chromium`), and network access to the data hosts.

Vercel Cron cannot host the worker — the DexTools scraper needs a real browser
and the run takes longer than a serverless function should.

## Cost

A run over 15 tokens makes at most 15 model calls, most of them skipped by the
reanalysis window after the first few days. `LLM_MAX_COST_USD_PER_RUN` is a hard
ceiling: once it is hit the pipeline keeps collecting market and chain data and
stops calling the model, and the run stats record that it happened. Start it low.
