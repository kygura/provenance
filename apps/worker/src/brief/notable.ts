/**
 * CLAUDE.md §3.1, deterministic: which tokens of the current run the brief is
 * about. Severity first (rug risk, impostor), then size of change, capped.
 */
import type { AlertRow, DossierRow, VerdictRow } from './queries';

export const NOTABLE_CAP = 8;
export const SCORE_DELTA_POINTS = 10;
const SEVERE_RULES = ['rug-risk', 'canonical-impostor'];

export interface NotableToken {
  row: DossierRow;
  reasons: string[];
  /** Rule of a severe alert in the last 24 h, if any. */
  severe?: string;
  delta?: number;
  tierChanged: boolean;
  /** `old → new` for an anchor or recycle verdict that changed this run. */
  verdictChange?: string;
  newVerdict: boolean;
  magnitude: number;
}

/**
 * The verdict this run wrote against the one before it. `history` is query C
 * for the token (newest first); the newest row is this run's own when the
 * token was researched this run.
 */
export function verdictDelta(row: DossierRow, history: readonly VerdictRow[]): { change?: string; isNew: boolean } {
  if (!row.provenanceAt) return { isNew: false };
  const older = history.filter((item) => item.createdAt < row.provenanceAt!);
  const prev = older[0];
  if (!prev) return { isNew: true };
  const parts: string[] = [];
  if ((prev.anchorVerdict ?? 'none') !== (row.anchorVerdict ?? 'none') && row.anchorVerdict) {
    parts.push(`${prev.anchorVerdict ?? 'none'} → ${row.anchorVerdict}`);
  }
  if (prev.recycleVerdict && row.recycleVerdict && prev.recycleVerdict !== row.recycleVerdict) {
    parts.push(`${prev.recycleVerdict} → ${row.recycleVerdict}`);
  }
  return parts.length > 0 ? { change: parts.join(', '), isNew: false } : { isNew: false };
}

export function selectNotable(
  rows: readonly DossierRow[],
  alerts24h: readonly AlertRow[],
  verdicts: ReadonlyMap<string, readonly VerdictRow[]>,
  nowMs: number,
  cap = NOTABLE_CAP,
): NotableToken[] {
  const dayAgo = new Date(nowMs - 86_400_000).toISOString();
  const out: NotableToken[] = [];
  for (const row of rows) {
    const reasons: string[] = [];
    const tierChanged = row.prevTier !== undefined && row.tier !== undefined && row.prevTier !== row.tier;
    const delta = row.score !== undefined && row.prevScore !== undefined ? row.score - row.prevScore : undefined;
    const severe = alerts24h.find((alert) => alert.tokenId === row.tokenId && SEVERE_RULES.includes(alert.rule))?.rule;
    const { change, isNew } = verdictDelta(row, verdicts.get(row.tokenId) ?? []);
    const isNewToken = row.firstSeenAt >= dayAgo;

    if (row.tier === 'S' || row.tier === 'A') reasons.push(`tier ${row.tier}`);
    if (tierChanged) reasons.push(`tier ${row.prevTier} → ${row.tier}`);
    if (delta !== undefined && Math.abs(delta) >= SCORE_DELTA_POINTS) reasons.push(`score ${delta > 0 ? '+' : ''}${delta.toFixed(0)}`);
    if (isNewToken && row.tier !== undefined && ['S', 'A', 'B'].includes(row.tier)) reasons.push('new in 24 h, tier B+');
    if (change) reasons.push(`verdict ${change}`);
    else if (isNew) reasons.push('first verdict');
    if (severe) reasons.push(`${severe} alert`);
    if (reasons.length === 0) continue;

    const magnitude =
      Math.abs(delta ?? 0) +
      (tierChanged ? 10 : 0) +
      (change ? 15 : 0) +
      (isNew ? 3 : 0) +
      (row.tier === 'S' || row.tier === 'A' ? 5 : 0) +
      (isNewToken ? 5 : 0);
    out.push({
      row,
      reasons,
      ...(severe ? { severe } : {}),
      ...(delta !== undefined ? { delta } : {}),
      tierChanged,
      ...(change ? { verdictChange: change } : {}),
      newVerdict: isNew,
      magnitude,
    });
  }
  out.sort(
    (a, b) =>
      Number(Boolean(b.severe)) - Number(Boolean(a.severe)) ||
      b.magnitude - a.magnitude ||
      (b.row.score ?? -1) - (a.row.score ?? -1),
  );
  return out.slice(0, cap);
}
