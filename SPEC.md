# Provenance — build spec

## Thesis

Recycled narratives are new participants rediscovering the metas of old. Novelty is
not required to start a speculative wave; a narrative that has already worked once
carries its own proof, and most market participants are neither informed nor careful
enough to distinguish a revival from an invention. Provenance treats a token's
**memetic lineage** as a tradeable signal: where the meme came from, how many times
it has already been monetised, and whether this particular token is the instance the
meme's audience would accept as canonical.

## What it does

Twice a day, in the cloud:

1. **Discover** — scrape trending token lists from DexTools, DexScreener and
   GeckoTerminal. No paid API keys anywhere.
2. **Merge and triage** — normalize to one `TokenSnapshot` per token, rank by
   cross-source agreement, filter on liquidity / volume / pool age.
3. **Analyse on-chain** — holder distribution, concentration, supply, mint and freeze
   authorities, LP burn/lock, creator holdings, risk flags. Free public RPCs only.
4. **Research provenance** — hand Claude the measured facts and let it search the
   web itself, then have a second pass structure its own notes into a
   `ProvenanceReport`: origin, lineage, prior cycles, recycle verdict and
   generation, durability, cultural reach, authenticity.
5. **Score** — composite 0-100 from recycling strength, memetic durability,
   distribution health, liquidity depth, momentum and authenticity.
6. **Alert** — rules fire into Telegram / Discord / webhook.
7. **Persist** — everything lands in SQLite/libSQL; the Vercel dashboard reads it.

## Hard constraints

- **Runtime: Bun + TypeScript.** ESM only. `strict: true`,
  `noUncheckedIndexedAccess: true`. No `any` in exported signatures.
- **No paid market-data API keys.** DexScreener and GeckoTerminal have free,
  keyless public endpoints — use them. DexTools has no free API, so it is scraped
  with Playwright driving the pre-installed Chromium.
- **The only paid credential is `ANTHROPIC_API_KEY`**, for the LLM step.
- **Never throw out of a source or analyser.** Partial data beats a failed run.
  Return what you have and record the failure in `notes` / `sourceErrors`.
- **Every network call goes through `RateLimiter` + `retry`** from `@provenance/core`.
- **Offline-testable.** Every parser must be exercised by a unit test against a
  fixture in `fixtures/`. The sandbox this was built in has no outbound network
  access to any data host, so fixture tests are the contract.
- Respect `robots`-adjacent etiquette: realistic delays, one browser context,
  identifiable-but-ordinary user agent, no login walls, no CAPTCHA solving.

## Layout

```
packages/core       contracts, types, config, logging, utilities   [DONE — do not edit]
packages/sources    trending discovery + normalization
packages/chain      holder distribution, supply, risk flags
packages/research   web-search research pass + structured extraction pass
packages/store      libSQL/SQLite persistence implementing ProvenanceStore
packages/alerts     scoring, alert rules, delivery channels
apps/worker         pipeline orchestration + CLI + GitHub Actions cron
apps/dashboard      Next.js dashboard deployed on Vercel
fixtures/           recorded upstream payloads for offline tests
```

## Contracts

`packages/core/src/` is already written and is the single source of truth. Read it
first. Key exports:

- `Chain`, `normalizeChain`, `tokenId`, `parseTokenId`, `isEvm` — `chains.ts`
- `TrendingEntry`, `TokenSnapshot`, `MarketMetrics`, `PairInfo`, `SocialLinks` — `market.ts`
- `ChainAnalysis`, `HolderRow`, `RiskFlag`, `TokenSupply` — `onchain.ts`
- `ProvenanceReport`, `EvidenceItem`, `PriorCycle`, `RecycleVerdict`,
  `ProvenanceScore`, `ScoreComponents` — `provenance.ts`
- `Alert`, `DeliveryResult` — `alerts.ts`
- `AppConfig`, `loadConfig` — `config.ts`
- `ProvenanceStore`, `RunRecord`, `RunStats`, `TokenDossier`, `DossierQuery` — `store.ts`
- `TrendingSource`, `ChainAnalyzer`, `EvidenceCollector`, `ProvenanceResearcher`,
  `Scorer`, `AlertRule`, `AlertChannelSink` — `contracts.ts`
- `retry`, `RateLimiter`, `mapLimit`, `sleep`, `hashKey`, `runId`, `clamp`, `ratio`,
  `hoursBetween`, `formatUsd`, `formatPct`, `shortAddress`, `truncate` — `util.ts`
- `createLogger`, `silentLogger` — `log.ts`

Import them as `@provenance/core` (workspace path alias already configured).

**Do not modify `packages/core`.** If a contract is genuinely wrong or missing a
field, say so in your final report and work around it locally; the integrator
applies core changes so parallel agents never collide.

## Conventions

- One responsibility per file; `src/index.ts` re-exports the public surface.
- Tests live next to the code as `*.test.ts` and run under `bun test`.
- Fixtures go in `fixtures/<source>/<name>.json` (or `.html`), committed, and
  trimmed to a representative size (a few hundred KB max, ideally far less).
- Comments explain *why*, not *what*. Match the density in `packages/core`.
- Timestamps are ISO-8601 UTC strings everywhere.
- Money is USD numbers, percentages are 0-100 numbers (not 0-1) unless the field
  name says otherwise (`herfindahl`, `gini`, `confidence`, `sourceQuality` are 0-1).

## Verification before you report done

```
cd /home/user/provenance
bun test packages/<yours>     # your tests pass
bunx tsc --noEmit -p tsconfig.json   # zero errors from YOUR files
```

Errors originating in other packages are other agents' problems — ignore those,
but never introduce one in your own.

## Do not

- Run any git command. The integrator owns commits, branches and the push.
- Touch files outside the directories you were assigned.
- Add a dependency without noting it in your final report (and actually running
  `bun add` for it in the repo root so the lockfile stays coherent).
- Invent network access: the build sandbox blocks every upstream data host with a
  403 at the egress proxy. Write the code, test it against fixtures, and note in
  your report exactly what still needs live validation.
