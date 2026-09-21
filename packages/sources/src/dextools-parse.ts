import * as cheerio from 'cheerio';
import {
  type Chain,
  type MarketMetrics,
  type PairInfo,
  normalizeChain,
  nowIso,
} from '@provenance/core';

import { compactEnrichment, type EnrichedTrendingEntry } from './enrichment';
import {
  ageHoursFrom,
  cleanText,
  compactMetrics,
  isRecord,
  looksLikeAddress,
  parseMoney,
  toIso,
} from './normalize';

/**
 * DexTools ships no public API and no stable DOM, and its Angular build changes
 * shape without notice. Everything in this file is therefore written to be
 * *lenient*: it hunts for row-shaped data rather than asserting a schema, and a
 * row it cannot key by address is skipped instead of throwing.
 */

export interface DexToolsParseOptions {
  capturedAt?: string;
  /** Rank of the first row, so several chain pages concatenate cleanly. */
  startRank?: number;
  /** Chain of the page being parsed, used when rows carry no chain of their own. */
  chain?: Chain;
  now?: Date;
}

/** EVM numeric chain ids seen in DexTools payloads. */
const NUMERIC_CHAIN_IDS: Record<string, Chain> = {
  '1': 'ethereum',
  '56': 'bsc',
  '137': 'polygon',
  '8453': 'base',
  '42161': 'arbitrum',
  '43114': 'avalanche',
  '81457': 'blast',
};

/** Our canonical chain -> DexTools url slug. */
export const DEXTOOLS_CHAIN_SLUGS: Partial<Record<Chain, string>> = {
  ethereum: 'ether',
  solana: 'solana',
  base: 'base',
  bsc: 'bnb',
  arbitrum: 'arbitrum',
  polygon: 'polygon',
  avalanche: 'avalanche',
  blast: 'blast',
  ton: 'ton',
  sui: 'sui',
};

export function dextoolsSlugFor(chain: Chain): string | undefined {
  return DEXTOOLS_CHAIN_SLUGS[chain];
}

function normKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Breadth-first search for the first value under any of `candidates` that the
 * caller accepts. Shallow keys win over deep ones; within a level the candidate
 * order is the preference order.
 */
function deepGet(root: unknown, candidates: readonly string[], accept: (value: unknown) => boolean, maxDepth = 4): unknown {
  const wanted = candidates.map(normKey);
  const queue: { node: unknown; depth: number }[] = [{ node: root, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const { node, depth } = current;
    if (!isRecord(node)) continue;

    const entries = Object.entries(node);
    for (const want of wanted) {
      for (const [key, value] of entries) {
        if (normKey(key) === want && accept(value)) return value;
      }
    }
    if (depth >= maxDepth) continue;
    for (const [, value] of entries) {
      if (isRecord(value)) queue.push({ node: value, depth: depth + 1 });
    }
  }
  return undefined;
}

const acceptString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const acceptNumeric = (value: unknown): boolean => parseMoney(value) !== undefined;
const acceptIso = (value: unknown): boolean => toIso(value) !== undefined;

function pluckString(row: unknown, keys: readonly string[]): string | undefined {
  const found = deepGet(row, keys, acceptString);
  return typeof found === 'string' ? found.trim() : undefined;
}

function pluckAddress(row: unknown, keys: readonly string[]): string | undefined {
  const found = deepGet(row, keys, looksLikeAddress);
  return typeof found === 'string' ? found.trim() : undefined;
}

function pluckNumber(row: unknown, keys: readonly string[]): number | undefined {
  return parseMoney(deepGet(row, keys, acceptNumeric));
}

function pluckIso(row: unknown, keys: readonly string[]): string | undefined {
  return toIso(deepGet(row, keys, acceptIso));
}

const TOKEN_ADDRESS_KEYS = [
  'tokenAddress',
  'baseTokenAddress',
  'baseAddress',
  'mainToken',
  'tokenId',
  'token',
  'base',
  'contract',
  'address',
  'id',
] as const;

const PAIR_ADDRESS_KEYS = ['pairAddress', 'pairId', 'poolAddress', 'poolId', 'lpAddress', 'pair'] as const;
const SYMBOL_KEYS = ['symbol', 'tokenSymbol', 'baseSymbol', 'ticker'] as const;
const NAME_KEYS = ['name', 'tokenName', 'baseName', 'title'] as const;
const CHAIN_KEYS = ['chain', 'chainId', 'network', 'blockchain', 'chainSlug', 'chainName'] as const;

export function resolveDexToolsChain(row: unknown, fallback?: Chain): Chain {
  const raw = deepGet(row, CHAIN_KEYS, (value) => typeof value === 'string' || typeof value === 'number');
  if (typeof raw === 'number') return NUMERIC_CHAIN_IDS[String(raw)] ?? fallback ?? 'unknown';
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^[0-9]+$/.test(trimmed)) return NUMERIC_CHAIN_IDS[trimmed] ?? fallback ?? 'unknown';
    const normalized = normalizeChain(trimmed);
    if (normalized !== 'unknown') return normalized;
  }
  return fallback ?? 'unknown';
}

