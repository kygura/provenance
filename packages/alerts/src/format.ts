/**
 * Alert bodies.
 *
 * The design constraint: someone who reads only the Telegram message must understand
 * the thesis for that token without opening the dashboard. So every alert carries the
 * same spine — identity, score, provenance verdict, lineage, the on-chain numbers that
 * decide whether the story is investable, and the risks — and the rule only supplies
 * the headline and one or two rule-specific lines on top.
 */

import {
  formatPct,
  formatUsd,
  ratio,
  shortAddress,
  truncate,
  type AlertRuleInput,
  type ChainAnalysis,
  type MarketMetrics,
  type PriorCycle,
  type ProvenanceReport,
  type ProvenanceScore,
  type RiskFlag,
  type Anchor,
} from '@provenance/core';

const SEVERITY_MARK: Record<RiskFlag['severity'], string> = {
  info: 'i',
  warn: '!',
  critical: '!!',
};

function num(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? 'n/a' : value.toLocaleString('en-US');
}

function pct1(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? 'n/a' : `${value.toFixed(1)}%`;
}

/** Plain-text rendering of a markdown body, for channels without formatting. */
export function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(^|\s)_([^_]+)_(?=\s|$|[.,:;])/g, '$1$2');
}

/** One line per prior cycle: the evidence that this narrative has moved a market before. */
export function renderPriorCycles(cycles: readonly PriorCycle[] | undefined): string[] {
  if (!cycles || cycles.length === 0) return ['• none on record'];
  return cycles.slice(0, 4).map((cycle) => {
    const bits: string[] = [];
    if (cycle.ticker && cycle.ticker !== cycle.name) bits.push(cycle.ticker);
    if (cycle.chain) bits.push(cycle.chain);
    if (cycle.year !== undefined) bits.push(String(cycle.year));
    const meta = bits.length > 0 ? ` (${bits.join(', ')})` : '';
    const outcome = cycle.outcome && cycle.outcome !== 'unknown' ? ` — ${cycle.outcome}` : '';
    const peak = cycle.peakMarketCapUsd !== undefined ? ` — peak ${formatUsd(cycle.peakMarketCapUsd)}` : '';
    return `• ${cycle.name}${meta}${outcome}${peak}`;
  });
}

/** The on-chain and market numbers that decide whether a good story is investable. */
export function renderMarketLines(metrics: MarketMetrics | undefined, chain: ChainAnalysis | undefined): string[] {
  const lines: string[] = [];
  const liquidity = metrics?.liquidityUsd;
  const cap = metrics?.marketCapUsd ?? metrics?.fdvUsd;
  const depth = ratio(liquidity, cap);
  lines.push(
    `• Liq ${formatUsd(liquidity)} · MC ${formatUsd(cap)} · depth ${depth === undefined ? 'n/a' : `${(depth * 100).toFixed(1)}%`}`,
  );
  lines.push(
    `• Vol24h ${formatUsd(metrics?.volume24hUsd)} · 24h ${formatPct(metrics?.priceChange24h)} · 6h ${formatPct(metrics?.priceChange6h)} · 1h ${formatPct(metrics?.priceChange1h)}`,
  );
  const txns = metrics?.txns24h ?? metrics?.txns6h;
  if (txns) lines.push(`• Txns ${num(txns.buys)} buys / ${num(txns.sells)} sells`);
  if (chain) {
    lines.push(
      `• Holders ${num(chain.holderCount)} · top10 ${pct1(chain.top10Pct)} · HHI ${chain.herfindahl === undefined ? 'n/a' : chain.herfindahl.toFixed(3)}`,
    );
    const authority: string[] = [];
    if (chain.mintAuthorityActive !== undefined) {
      authority.push(`mint ${chain.mintAuthorityActive ? 'ACTIVE' : 'revoked'}`);
    }
    if (chain.freezeAuthorityActive !== undefined) {
      authority.push(`freeze ${chain.freezeAuthorityActive ? 'ACTIVE' : 'revoked'}`);
    }
    if (chain.ownerRenounced !== undefined) authority.push(`owner ${chain.ownerRenounced ? 'renounced' : 'RETAINED'}`);
    if (chain.lpBurnedPct !== undefined) authority.push(`LP burned ${pct1(chain.lpBurnedPct)}`);
    if (chain.lpLockedPct !== undefined) authority.push(`LP locked ${pct1(chain.lpLockedPct)}`);
    if (chain.privilegedFunctions !== undefined) {
      authority.push(
        chain.privilegedFunctions.length === 0 ? 'no privileged fns' : `fns ${chain.privilegedFunctions.join('/')}`,
      );
    }
    if (chain.creatorHoldingPct !== undefined) authority.push(`creator ${pct1(chain.creatorHoldingPct)}`);
    if (authority.length > 0) lines.push(`• ${authority.join(' · ')}`);
  }
  return lines;
}

