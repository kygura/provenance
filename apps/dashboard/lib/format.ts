import { formatPct, formatUsd, shortAddress, truncate } from '@provenance/core';

export { formatPct, formatUsd, shortAddress, truncate };

/** Everything the UI prints when a value was never determined. */
export const NA = 'n/a';

/**
 * Token names, meme names and model prose are untrusted text pulled off the
 * internet. React escapes markup for us, but it happily renders control
 * characters and bidi overrides, which are the cheap way to spoof a ticker or
 * make a name overflow its cell. Strip them, collapse whitespace, and cap length.
 */
export function clean(value: unknown, max = 200): string {
  if (typeof value !== 'string') return '';
  const stripped = value
    // C0/C1 control characters, plus the bidi override and isolate family.
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > max ? truncate(stripped, max) : stripped;
}

/** Same sanitisation, but newlines survive so prose keeps its paragraphs. */
export function cleanProse(value: unknown, max = 4000): string {
  if (typeof value !== 'string') return '';
  const stripped = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return stripped.length > max ? truncate(stripped, max) : stripped;
}

/**
 * Only http(s) links are ever emitted. Evidence URLs come from a model and from
 * scraped pages, so `javascript:` and `data:` have to be impossible to reach.
 */
export function safeHref(url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  const trimmed = url.trim();
  if (trimmed === '') return undefined;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/** Host of a link, for showing where an evidence item actually came from. */
export function hostOf(url: string | undefined): string {
  if (url === undefined) return '';
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function formatCount(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NA;
  return Math.round(value).toLocaleString('en-US');
}

/** Percentages are 0-100 numbers everywhere in core; render them unsigned. */
export function formatPctPlain(value: unknown, digits = 1): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NA;
  return `${value.toFixed(digits)}%`;
}

/** 0..1 ratios (confidence, herfindahl, gini, sourceQuality). */
export function formatRatio(value: unknown, digits = 2): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NA;
  return value.toFixed(digits);
}

export function formatScore(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NA;
  return Math.round(value).toString();
}

/** A finite number or undefined — the guard every numeric render goes through. */
export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function formatDateTime(iso: unknown): string {
  const ms = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(ms)) return NA;
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

export function formatDate(iso: unknown): string {
  const ms = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(ms)) return NA;
  return new Date(ms).toISOString().slice(0, 10);
}

/** "3h 12m ago" — coarse on purpose; the exact stamp is in the title attribute. */
export function formatAgo(iso: unknown, now = Date.now()): string {
  const ms = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(ms)) return NA;
  const delta = now - ms;
  const future = delta < 0;
  const mins = Math.floor(Math.abs(delta) / 60_000);
  const body =
    mins < 1
      ? 'just now'
      : mins < 60
        ? `${mins}m`
        : mins < 60 * 48
          ? `${Math.floor(mins / 60)}h ${mins % 60}m`
          : `${Math.floor(mins / 1440)}d`;
  if (body === 'just now') return body;
  return future ? `in ${body}` : `${body} ago`;
}

export function formatDuration(ms: unknown): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return NA;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** LLM spend is small; $0.00 is a meaningful answer, undefined is not. */
export function formatCostUsd(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return NA;
  if (value === 0) return '$0.00';
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/**
 * The pipeline runs twice a day. Without a schedule in the store we infer the
 * next slot from the cadence rather than inventing a timestamp.
 */
export function nextRunEstimate(lastStartedAt: unknown): string {
  const ms = typeof lastStartedAt === 'string' ? Date.parse(lastStartedAt) : Number.NaN;
  if (!Number.isFinite(ms)) return NA;
  return formatDateTime(new Date(ms + 12 * 3_600_000).toISOString());
}
