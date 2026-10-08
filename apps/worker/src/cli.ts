#!/usr/bin/env bun
/**
 * `bun run apps/worker/src/cli.ts <command> [flags]`
 *
 * Exit codes are part of the contract with the cron workflow:
 *   0  the command did what it said
 *   1  the run failed (or an alert channel rejected us)
 *   2  configuration error — the message names the variable to set
 */
import {
  type Alert,
  type AppConfig,
  type Logger,
  type ProvenanceReport,
  type TokenDossier,
  type TokenSnapshot,
  type WatchEntry,
  createLogger,
  loadConfig,
  nowIso,
  parseTokenId,
  runId as newRunId,
} from '@provenance/core';
import {
  type CommandName,
  type ParsedArgs,
  applyFlags,
  flagBool,
  flagString,
  llmDisabled,
  parseArgs,
  validateEnv,
} from './args';
import { type PipelineDeps, loadRuntimeDeps } from './deps';
import { runPipeline } from './pipeline';
import {
  type ReportFormat,
  type Style,
  createStyle,
  dossierTable,
  launchSummary,
  renderDossier,
  renderRun,
  snapshotTable,
  socialSummary,
  statusColor,
  watchTable,
} from './format';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_CONFIG = 2;

const HELP = `provenance — recycled-narrative scanner

usage: bun run apps/worker/src/cli.ts <command> [options]

commands:
  run                      discover, analyse, research, score, alert
  discover                 discovery only; print the merged, triaged table
  launches                 launch lane only: new pools and their market-gate results
  watchlist                every launch judged: anchored/forced/unclear, and what happened next
  analyze <chain:address>  full treatment of one token, printed as a dossier
  migrate                  apply database migrations
  seed                     load demo data into the database
  alerts:test              push a synthetic alert through every configured channel
  report                   print a run's results
  help, version

options:
  --dry-run, -n            do not deliver alerts to remote channels
  --fixtures               read recorded payloads; no network, no API key
  --limit N                cap tokens analysed this run
  --chains sol,base        restrict to these chains
  --sources dexscreener,…  restrict to these trending sources
  --no-llm                 skip the research stage entirely
  --run <id>               report: which run (default: the latest)
  --status active|expressed|dormant|dismissed   watchlist: filter by status
  --verdict anchored|forced|unclear            watchlist: filter by verdict
  --lane launches          run: the launch lane only (the 30-minute cadence)
  --format table|json|markdown
  --verbose, -v            debug logging
  --no-color               disable ANSI colour (also honoured: NO_COLOR)
`;

function print(line: string): void {
  console.log(line);
}