/** Does this object look like a hot-pairs row rather than config or chrome? */
function looksLikeRow(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const address = pluckAddress(value, TOKEN_ADDRESS_KEYS) ?? pluckAddress(value, PAIR_ADDRESS_KEYS);
  if (!address) return false;
  const hasIdentity = pluckString(value, SYMBOL_KEYS) !== undefined || pluckString(value, NAME_KEYS) !== undefined;
  const hasMetric =
    pluckNumber(value, ['price', 'priceUsd']) !== undefined ||
    pluckNumber(value, ['liquidity', 'liquidityUsd', 'reserve']) !== undefined ||
    pluckNumber(value, ['volume24h', 'volume', 'volume24']) !== undefined;
  return hasIdentity || hasMetric;
}

/**
 * Finds every array in the payload that plausibly holds trending rows, best
 * first. Exported so a future live capture can be inspected without a browser.
 */
export function collectRowArrays(payload: unknown, maxDepth = 6): unknown[][] {
  const found: { rows: unknown[]; score: number; depth: number }[] = [];
  const queue: { node: unknown; depth: number }[] = [{ node: payload, depth: 0 }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const { node, depth } = current;
    if (depth > maxDepth) continue;

    if (Array.isArray(node)) {
      const records = node.filter(isRecord);
      if (records.length > 0) {
        const hits = records.filter(looksLikeRow).length;
        const score = hits / records.length;
        if (score > 0) found.push({ rows: node, score, depth });
      }
      for (const item of node) {
        if (isRecord(item) || Array.isArray(item)) queue.push({ node: item, depth: depth + 1 });
      }
      continue;
    }
    if (isRecord(node)) {
      for (const value of Object.values(node)) {
        if (isRecord(value) || Array.isArray(value)) queue.push({ node: value, depth: depth + 1 });
      }
    }
  }

  return found
    .sort((a, b) => b.score - a.score || b.rows.length - a.rows.length || a.depth - b.depth)
    .map((entry) => entry.rows);
}

/** True when a captured XHR body is worth parsing. Cheap pre-filter for the driver. */
export function looksLikeDexToolsPayload(payload: unknown): boolean {
  return collectRowArrays(payload).length > 0;
}

