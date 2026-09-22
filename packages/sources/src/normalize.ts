import type { MarketMetrics, SocialLinks, TxnCounts } from '@provenance/core';

/** Narrowing helper: everything upstream is `unknown` until proven otherwise. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Upstreams are inconsistent about number vs numeric-string (GeckoTerminal sends
 * `"0.0000123"`, DexScreener sends `0.0000123`), so every numeric read goes
 * through here. Non-finite values become `undefined`, never 0 — a missing metric
 * must stay distinguishable from a genuine zero.
 */
export function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

const SUFFIXES: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 };

/**
 * Parses human-rendered numbers out of scraped DOM text: `$1.23M`, `1,234.5`,
 * `+12.4%`, `(2.1%)` for negatives, `-`/`N/A` for missing.
 */
export function parseMoney(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;

  let text = value.trim().toLowerCase();
  if (text === '' || text === '-' || text === '--' || text === 'n/a' || text === 'na') return undefined;

  let negative = false;
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith('-')) {
    negative = true;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }

  text = text.replace(/[$€£,\s]/g, '').replace(/%$/, '');
  const match = /^([0-9]*\.?[0-9]+)([kmbt])?$/.exec(text);
  if (!match || match[1] === undefined) return undefined;

  const base = Number(match[1]);
  if (!Number.isFinite(base)) return undefined;
  const suffix = match[2];
  const scaled = suffix ? base * (SUFFIXES[suffix] ?? 1) : base;
  return negative ? -scaled : scaled;
}

/**
 * Timestamps arrive as ISO strings (GeckoTerminal), epoch milliseconds
 * (DexScreener `pairCreatedAt`) or epoch seconds (some DexTools payloads).
 * Anything before 2000 or after now+1y is treated as a unit mix-up and dropped.
 */
export function toIso(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;

  let ms: number | undefined;
  if (typeof value === 'number' && Number.isFinite(value)) {
    ms = value > 1e11 ? value : value * 1000;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    if (/^[0-9]+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      ms = numeric > 1e11 ? numeric : numeric * 1000;
    } else {
      const parsed = Date.parse(trimmed);
      ms = Number.isFinite(parsed) ? parsed : undefined;
    }
  }

  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  if (ms < 946_684_800_000) return undefined; // < 2000-01-01
  if (ms > Date.now() + 365 * 86_400_000) return undefined;
  return new Date(ms).toISOString();
}

export function ageHoursFrom(iso: string | undefined, now: Date = new Date()): number | undefined {
  if (!iso) return undefined;
  const created = Date.parse(iso);
  if (!Number.isFinite(created)) return undefined;
  return Math.max(0, (now.getTime() - created) / 3_600_000);
}

/** `{buys, sells}` blocks appear under several key spellings across sources. */
export function toTxnCounts(value: unknown): TxnCounts | undefined {
  if (!isRecord(value)) return undefined;
  const buys = toNumber(value.buys ?? value.buyers ?? value.buy);
  const sells = toNumber(value.sells ?? value.sellers ?? value.sell);
  if (buys === undefined && sells === undefined) return undefined;
  return { buys: buys ?? 0, sells: sells ?? 0 };
}

const METRIC_KEYS: readonly (keyof MarketMetrics)[] = [
  'priceUsd',
  'priceNative',
  'fdvUsd',
  'marketCapUsd',
  'liquidityUsd',
  'liquidityBaseTokens',
  'volume5mUsd',
  'volume1hUsd',
  'volume6hUsd',
  'volume24hUsd',
  'priceChange5m',
  'priceChange1h',
  'priceChange6h',
  'priceChange24h',
  'txns5m',
  'txns1h',
  'txns6h',
  'txns24h',
  'uniqueBuyers24h',
  'uniqueSellers24h',
  'poolCreatedAt',
  'ageHours',
];

export function metricKeys(): readonly (keyof MarketMetrics)[] {
  return METRIC_KEYS;
}

