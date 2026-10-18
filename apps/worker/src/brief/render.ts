/**
 * The brief as plain text (CLAUDE.md §4, plus Regime and Setups), and the
 * split into messages that fit Telegram after MarkdownV2 escaping.
 *
 * Numbers and changes come from code; the model's words fill only the
 * interpretive slots (read, why, evidence, breaks-if). Without a model every
 * slot has a deterministic fallback.
 */
import { escapeMarkdownV2 } from '@provenance/alerts';
import type { Setup } from '@provenance/core';
import type { GateVerdict } from './gate';
import { entryMid } from './ledger';
import type { SetupStats } from './ledger';
import type { BriefOutput, BriefTokenRead } from './llm';
import type { NotableToken } from './notable';
import type { AlertRow, ClusterRow, DossierRow, FullRun, TrackRow, WatchRow } from './queries';
import type { BtcRegime, MemeRegimeRead } from './regime';

export interface SetupChange {
  before: Setup['status'];
  after: Setup;
}

export interface BriefView {
  date: string;
  cur?: FullRun;
  /** The newest full run: an in-flight one when there is one, else CUR. */
  latest?: { startedAt: string; status: string };
  /** False when no full run landed in the last 24 h, or one is still running. */
  fresh: boolean;
  tokenCount: number;
  alerts: AlertRow[];
  meme: MemeRegimeRead;
  btc: BtcRegime;
  notable: NotableToken[];
  watch: WatchRow[];
  track: TrackRow[];
  clusters: ClusterRow[];
  pipeline: string[];
  gaps: string[];
  llm?: BriefOutput;
  newSetups: Setup[];
  changes: SetupChange[];
  dropped: GateVerdict[];
  stats: SetupStats;
  standAside?: string;
}

/** Strip control characters from deployer-written text before it reaches a chat. */
export function safe(value: string | undefined, max = 24): string {
  const text = (value ?? '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text || '?';
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

export function fmtUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return 'n/a';
  const abs = Math.abs(value);
  if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(value / 1e3).toFixed(0)}K`;
  return `$${Math.round(value)}`;
}

function fmtPct(value: number | undefined): string {
  return value === undefined ? 'n/a' : `${value.toFixed(1)}%`;
}

function tokenLink(row: DossierRow): string {
  return row.pairUrl && /^https:\/\//.test(row.pairUrl) ? row.pairUrl : `https://dexscreener.com/${row.chain}/${row.address}`;
}

export function changeText(token: NotableToken): string {
  const { row } = token;
  const now = `${row.tier ?? '?'} ${row.score !== undefined ? row.score.toFixed(0) : 'n/a'}`;
  const parts: string[] = [];
  if (row.prevScore !== undefined || row.prevTier !== undefined) {
    const before = `${row.prevTier ?? '?'} ${row.prevScore !== undefined ? row.prevScore.toFixed(0) : 'n/a'}`;
    parts.push(before === now ? `${now} (unchanged)` : `${before} → ${now}`);
  } else parts.push(`new, ${now}`);
  if (token.verdictChange) parts.push(token.verdictChange);
  else if (token.newVerdict && row.anchorVerdict) parts.push(`verdict ${row.anchorVerdict}`);
  if (token.severe) parts.push(`${token.severe} alert`);
  return parts.join('; ');
}

export function whyText(row: DossierRow): string {
  const top = Object.entries(row.components)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([key, value]) => `${key} ${value.toFixed(0)}`);
  // Stored penalties carry either sign depending on the writer; the reader only needs the size.
  const penalties = row.penalties.map((p) => `−${Math.abs(p.points).toFixed(0)} ${safe(p.reason, 60)}`);
  return [...top, ...penalties].join(', ') || 'no score breakdown';
}

