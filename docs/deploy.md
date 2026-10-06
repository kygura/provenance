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

`.github/workflows/provenance.yml` (full run, twice daily) and `launches.yml`
(launch lane, every 30 minutes) both run on a cron and on manual dispatch. They
share one job, `run-lane.yml`, which is the only place secrets and variables are
forwarded to the worker; a new provider's key is one line there. Add the
secrets under **Settings → Secrets and variables → Actions**:

| Secret | Required | What it is |
|---|---|---|
| `ANTHROPIC_API_KEY` | one LLM key | default provider (`LLM_MODEL=claude-opus-5`) |
| `OPENAI_API_KEY` | one LLM key | for `openai:` models |
| `OPENROUTER_API_KEY` | one LLM key | for `openrouter:` models (Kimi, DeepSeek, GPT… through one key) |
| `MOONSHOT_API_KEY` | one LLM key | for `moonshot:` Kimi models |
| `DASHSCOPE_API_KEY` | one LLM key | for `qwen:` models on Alibaba Model Studio |
| `DEEPSEEK_API_KEY` | one LLM key | for `deepseek:` models (no web search) |
| `OPENAI_COMPATIBLE_API_KEY` / `OPENAI_COMPATIBLE_BASE_URL` | one LLM key | any other OpenAI-dialect endpoint (no web search) |
| `DATABASE_URL` | yes | Turso database URL |
| `DATABASE_AUTH_TOKEN` | yes | Turso token |
| `TELEGRAM_BOT_TOKEN` | no | from @BotFather |
| `TELEGRAM_CHAT_ID` | no | your chat or channel id |
| `DISCORD_WEBHOOK_URL` | no | channel webhook |
| `ALERT_WEBHOOK_URL` | no | any JSON endpoint |
| `ETHERSCAN_API_KEY` | no | contract verification lookups |
| `ELFA_API_KEY` | no | crypto-social sightings for the watchlist's social lead (`docs/social.md`); free tier is enough |

Tuning knobs (`MAX_TOKENS_PER_RUN`, `MIN_LIQUIDITY_USD`,
`ALERT_SCORE_THRESHOLD`, `LLM_MAX_COST_USD_PER_RUN`, …) belong in **Variables**
rather than Secrets; every one is listed in `.env.example`. So do the model
choices: `LLM_MODEL`, `LLM_EXTRACT_MODEL`, `LLM_TRIAGE_MODEL` and `LLM_PRICING`.
Only the keys for the providers those models name are needed. A cheap setup
that keeps web search, for example:

```
LLM_MODEL=openrouter:moonshotai/kimi-k2.6
LLM_EXTRACT_MODEL=openrouter:openai/gpt-5.6-luna
LLM_TRIAGE_MODEL=openrouter:openai/gpt-5.6-luna
```

or, cheapest with direct keys and no aggregator fee:

```
LLM_MODEL=qwen:qwen3.7-plus
LLM_EXTRACT_MODEL=qwen:qwen3.8-flash
LLM_TRIAGE_MODEL=qwen:qwen3.8-flash
LLM_PRICING=qwen3.7-plus=0.4/1.6,qwen3.8-flash=0.15/0.47
```

A run refuses to start if a configured model has no key, or no price (OpenRouter
excepted), naming the variable to set.

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
