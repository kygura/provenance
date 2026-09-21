"""Command line entry point."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from provenance.alerts.render import render_report_markdown
from provenance.config import Config
from provenance.pipeline import run
from provenance.state import Store


def _configure_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stderr,
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


def _cmd_run(args: argparse.Namespace) -> int:
    config = Config.load(args.config)
    if not args.dry_run and not config.secrets.anthropic_api_key:
        print(
            "ANTHROPIC_API_KEY is not set. Set it, or use --dry-run to see what "
            "would be researched without calling the model.",
            file=sys.stderr,
        )
        return 2

    report = run(config, dry_run=args.dry_run, limit=args.limit)

    if args.json:
        print(json.dumps(report.model_dump(mode="json"), indent=2, default=str))
    elif args.dry_run:
        print(f"Would research {len(report.entries)} token(s):\n")
        for entry in report.entries:
            d = entry.dossier
            print(f"  {d.heuristic_score:6.0f}  {d.ref}")
            for note in d.heuristic_notes:
                print(f"          · {note}")
        print(f"\n{report.skipped} filtered out.")
    else:
        print(render_report_markdown(report))

    return 1 if report.errors and not report.entries else 0


def _cmd_history(args: argparse.Namespace) -> int:
    config = Config.load(args.config)
    with Store(config.resolved_state_path()) as store:
        rows = store.recent_alerts(args.limit)
    if not rows:
        print("No alerts recorded yet.")
        return 0
    for row in rows:
        print(f"{row['alerted_at'][:16]}  {row['token_key']:<50} "
              f"{row['novelty'] or '?':<11} {row['confidence'] or 0:>3}  {row['one_liner'] or ''}")
    return 0


def _cmd_lexicon(_: argparse.Namespace) -> int:
    from provenance.lexicon import ARCHETYPES

    for archetype in ARCHETYPES:
        print(f"{archetype.label}  (weight {archetype.weight})")
        print(f"  ancestors: {'; '.join(archetype.ancestors)}")
        print(f"  {archetype.note}")
        print()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="provenance",
        description="Scrape trending tokens and trace where their memes came from.",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.add_argument(
        "-c", "--config", type=Path, default=None, help="path to provenance.toml"
    )
    sub = parser.add_subparsers(dest="command", required=True)

    run_cmd = sub.add_parser("run", help="do a full sweep")
    run_cmd.add_argument(
        "--dry-run",
        action="store_true",
        help="scrape, filter and rank, but make no LLM calls and send no alerts",
    )
    run_cmd.add_argument(
        "--limit", type=int, default=None, help="override research.max_tokens_per_run"
    )
    run_cmd.add_argument("--json", action="store_true", help="emit the raw report as JSON")
    run_cmd.set_defaults(func=_cmd_run)

    hist = sub.add_parser("history", help="show recent alerts from the local store")
    hist.add_argument("--limit", type=int, default=25)
    hist.set_defaults(func=_cmd_history)

    lex = sub.add_parser("lexicon", help="print the archetype table")
    lex.set_defaults(func=_cmd_lexicon)

    args = parser.parse_args(argv)
    _configure_logging(args.verbose)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