export function chainFact(row: DossierRow): string {
  const severe = row.flags.find((flag) => flag.severity === 'critical' || flag.severity === 'high');
  if (severe) return `${severe.severity} flag ${severe.code}`;
  if (row.mintActive) return 'mint authority active';
  if (row.freezeActive) return 'freeze authority active';
  const facts: string[] = [];
  if (row.top10Pct !== undefined) facts.push(`top-10 ${fmtPct(row.top10Pct)}`);
  if (row.largestHolderPct !== undefined) facts.push(`largest holder ${fmtPct(row.largestHolderPct)}`);
  const lp = (row.lpBurnedPct ?? 0) + (row.lpLockedPct ?? 0);
  if (row.lpBurnedPct !== undefined || row.lpLockedPct !== undefined) facts.push(`LP burned+locked ${lp.toFixed(0)}%`);
  return facts.join(', ') || 'no chain facts';
}

export function breaksIfText(row: DossierRow): string {
  const parts: string[] = [];
  if (row.liqUsd !== undefined) parts.push(`liquidity < ${fmtUsd(row.liqUsd / 2)}`);
  parts.push('top-10 ≥ 80%', 'one holder ≥ 25%');
  if (row.mintActive === false || row.freezeActive === false) parts.push('mint/freeze turns active');
  return parts.join(' or ');
}

function confidenceWord(row: DossierRow): string {
  const c = row.confidence;
  if (c === undefined) return 'low-confidence';
  return c >= 0.7 ? 'base case' : c >= 0.4 ? 'we lean' : 'low-confidence';
}

function tokenLines(token: NotableToken, read: BriefTokenRead | undefined): string[] {
  const { row } = token;
  const head = `- ${safe(row.symbol, 16)} ${row.chain}:${shortAddress(row.address)} — ${changeText(token)}.`;
  const why = read?.why || whyText(row);
  const evidence = read?.evidence || chainFact(row);
  const confidence = read?.confidence || confidenceWord(row);
  const breaks = read?.breaks_if || breaksIfText(row);
  return [head, `  Why: ${why}. Evidence: ${evidence}.`, `  ${confidence}. Breaks if: ${breaks}. ${tokenLink(row)}`];
}

function watchLines(rows: readonly WatchRow[], dayAgo: string): string[] {
  const lines: string[] = [];
  let dismissed = 0;
  for (const row of rows) {
    const sym = safe(row.symbol, 16);
    if (row.status === 'expressed' && row.expressedAt && row.expressedAt >= dayAgo) {
      const social = row.socialLeadHours !== undefined ? ` (social lead ${row.socialLeadHours.toFixed(0)} h)` : '';
      const on = row.expressedOn.length > 0 ? ` on ${row.expressedOn.map((s) => safe(s, 16)).join(', ')}` : '';
      const lead = row.leadHours !== undefined ? ` ${row.leadHours.toFixed(0)} h after verdict` : '';
      lines.push(`- ${sym} expressed${lead}${social}${on}`);
    } else if (row.status === 'dormant') {
      lines.push(`- ${sym} went dormant — anchored ${row.anchorDate ?? row.firstSeenAt.slice(0, 10)}, never trended`);
    } else if (row.status === 'dismissed' && row.firstSeenAt >= dayAgo) {
      dismissed += 1;
    } else if (row.firstSeenAt >= dayAgo) {
      lines.push(`- ${sym} catalogued ${row.anchorVerdict ?? 'unclear'} (${row.anchorType ?? 'none'}), liq at catalogue ${fmtUsd(row.liqAtCatalog)}`);
    } else if (row.socialAt && row.socialAt >= dayAgo) {
      const lead = row.socialLeadHours !== undefined ? `, social lead ${row.socialLeadHours.toFixed(0)} h` : '';
      lines.push(`- ${sym} first social sighting${lead}`);
    }
  }
  if (dismissed > 0) lines.push(`- ${dismissed} launch${dismissed === 1 ? '' : 'es'} dismissed (forced/unclear)`);
  return lines;
}

