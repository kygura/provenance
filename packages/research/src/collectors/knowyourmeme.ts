/**
 * Know Your Meme is the canonical corpus for meme provenance. Its entries carry
 * exactly the three things this project needs and nowhere else publishes
 * together: an origin YEAR in a structured field, an "Origin" section naming the
 * first appearance, and a "Spread" section that usually enumerates prior
 * revivals — including prior tokenisations.
 *
 * It is also a scraped HTML site, so every selector below is a guess that will
 * eventually rot. They live in ONE table, each with fallbacks, and a parse that
 * finds nothing returns [] rather than throwing.
 */
import * as cheerio from 'cheerio';
import type { EvidenceCollector, EvidenceItem, ResearchContext, TokenSnapshot } from '@provenance/core';
import { nowIso } from '@provenance/core';
import { HttpClient, type HttpClientOptions } from '../http';
import { cleanSnippet, quality } from '../evidence';
import { buildQueries } from '../queries';

export const KYM_ORIGIN = 'https://knowyourmeme.com';

/**
 * Every DOM assumption in one place. Each entry is tried in order; the first
 * that yields anything wins. Adding a fallback here is the whole fix when the
 * site redesigns.
 */
export const KYM_SELECTORS = {
  searchEntryLinks: ['td.entry-grid-body h2 a', 'td.entry-grid-body a.photo', 'a[href^="/memes/"]'],
  articleTitle: ['h1', 'meta[property="og:title"]', 'title'],
  articleBody: ['#entry_body .bodycopy', '.bodycopy', 'section#entry_body'],
  detailList: ['dl.info', 'aside dl', 'dl'],
} as const;

function firstMatch($: cheerio.CheerioAPI, selectors: readonly string[]): cheerio.Cheerio<never> | null {
  for (const selector of selectors) {
    const found = $(selector);
    if (found.length > 0) return found as unknown as cheerio.Cheerio<never>;
  }
  return null;
}

export interface KymSearchHit {
  title: string;
  path: string;
}

/** Entry links from a KYM search results page. Editorials are filtered out. */
export function parseKymSearch(html: string): KymSearchHit[] {
  const $ = cheerio.load(html);
  const hits: KymSearchHit[] = [];
  const seen = new Set<string>();
  for (const selector of KYM_SELECTORS.searchEntryLinks) {
    $(selector).each((_, element) => {
      const href = $(element).attr('href') ?? '';
      // Only real meme entries carry provenance; editorials and tag pages do not.
      if (!href.startsWith('/memes/') || href.startsWith('/memes/events')) return;
      const path = href.split('?')[0] ?? href;
      if (seen.has(path)) return;
      const title = cleanSnippet($(element).text() || $(element).attr('title') || '', 160);
      if (title.length === 0) return;
      seen.add(path);
      hits.push({ title, path });
    });
    if (hits.length > 0) break;
  }
  return hits;
}

export interface KymArticle {
  title: string;
  year?: number;
  originSite?: string;
  /** Heading -> prose, for the sections that carry provenance. */
  sections: { heading: string; body: string }[];
}

/** The `<dt>Year</dt><dd>2010</dd>` detail block is the highest-value field on the page. */
function parseDetails($: cheerio.CheerioAPI): { year?: number; originSite?: string } {
  const details: { year?: number; originSite?: string } = {};
  const list = firstMatch($, KYM_SELECTORS.detailList);
  if (!list) return details;
  const terms = (list as unknown as cheerio.Cheerio<never>).find('dt');
  terms.each((_, element) => {
    const label = $(element).text().trim().toLowerCase();
    const value = cleanSnippet($(element).next('dd').text(), 120);
    if (label === 'year') {
      const match = value.match(/(1[89]|20)\d{2}/);
      if (match) details.year = Number(match[0]);
    } else if (label === 'origin' && value.length > 0) {
      details.originSite = value;
    }
  });
  return details;
}

/** Sections we care about, in descending provenance value. */
const WANTED_SECTIONS = ['origin', 'about', 'spread', 'history', 'background', 'notable'];

