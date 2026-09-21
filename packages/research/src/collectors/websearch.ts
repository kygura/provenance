/**
 * DuckDuckGo's HTML endpoint is the only keyless general web search left that
 * returns parseable results. It is the catch-all: anything the meme corpora miss
 * (a news article about a prior token cycle, a blog post dating the meme) shows
 * up here.
 *
 * Its markup changes without notice, so every selector lives in DDG_SELECTORS
 * with fallbacks, and a page that parses to nothing returns [] rather than
 * failing the run.
 */
import * as cheerio from 'cheerio';
import type { EvidenceCollector, EvidenceItem, ResearchContext, TokenSnapshot } from '@provenance/core';
import { nowIso } from '@provenance/core';
import { HttpClient, type HttpClientOptions } from '../http';
import { cleanSnippet, quality } from '../evidence';
import { buildQueries } from '../queries';

export const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/';

/**
 * All DOM assumptions in one table. `result` scopes a row; `link`/`snippet` are
 * tried in order inside it. When DDG redesigns, this object is the entire fix.
 */
export const DDG_SELECTORS = {
  result: ['div.result', 'div.web-result', 'div.results_links'],
  link: ['a.result__a', 'h2.result__title a', 'a[href*="uddg="]'],
  snippet: ['a.result__snippet', '.result__snippet', '.result__body'],
  /** Rows matching any of these are adverts, not evidence. */
  adMarkers: ['result--ad', 'results--ad', 'badge--ad'],
} as const;

export function ddgSearchUrl(query: string): string {
  return `${DDG_ENDPOINT}?q=${encodeURIComponent(query)}`;
}

/**
 * DDG wraps outbound links as `//duckduckgo.com/l/?uddg=<encoded>&rut=...`.
 * Unwrapping is mandatory: the wrapper URL is useless as a citation and breaks
 * dedupe, since two wrappers for the same page differ in `rut`.
 */
export function unwrapDdgUrl(href: string): string | null {
  if (href.length === 0) return null;
  const absolute = href.startsWith('//') ? `https:${href}` : href;
  try {
    const url = new URL(absolute, DDG_ENDPOINT);
    const target = url.searchParams.get('uddg');
    if (target !== null && target.length > 0) return decodeURIComponent(target);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (/(^|\.)duckduckgo\.com$/i.test(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Domains whose provenance claims we trust more than a random blog. */
function domainQuality(url: string): number {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return 0.4;
  }
  if (host === 'en.wikipedia.org' || host.endsWith('.wikipedia.org')) return 0.72;
  if (host === 'knowyourmeme.com') return 0.7;
  if (/^(reuters|apnews|bbc|theguardian|nytimes|wired|theverge|arstechnica)\.com$/.test(host)) return 0.6;
  if (/^(coindesk|cointelegraph|decrypt|theblock|dlnews)\.(com|co)$/.test(host)) return 0.55;
  if (/(^|\.)reddit\.com$/.test(host)) return 0.45;
  if (/(^|\.)(medium|substack|blogspot|wordpress)\.com$/.test(host)) return 0.35;
  return 0.42;
}

/** Parse a DDG HTML results page. Tolerates missing snippets and ad rows. */
export function parseDdgResults(html: string, retrievedAt = nowIso()): EvidenceItem[] {
  const $ = cheerio.load(html);
  const items: EvidenceItem[] = [];

  const rowSelector = DDG_SELECTORS.result.find((selector) => $(selector).length > 0);
  if (rowSelector === undefined) return items;

  $(rowSelector).each((_, element) => {
    const row = $(element);
    const className = row.attr('class') ?? '';
    if (DDG_SELECTORS.adMarkers.some((marker) => className.includes(marker))) return;

    let href: string | undefined;
    let title = '';
    for (const selector of DDG_SELECTORS.link) {
      const anchor = row.find(selector).first();
      if (anchor.length === 0) continue;
      href = anchor.attr('href');
      title = cleanSnippet(anchor.text(), 200);
      if (href !== undefined) break;
    }
    const url = href === undefined ? null : unwrapDdgUrl(href);
    if (url === null || title.length === 0) return;

    let snippet = '';
    for (const selector of DDG_SELECTORS.snippet) {
      const node = row.find(selector).first();
      if (node.length === 0) continue;
      snippet = cleanSnippet(node.html() ?? node.text(), 700);
      if (snippet.length > 0) break;
    }

    items.push({
      kind: 'web',
      url,
      title,
      snippet: snippet.length > 0 ? snippet : title,
      retrievedAt,
      sourceQuality: quality(domainQuality(url)),
    });
  });

  return items;
}

export class WebSearchCollector implements EvidenceCollector {
  readonly id = 'websearch';
  private readonly http: HttpClient;
  private readonly maxQueries: number;

  constructor(options: HttpClientOptions & { maxQueries?: number } = {}) {
    const { maxQueries, ...http } = options;
    this.maxQueries = maxQueries ?? 3;
    this.http = new HttpClient({ rateLimitMs: 3000, ...http });
  }

  async collect(snapshot: TokenSnapshot, ctx: ResearchContext): Promise<EvidenceItem[]> {
    const log = ctx.logger.child('websearch');
    const queries = buildQueries(snapshot);
    if (queries.degraded) return [];

    // One origin query plus the prior-tokenisation queries: this collector
    // exists mainly to surface EARLIER runs of the same meme.
    const plan = [
      queries.meme[0],
      queries.priorTokenisations[0],
      queries.priorTokenisations[1],
      queries.meme[1],
    ].filter((q): q is string => typeof q === 'string' && q.length > 0);

    const out: EvidenceItem[] = [];
    for (const query of plan.slice(0, this.maxQueries)) {
      try {
        const html = await this.http.text(ddgSearchUrl(query), ctx);
        const parsed = parseDdgResults(html);
        if (parsed.length === 0) {
          log.debug('no results parsed — selectors may have rotted', { query });
        }
        out.push(...parsed.slice(0, 6));
      } catch (error) {
        log.debug('search failed', { query, error: String(error) });
      }
    }
    return out;
  }
}
