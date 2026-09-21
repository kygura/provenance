/**
 * Alert channels.
 *
 * Each channel activates only when its credentials are present, so the same
 * code runs locally with nothing configured and in Actions with everything. A
 * channel that fails logs and is skipped; one dead webhook must not lose the
 * report, which is also written to disk and committed.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

import { REPO_ROOT, type Config } from "../config.js";
import type { Fetcher } from "../http.js";
import { log } from "../log.js";
import type { Report, ReportEntry } from "../models.js";
import { renderEntryShort, renderReportMarkdown } from "./render.js";

const TELEGRAM_LIMIT = 4096;
const DISCORD_LIMIT = 2000;
/** GitHub rejects issue bodies over 65536 characters. */
const GITHUB_BODY_LIMIT = 60_000;

/**
 * Repo-relative when it is inside the repo, absolute when it is not - a
 * configured reportsDir is allowed to point anywhere.
 */
function displayPath(path: string): string {
  const rel = relative(REPO_ROOT, path);
  return rel.startsWith("..") ? path : rel;
}

function writeReport(report: Report, config: Config): string {
  // An absolute reportsDir wins; a relative one is resolved against the repo.
  const directory = isAbsolute(config.alerts.reportsDir)
    ? config.alerts.reportsDir
    : join(REPO_ROOT, config.alerts.reportsDir);
  mkdirSync(directory, { recursive: true });

  const stamp = report.startedAt.toISOString().slice(0, 16).replace("T", "-").replace(":", "");
  const path = resolve(directory, `${stamp}.md`);
  writeFileSync(path, renderReportMarkdown(report));
  log.info(`wrote ${path}`);
  return path;
}

/**
 * Split on paragraph boundaries where possible; hard-split only if a single
 * paragraph is itself over the limit.
 */
export function chunk(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const out: string[] = [];
  let current = "";

  for (const para of text.split("\n\n")) {
    if (para.length > limit) {
      if (current) {
        out.push(current);
        current = "";
      }
      for (let i = 0; i < para.length; i += limit) out.push(para.slice(i, i + limit));
      continue;
    }
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length > limit) {
      out.push(current);
      current = para;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out;
}

async function sendTelegram(
  entries: ReportEntry[],
  token: string,
  chatId: string,
  fetcher: Fetcher,
): Promise<boolean> {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  let ok = false;

  for (const entry of entries) {
    for (const part of chunk(renderEntryShort(entry, TELEGRAM_LIMIT - 200), TELEGRAM_LIMIT)) {
      const result = await fetcher.postJson(url, {
        chat_id: chatId,
        text: part,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      });
      ok ||= result !== null;
    }
  }
  if (!ok) log.warn("telegram delivery failed");
  return ok;
}

async function sendDiscord(
  entries: ReportEntry[],
  webhook: string,
  fetcher: Fetcher,
): Promise<boolean> {
  let ok = false;
  for (const entry of entries) {
    for (const part of chunk(renderEntryShort(entry, DISCORD_LIMIT - 100), DISCORD_LIMIT)) {
      // flags: 4 suppresses embeds - the chart link should not unfurl.
      const result = await fetcher.postJson(webhook, { content: part, flags: 4 });
      ok ||= result !== null;
    }
  }
  if (!ok) log.warn("discord delivery failed");
  return ok;
}

/**
 * One issue per run. Private repo, so this is a log you can search and comment
 * on rather than a publication.
 */
async function openGithubIssue(
  report: Report,
  entries: ReportEntry[],
  token: string,
  repository: string,
  fetcher: Fetcher,
): Promise<boolean> {
  const stamp = `${report.startedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  let body = renderReportMarkdown({ ...report, entries });
  if (body.length > GITHUB_BODY_LIMIT) {
    body = `${body.slice(0, GITHUB_BODY_LIMIT)}\n\n_(truncated — see the committed report in \`reports/\`)_`;
  }

  const result = await fetcher.postJson(
    `https://api.github.com/repos/${repository}/issues`,
    {
      title: `Provenance — ${stamp} (${entries.length} flagged)`,
      body,
      labels: ["provenance-run"],
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!result) {
    log.warn("github issue creation failed");
    return false;
  }
  log.info(`opened issue ${(result as { html_url?: string }).html_url ?? ""}`);
  return true;
}

/** Send `entries` to every configured channel. Returns the channels used. */
export async function dispatch(
  report: Report,
  entries: ReportEntry[],
  config: Config,
  fetcher: Fetcher,
): Promise<string[]> {
  const used: string[] = [];
  const s = config.secrets;

  if (config.alerts.writeMarkdownReport) {
    used.push(`file:${displayPath(writeReport(report, config))}`);
  }

  if (entries.length === 0) {
    log.info("nothing cleared the alert threshold");
    return used;
  }

  if (s.telegramBotToken && s.telegramChatId) {
    if (await sendTelegram(entries, s.telegramBotToken, s.telegramChatId, fetcher)) {
      used.push("telegram");
    }
  }
  if (s.discordWebhookUrl) {
    if (await sendDiscord(entries, s.discordWebhookUrl, fetcher)) used.push("discord");
  }
  if (s.githubToken && s.githubRepository) {
    if (await openGithubIssue(report, entries, s.githubToken, s.githubRepository, fetcher)) {
      used.push("github");
    }
  }

  if (used.length <= 1) {
    log.warn(
      "no push channel configured - set TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID, " +
        "DISCORD_WEBHOOK_URL, or run in Actions for the issue channel",
    );
  }
  return used;
}
