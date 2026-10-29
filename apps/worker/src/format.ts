/**
 * Terminal presentation: colour that disables itself politely, a column-aligned
 * table, and the three `report` renderings. Kept away from the command logic so
 * both can be read on their own.
 */
import {
  type RunRecord,
  type RunStats,
  type TokenDossier,
  type TokenSnapshot,
  type WatchEntry,
  formatPct,
  formatUsd,
  truncate,
} from '@provenance/core';

export interface Style {
  enabled: boolean;
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  cyan(text: string): string;
  magenta(text: string): string;
}

export interface StyleOptions {
  isTty?: boolean;
  env?: Record<string, string | undefined>;
  noColor?: boolean;
}

/** NO_COLOR is honoured unconditionally; a pipe or a redirect disables colour too. */
export function colorEnabled(options: StyleOptions = {}): boolean {
  const env = options.env ?? process.env;
  if (options.noColor) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && env.FORCE_COLOR !== '0') return true;
  if (env.CI !== undefined && env.CI !== '') return false;
  return options.isTty ?? Boolean(process.stdout.isTTY);
}

export function createStyle(options: StyleOptions = {}): Style {
  const enabled = colorEnabled(options);
  const wrap = (code: string) => (text: string) => (enabled ? `\u001b[${code}m${text}\u001b[0m` : text);
  return {
    enabled,
    bold: wrap('1'),
    dim: wrap('2'),
    red: wrap('31'),
    green: wrap('32'),
    yellow: wrap('33'),
    cyan: wrap('36'),
    magenta: wrap('35'),
  };
}