export function parseKymArticle(html: string): KymArticle | null {
  const $ = cheerio.load(html);
  const titleNode = firstMatch($, KYM_SELECTORS.articleTitle);
  const rawTitle =
    (titleNode ? (titleNode as unknown as cheerio.Cheerio<never>).first().attr('content') : undefined) ??
    (titleNode ? (titleNode as unknown as cheerio.Cheerio<never>).first().text() : '');
  const title = cleanSnippet(rawTitle ?? '', 160).replace(/\s*\|\s*Know Your Meme\s*$/i, '');
  if (title.length === 0) return null;

  const body = firstMatch($, KYM_SELECTORS.articleBody);
  const sections: { heading: string; body: string }[] = [];
  if (body) {
    const scope = body as unknown as cheerio.Cheerio<never>;
    scope.find('h2, h3').each((_, element) => {
      const heading = cleanSnippet($(element).text(), 80);
      const key = heading.toLowerCase();
      if (!WANTED_SECTIONS.some((wanted) => key.includes(wanted))) return;
      // Collect prose up to the next heading.
      const paragraphs: string[] = [];
      let cursor = $(element).next();
      while (cursor.length > 0 && !['h2', 'h3'].includes((cursor.prop('tagName') ?? '').toLowerCase())) {
        const text = cleanSnippet(cursor.text(), 2_000);
        if (text.length > 0) paragraphs.push(text);
        cursor = cursor.next();
      }
      const prose = paragraphs.join(' ').trim();
      if (prose.length >= 40) sections.push({ heading, body: prose });
    });
  }

  const details = parseDetails($);
  const article: KymArticle = { title, sections };
  if (details.year !== undefined) article.year = details.year;
  if (details.originSite !== undefined) article.originSite = details.originSite;
  return article;
}

const SECTION_QUALITY: Record<string, number> = {
  origin: 0.88,
  about: 0.8,
  history: 0.82,
  background: 0.78,
  spread: 0.76,
  notable: 0.7,
};

/** Turn a parsed article into one evidence item per provenance-bearing section. */
export function kymArticleToEvidence(
  article: KymArticle,
  url: string,
  retrievedAt = nowIso(),
): EvidenceItem[] {
  const yearNote = article.year !== undefined ? ` [KYM year field: ${article.year}]` : '';
  const originNote = article.originSite !== undefined ? ` [KYM origin site: ${article.originSite}]` : '';

  const items = article.sections.map<EvidenceItem>((section) => {
    const key = section.heading.toLowerCase();
    const base = Object.entries(SECTION_QUALITY).find(([name]) => key.includes(name))?.[1] ?? 0.65;
    return {
      kind: 'knowyourmeme',
      url,
      title: `${article.title} — ${section.heading}`,
      snippet: `${section.body}${yearNote}${originNote}`,
      retrievedAt,
      sourceQuality: quality(base),
    };
  });

  // If the page had a structured year but no parseable prose (a redesign, or a
  // stub entry), the year alone is still worth handing to the model.
  if (items.length === 0 && article.year !== undefined) {
    items.push({
      kind: 'knowyourmeme',
      url,
      title: article.title,
      snippet: `Know Your Meme lists this entry with year ${article.year}.${originNote}`,
      retrievedAt,
      sourceQuality: quality(0.6),
    });
  }
  return items;
}

export class KnowYourMemeCollector implements EvidenceCollector {
  readonly id = 'knowyourmeme';
  private readonly http: HttpClient;

  constructor(options: HttpClientOptions = {}) {
    this.http = new HttpClient({ rateLimitMs: 2500, ...options });
  }

  async collect(snapshot: TokenSnapshot, ctx: ResearchContext): Promise<EvidenceItem[]> {
    const log = ctx.logger.child('knowyourmeme');
    const queries = buildQueries(snapshot);
    if (queries.degraded) return [];

    const searchHref = `${KYM_ORIGIN}/search?q=${encodeURIComponent(queries.subject)}`;
    let hits: KymSearchHit[] = [];
    try {
      hits = parseKymSearch(await this.http.text(searchHref, ctx));
    } catch (error) {
      log.warn('search failed', { subject: queries.subject, error: String(error) });
      return [];
    }
    if (hits.length === 0) {
      log.debug('no entries matched', { subject: queries.subject });
      return [];
    }

    const out: EvidenceItem[] = [];
    // Two entries is the right depth: the meme itself, and usually the coin
    // entry that names the prior tokenisation.
    for (const hit of hits.slice(0, 2)) {
      const url = `${KYM_ORIGIN}${hit.path}`;
      try {
        const article = parseKymArticle(await this.http.text(url, ctx));
        if (article) out.push(...kymArticleToEvidence(article, url));
      } catch (error) {
        log.debug('article fetch failed', { url, error: String(error) });
      }
    }
    return out;
  }
}