function metricsFromRow(row: unknown, now: Date): MarketMetrics {
  const createdAt = pluckIso(row, [
    'creationTime',
    'createdAt',
    'creationDate',
    'pairCreatedAt',
    'firstSwapTimestamp',
    'poolCreatedAt',
  ]);
  const buys = pluckNumber(row, ['buys24h', 'buys', 'buyCount']);
  const sells = pluckNumber(row, ['sells24h', 'sells', 'sellCount']);

  return compactMetrics({
    priceUsd: pluckNumber(row, ['priceUsd', 'price', 'tokenPriceUsd', 'currentPrice']),
    priceNative: pluckNumber(row, ['priceChain', 'priceNative', 'priceEth']),
    fdvUsd: pluckNumber(row, ['fdv', 'fullyDilutedValuation', 'fdvUsd']),
    marketCapUsd: pluckNumber(row, ['marketCap', 'mcap', 'marketCapUsd']),
    liquidityUsd: pluckNumber(row, ['liquidity', 'liquidityUsd', 'reserve', 'totalLiquidity']),
    volume5mUsd: pluckNumber(row, ['volume5m', 'volumeM5']),
    volume1hUsd: pluckNumber(row, ['volume1h', 'volumeH1']),
    volume6hUsd: pluckNumber(row, ['volume6h', 'volumeH6']),
    volume24hUsd: pluckNumber(row, ['volume24h', 'volume', 'volumeH24', 'volumeUsd24h']),
    priceChange5m: pluckNumber(row, ['variation5m', 'priceChange5m']),
    priceChange1h: pluckNumber(row, ['variation1h', 'priceChange1h']),
    priceChange6h: pluckNumber(row, ['variation6h', 'priceChange6h']),
    priceChange24h: pluckNumber(row, ['variation24h', 'priceChange24h', 'change24h', 'variation']),
    txns24h: buys !== undefined || sells !== undefined ? { buys: buys ?? 0, sells: sells ?? 0 } : undefined,
    poolCreatedAt: createdAt,
    ageHours: ageHoursFrom(createdAt, now),
  });
}

/**
 * Pure parser (a): whatever JSON the DexTools frontend fetched -> entries.
 * The payload shape is a best guess, so the extraction is key-name driven and
 * survives renames of the wrapper objects around the rows.
 */
export function parseDexToolsXhr(payload: unknown, options: DexToolsParseOptions = {}): EnrichedTrendingEntry[] {
  const capturedAt = options.capturedAt ?? nowIso();
  const now = options.now ?? new Date(capturedAt);
  const arrays = collectRowArrays(payload);
  const rows = arrays[0];
  if (!rows) return [];

  const entries: EnrichedTrendingEntry[] = [];
  let rank = options.startRank ?? 1;

  for (const row of rows) {
    if (!isRecord(row)) continue;
    const tokenAddress = pluckAddress(row, TOKEN_ADDRESS_KEYS);
    if (!tokenAddress) continue;

    const chain = resolveDexToolsChain(row, options.chain);
    const pairAddress = pluckAddress(row, PAIR_ADDRESS_KEYS);
    const symbol = cleanText(pluckString(row, SYMBOL_KEYS), 40) ?? 'UNKNOWN';
    const name = cleanText(pluckString(row, NAME_KEYS), 120) ?? symbol;
    const metrics = metricsFromRow(row, now);
    const slug = dextoolsSlugFor(chain);
    const url = pairAddress && slug ? `https://www.dextools.io/app/en/${slug}/pair-explorer/${pairAddress}` : undefined;

    const pair: PairInfo | undefined = pairAddress
      ? {
          pairAddress,
          dexId: cleanText(pluckString(row, ['exchange', 'exchangeName', 'dex', 'dexId']), 60),
          quoteSymbol: cleanText(pluckString(row, ['quoteSymbol', 'sideTokenSymbol', 'pairSymbol']), 40),
          url,
          liquidityUsd: metrics.liquidityUsd,
          createdAt: metrics.poolCreatedAt,
        }
      : undefined;

    // DexTools often carries its own ordinal; trust it when present.
    const declaredRank = pluckNumber(row, ['rank', 'position', 'index']);
    const entry: EnrichedTrendingEntry = {
      source: 'dextools',
      rank: rank++,
      chain,
      tokenAddress,
      pairAddress,
      symbol,
      name,
      capturedAt,
      metrics,
      url,
      raw: row,
    };
    if (declaredRank !== undefined && declaredRank > 0 && Number.isInteger(declaredRank)) {
      entry.rank = declaredRank + (options.startRank ?? 1) - 1;
    }
    const enrichment = compactEnrichment({
      imageUrl: pluckString(row, ['logo', 'image', 'imageUrl', 'icon']),
      pairs: pair ? [pair] : undefined,
    });
    if (enrichment) entry.enrichment = enrichment;
    entries.push(entry);
  }

  return entries;
}

