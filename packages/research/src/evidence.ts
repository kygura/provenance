/**
 * Evidence hygiene: dedupe, rank, trim. The model's context is the scarce
 * resource, so what survives trimming decides what it can reason over — we keep
 * the highest-quality items, never the first-arrived ones.
 */
import type { EvidenceItem } from '@provenance/core';
import { clamp, truncate } from '@provenance/core';

/** Ceilings chosen so a full evidence pack stays well under a cheap prompt. */
export const MAX_EVIDENCE_ITEMS = 25;
export const MAX_EVIDENCE_CHARS = 30_000;
export const MAX_SNIPPET_CHARS = 1_400;

/** Tie-break order when two items have identical quality. */
const KIND_RANK: Record<EvidenceItem['kind'], number> = {
  wiki: 0,
  knowyourmeme: 1,
  news: 2,
  web: 3,
  reddit: 4,
  social: 5,
  onchain: 6,
  'model-knowledge': 7,
};

/** Tracking params make two identical pages look like two sources. */
const NOISE_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'ref', 'ref_src', 'source', 'fbclid', 'gclid', 'rut', 'ia', 'kl',
]);

export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    url.host = url.host.toLowerCase().replace(/^www\./, '');
    url.protocol = 'https:';
    for (const param of [...url.searchParams.keys()]) {
      if (NOISE_PARAMS.has(param.toLowerCase())) url.searchParams.delete(param);
    }
    let path = url.pathname.replace(/\/+$/, '');
    if (path === '') path = '/';
    url.pathname = path;
    return url.toString();
  } catch {
    return raw.trim().toLowerCase();
  }
}

function dedupeKey(item: EvidenceItem): string {
  if (item.url && item.url.trim().length > 0) return `url:${canonicalUrl(item.url)}`;
  return `t:${item.kind}:${item.title.trim().toLowerCase()}`;
}

/** Keeps the best-quality copy of each distinct source. */
export function dedupeEvidence(items: readonly EvidenceItem[]): EvidenceItem[] {
  const best = new Map<string, EvidenceItem>();
  for (const item of items) {
    const key = dedupeKey(item);
    const existing = best.get(key);
    if (existing === undefined) {
      best.set(key, item);
      continue;
    }
    // Same source seen twice: keep the higher-quality one, and if quality ties,
    // the one carrying more text.
    const better =
      item.sourceQuality > existing.sourceQuality ||
      (item.sourceQuality === existing.sourceQuality && item.snippet.length > existing.snippet.length);
    if (better) best.set(key, item);
  }
  return [...best.values()];
}

/** Highest quality first; kind priority then snippet length break ties. */
export function rankEvidence(items: readonly EvidenceItem[]): EvidenceItem[] {
  return [...items].sort((a, b) => {
    if (b.sourceQuality !== a.sourceQuality) return b.sourceQuality - a.sourceQuality;
    const kindDelta = (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9);
    if (kindDelta !== 0) return kindDelta;
    return b.snippet.length - a.snippet.length;
  });
}

export interface TrimOptions {
  maxItems?: number;
  maxChars?: number;
  maxSnippetChars?: number;
}

/**
 * Trim to budget, keeping the highest-quality items. Oversized snippets are
 * truncated rather than dropped: a long Wikipedia extract is still the best
 * evidence we have even at 1,400 characters.
 */
export function trimEvidence(items: readonly EvidenceItem[], options: TrimOptions = {}): EvidenceItem[] {
  const maxItems = options.maxItems ?? MAX_EVIDENCE_ITEMS;
  const maxChars = options.maxChars ?? MAX_EVIDENCE_CHARS;
  const maxSnippet = options.maxSnippetChars ?? MAX_SNIPPET_CHARS;

  const kept: EvidenceItem[] = [];
  let budget = maxChars;
  for (const item of rankEvidence(items)) {
    if (kept.length >= maxItems) break;
    const snippet = truncate(item.snippet, maxSnippet);
    const cost = snippet.length + item.title.length;
    if (cost > budget) {
      // Skip this one but keep scanning: a later, smaller item may still fit.
      if (budget <= 0) break;
      continue;
    }
    budget -= cost;
    kept.push({ ...item, snippet });
  }
  return kept;
}

/** dedupe -> rank -> trim, the pipeline every caller actually wants. */
export function normalizeEvidence(items: readonly EvidenceItem[], options: TrimOptions = {}): EvidenceItem[] {
  return trimEvidence(dedupeEvidence(items), options);
}

/** Collapse scraped HTML whitespace into something a prompt can read. */
export function cleanSnippet(raw: string, max = MAX_SNIPPET_CHARS): string {
  const text = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#3[49];/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(text, max);
}

/** Clamp a collector-assigned quality into the documented 0..1 range. */
export function quality(value: number): number {
  return Number(clamp(value, 0, 1).toFixed(3));
}
