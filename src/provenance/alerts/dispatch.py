"""Alert channels.

Each channel activates only when its credentials are present, so the same code
runs locally with nothing configured and in Actions with everything. A channel
that fails logs and is skipped; one dead webhook must not lose the report, which
is also written to disk and committed.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from pathlib import Path

from provenance.alerts.render import (
    render_entry_short,
    render_report_markdown,
)
from provenance.config import REPO_ROOT, Config
from provenance.http import Fetcher
from provenance.models import Report, ReportEntry

log = logging.getLogger(__name__)

TELEGRAM_LIMIT = 4096
DISCORD_LIMIT = 2000


def dispatch(
    report: Report, entries: list[ReportEntry], config: Config, fetcher: Fetcher
) -> list[str]:
    """Send `entries` to every configured channel. Returns the channels used."""
    used: list[str] = []
    secrets = config.secrets

    if config.alerts.write_markdown_report:
        path = _write_report(report, config)
        used.append(f"file:{_display_path(path)}")

    if not entries:
        log.info("nothing cleared the alert threshold")
        return used

    if secrets.telegram_bot_token and secrets.telegram_chat_id:
        if _telegram(entries, secrets.telegram_bot_token, secrets.telegram_chat_id, fetcher):
            used.append("telegram")

    if secrets.discord_webhook_url:
        if _discord(entries, secrets.discord_webhook_url, fetcher):
            used.append("discord")

    if secrets.github_token and secrets.github_repository:
        if _github_issue(report, entries, secrets.github_token, secrets.github_repository, fetcher):
            used.append("github")

    if len(used) <= 1:
        log.warning(
            "no push channel configured - set TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID, "
            "DISCORD_WEBHOOK_URL, or run in Actions for the issue channel"
        )
    return used


def _display_path(path: Path) -> str:
    """Repo-relative when it is inside the repo, absolute when it is not - a
    configured reports_dir is allowed to point anywhere."""
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def _write_report(report: Report, config: Config) -> Path:
    # An absolute reports_dir wins; a relative one is resolved against the repo.
    directory = Path(config.alerts.reports_dir)
    if not directory.is_absolute():
        directory = REPO_ROOT / directory
    directory.mkdir(parents=True, exist_ok=True)
    stamp = report.started_at.strftime("%Y-%m-%d-%H%M")
    path = directory / f"{stamp}.md"
    path.write_text(render_report_markdown(report))
    log.info("wrote %s", path)
    return path


def _chunks(text: str, limit: int) -> list[str]:
    """Split on paragraph boundaries where possible; hard-split only if a single
    paragraph is itself over the limit."""
    if len(text) <= limit:
        return [text]
    out: list[str] = []
    current = ""
    for para in text.split("\n\n"):
        if len(para) > limit:
            if current:
                out.append(current)
                current = ""
            out.extend(para[i : i + limit] for i in range(0, len(para), limit))
            continue
        candidate = f"{current}\n\n{para}" if current else para
        if len(candidate) > limit:
            out.append(current)
            current = para
        else:
            current = candidate
    if current:
        out.append(current)
    return out


def _telegram(entries: list[ReportEntry], token: str, chat_id: str, fetcher: Fetcher) -> bool:
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    ok = False
    for entry in entries:
        for chunk in _chunks(render_entry_short(entry, TELEGRAM_LIMIT - 200), TELEGRAM_LIMIT):
            result = fetcher.post_json(
                url,
                {
                    "chat_id": chat_id,
                    "text": chunk,
                    "parse_mode": "Markdown",
                    "disable_web_page_preview": True,
                },
            )
            ok = ok or bool(result)
    if not ok:
        log.warning("telegram delivery failed")
    return ok


def _discord(entries: list[ReportEntry], webhook: str, fetcher: Fetcher) -> bool:
    ok = False
    for entry in entries:
        for chunk in _chunks(render_entry_short(entry, DISCORD_LIMIT - 100), DISCORD_LIMIT):
            # Discord webhooks answer 204 with an empty body on success, which
            # post_json reports as None - so send and treat a non-exception as ok.
            fetcher.post_json(webhook, {"content": chunk, "flags": 4})
            ok = True
    return ok


def _github_issue(
    report: Report, entries: list[ReportEntry], token: str, repository: str, fetcher: Fetcher
) -> bool:
    """One issue per run. Private repo, so this is a log you can search and
    comment on rather than a publication."""
    stamp = report.started_at.strftime("%Y-%m-%d %H:%M UTC")
    body_report = Report(
        run_id=report.run_id,
        started_at=report.started_at,
        finished_at=report.finished_at,
        entries=entries,
        skipped=report.skipped,
    )
    body = render_report_markdown(body_report)
    # GitHub rejects issue bodies over 65536 characters.
    if len(body) > 60_000:
        body = body[:60_000] + "\n\n_(truncated — see the committed report in `reports/`)_"

    result = fetcher.post_json(
        f"https://api.github.com/repos/{repository}/issues",
        {
            "title": f"Provenance — {stamp} ({len(entries)} flagged)",
            "body": body,
            "labels": ["provenance-run"],
        },
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    if not result:
        log.warning("github issue creation failed")
        return False
    log.info("opened issue %s", result.get("html_url"))
    return True


def utcnow() -> datetime:
    return datetime.now(UTC)
