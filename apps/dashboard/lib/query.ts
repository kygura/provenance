import {
  CHAINS,
  type DossierQuery,
  type TokenDossier,
} from '@provenance/core';
import { TIERS, VERDICTS } from './vocab';
import { num } from './format';

/** Next 15 hands page components a promise of this shape. */
export type SearchParams = Record<string, string | string[] | undefined>;

export const SORT_KEYS = [
  'score',
  'rank',
  'name',
  'mcap',
  'liq',
  'vol',
  'chg',
  'top10',
  'year',
] as const;

export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';

export interface TableQuery {
  runId?: string;
  chain?: string;
  tier?: string;
  verdict?: string;
  minScore?: number;
  search?: string;
  sort: SortKey;
  dir: SortDir;
}

function one(params: SearchParams, key: string): string | undefined {
  const raw = params[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Filters live in the URL so a filtered view is linkable, which means every value
 * arrives as untrusted text. Anything not in the known vocabulary is dropped
 * rather than passed to the store.
 */
export function parseQuery(params: SearchParams): TableQuery {
  const chain = one(params, 'chain');
  const tier = one(params, 'tier');
  const verdict = one(params, 'verdict');
  const minScoreRaw = one(params, 'minScore');
  const parsedMin = minScoreRaw === undefined ? Number.NaN : Number(minScoreRaw);
  const sortRaw = one(params, 'sort');
  const dirRaw = one(params, 'dir');

  const query: TableQuery = {
    sort: SORT_KEYS.includes(sortRaw as SortKey) ? (sortRaw as SortKey) : 'score',
    dir: dirRaw === 'asc' ? 'asc' : 'desc',
  };

  const runId = one(params, 'run');
  if (runId !== undefined) query.runId = runId;
  if (chain !== undefined && (CHAINS as readonly string[]).includes(chain)) query.chain = chain;
  if (tier !== undefined && (TIERS as readonly string[]).includes(tier)) query.tier = tier;
  if (verdict !== undefined && (VERDICTS as readonly string[]).includes(verdict)) {
    query.verdict = verdict;
  }
  if (Number.isFinite(parsedMin)) {
    query.minScore = Math.min(100, Math.max(0, Math.round(parsedMin)));
  }
  const search = one(params, 'q');
  if (search !== undefined) query.search = search.slice(0, 80);

  return query;
}

/** The subset of the table query the store understands. */
export function toDossierQuery(query: TableQuery): DossierQuery {
  const out: DossierQuery = { limit: 500 };
  if (query.runId !== undefined) out.runId = query.runId;
  if (query.chain !== undefined) out.chain = query.chain;
  if (query.tier !== undefined) out.tier = query.tier;
  if (query.verdict !== undefined) out.verdict = query.verdict;
  if (query.minScore !== undefined) out.minScore = query.minScore;
  if (query.search !== undefined) out.search = query.search;
  out.orderBy = query.sort === 'rank' ? 'rank' : 'score';
  return out;
}

/** Serialises a table query back to a query string, dropping defaults. */
export function toSearchString(query: TableQuery, overrides: Partial<TableQuery> = {}): string {
  const merged = { ...query, ...overrides };
  const params = new URLSearchParams();
  if (merged.runId !== undefined) params.set('run', merged.runId);
  if (merged.chain !== undefined) params.set('chain', merged.chain);
  if (merged.tier !== undefined) params.set('tier', merged.tier);
  if (merged.verdict !== undefined) params.set('verdict', merged.verdict);
  if (merged.minScore !== undefined && merged.minScore > 0) {
    params.set('minScore', String(merged.minScore));
  }
  if (merged.search !== undefined) params.set('q', merged.search);
  if (merged.sort !== 'score') params.set('sort', merged.sort);
  if (merged.dir !== 'desc') params.set('dir', merged.dir);
  const qs = params.toString();
  return qs === '' ? '' : `?${qs}`;
}

export function hasFilters(query: TableQuery): boolean {
  return (
    query.chain !== undefined ||
    query.tier !== undefined ||
    query.verdict !== undefined ||
    query.search !== undefined ||
    (query.minScore !== undefined && query.minScore > 0)
  );
}

/**
 * The same predicate the store is asked for, applied again locally.
 *
 * Belt and braces on purpose: the dashboard must show exactly what the URL says
 * even if the store widens a filter, and re-applying a filter that already
 * matched is free at the row counts a run produces (tens, not thousands).
 */
export function applyFilters(rows: readonly TokenDossier[], query: TableQuery): TokenDossier[] {
  const needle = query.search?.toLowerCase();
  return rows.filter((row) => {
    if (query.chain !== undefined && row.snapshot.chain !== query.chain) return false;
    if (query.tier !== undefined && row.score?.tier !== query.tier) return false;
    if (query.verdict !== undefined && row.provenance?.recycleVerdict !== query.verdict) {
      return false;
    }
    if (query.minScore !== undefined && query.minScore > 0) {
      const total = num(row.score?.total);
      if (total === undefined || total < query.minScore) return false;
    }
    if (needle !== undefined) {
      const haystack = [
        row.snapshot.symbol,
        row.snapshot.name,
        row.provenance?.memeName,
        row.provenance?.narrativeCluster,
        row.snapshot.tokenAddress,
      ]
        .filter((part): part is string => typeof part === 'string')
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

function sortValue(row: TokenDossier, key: SortKey): number | string | undefined {
  switch (key) {
    case 'score':
      return num(row.score?.total);
    case 'rank':
      return num(row.snapshot.bestRank);
    case 'name':
      return (row.snapshot.symbol || row.snapshot.name || '').toLowerCase();
    case 'mcap':
      return num(row.snapshot.metrics.marketCapUsd) ?? num(row.snapshot.metrics.fdvUsd);
    case 'liq':
      return num(row.snapshot.metrics.liquidityUsd);
    case 'vol':
      return num(row.snapshot.metrics.volume24hUsd);
    case 'chg':
      return num(row.snapshot.metrics.priceChange24h);
    case 'top10':
      return num(row.chain?.top10Pct);
    case 'year':
      return num(row.provenance?.originYear);
  }
}

/**
 * Sorting happens here rather than in SQL because three of the sortable columns
 * (market cap, 24h change, top-10 concentration) are not part of DossierQuery.
 * Rows with no value always sink to the bottom regardless of direction — an
 * unknown market cap is not "the smallest market cap".
 */
export function applySort(rows: readonly TokenDossier[], query: TableQuery): TokenDossier[] {
  const factor = query.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, query.sort);
    const bv = sortValue(b, query.sort);
    if (av === undefined && bv === undefined) return 0;
    if (av === undefined) return 1;
    if (bv === undefined) return -1;
    if (typeof av === 'string' || typeof bv === 'string') {
      return String(av).localeCompare(String(bv)) * factor;
    }
    if (av === bv) return 0;
    return (av < bv ? -1 : 1) * factor;
  });
}
