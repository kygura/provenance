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

`.github/workflows/provenance.yml` (full run, hourly cron behind a cadence
gate: twice daily at quiet volume, see [cadence.md](cadence.md)) and `launches.yml`
(launch lane, every 30 minutes) both run on a cron and on manual dispatch. They
share one job, `run-lane.yml`, which is the only place secrets and variables are
forwarded to the worker; a new provider's key is one line there. Add the
secrets under **Settings → Secrets and variables → Actions**:

| Secret | Required | What it is |
|---|---|---|
| `MOONSHOT_API_KEY` | one LLM key | Kimi: research on `moonshot:kimi-k3`, extraction and the anchor check on `moonshot:kimi-k2.6`; the runtime fallback when Claude is primary, and the only provider when no Anthropic key is set |
| `ANTHROPIC_API_KEY` | one LLM key | default provider when set: every role runs on Claude (unless `LLM_ANTHROPIC_FIRST=false`) |
| `OPENAI_API_KEY` | one LLM key | for `openai:` models |
| `OPENROUTER_API_KEY` | one LLM key | for `openrouter:` models (Kimi, DeepSeek, GPT… through one key) |
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
| `EXA_API_KEY` | recommended | the search tool for every non-Anthropic model (anchor check and research), and how DexTools pair pages are found; without it the DexTools source is skipped |
| `ELFA_API_KEY` | no | crypto-social sightings for the watchlist's social lead (`docs/social.md`); free tier is enough |
| `RPC_ETHEREUM` / `RPC_SOLANA` | no | your own RPC endpoints, comma-separated and tried in order. A set list is tried first and the public defaults (Allnodes' publicnode.com, drpc, …) follow as fallbacks; set `RPC_PUBLIC_FALLBACK=false` to use only your list. A keyed URL (Alchemy, Helius) must be a secret so the logs mask it. Blank keeps the public defaults |

Tuning knobs (`MAX_TOKENS_PER_RUN`, `MIN_LIQUIDITY_USD`,
`ALERT_SCORE_THRESHOLD`, …) belong in **Variables**
rather than Secrets; every one is listed in `.env.example`. So do the model
choices: `LLM_MODEL`, `LLM_EXTRACT_MODEL`, `LLM_TRIAGE_MODEL` and `LLM_PRICING`.
Only the keys for the providers those models name are needed.

With the `ANTHROPIC_API_KEY` secret set, every role runs on Claude by default
(`claude-opus-5` for research and extract, `claude-sonnet-5` for triage), at
about twice the cost per report of Kimi. Each role keeps a fallback: the
non-Anthropic model its `LLM_*_MODEL` variable names, else its Kimi default.
When Anthropic fails mid-run (credit balance too low, a rejected key, a rate
limit or overload that outlasts the SDK's retries, the network), the run logs
one warning and finishes on the fallback, billed at the fallback's price. The
fallback needs its own key (`MOONSHOT_API_KEY` for Kimi). A `claude-*` value
in an `LLM_*_MODEL` variable picks that role's Claude model.

Without an Anthropic key, or with the variable `LLM_ANTHROPIC_FIRST=false`,
the model variables run as set; blank means Kimi on Moonshot, searching through
Exa (`MOONSHOT_API_KEY` + `EXA_API_KEY`): K3 researches, K2.6 extracts and runs
the anchor check.

Other setups, for example Kimi through OpenRouter when only an OpenRouter key
is at hand:

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

### Gather/judge split

`LLM_SEARCH_MODEL` splits research by model. The search pass, which is the
token-heavy part (each search turn re-reads everything gathered so far), runs
on the cheaper model named there. That model only gathers dated, sourced
evidence and is told not to decide. `LLM_MODEL` then reads those notes and
makes both calls, anchor and organic, in one structured pass. `LLM_EXTRACT_MODEL`
goes unused in this mode. Reports carry
`promptVersion = provenance-research-v5-split` so the two populations can be
compared.

```
LLM_MODEL=claude-opus-5            # the judge
LLM_SEARCH_MODEL=moonshot:kimi-k2.6  # gathers through Exa; or claude-sonnet-5
```

Both calls run in real time, so no verdict waits on the split. The judge's
system prompt is static and carries a cache breakpoint, so from the second
token of a run onward most of the judge's input is read from cache. Unset
keeps the single-researcher flow.

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
One requirement: network access to the data hosts. No browser is needed.

Vercel Cron cannot host the worker — the run takes longer than a serverless
function should.

## Cost

A run over 15 tokens makes at most 15 model calls, most of them skipped by the
reanalysis window after the first few days. `LLM_MAX_COST_USD_PER_RUN` is a hard
ceiling: once it is hit the pipeline keeps collecting market and chain data and
stops calling the model, and the run stats record that it happened. It is not a
repo variable: the workflow does not forward it, so the default in
`packages/core/src/config.ts` ($15) applies to both lanes. Change it there.

`LLM_MAX_COST_USD_PER_DAY` caps the trailing 24 hours across every run of both
lanes; a run's budget is the smaller of the two. It is off (0) by default, and
the cadence gate will not raise the full run above twice daily until it is set,
since a faster cadence multiplies the per-run worst case.