/** Drops explicitly-undefined keys so `countDefined` and JSON output stay clean. */
export function compactMetrics(metrics: MarketMetrics): MarketMetrics {
  const out: Record<string, unknown> = {};
  for (const key of METRIC_KEYS) {
    const value = metrics[key];
    if (value !== undefined) out[key] = value;
  }
  return out as MarketMetrics;
}

/** How much of `MarketMetrics` a source actually filled in. Used as a merge tiebreak. */
export function countDefinedMetrics(metrics: MarketMetrics | undefined): number {
  if (!metrics) return 0;
  let count = 0;
  for (const key of METRIC_KEYS) {
    if (metrics[key] !== undefined) count++;
  }
  return count;
}

const SOCIAL_HOSTS: { key: Exclude<keyof SocialLinks, 'other'>; patterns: RegExp[] }[] = [
  { key: 'twitter', patterns: [/(^|\.)twitter\.com/i, /(^|\.)x\.com/i] },
  { key: 'telegram', patterns: [/(^|\.)t\.me/i, /(^|\.)telegram\.(me|org)/i] },
  { key: 'discord', patterns: [/(^|\.)discord\.(gg|com)/i] },
  { key: 'github', patterns: [/(^|\.)github\.com/i] },
  { key: 'docs', patterns: [/(^|\.)gitbook\.(io|com)/i, /\/docs(\/|$)/i] },
];

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Classifies a link into `SocialLinks`. The declared `type`/`label` wins when it
 * names a known channel; otherwise we fall back to the host, because DexScreener
 * regularly reports `type: "website"` for a Linktree and `type: null` for X links.
 */
export function classifySocial(
  socials: SocialLinks,
  url: string | undefined,
  type?: string | undefined,
  label?: string | undefined,
): SocialLinks {
  if (!url || typeof url !== 'string' || url.trim() === '') return socials;
  const clean = url.trim();
  const hint = `${type ?? ''} ${label ?? ''}`.toLowerCase();

  const assign = (key: Exclude<keyof SocialLinks, 'other'>): SocialLinks => {
    if (!socials[key]) socials[key] = clean;
    else if (socials[key] !== clean) socials.other = [...(socials.other ?? []), clean];
    return socials;
  };

  if (/twitter|\bx\b/.test(hint)) return assign('twitter');
  if (/telegram/.test(hint)) return assign('telegram');
  if (/discord/.test(hint)) return assign('discord');
  if (/github/.test(hint)) return assign('github');
  if (/docs|gitbook|whitepaper/.test(hint)) return assign('docs');

  const host = hostOf(clean);
  for (const entry of SOCIAL_HOSTS) {
    if (entry.patterns.some((pattern) => pattern.test(host) || pattern.test(clean))) {
      return assign(entry.key);
    }
  }

  if (/website|home|site/.test(hint)) return assign('website');
  if (!socials.website && host !== '') return assign('website');
  socials.other = [...(socials.other ?? []), clean];
  return socials;
}

/** Union of two social blocks; `a` wins on conflict, extras land in `other`. */
export function mergeSocials(a: SocialLinks, b: SocialLinks): SocialLinks {
  const out: SocialLinks = { ...a };
  const extras = new Set<string>([...(a.other ?? []), ...(b.other ?? [])]);
  for (const key of ['website', 'twitter', 'telegram', 'discord', 'github', 'docs'] as const) {
    const value = b[key];
    if (!value) continue;
    if (!out[key]) out[key] = value;
    else if (out[key] !== value) extras.add(value);
  }
  if (extras.size > 0) out.other = [...extras];
  else delete out.other;
  return out;
}

export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
export const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Cheap shape check used to tell a token address apart from an id or a slug. */
export function looksLikeAddress(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return EVM_ADDRESS_RE.test(trimmed) || SOLANA_ADDRESS_RE.test(trimmed);
}

export function cleanText(value: unknown, max = 600): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  if (text === '') return undefined;
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