/** Worst-first, capped: an alert with twenty flags is an alert nobody reads. */
export function renderRiskFlags(flags: readonly RiskFlag[] | undefined, limit = 4): string[] {
  if (!flags || flags.length === 0) return ['• none raised'];
  const rank: Record<RiskFlag['severity'], number> = { critical: 0, warn: 1, info: 2 };
  return [...flags]
    .sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3))
    .slice(0, limit)
    .map((flag) => `• [${SEVERITY_MARK[flag.severity] ?? '?'}] ${flag.code}: ${truncate(flag.detail ?? '', 140)}`);
}

export function renderComponents(score: ProvenanceScore): string {
  const c = score.components;
  return `recycling ${Math.round(c.recycling)} · memetic ${Math.round(c.memetic)} · distribution ${Math.round(
    c.distribution,
  )} · liquidity ${Math.round(c.liquidity)} · momentum ${Math.round(c.momentum)} · authenticity ${Math.round(
    c.authenticity,
  )}`;
}

/**
 * The headline of every alert: anchored, forced or unclear, what the anchor is,
 * and whether it predates the token. Everything else in an alert supports it.
 */
export function renderAnchorLine(anchor: Anchor | undefined): string[] {
  if (!anchor) return ['_Anchor_: not judged (report predates the anchor verdict).'];
  const bits: string[] = [anchor.type === 'none' ? 'no anchor' : anchor.type.replace('-', ' ')];
  if (anchor.anchorDate) bits.push(`dated ${anchor.anchorDate}`);
  if (anchor.precedesLaunch === true) bits.push('before launch');
  else if (anchor.precedesLaunch === false) bits.push('AFTER launch');
  const subject = anchor.subject ? ` — ${anchor.subject}` : '';
  const lines = [
    `_Anchor_: **${anchor.verdict.toUpperCase()}**${subject} (${bits.join(', ')}; ${anchor.confidence} confidence)`,
  ];
  if (anchor.summary) lines.push(truncate(anchor.summary, 300));
  if (anchor.earliestSource) {
    const source = anchor.earliestSource;
    lines.push(`_Earliest source_: ${source.title}${source.date ? ` (${source.date})` : ''}${source.url ? ` ${source.url}` : ''}`);
  }
  return lines;
}

function renderProvenanceLines(report: ProvenanceReport | undefined): string[] {
  if (!report) return ['_Provenance_: no report — the meme behind this token was not researched.'];
  const origin = report.originYear === undefined ? 'origin year unknown' : `origin ${report.originYear}`;
  return [
    ...renderAnchorLine(report.anchor),
    `_Meme_: **${report.memeName}** (${origin}) · cluster \`${report.narrativeCluster}\``,
    `_Verdict_: **${report.recycleVerdict}** · generation ${report.recycleGeneration} · durability ${Math.round(
      report.memeticDurability,
    )} · reach ${Math.round(report.culturalReach)} · authenticity ${Math.round(report.authenticityScore)}`,
    truncate(report.originSummary ?? '', 400),
  ];
}

export interface AlertBodyOptions {
  /** Rule-specific lines inserted directly under the header. */
  lead?: string[];
  /** Rule-specific closing line, e.g. the delta that triggered a surge. */
  footer?: string[];
}

/**
 * Builds the markdown and plain-text bodies for an alert. The two are kept in sync by
 * construction: the plain text is the markdown with its formatting stripped.
 */
export function renderAlertBody(input: AlertRuleInput, options: AlertBodyOptions = {}): {
  markdown: string;
  body: string;
} {
  const { snapshot, chain, provenance, score } = input;
  const sections: string[] = [];

  sections.push(
    [
      `**$${snapshot.symbol}** — ${snapshot.name}`,
      `${snapshot.chain} · \`${shortAddress(snapshot.tokenAddress, 6, 6)}\``,
      `**Score ${score.total.toFixed(1)} · tier ${score.tier}**${
        provenance ? ` · confidence ${provenance.confidence.toFixed(2)}` : ''
      }`,
    ].join('\n'),
  );

  if (options.lead && options.lead.length > 0) sections.push(options.lead.join('\n'));

  sections.push(renderProvenanceLines(provenance).filter(Boolean).join('\n'));

  sections.push(
    [`**Prior cycles (${provenance?.priorCycles?.length ?? 0})**`, ...renderPriorCycles(provenance?.priorCycles)].join(
      '\n',
    ),
  );

  sections.push(['**Market & on-chain**', ...renderMarketLines(snapshot.metrics, chain)].join('\n'));

  sections.push(['**Risk flags**', ...renderRiskFlags(chain?.flags)].join('\n'));

  sections.push(`**Components** ${renderComponents(score)}`);

  if (score.penalties.length > 0) {
    sections.push(
      ['**Penalties**', ...score.penalties.map((p) => `• -${p.points} ${p.reason}`)].join('\n'),
    );
  }

  if (provenance?.speculativeSetup) {
    sections.push(`_Setup_: ${truncate(provenance.speculativeSetup, 400)}`);
  }

  if (options.footer && options.footer.length > 0) sections.push(options.footer.join('\n'));

  sections.push(`_seen on ${snapshot.sourceCount} trending source(s), best rank ${snapshot.bestRank}_`);

  const markdown = sections.join('\n\n');
  return { markdown, body: stripMarkdown(markdown) };
}