function fail(style: Style, messages: string[]): number {
  for (const message of messages) console.error(style.red(`error: ${message}`));
  return EXIT_CONFIG;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A stand-in snapshot so `analyze` works on a token that is not trending today. */
function bareSnapshot(id: string): TokenSnapshot {
  const { chain, address } = parseTokenId(id);
  return {
    tokenId: `${chain}:${address}`,
    chain,
    tokenAddress: address,
    symbol: address.slice(0, 6),
    name: address,
    socials: {},
    metrics: {},
    pairs: [],
    appearances: [],
    bestRank: 999,
    sourceCount: 0,
    capturedAt: nowIso(),
  };
}

async function cmdRun(
  app: AppConfig,
  parsed: ParsedArgs,
  logger: Logger,
  deps: PipelineDeps,
  style: Style,
): Promise<number> {
  const record = await runPipeline(app, logger, deps, { skipLlm: llmDisabled(app, parsed) });
  print('');
  print(
    `${style.bold('run')} ${record.id} ${statusColor(style, record.status)} ` +
      style.dim(
        `discovered=${record.stats.discovered} kept=${record.stats.afterFilter} analysed=${record.stats.analysed} reused=${record.stats.reused} alerts=${record.stats.alertsFired} cost=$${record.stats.llmCostUsd.toFixed(4)}`,
      ),
  );
  const lanes = launchSummary(record.stats);
  if (lanes) print(style.dim(lanes));
  const social = socialSummary(record.stats);
  if (social) print(style.dim(social));
  for (const failure of record.stats.sourceErrors) {
    print(style.yellow(`! ${failure.source}: ${failure.error}`));
  }
  return record.status === 'failed' ? EXIT_FAILED : EXIT_OK;
}

/**
 * Smoke test for the supply side: only the launches source runs, and each new
 * pool is shown with its market-gate verdict. No RPC beyond discovery, no LLM.
 */
async function cmdLaunches(app: AppConfig, logger: Logger, deps: PipelineDeps, style: Style): Promise<number> {
  const only: AppConfig = {
    ...app,
    launches: { ...app.launches, enabled: true },
    pipeline: {
      ...app.pipeline,
      sources: app.pipeline.sources.map((source) => ({ ...source, enabled: source.id === 'launches' })),
    },
  };
  const discovery = await deps.discoverTrending(only, logger);
  const { launches } = deps.splitLanes(deps.mergeToSnapshots(discovery.entries));
  const notes = new Map<string, string>();
  for (const snapshot of launches) {
    const gate = deps.gateLaunchMarket(snapshot, app.launches);
    notes.set(snapshot.tokenId, gate.passed ? style.green('market gate ok') : style.dim(gate.reasons.join('; ')));
  }
  print(style.dim(`${discovery.entries.length} new pools → ${launches.length} launch-only tokens`));
  print(snapshotTable(launches, style, notes));
  for (const failure of discovery.errors) {
    print(style.yellow(`! ${failure.source}: ${failure.error}`));
  }
  return discovery.errors.length > 0 && launches.length === 0 ? EXIT_FAILED : EXIT_OK;
}

async function cmdWatchlist(app: AppConfig, parsed: ParsedArgs, deps: PipelineDeps, style: Style): Promise<number> {
  const status = flagString(parsed.flags, 'status');
  if (status !== undefined && !['active', 'expressed', 'dormant', 'dismissed'].includes(status)) {
    return fail(style, [`--status must be active, expressed, dormant or dismissed (got ${status})`]);
  }
  const verdict = flagString(parsed.flags, 'verdict');
  if (verdict !== undefined && !['anchored', 'forced', 'unclear'].includes(verdict)) {
    return fail(style, [`--verdict must be anchored, forced or unclear (got ${verdict})`]);
  }
  const store = deps.createStore(app);
  try {
    await store.migrate();
    const entries = await store.listWatch({
      ...(status ? { status: status as WatchEntry['status'] } : {}),
      ...(verdict ? { verdict: verdict as WatchEntry['anchor']['verdict'] } : {}),
      limit: 200,
    });
    if (entries.length === 0) {
      print(style.dim('watchlist is empty'));
      return EXIT_OK;
    }
    print(watchTable(entries, style));
    // The verdict's track record: how often each call went on to trend.
    const summary = (['anchored', 'forced', 'unclear'] as const)
      .map((v) => {
        const judged = entries.filter((entry) => entry.anchor.verdict === v);
        const trended = judged.filter((entry) => entry.expressedAt !== undefined).length;
        return judged.length > 0 ? `${v} ${trended}/${judged.length} trended` : undefined;
      })
      .filter((line): line is string => line !== undefined);
    if (summary.length > 0) print(style.dim(`\n${summary.join(' · ')}`));
  } finally {
    await store.close().catch(() => undefined);
  }
  return EXIT_OK;
}

async function cmdDiscover(
  app: AppConfig,
  logger: Logger,
  deps: PipelineDeps,
  style: Style,
): Promise<number> {
  const discovery = await deps.discoverTrending(app, logger);
  const merged = deps.mergeToSnapshots(discovery.entries);
  const { kept, dropped } = deps.filterSnapshots(merged, app.pipeline);
  const triaged = deps.triageOrder(kept);

  print(
    style.dim(
      `${discovery.entries.length} entries → ${merged.length} tokens → ${kept.length} after filter`,
    ),
  );
  print(snapshotTable(triaged, style));
  if (dropped.length > 0) {
    print('');
    print(style.dim(`dropped ${dropped.length}:`));
    for (const drop of dropped) print(style.dim(`  ${drop.tokenId}: ${drop.reason}`));
  }
  for (const failure of discovery.errors) {
    print(style.yellow(`! ${failure.source}: ${failure.error}`));
  }
  return discovery.errors.length > 0 && kept.length === 0 ? EXIT_FAILED : EXIT_OK;
}

async function cmdAnalyze(
  app: AppConfig,
  parsed: ParsedArgs,
  logger: Logger,
  deps: PipelineDeps,
  style: Style,
): Promise<number> {
  const target = parsed.positionals[0] ?? '';
  const { chain: wantedChain, address } = parseTokenId(target);
  const id = `${wantedChain}:${address}`;
  const store = deps.createStore(app);

  try {
    await store.migrate();

    // Prefer a real trending row so the dossier carries real market numbers.
    let snapshot: TokenSnapshot | undefined;
    try {
      const discovery = await deps.discoverTrending(app, logger);
      snapshot = deps
        .mergeToSnapshots(discovery.entries)
        .find((candidate) => candidate.tokenId.toLowerCase() === id.toLowerCase());
    } catch (error) {
      logger.warn('discovery failed; falling back to a bare snapshot', { error: errorMessage(error) });
    }
    if (!snapshot) {
      logger.warn('token not on any trending list; market metrics will be empty', { tokenId: id });
      snapshot = bareSnapshot(id);
    }

    const chain = await deps.analyzeToken(snapshot, { app, logger: logger.child('chain') });

    let provenance: ProvenanceReport | undefined;
    if (!llmDisabled(app, parsed)) {
      const ctx = {
        app,
        logger: logger.child('research'),
        cacheGet: (key: string) => store.getCachedEvidence(key, app.pipeline.reanalyseAfterHours),
        cachePut: (key: string, url: string, content: string) => store.putCachedEvidence(key, url, content),
      };
      const evidence = await deps.collectEvidence(snapshot, ctx);
      provenance = await deps.createResearcher(app, logger).research(snapshot, chain, evidence, ctx);
    } else {
      provenance = (await store.latestProvenance(snapshot.tokenId)) ?? undefined;
    }

    const score = deps.scoreToken({ snapshot, chain, provenance });
    const history = await store.scoreHistory(snapshot.tokenId);
    const alerts = deps.createAlerts(
      newRunId(),
      { snapshot, chain, provenance, score, config: app, history },
      deps.defaultRules,
    );
    const dossier: TokenDossier = { snapshot, chain, provenance, score, alerts, runId: 'ad-hoc' };
    print(renderDossier(dossier, style));
    return EXIT_OK;
  } finally {
    await store.close().catch(() => undefined);
  }
}

async function cmdReport(
  app: AppConfig,
  parsed: ParsedArgs,
  deps: PipelineDeps,
  style: Style,
): Promise<number> {
  const store = deps.createStore(app);
  try {
    const wanted = flagString(parsed.flags, 'run');
    const run = wanted ? await store.getRun(wanted) : await store.latestRun();
    if (!run) {
      console.error(style.red(wanted ? `error: no run ${wanted}` : 'error: no runs recorded yet'));
      return EXIT_FAILED;
    }
    const dossiers = await store.listDossiers({ runId: run.id, orderBy: 'score' });
    const format = (flagString(parsed.flags, 'format') ?? 'table') as ReportFormat;
    print(renderRun(run, dossiers, format, style));
    return run.status === 'failed' ? EXIT_FAILED : EXIT_OK;
  } finally {
    await store.close().catch(() => undefined);
  }
}

async function cmdAlertsTest(
  app: AppConfig,
  logger: Logger,
  deps: PipelineDeps,
  style: Style,
): Promise<number> {
  const alert: Alert = {
    id: `test_${Date.now().toString(36)}`,
    runId: 'alerts-test',
    tokenId: 'solana:TEST',
    rule: 'synthetic',
    severity: 'info',
    title: 'Provenance channel test',
    body: 'If you can read this, the channel credentials work. No token was analysed.',
    markdown: '*Provenance channel test*\nIf you can read this, the channel credentials work.',
    createdAt: nowIso(),
    payload: { synthetic: true },
  };

  const sinks = deps.createSinks(app, logger).filter((sink) => sink.enabled);
  if (sinks.length === 0) {
    console.error(style.red('error: no alert sink is enabled; check the TELEGRAM_/DISCORD_/ALERT_ vars.'));
    return EXIT_CONFIG;
  }
  const results = await deps.dispatchAlerts([alert], sinks, logger);
  let failures = 0;
  for (const delivery of results.get(alert.id) ?? []) {
    if (delivery.ok) print(`${style.green('ok  ')} ${delivery.channel}`);
    else {
      failures += 1;
      print(`${style.red('fail')} ${delivery.channel}: ${delivery.error ?? 'unknown error'}`);
    }
  }
  return failures > 0 ? EXIT_FAILED : EXIT_OK;
}

export async function main(
  argv: readonly string[],
  overrides: { deps?: PipelineDeps; env?: Record<string, string | undefined> } = {},
): Promise<number> {
  const parsed = parseArgs(argv);
  const env = overrides.env ?? process.env;
  const style = createStyle({ noColor: flagBool(parsed.flags, 'no-color'), env });

  if (parsed.errors.length > 0) return fail(style, [...parsed.errors, 'run `help` for usage']);
  const wantsHelp = flagBool(parsed.flags, 'help') || parsed.command === 'help';
  if (wantsHelp || !parsed.command) {
    print(HELP);
    // No command at all is a usage error; asking for help is not.
    return wantsHelp ? EXIT_OK : EXIT_CONFIG;
  }
  if (flagBool(parsed.flags, 'version') || parsed.command === 'version') {
    print('provenance-worker 0.1.0');
    return EXIT_OK;
  }

  const command: CommandName = parsed.command;
  const applied = applyFlags(loadConfig(env), parsed);
  if (applied.errors.length > 0) return fail(style, applied.errors);

  const app = applied.app;
  const envErrors = validateEnv(command, app, parsed);
  if (envErrors.length > 0) return fail(style, envErrors);

  const logger = createLogger(app.logLevel, 'worker');
  const deps = overrides.deps ?? (await loadRuntimeDeps());

  try {
    switch (command) {
      case 'run':
        return await cmdRun(app, parsed, logger, deps, style);
      case 'discover':
        return await cmdDiscover(app, logger, deps, style);
      case 'launches':
        return await cmdLaunches(app, logger, deps, style);
      case 'watchlist':
        return await cmdWatchlist(app, parsed, deps, style);
      case 'analyze':
        return await cmdAnalyze(app, parsed, logger, deps, style);
      case 'migrate': {
        const store = deps.createStore(app);
        try {
          await store.migrate();
          print(style.green(`migrated ${app.databaseUrl}`));
        } finally {
          await store.close().catch(() => undefined);
        }
        return EXIT_OK;
      }
      case 'seed': {
        const store = deps.createStore(app);
        try {
          await store.migrate();
          await deps.seedDemoData(store);
          const dossiers: TokenDossier[] = await store.listDossiers({ limit: 20 });
          print(style.green(`seeded ${dossiers.length} dossiers`));
          if (dossiers.length > 0) print(dossierTable(dossiers, style));
        } finally {
          await store.close().catch(() => undefined);
        }
        return EXIT_OK;
      }
      case 'alerts:test':
        return await cmdAlertsTest(app, logger, deps, style);
      case 'report':
        return await cmdReport(app, parsed, deps, style);
      default:
        print(HELP);
        return EXIT_CONFIG;
    }
  } catch (error) {
    console.error(style.red(`error: ${errorMessage(error)}`));
    if (flagBool(parsed.flags, 'verbose') && error instanceof Error && error.stack) {
      console.error(style.dim(error.stack));
    }
    return EXIT_FAILED;
  }
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
