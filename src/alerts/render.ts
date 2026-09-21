/**
 * Turning a verdict into something readable.
 *
 * Two renderings: full markdown for the committed report, and a short form for
 * chat, where anything longer than a screen gets ignored.
 */

import {
  ageHours,
  volumeToLiquidity,
  type Report,
  type ReportEntry,
  type TokenDossier,
} from "../models.js";

export function chartLink(dossier: TokenDossier): string | null {
  if (!dossier.ref.pairAddress) return null;
  return `https://dexscreener.com/${dossier.ref.chain}/${dossier.ref.pairAddress}`;
}

function usd(value: number | null | undefined): string {
  if (value == null) return "?";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(2)}`;
}

function headline(dossier: TokenDossier): string {
  const { ref } = dossier;
  return `${ref.symbol ?? ref.name ?? ref.address.slice(0, 10)} · ${ref.chain}`;
}

function dataTable(d: TokenDossier): string {
  const { market: m, holders: h, security: s } = d;
  const age = ageHours(m);
  const vtl = volumeToLiquidity(m);

  const rows: [string, string][] = [
    ["Liquidity", usd(m.liquidityUsd)],
    ["FDV", usd(m.fdvUsd)],
    ["24h volume", usd(m.volume24hUsd)],
    ["Volume / liquidity", vtl != null ? `${vtl.toFixed(1)}x` : "?"],
    [
      "24h change",
      m.priceChange24hPct != null
        ? `${m.priceChange24hPct >= 0 ? "+" : ""}${m.priceChange24hPct.toFixed(1)}%`
        : "?",
    ],
    ["Pool age", age != null ? `${age.toFixed(0)}h` : "?"],
    ["Holders", h.holderCount != null ? String(h.holderCount) : "?"],
    ["Top-10 share", h.top10Pct != null ? `${h.top10Pct.toFixed(1)}%` : "?"],
    ["Contract flags", s.flags.length > 0 ? s.flags.join(", ") : "none"],
    ["Surfaced by", d.sources.join(", ") || "?"],
    ["Heuristic score", d.heuristicScore.toFixed(0)],
  ];

  return ["| | |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join("\n");
}

export function renderEntryMarkdown(entry: ReportEntry): string {
  const d = entry.dossier;
  const v = entry.verdict;
  const lines: string[] = [`## ${headline(d)}`, ""];

  if (entry.error) lines.push(`> Research failed: ${entry.error}`, "");

  if (v) {
    lines.push(
      `**${v.one_liner}**`,
      "",
      `- **Archetype**: ${v.archetype}`,
      `- **Novelty**: ${v.novelty}` +
        (v.cycle_distance_years != null
          ? ` · closest ancestor peaked ~${v.cycle_distance_years.toFixed(1)}y ago`
          : ""),
      `- **Confidence in the lineage claim**: ${v.recycle_confidence}/100`,
      "",
      "### Origin",
      v.origin_story,
      "",
    );

    if (v.lineage.length > 0) {
      lines.push("### Lineage");
      for (const ancestor of v.lineage) {
        lines.push(
          `**${ancestor.name}${ancestor.ticker ? ` ($${ancestor.ticker})` : ""}** — ${ancestor.era}`,
          `- Peak: ${ancestor.peak_context}`,
          `- Resolved: ${ancestor.what_happened_next}`,
          `- Link to this token: ${ancestor.resemblance}`,
        );
        if (ancestor.evidence_urls.length > 0) {
          const sources = ancestor.evidence_urls
            .slice(0, 4)
            .map((u) => `[src](${u})`)
            .join(", ");
          lines.push(`- Sources: ${sources}`);
        }
        lines.push("");
      }
    } else {
      lines.push("### Lineage", "No ancestor established.", "");
    }

    lines.push("### Who is holding it", v.audience_read, "");

    const sections: [string, string[]][] = [
      ["Would confirm", v.what_would_confirm],
      ["Would kill it", v.what_would_kill_it],
      ["Red flags", v.red_flags],
      ["Open questions", v.open_questions],
    ];
    for (const [title, items] of sections) {
      if (items.length === 0) continue;
      lines.push(`### ${title}`, ...items.map((item) => `- ${item}`), "");
    }
  }

  lines.push("### Data", "", dataTable(d), "");

  const link = chartLink(d);
  lines.push(link ? `[Chart](${link}) · \`${d.ref.address}\`` : `\`${d.ref.address}\``, "");

  if (entry.citations.length > 0) {
    lines.push(
      "<details><summary>Sources consulted</summary>",
      "",
      ...entry.citations.slice(0, 25).map((url) => `- ${url}`),
      "",
      "</details>",
      "",
    );
  }

  return lines.join("\n");
}

export function renderReportMarkdown(report: Report): string {
  const stamp = `${report.startedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const lines: string[] = [
    `# Provenance — ${stamp}`,
    "",
    `Researched ${report.entries.length} token(s); ${report.skipped} filtered out before research.`,
    "",
  ];

  const researched = report.entries.filter((e) => e.verdict);
  if (researched.length > 0) {
    lines.push("| Token | Archetype | Novelty | Confidence | Read |", "|---|---|---|---|---|");
    for (const entry of researched) {
      const v = entry.verdict!;
      lines.push(
        `| ${headline(entry.dossier)} | ${v.archetype} | ${v.novelty} | ` +
          `${v.recycle_confidence} | ${v.one_liner} |`,
      );
    }
    lines.push("");
  }

  for (const entry of report.entries) {
    lines.push(renderEntryMarkdown(entry), "---", "");
  }

  if (report.errors.length > 0) {
    lines.push("## Run errors", "", ...report.errors.map((e) => `- ${e}`), "");
  }

  lines.push(
    "",
    "_Provenance is a research tool. Nothing here is a recommendation, and the " +
      "lineage claims are model output — check the sources before acting on any of it._",
  );
  return lines.join("\n");
}

/** Chat-length version. Leads with the lineage, because that is the point. */
export function renderEntryShort(entry: ReportEntry, limit = 3500): string {
  const d = entry.dossier;
  const v = entry.verdict;
  const head = `*${headline(d)}*`;

  if (!v) return `${head}\nResearch failed: ${entry.error ?? "unknown error"}`;

  const parts: string[] = [
    head,
    v.one_liner,
    "",
    `Archetype: ${v.archetype} · ${v.novelty} · confidence ${v.recycle_confidence}/100`,
  ];

  const top = v.lineage[0];
  if (top) parts.push(`Runs as: ${top.name} (${top.era}) — ${top.what_happened_next}`);
  if (v.red_flags.length > 0) parts.push(`Flags: ${v.red_flags.slice(0, 3).join("; ")}`);

  const { market: m, holders: h } = d;
  parts.push(
    `Liq ${usd(m.liquidityUsd)} · Vol24h ${usd(m.volume24hUsd)} · FDV ${usd(m.fdvUsd)}` +
      (h.top10Pct != null ? ` · top10 ${h.top10Pct.toFixed(0)}%` : ""),
  );

  const link = chartLink(d);
  if (link) parts.push(link);
  parts.push(`\`${d.ref.address}\``);

  const text = parts.join("\n");
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}