export function trackRecordLine(rows: readonly TrackRow[]): string | undefined {
  if (rows.length === 0) return undefined;
  const count = (verdicts: string[], status?: string, field: 'n' | 'n7d' = 'n') =>
    rows
      .filter((row) => verdicts.includes(row.anchorVerdict) && (status === undefined || row.status === status))
      .reduce((sum, row) => sum + row[field], 0);
  const anchoredExpressed = count(['anchored'], 'expressed');
  const anchoredResolved = anchoredExpressed + count(['anchored'], 'dormant');
  const dismissedTrended = count(['forced', 'unclear'], 'expressed');
  const dismissedAll = count(['forced', 'unclear']);
  const lead = rows.find((row) => row.anchorVerdict === 'anchored' && row.status === 'expressed')?.avgLeadH;
  const line =
    `- anchored ${anchoredExpressed}/${anchoredResolved} expressed${lead !== undefined ? ` (avg lead ${lead} h)` : ''}` +
    ` vs forced/unclear ${dismissedTrended}/${dismissedAll} trended anyway` +
    ` (7 d: anchored ${count(['anchored'], 'expressed', 'n7d')}/${count(['anchored'], undefined, 'n7d')}, forced/unclear ${count(['forced', 'unclear'], 'expressed', 'n7d')}/${count(['forced', 'unclear'], undefined, 'n7d')})`;
  return anchoredResolved < 10 ? `${line}; sample too small to judge` : line;
}

function clusterLine(row: ClusterRow): string {
  const label = row.tokens >= 3 && (row.avgScore ?? 0) >= 58 ? 'forming' : 'active';
  return `- ${safe(row.cluster, 32)}: ${row.tokens} tokens, avg score ${row.avgScore?.toFixed(1) ?? 'n/a'} — ${label}`;
}

function setupLevels(setup: Setup): string {
  const mid = entryMid(setup);
  const rr = mid > setup.invalidationMcap && setup.targets[0] !== undefined
    ? ((setup.targets[0] - mid) / (mid - setup.invalidationMcap)).toFixed(1)
    : 'n/a';
  return `entry ${fmtUsd(setup.entryMcapLow)}–${fmtUsd(setup.entryMcapHigh)} mcap, invalidation ${fmtUsd(setup.invalidationMcap)}, targets ${setup.targets.map(fmtUsd).join('/')} (${rr}R)`;
}

function setupLines(view: BriefView): string[] {
  const lines: string[] = [];
  for (const setup of view.newSetups) {
    lines.push(
      `- NEW ${setup.id} long — ${setupLevels(setup)}, expires ${setup.expiresAt.slice(0, 10)}, conviction ${setup.conviction}.`,
      `  Thesis: ${setup.thesis} Trigger: ${setup.trigger}`,
    );
  }
  for (const change of view.changes) {
    const r = change.after.rResult !== undefined ? ` (${change.after.rResult > 0 ? '+' : ''}${change.after.rResult}R)` : '';
    lines.push(`- ${change.after.id} ${change.before} → ${change.after.status}${r} — ${change.after.statusNote ?? ''}`);
  }
  const symbols = new Map(view.notable.map((token) => [token.row.tokenId, token.row.symbol]));
  for (const verdict of view.dropped) {
    const id = verdict.proposal.token_id;
    const name = symbols.has(id) ? safe(symbols.get(id), 16) : shortAddress(safe(id.split(':')[1] ?? id, 64));
    lines.push(`- gate dropped ${name} ${verdict.proposal.direction}: ${verdict.reasons.slice(0, 2).join('; ')}`);
  }
  if (view.newSetups.length === 0 && view.standAside) lines.push(`- No new setups: ${view.standAside}`);
  const { stats } = view;
  const record =
    stats.resolved90d > 0
      ? `90 d: ${stats.hits90d}/${stats.resolved90d} hit (${Math.round((stats.hitRate ?? 0) * 100)}%), avg ${stats.avgR}R`
      : '90 d: nothing resolved yet';
  if (lines.length > 0 || stats.open > 0 || stats.resolved90d > 0) {
    lines.push(`- Open ${stats.open} · ${record}`);
    lines.push('- Statuses reflect one observation per brief (~12 h apart), not the intraday path.');
  }
  return lines;
}