const HEADER_MATCHERS: { key: string; patterns: RegExp[] }[] = [
  { key: 'rank', patterns: [/^#$/, /^rank$/, /^pos/] },
  { key: 'token', patterns: [/token/, /^pair$/, /^name$/, /asset/] },
  { key: 'price', patterns: [/price/] },
  { key: 'change24h', patterns: [/variation/, /change/, /24h%/, /%$/] },
  { key: 'volume24h', patterns: [/volume/, /^vol/] },
  { key: 'liquidity', patterns: [/liquidity/, /pooled/, /reserve/] },
  { key: 'swaps', patterns: [/swaps/, /txns/, /trades/, /transactions/] },
  { key: 'age', patterns: [/age/, /created/] },
  { key: 'fdv', patterns: [/fdv/, /market ?cap/, /mcap/] },
];

function mapHeaders(labels: string[]): Record<string, number> {
  const map: Record<string, number> = {};
  labels.forEach((label, index) => {
    const text = label.toLowerCase().replace(/\s+/g, ' ').trim();
    if (text === '') return;
    for (const matcher of HEADER_MATCHERS) {
      if (map[matcher.key] !== undefined) continue;
      if (matcher.patterns.some((pattern) => pattern.test(text))) {
        map[matcher.key] = index;
        return;
      }
    }
  });
  return map;
}

function cellAt(cells: string[], map: Record<string, number>, key: string): string | undefined {
  const index = map[key];
  if (index === undefined) return undefined;
  return cells[index];
}

/**
 * Pure parser (b): the hot-pairs table DOM -> entries. Used only when no usable
 * XHR was intercepted. Column positions come from the header row when there is
 * one; the token address and chain come from the pair-explorer links, which have
 * been stable far longer than the class names.
 */
export function parseDexToolsHtml(html: string, options: DexToolsParseOptions = {}): EnrichedTrendingEntry[] {
  const capturedAt = options.capturedAt ?? nowIso();
  const now = options.now ?? new Date(capturedAt);
  if (typeof html !== 'string' || html.trim() === '') return [];

  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch {
    return [];
  }

  const headerLabels = $('thead th, [class*="datatable-header-cell"]')
    .toArray()
    .map((element) => $(element).text().replace(/\s+/g, ' ').trim());
  const headers = mapHeaders(headerLabels);

  let rows = $('tbody tr').toArray();
  if (rows.length === 0) rows = $('[class*="datatable-body-row"]').toArray();
  if (rows.length === 0) rows = $('tr').toArray().filter((element) => $(element).find('td').length > 0);

  const entries: EnrichedTrendingEntry[] = [];
  let rank = options.startRank ?? 1;

  for (const element of rows) {
    const row = $(element);
    let cellNodes = row.find('td').toArray();
    if (cellNodes.length === 0) cellNodes = row.find('[class*="datatable-body-cell"]').toArray();
    if (cellNodes.length === 0) continue;
    const cells = cellNodes.map((cell) => $(cell).text().replace(/\s+/g, ' ').trim());

    // The pair-explorer href is the most reliable identifier in the DOM.
    let pairAddress: string | undefined;
    let tokenAddress: string | undefined;
    let chainSlug: string | undefined;
    row.find('a[href]').each((_, anchor) => {
      const href = $(anchor).attr('href') ?? '';
      const pairMatch = /\/([^/]+)\/pair-explorer\/([^/?#]+)/.exec(href);
      if (pairMatch && pairMatch[1] && pairMatch[2]) {
        chainSlug ??= pairMatch[1];
        pairAddress ??= pairMatch[2];
      }
      const tokenMatch = /\/([^/]+)\/token(?:-explorer)?\/([^/?#]+)/.exec(href);
      if (tokenMatch && tokenMatch[1] && tokenMatch[2]) {
        chainSlug ??= tokenMatch[1];
        tokenAddress ??= tokenMatch[2];
      }
    });

    tokenAddress ??= row.attr('data-token-address') ?? row.attr('data-token') ?? undefined;
    pairAddress ??= row.attr('data-pair-address') ?? row.attr('data-pair') ?? undefined;
    chainSlug ??= row.attr('data-chain') ?? undefined;

    if (tokenAddress && !looksLikeAddress(tokenAddress)) tokenAddress = undefined;
    if (pairAddress && !looksLikeAddress(pairAddress)) pairAddress = undefined;
    // Without a token address the row cannot be keyed; the pair address is the
    // documented fallback so a scrape still produces something joinable.
    const address = tokenAddress ?? pairAddress;
    if (!address) continue;

    const chain = chainSlug ? normalizeChain(chainSlug) : (options.chain ?? 'unknown');

    const tokenCellIndex = headers.token ?? 0;
    const tokenCell = $(cellNodes[tokenCellIndex] ?? cellNodes[0]);
    const symbol =
      cleanText(tokenCell.find('[class*="symbol"], strong, b').first().text(), 40) ??
      cleanText(cells[tokenCellIndex]?.split(/[\/\n]/)[0], 40) ??
      'UNKNOWN';
    const name =
      cleanText(tokenCell.find('[class*="name"], small, .text-muted').first().text(), 120) ?? symbol;

    const swaps = parseMoney(cellAt(cells, headers, 'swaps'));
    const ageText = cellAt(cells, headers, 'age');
    const poolCreatedAt = toIso(tokenCell.attr('data-created') ?? row.attr('data-created'));

    const metrics: MarketMetrics = compactMetrics({
      priceUsd: parseMoney(cellAt(cells, headers, 'price')),
      priceChange24h: parseMoney(cellAt(cells, headers, 'change24h')),
      volume24hUsd: parseMoney(cellAt(cells, headers, 'volume24h')),
      liquidityUsd: parseMoney(cellAt(cells, headers, 'liquidity')),
      fdvUsd: parseMoney(cellAt(cells, headers, 'fdv')),
      // Only a total is rendered; split is unknown, so attribute it all to buys=0/sells=0
      // would be a lie — record it as the 24h txn total via buys and leave sells at 0.
      txns24h: swaps !== undefined ? { buys: swaps, sells: 0 } : undefined,
      poolCreatedAt,
      ageHours: poolCreatedAt ? ageHoursFrom(poolCreatedAt, now) : parseAgeText(ageText),
    });

    const declaredRank = parseMoney(cellAt(cells, headers, 'rank'));
    const slug = chainSlug ?? dextoolsSlugFor(chain);
    const url = pairAddress && slug ? `https://www.dextools.io/app/en/${slug}/pair-explorer/${pairAddress}` : undefined;

    const entry: EnrichedTrendingEntry = {
      source: 'dextools',
      rank: declaredRank !== undefined && Number.isInteger(declaredRank) && declaredRank > 0
        ? declaredRank + (options.startRank ?? 1) - 1
        : rank,
      chain,
      tokenAddress: address,
      pairAddress,
      symbol,
      name,
      capturedAt,
      metrics,
      url,
      raw: { cells, headerLabels },
    };
    rank++;

    if (pairAddress) {
      const enrichment = compactEnrichment({
        pairs: [
          {
            pairAddress,
            url,
            liquidityUsd: metrics.liquidityUsd,
            createdAt: metrics.poolCreatedAt,
          },
        ],
      });
      if (enrichment) entry.enrichment = enrichment;
    }
    entries.push(entry);
  }

  return entries;
}

/** "3h 20m", "2d", "45m" -> hours. Returns undefined for anything else. */
export function parseAgeText(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const matches = [...text.toLowerCase().matchAll(/([0-9]+(?:\.[0-9]+)?)\s*(mo|[dhms])/g)];
  if (matches.length === 0) return undefined;
  const unitHours: Record<string, number> = { mo: 730, d: 24, h: 1, m: 1 / 60, s: 1 / 3600 };
  let hours = 0;
  for (const match of matches) {
    const value = Number(match[1]);
    const unit = match[2];
    if (!Number.isFinite(value) || !unit) continue;
    hours += value * (unitHours[unit] ?? 0);
  }
  return hours > 0 ? hours : undefined;
}
