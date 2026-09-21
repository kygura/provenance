#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
/**
 * Command line entry point.
 *
 * The shebang carries --disable-warning=ExperimentalWarning for node:sqlite.
 * A process.on("warning") handler cannot cover it: Node loads the whole ESM
 * graph, builtins included, before any module body runs, so the warning is
 * already out before our first line executes. The npm scripts pass the same
 * flag for the paths that do not go through this shebang.
 */

import { parseArgs } from "node:util";

import { renderReportMarkdown } from "./alerts/render.js";
import { loadConfig, resolvedStatePath, type Config } from "./config.js";
import { ARCHETYPES } from "./lexicon.js";
import { log, setVerbose } from "./log.js";
import { describeToken } from "./models.js";
import { run } from "./pipeline.js";
import { Store } from "./state.js";

const USAGE = `provenance - scrape trending tokens and trace where their memes came from.

Usage:
  provenance run [--dry-run] [--limit N] [--json]
  provenance history [--limit N]
  provenance lexicon

Options:
  -v, --verbose        debug logging
  -c, --config PATH    path to provenance.toml
      --dry-run        scrape, filter and rank, but make no LLM calls and send no alerts
      --limit N        override research.max_tokens_per_run (or history rows)
      --json           emit the raw report as JSON
  -h, --help           this text
`;

async function cmdRun(config: Config, flags: Flags): Promise<number> {
  if (!flags.dryRun && !config.secrets.anthropicApiKey) {
    process.stderr.write(
      "ANTHROPIC_API_KEY is not set. Set it, or use --dry-run to see what would be " +
        "researched without calling the model.\n",
    );
    return 2;
  }

  const report = await run(config, { dryRun: flags.dryRun, limit: flags.limit });

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (flags.dryRun) {
    process.stdout.write(`Would research ${report.entries.length} token(s):\n\n`);
    for (const { dossier } of report.entries) {
      process.stdout.write(
        `  ${dossier.heuristicScore.toFixed(0).padStart(6)}  ${describeToken(dossier.ref)}\n`,
      );
      for (const note of dossier.heuristicNotes) {
        process.stdout.write(`          · ${note}\n`);
      }
    }
    process.stdout.write(`\n${report.skipped} filtered out.\n`);
  } else {
    process.stdout.write(`${renderReportMarkdown(report)}\n`);
  }

  return report.errors.length > 0 && report.entries.length === 0 ? 1 : 0;
}

function cmdHistory(config: Config, flags: Flags): number {
  const store = new Store(resolvedStatePath(config));
  try {
    const rows = store.recentAlerts(flags.limit ?? 25);
    if (rows.length === 0) {
      process.stdout.write("No alerts recorded yet.\n");
      return 0;
    }
    for (const row of rows) {
      process.stdout.write(
        `${row.alerted_at.slice(0, 16)}  ${row.token_key.padEnd(50)} ` +
          `${(row.novelty ?? "?").padEnd(11)} ${String(row.confidence ?? 0).padStart(3)}  ` +
          `${row.one_liner ?? ""}\n`,
      );
    }
    return 0;
  } finally {
    store.close();
  }
}

function cmdLexicon(): number {
  for (const archetype of ARCHETYPES) {
    process.stdout.write(`${archetype.label}  (weight ${archetype.weight})\n`);
    process.stdout.write(`  ancestors: ${archetype.ancestors.join("; ")}\n`);
    process.stdout.write(`  ${archetype.note}\n\n`);
  }
  return 0;
}

interface Flags {
  verbose: boolean;
  config: string | null;
  dryRun: boolean;
  limit: number | null;
  json: boolean;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        verbose: { type: "boolean", short: "v", default: false },
        config: { type: "string", short: "c" },
        "dry-run": { type: "boolean", default: false },
        limit: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n\n${USAGE}`);
    return 2;
  }

  const command = parsed.positionals[0];
  if (parsed.values.help || !command) {
    process.stdout.write(USAGE);
    return parsed.values.help ? 0 : 2;
  }

  const rawLimit = parsed.values.limit;
  const limit = rawLimit === undefined ? null : Number(rawLimit);
  if (limit !== null && !Number.isInteger(limit)) {
    process.stderr.write(`--limit must be an integer, got "${rawLimit}"\n`);
    return 2;
  }

  const flags: Flags = {
    verbose: parsed.values.verbose ?? false,
    config: parsed.values.config ?? null,
    dryRun: parsed.values["dry-run"] ?? false,
    limit,
    json: parsed.values.json ?? false,
  };

  setVerbose(flags.verbose);
  const config = loadConfig(flags.config);

  switch (command) {
    case "run":
      return cmdRun(config, flags);
    case "history":
      return cmdHistory(config, flags);
    case "lexicon":
      return cmdLexicon();
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

// Only run when invoked directly, not when imported by a test.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      log.error(String(error instanceof Error ? (error.stack ?? error.message) : error));
      process.exitCode = 1;
    });
}