const ANSI = /\u001b\[[0-9;]*m/g;
const width = (text: string): number => text.replace(ANSI, '').length;

/** Column-aligned table that stays aligned when cells contain colour codes. */
export function table(headers: string[], rows: string[][], style?: Style): string {
  const widths = headers.map((header, index) =>
    Math.max(width(header), ...rows.map((row) => width(row[index] ?? ''))),
  );
  const pad = (text: string, index: number) => text + ' '.repeat(Math.max(0, (widths[index] ?? 0) - width(text)));
  const head = headers.map((header, index) => pad(header, index)).join('  ');
  const rule = widths.map((w) => '-'.repeat(w)).join('  ');
  const body = rows.map((row) => row.map((cell, index) => pad(cell ?? '', index)).join('  '));
  return [style ? style.bold(head) : head, style ? style.dim(rule) : rule, ...body].join('\n');
}

export function tierColor(style: Style, tier?: string): string {
  if (!tier) return style.dim('-');
  if (tier === 'S') return style.magenta(tier);
  if (tier === 'A') return style.green(tier);
  if (tier === 'B') return style.cyan(tier);
  if (tier === 'C') return style.yellow(tier);
  return style.dim(tier);
}

export function statusColor(style: Style, status: string): string {
  if (status === 'ok') return style.green(status);
  if (status === 'partial') return style.yellow(status);
  if (status === 'failed') return style.red(status);
  return style.dim(status);
}

export function snapshotTable(snapshots: TokenSnapshot[], style: Style, notes?: Map<string, string>): string {
  const rows = snapshots.map((snapshot, index) => [
    String(index + 1),
    truncate(snapshot.symbol || '?', 12),
    snapshot.chain,
    String(snapshot.bestRank),
    String(snapshot.sourceCount),
    formatUsd(snapshot.metrics.liquidityUsd),
    formatUsd(snapshot.metrics.volume24hUsd),
    formatPct(snapshot.metrics.priceChange24h),
    notes?.get(snapshot.tokenId) ?? '',
  ]);
  return table(['#', 'SYMBOL', 'CHAIN', 'RANK', 'SRC', 'LIQ', 'VOL24H', '24H', 'NOTE'], rows, style);
}

function verdictColor(style: Style, verdict: string): string {
  if (verdict === 'anchored') return style.green(verdict);
  if (verdict === 'forced') return style.red(verdict);
  return style.yellow(verdict);
}

/** Every launch the lane judged: the verdict first, then what became of it. */
export function watchTable(entries: WatchEntry[], style: Style): string {
  const rows = entries.map((entry) => [
    truncate(entry.symbol || '?', 12),
    entry.chain,
    verdictColor(style, entry.anchor.verdict),
    entry.anchor.confidence,
    truncate(entry.anchor.subject || '-', 28),
    entry.anchor.anchorDate ?? '-',
    entry.anchor.precedesLaunch === undefined ? '-' : entry.anchor.precedesLaunch ? 'yes' : style.red('NO'),
    entry.status === 'expressed' ? style.green(entry.status) : style.dim(entry.status),
    entry.firstSeenAt.slice(0, 16).replace('T', ' '),
    entry.leadHours === undefined ? '-' : `${entry.leadHours.toFixed(1)}h`,
    socialLead(entry.socialLeadHours, style),
  ]);
  return table(
    ['SYMBOL', 'CHAIN', 'VERDICT', 'CONF', 'ANCHOR', 'DATED', 'BEFORE', 'STATUS', 'JUDGED', 'TO TREND', 'TO SOCIAL'],
    rows,
    style,
  );
}

/** Signed: a negative lead means crypto-social had the token before we judged it. */
function socialLead(hours: number | undefined, style: Style): string {
  if (hours === undefined) return '-';
  const text = `${hours >= 0 ? '+' : ''}${hours.toFixed(1)}h`;
  return hours < 0 ? style.red(text) : text;
}

/** One line of social-step counters, or nothing when the step never ran. */
export function socialSummary(stats: RunStats): string | undefined {
  const s = stats.social;
  if (!s || s.skipped === 'no-key') return undefined;
  const fetched = s.skipped === 'throttled' ? 'throttled' : `sightings=${s.sightings} new=${s.newTokens}`;
  return `social: ${fetched} matched=${s.matched}`;
}

/** One line of launch-lane counters, or nothing for runs from before the lane. */
export function launchSummary(stats: RunStats): string | undefined {
  const l = stats.launches;
  if (!l) return undefined;
  const by = Object.entries(l.rejectedBy ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([rule, n]) => `${rule}=${n}`)
    .join(',');
  return `launches: discovered=${l.discovered} rejected=${l.rejected}${by ? ` (${by})` : ''} anchored=${l.catalogued} researched=${l.researched} dismissed=${l.dismissed} trended=${l.expressed} dormant=${l.dormant}`;
}

export function dossierTable(dossiers: TokenDossier[], style: Style): string {
  const rows = dossiers.map((dossier) => [
    truncate(dossier.snapshot.symbol || '?', 12),
    dossier.snapshot.chain,
    dossier.score ? String(Math.round(dossier.score.total)) : '-',
    tierColor(style, dossier.score?.tier),
    dossier.provenance?.recycleVerdict ?? '-',
    dossier.provenance ? String(dossier.provenance.recycleGeneration) : '-',
    truncate(dossier.provenance?.memeName ?? '-', 24),
    formatUsd(dossier.snapshot.metrics.liquidityUsd),
    String(dossier.alerts.length),
  ]);
  return table(
    ['SYMBOL', 'CHAIN', 'SCORE', 'TIER', 'VERDICT', 'GEN', 'MEME', 'LIQ', 'ALERTS'],
    rows,
    style,
  );
}

/** The `analyze` output: one token, everything we know about it. */
export function renderDossier(dossier: TokenDossier, style: Style): string {
  const { snapshot, chain, provenance, score, alerts } = dossier;
  const out: string[] = [];
  const head = `${snapshot.symbol} — ${snapshot.name}`;
  out.push(style.bold(head));
  out.push(style.dim(`${snapshot.tokenId}  ·  sources: ${snapshot.sourceCount}  ·  best rank: ${snapshot.bestRank}`));
  out.push('');

  out.push(style.bold('Market'));
  out.push(
    table(
      ['PRICE', 'FDV', 'LIQ', 'VOL24H', '1H', '24H', 'AGE'],
      [
        [
          formatUsd(snapshot.metrics.priceUsd),
          formatUsd(snapshot.metrics.fdvUsd),
          formatUsd(snapshot.metrics.liquidityUsd),
          formatUsd(snapshot.metrics.volume24hUsd),
          formatPct(snapshot.metrics.priceChange1h),
          formatPct(snapshot.metrics.priceChange24h),
          snapshot.metrics.ageHours === undefined ? 'n/a' : `${snapshot.metrics.ageHours.toFixed(1)}h`,
        ],
      ],
      style,
    ),
  );
  out.push('');

  out.push(style.bold('On-chain'));
  if (!chain) {
    out.push(style.dim('  no chain analysis'));
  } else {
    out.push(
      `  method=${chain.method}  holders=${chain.holderCount ?? 'n/a'}  top10=${
        chain.top10Pct === undefined ? 'n/a' : `${chain.top10Pct.toFixed(1)}%`
      }  lpBurned=${chain.lpBurnedPct === undefined ? 'n/a' : `${chain.lpBurnedPct.toFixed(1)}%`}`,
    );
    for (const flag of chain.flags) {
      const paint = flag.severity === 'critical' ? style.red : flag.severity === 'warn' ? style.yellow : style.dim;
      out.push(`  ${paint(`[${flag.severity}] ${flag.code}`)} ${flag.detail}`);
    }
    for (const note of chain.notes) out.push(style.dim(`  note: ${note}`));
  }
  out.push('');

  out.push(style.bold('Provenance'));
  if (!provenance) {
    out.push(style.dim('  no provenance report (llm skipped, budget exhausted or cache miss)'));
  } else {
    out.push(`  meme: ${style.cyan(provenance.memeName)}  cluster: ${provenance.narrativeCluster}`);
    out.push(
      `  verdict: ${style.bold(provenance.recycleVerdict)}  generation: ${provenance.recycleGeneration}  confidence: ${provenance.confidence.toFixed(2)}`,
    );
    out.push(
      `  durability: ${provenance.memeticDurability}  reach: ${provenance.culturalReach}  authenticity: ${provenance.authenticityScore}`,
    );
    out.push(`  ${provenance.originSummary}`);
    if (provenance.lineage.length > 0) {
      out.push(
        style.dim(
          `  lineage: ${provenance.lineage.map((node) => `${node.label}${node.year ? ` (${node.year})` : ''}`).join(' → ')}`,
        ),
      );
    }
    for (const cycle of provenance.priorCycles) {
      out.push(
        style.dim(`  prior: ${cycle.name}${cycle.year ? ` ${cycle.year}` : ''}${cycle.outcome ? ` — ${cycle.outcome}` : ''}`),
      );
    }
    out.push(`  setup: ${provenance.speculativeSetup}`);
    for (const risk of provenance.risks) out.push(style.yellow(`  risk: ${risk}`));
    out.push(style.dim(`  model=${provenance.model} prompt=${provenance.promptVersion} evidence=${provenance.evidence.length}`));
  }
  out.push('');

  out.push(style.bold('Score'));
  if (!score) {
    out.push(style.dim('  not scored'));
  } else {
    out.push(`  ${style.bold(String(Math.round(score.total)))}/100  tier ${tierColor(style, score.tier)}`);
    const c = score.components;
    out.push(
      table(
        ['RECYCLING', 'MEMETIC', 'DISTRIB', 'LIQUIDITY', 'MOMENTUM', 'AUTHENTIC'],
        [[c.recycling, c.memetic, c.distribution, c.liquidity, c.momentum, c.authenticity].map((n) =>
          String(Math.round(n)),
        )],
        style,
      ),
    );
    for (const penalty of score.penalties) {
      out.push(style.red(`  -${penalty.points} ${penalty.reason}`));
    }
  }

  if (alerts.length > 0) {
    out.push('');
    out.push(style.bold('Alerts'));
    for (const alert of alerts) out.push(`  ${style.yellow(alert.rule)} ${alert.title}`);
  }
  return out.join('\n');
}

export type ReportFormat = 'table' | 'json' | 'markdown';

export function renderRun(
  run: RunRecord,
  dossiers: TokenDossier[],
  format: ReportFormat,
  style: Style,
): string {
  if (format === 'json') return JSON.stringify({ run, dossiers }, null, 2);

  if (format === 'markdown') {
    const lines = [
      `# Provenance run \`${run.id}\``,
      '',
      `- status: **${run.status}**`,
      `- started: ${run.startedAt}`,
      `- finished: ${run.finishedAt ?? '-'}`,
      `- discovered: ${run.stats.discovered}, after filter: ${run.stats.afterFilter}, analysed: ${run.stats.analysed}, reused: ${run.stats.reused}`,
      `- alerts: ${run.stats.alertsFired}, llm cost: $${run.stats.llmCostUsd.toFixed(4)}`,
      ...(launchSummary(run.stats) ? [`- ${launchSummary(run.stats)}`] : []),
      '',
      '| Symbol | Chain | Score | Tier | Verdict | Gen | Meme | Alerts |',
      '| --- | --- | ---: | --- | --- | ---: | --- | ---: |',
      ...dossiers.map((d) =>
        `| ${d.snapshot.symbol} | ${d.snapshot.chain} | ${d.score ? Math.round(d.score.total) : '-'} | ${
          d.score?.tier ?? '-'
        } | ${d.provenance?.recycleVerdict ?? '-'} | ${d.provenance?.recycleGeneration ?? '-'} | ${
          d.provenance?.memeName ?? '-'
        } | ${d.alerts.length} |`,
      ),
    ];
    if (run.stats.sourceErrors.length > 0) {
      lines.push('', '## Degradations', ...run.stats.sourceErrors.map((e) => `- \`${e.source}\`: ${e.error}`));
    }
    return lines.join('\n');
  }

  const header = [
    `${style.bold('run')} ${run.id}  ${statusColor(style, run.status)}`,
    style.dim(
      `discovered=${run.stats.discovered} kept=${run.stats.afterFilter} analysed=${run.stats.analysed} reused=${run.stats.reused} alerts=${run.stats.alertsFired} cost=$${run.stats.llmCostUsd.toFixed(4)}${
        run.stats.durationMs ? ` in ${(run.stats.durationMs / 1000).toFixed(1)}s` : ''
      }`,
    ),
    ...(launchSummary(run.stats) ? [style.dim(launchSummary(run.stats) ?? '')] : []),
    '',
  ];
  const errors = run.stats.sourceErrors.map((e) => style.yellow(`! ${e.source}: ${e.error}`));
  return [...header, dossierTable(dossiers, style), ...(errors.length > 0 ? ['', ...errors] : [])].join('\n');
}