export function renderBrief(view: BriefView, nowMs: number): string {
  const dayAgo = new Date(nowMs - 86_400_000).toISOString();
  const out: string[] = [];
  const header = view.fresh && view.cur
    ? `provenance · ${view.date} · full run ${view.cur.startedAt} (${view.cur.status}) · ${view.tokenCount} tokens, ${view.alerts.length} alerts`
    : `provenance · ${view.date} · today's full run hasn't landed (latest: ${view.latest ? `${view.latest.startedAt}, ${view.latest.status}` : 'none'}) · watchlist and alerts only · ${view.alerts.length} alerts`;
  out.push(header);
  const btc = view.btc.state
    ? `BTC ${view.btc.state}${view.btc.since ? ` since ${view.btc.since}` : ''}${view.btc.stale ? ' (stale)' : ''}`
    : `BTC n/a (${view.btc.gap ?? 'no data'})`;
  out.push(`Regime: meme ${view.meme.label} (${view.meme.score >= 0 ? '+' : ''}${view.meme.score}) · ${btc}`);
  if (view.llm?.headline) out.push(`Read: ${view.llm.headline}`);

  const blocks: [string, string[]][] = [];
  if (view.fresh && view.notable.length > 0) {
    const reads = new Map((view.llm?.tokens ?? []).map((read) => [read.token_id, read]));
    blocks.push(['Tokens', view.notable.flatMap((token) => tokenLines(token, reads.get(token.row.tokenId)))]);
  }
  const watch = [...watchLines(view.watch, dayAgo), ...(view.llm?.watchlist ?? []).slice(0, 3).map((line) => `  · ${line}`)];
  if (watch.length > 0) blocks.push(['Watchlist', watch]);
  const track = trackRecordLine(view.track);
  if (track) blocks.push(['Lane track record', [track, ...(view.llm?.track_record ? [`  · ${view.llm.track_record}`] : [])]]);
  if (view.fresh && view.clusters.length > 0) {
    blocks.push(['Clusters', [...view.clusters.map(clusterLine), ...(view.llm?.clusters ?? []).slice(0, 3).map((line) => `  · ${line}`)]]);
  }
  const setups = setupLines(view);
  if (setups.length > 0) blocks.push(['Setups', setups]);
  const pipeline = [...view.pipeline, ...(view.llm?.pipeline ?? []).slice(0, 3).map((line) => `note: ${line}`)].map((line) => `- ${line}`);
  if (pipeline.length > 0) blocks.push(['Pipeline', pipeline]);
  if (view.gaps.length > 0) blocks.push(['Data gaps', view.gaps.map((gap) => `- ${gap}`)]);

  for (const [title, lines] of blocks) out.push('', title, ...lines);
  if (blocks.length === 0) out.push('', 'Nothing changed in the last 24 h.');
  return out.join('\n');
}

/** Discord renders `markdown`; neutralise the characters it would read as formatting. */
export function discordSafe(text: string): string {
  return text.replace(/([\\*_~`|>])/g, '\\$1');
}

/** Length of a part as the longer of what Telegram (MarkdownV2) and Discord (embed) will receive. */
export function deliveredLength(text: string): number {
  return Math.max(escapeMarkdownV2(text).length, discordSafe(text).length);
}

/**
 * Budget per message, against `deliveredLength`, leaving room for the title
 * line under Telegram's 4096 and Discord's 4096-character embed description.
 */
export const MESSAGE_BUDGET = 3800;

/**
 * Splits on line boundaries so every part stays under `budget` once escaped
 * for either channel (escaping can double a line). A single line too long on its own
 * is cut hard.
 */
export function splitBrief(text: string, budget = MESSAGE_BUDGET, measure: (s: string) => number = deliveredLength): string[] {
  const parts: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim() !== '') parts.push(current.replace(/\n+$/, ''));
    current = '';
  };
  for (const raw of text.split('\n')) {
    let line = raw;
    while (measure(line) > budget) {
      let cut = line.length;
      while (cut > 1 && measure(line.slice(0, cut)) > budget) cut = Math.floor(cut * 0.9);
      push();
      parts.push(line.slice(0, cut));
      line = line.slice(cut);
    }
    const candidate = current === '' ? line : `${current}\n${line}`;
    if (measure(candidate) > budget) {
      push();
      current = line;
    } else current = candidate;
  }
  push();
  return parts;
}
