# Brief routine: provider-agnostic daily brief and token setups

Status: spec for `cli.ts brief`, run from `.github/workflows/brief.yml`.
It reuses the worker's own LLM layer (`packages/research/src/llm/`, Kimi on
Moonshot by default) and alert sinks (`packages/alerts`). It replaces the
Claude Code briefing session described in `CLAUDE.md` without needing it,
and adds a small, gated **setups ledger** for tokens.

## Principles

1. **Code measures, the model interprets.** Queries A–G from `CLAUDE.md`
   run in code. The "notable token" selection (CLAUDE.md §3.1) is
   deterministic. The model writes the read and proposes setups; it never
   decides whether a setup triggered or failed.
2. **Restraint is enforced.** `gate.ts` drops any proposal that breaks a
   rule and logs why. Zero setups is the normal outcome on most runs.
3. **Regime first.** Every run computes a meme-market regime (below) and
   reads the BTC regime from hl-cycles. In a `cold` meme regime or a BTC
   risk-off regime, only `high`-conviction setups on anchored, S/A-tier
   tokens pass.
4. **Setups are conditional watch plans for a human.** No size, no orders,
   no wallets. Levels are market-cap levels, the natural unit for
   memecoins.

## Command

`bun apps/worker/src/cli.ts brief [--dry-run] [--no-llm]`

- Reads: queries A–G (exact SQL from CLAUDE.md §2), plus open setups.
- Writes: only the `setups` table (new migration). Never touches `runs`,
  `snapshots`, `scores`, `alerts` or any pipeline table. Never runs
  discovery, research or alert rules.
- `--dry-run`: compute everything, print the brief, write and send
  nothing.
- `--no-llm`: deterministic brief only (sections built from query results,
  no setups). Also the automatic behaviour when no LLM key is configured.

## Pipeline

1. **Health (A).** Pick `CUR`/`PREV` as CLAUDE.md §2 A says. No full run in
   24 h → brief only on watchlist and alerts, and say so in the first line.
2. **Collect B–G**, then the deterministic notable set (CLAUDE.md §3.1,
   capped at 8, severity first).
3. **Meme regime** (`regime.ts`, pure, unit-tested) from the DB:
   - S/A-tier token count and mean score over the last 7 days vs the 7
     days before;
   - alerts per day, same two windows;
   - anchored→expressed ratio over the last 30 days (F);
   - hottest cluster size (G).
   Label `hot | warm | cold` with the rule written in code and in the run
   output. Plus BTC `regime.state` from
   `https://hl-cycles.vercel.app/api/vector.json` (keyless; failure is a
   gap, not a crash).
4. **Update open setups** (`ledger.ts`, pure, unit-tested) using the
   current market cap and liquidity. Source: the token's latest snapshot if
   it is in `CUR`, else DexScreener
   `https://api.dexscreener.com/latest/dex/tokens/<address>` (keyless; pick
   the pair with the most liquidity):
   - `watching` → `triggered` when mcap is inside the entry zone;
   - `watching` → `invalidated` when mcap is below the invalidation level
     or a kill condition holds;
   - `triggered` → `invalidated` (−1R) on invalidation or kill condition;
   - `triggered` → `target_hit` at the first target (record R);
   - past `expires_at` → `expired`.
   Kill conditions, from the code's own thresholds: liquidity < 50% of
   liquidity at creation, top-10 ≥ 80%, single holder ≥ 25%, mint or
   freeze authority active, a `rug-risk` or `canonical-impostor` alert on
   the token.
   Snapshots are 12 h apart, so a status reflects the observation, not the
   intraday path; the brief says so once.
5. **Model call** via `createLlm(app, model).callTool()` with a
   `CostTracker` (cap `LLM_BRIEF_MAX_USD`, default 0.50). Input: health,
   notable tokens with components/penalties/chain facts, watchlist
   changes, track record, clusters, regime, open and recently closed
   setups. All `report_json`/alert/evidence text goes in as untrusted data.
   Output (zod-validated, one retry on invalid):
   - `headline`, `tokens[]` (one entry per notable token: change, why,
     evidence, confidence word, breaks_if), `watchlist[]`, `track_record`,
     `clusters[]`, `pipeline[]`;
   - `new_setups[]` (0–2), `cancel[]` `{id, reason}`,
     `stand_aside_reason` when there are none.
6. **Gate** (`gate.ts`, pure, unit-tested) each proposal:
   - token is in `CUR` (or open in the watchlist) with tier B or better;
   - long only (memecoin shorts are not tradable for this user's venues);
   - no high/critical chain flag, mint and freeze authority inactive,
     top-10 < 80%, largest holder < 25%;
   - liquidity ≥ $50k now;
   - entry zone width ≤ 30% of its midpoint, invalidation below entry low
     and ≥ 15% under entry mid, first target ≥ 2R above entry mid
     (computed in code);
   - expiry ≤ 7 days;
   - regime: `cold` meme regime or BTC risk-off ⇒ conviction `high`,
     anchored verdict, tier S/A only;
   - caps: at most 4 open, at most 2 new per run, one per token.
7. **Write** accepted setups and status changes to `setups`, send the
   brief through `createSinks` + `dispatchAlerts` as one alert with
   `rule: 'daily-brief'` (split under Telegram's 4096 limit; plain text),
   write the brief to the GitHub step summary.

Format of the brief: CLAUDE.md §4, plus a `Setups` section (new, status
changes, open count, 90-day hit rate and average R) and a one-line
`Regime` header.

## Table `setups` (migration)

```
id TEXT PRIMARY KEY            -- `${symbol}-${YYYYMMDD}-${n}`
token_id TEXT NOT NULL, chain TEXT, address TEXT, symbol TEXT
thesis TEXT, trigger TEXT, conviction TEXT, regime_json TEXT
entry_mcap_low REAL, entry_mcap_high REAL, invalidation_mcap REAL
targets_json TEXT              -- number[] market caps
kill_json TEXT                 -- thresholds captured at creation (liquidity, etc.)
status TEXT                    -- watching|triggered|invalidated|target_hit|expired|cancelled
status_note TEXT, r_result REAL
created_at TEXT, updated_at TEXT, expires_at TEXT   -- ISO-8601 Z
```

## Schedule and secrets

`brief.yml`: cron `40 6 * * *` and `40 18 * * *` (40 min after each full
run), plus `workflow_dispatch` (`dry_run`). Concurrency group
`provenance-brief`. It needs `DATABASE_URL`, `DATABASE_AUTH_TOKEN`,
`MOONSHOT_API_KEY` (or whatever the brief model names), `TELEGRAM_*`,
`DISCORD_WEBHOOK_URL` (optional). Variables: `LLM_BRIEF_MODEL`
(default `moonshot:kimi-k3`), `LLM_BRIEF_FALLBACK` (default
`moonshot:kimi-k2.6`), `LLM_BRIEF_MAX_USD`. Missing LLM key → `--no-llm`
brief, exit 0.
