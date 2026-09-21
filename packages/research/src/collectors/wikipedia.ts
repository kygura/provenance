/**
 * Wikipedia is the single best free source for DATING a meme's cultural origin:
 * notable memes get an article, and that article states the year. It is also the
 * one source that reliably distinguishes the meme from the coin named after it
 * ("Doge (meme)" vs "Dogecoin"), which is exactly the confusion this project
 * exists to resolve.
 */
import type { EvidenceCollector, EvidenceItem, ResearchContext, TokenSnapshot } from '@provenance/core';
import { nowIso } from '@provenance/core';
import { HttpClient, type HttpClientOptions } from '../http';
import { cleanSnippet, quality } from '../evidence';
import { buildQueries } from '../queries';

const API = 'https://en.wikipedia.org/w/api.php';
const REST = 'https://en.wikipedia.org/api/rest_v1/page/summary';

export interface WikipediaSearchHit {
  title: string;
  pageid: number;
  snippet: string;
  timestamp?: string;
}

interface WikipediaSearchResponse {
  query?: { search?: unknown };
}

interface WikipediaSummaryResponse {
  title?: unknown;
  description?: unknown;
  extract?: unknown;
  timestamp?: unknown;
  type?: unknown;
  content_urls?: { desktop?: { page?: unknown } };
}

export function searchUrl(query: string): string {
  const params = new URLSearchParams({
    action: 'query',
    list: 'search',
    srsearch: query,
    srlimit: '5',
    format: 'json',
    origin: '*',
  });
  return `${API}?${params.toString()}`;
}

export function summaryUrl(title: string): string {
  return `${REST}/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

/** Parse the `list=search` payload. Never throws; bad rows are dropped. */
export function parseWikipediaSearch(raw: unknown): WikipediaSearchHit[] {
  const body = raw as WikipediaSearchResponse | null;
  const rows = body?.query?.search;
  if (!Array.isArray(rows)) return [];
  const hits: WikipediaSearchHit[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    const title = typeof record.title === 'string' ? record.title.trim() : '';
    if (title.length === 0) continue;
    hits.push({
      title,
      pageid: typeof record.pageid === 'number' ? record.pageid : 0,
      snippet: cleanSnippet(typeof record.snippet === 'string' ? record.snippet : ''),
      timestamp: typeof record.timestamp === 'string' ? record.timestamp : undefined,
    });
  }
  return hits;
}

/**
 * An article whose title or extract talks about the meme itself outranks one
 * that merely mentions the token — the whole point is to date the culture, not
 * the listing.
 */
function summaryQuality(title: string, extract: string, type: string): number {
  if (type === 'disambiguation') return 0.4;
  const haystack = `${title} ${extract}`.toLowerCase();
  let score = 0.72;
  if (/\bmeme\b|internet phenomenon|viral/.test(haystack)) score += 0.16;
  if (/\b(19|20)\d{2}\b/.test(extract)) score += 0.05;
  if (/\bcryptocurrency\b|\btoken\b/.test(title.toLowerCase())) score -= 0.08;
  if (extract.length < 120) score -= 0.15;
  return quality(score);
}

/** Parse `/page/summary/{title}` into a single evidence item, or null. */
export function parseWikipediaSummary(raw: unknown, retrievedAt = nowIso()): EvidenceItem | null {
  const body = raw as WikipediaSummaryResponse | null;
  if (typeof body !== 'object' || body === null) return null;
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const extract = typeof body.extract === 'string' ? body.extract.trim() : '';
  if (title.length === 0 || extract.length === 0) return null;
  const description = typeof body.description === 'string' ? body.description : '';
  const page = body.content_urls?.desktop?.page;
  const type = typeof body.type === 'string' ? body.type : 'standard';

  return {
    kind: 'wiki',
    url: typeof page === 'string' ? page : summaryUrl(title),
    title: description.length > 0 ? `${title} — ${description}` : title,
    snippet: cleanSnippet(extract),
    // Wikipedia's `timestamp` is the last revision, NOT the subject's date, so
    // it is deliberately not mapped onto publishedAt: doing so would hand the
    // model a 2025 date for a 2013 meme.
    retrievedAt,
    sourceQuality: summaryQuality(title, extract, type),
  };
}

export class WikipediaCollector implements EvidenceCollector {
  readonly id = 'wikipedia';
  private readonly http: HttpClient;

  constructor(options: HttpClientOptions = {}) {
    this.http = new HttpClient({ rateLimitMs: 1200, accept: 'application/json', ...options });
  }

  async collect(snapshot: TokenSnapshot, ctx: ResearchContext): Promise<EvidenceItem[]> {
    const log = ctx.logger.child('wikipedia');
    const queries = buildQueries(snapshot);
    if (queries.degraded) {
      log.debug('skipping: no usable meme subject', { tokenId: snapshot.tokenId });
      return [];
    }

    const out: EvidenceItem[] = [];
    // One search is enough: Wikipedia's own relevance ranking beats us issuing
    // three near-identical queries and burning the rate limit.
    const term = `${queries.subject} meme`;
    let hits: WikipediaSearchHit[] = [];
    try {
      hits = parseWikipediaSearch(await this.http.json(searchUrl(term), ctx));
    } catch (error) {
      log.warn('search failed', { term, error: String(error) });
      return [];
    }

    for (const hit of hits.slice(0, 3)) {
      try {
        const item = parseWikipediaSummary(await this.http.json(summaryUrl(hit.title), ctx));
        if (item) out.push(item);
      } catch (error) {
        log.debug('summary failed', { title: hit.title, error: String(error) });
        // Fall back to the search snippet: weaker, but still dated prose.
        if (hit.snippet.length > 0) {
          out.push({
            kind: 'wiki',
            url: `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
            title: hit.title,
            snippet: hit.snippet,
            retrievedAt: nowIso(),
            sourceQuality: quality(0.55),
          });
        }
      }
    }
    return out;
  }
}
