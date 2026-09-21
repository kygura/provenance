/**
 * Reddit's keyless JSON search is the best free proxy for WHEN a meme peaked.
 * Post dates plus scores give the shape of attention over time, and that shape
 * is the evidence for the central claim: a meme with a high-scoring post in 2013
 * and another in 2021 has demonstrably worked twice, which is what makes a third
 * run a recycled narrative rather than a novel one.
 *
 * Reddit 429s the default runtime user agent, so this collector is useless
 * without HttpClient's UA header.
 */
import type { EvidenceCollector, EvidenceItem, ResearchContext, TokenSnapshot } from '@provenance/core';
import { clamp, nowIso } from '@provenance/core';
import { HttpClient, type HttpClientOptions } from '../http';
import { cleanSnippet, quality } from '../evidence';
import { buildQueries } from '../queries';

const ORIGIN = 'https://www.reddit.com';

export function redditSearchUrl(query: string, subreddit?: string): string {
  const params = new URLSearchParams({ q: query, sort: 'top', t: 'all', limit: '25' });
  if (subreddit !== undefined) {
    params.set('restrict_sr', '1');
    return `${ORIGIN}/r/${encodeURIComponent(subreddit)}/search.json?${params.toString()}`;
  }
  return `${ORIGIN}/search.json?${params.toString()}`;
}

/**
 * Score is the crowd's own quality signal, so it drives sourceQuality — but the
 * ceiling stays below Wikipedia/KYM because a popular post is still a post.
 * A 3-upvote shill thread must not outrank an encyclopedia entry.
 */
export function redditQuality(score: number, comments: number, subreddit: string): number {
  const base = 0.3 + Math.log10(Math.max(score, 0) + 1) * 0.07 + Math.log10(Math.max(comments, 0) + 1) * 0.02;
  // Explainer subs are where people document a meme's history rather than pump it.
  const contextual = /outoftheloop|askreddit|explainlikeimfive|memes|dankmemes/i.test(subreddit) ? 0.05 : 0;
  // Shill subs are evidence of tokenisation but not of culture.
  const promotional = /moonshot|satoshistreetbets|cryptomoonshots|pumps?$/i.test(subreddit) ? -0.06 : 0;
  return quality(clamp(base + contextual + promotional, 0.15, 0.68));
}

interface RedditChild {
  data?: unknown;
}

/** Parse a `search.json` listing. Malformed children are skipped, never thrown on. */
export function parseRedditSearch(raw: unknown, retrievedAt = nowIso()): EvidenceItem[] {
  const body = raw as { data?: { children?: unknown } } | null;
  const children = body?.data?.children;
  if (!Array.isArray(children)) return [];

  const items: EvidenceItem[] = [];
  for (const child of children as RedditChild[]) {
    const data = child?.data;
    if (typeof data !== 'object' || data === null) continue;
    const post = data as Record<string, unknown>;
    const title = typeof post.title === 'string' ? post.title.trim() : '';
    if (title.length === 0) continue;

    const subreddit = typeof post.subreddit === 'string' ? post.subreddit : 'unknown';
    const score = typeof post.score === 'number' ? post.score : 0;
    const comments = typeof post.num_comments === 'number' ? post.num_comments : 0;
    const createdUtc = typeof post.created_utc === 'number' ? post.created_utc : undefined;
    const permalink = typeof post.permalink === 'string' ? post.permalink : '';
    const selftext = typeof post.selftext === 'string' ? post.selftext : '';

    const publishedAt =
      createdUtc !== undefined && Number.isFinite(createdUtc)
        ? new Date(createdUtc * 1000).toISOString()
        : undefined;

    // The date and score are the evidence; the body is context. Both go into
    // the snippet because the model only reads the snippet.
    const parts = [`r/${subreddit} · ${score} upvotes · ${comments} comments`];
    if (publishedAt) parts.push(`posted ${publishedAt.slice(0, 10)}`);
    if (selftext.length > 0) parts.push(cleanSnippet(selftext, 600));

    items.push({
      kind: 'reddit',
      url: permalink.length > 0 ? `${ORIGIN}${permalink}` : undefined,
      title: cleanSnippet(title, 200),
      snippet: parts.join(' — '),
      publishedAt,
      retrievedAt,
      sourceQuality: redditQuality(score, comments, subreddit),
    });
  }
  return items;
}

export class RedditCollector implements EvidenceCollector {
  readonly id = 'reddit';
  private readonly http: HttpClient;

  constructor(options: HttpClientOptions = {}) {
    // Reddit's unauthenticated budget is tight; 2s between hits keeps it happy.
    this.http = new HttpClient({ rateLimitMs: 2000, accept: 'application/json', ...options });
  }

  async collect(snapshot: TokenSnapshot, ctx: ResearchContext): Promise<EvidenceItem[]> {
    const log = ctx.logger.child('reddit');
    const queries = buildQueries(snapshot);
    if (queries.degraded) return [];

    const plan: { url: string; label: string }[] = [
      { url: redditSearchUrl(`${queries.subject} meme`), label: 'global meme' },
      { url: redditSearchUrl(`${queries.subject} coin`), label: 'global token' },
    ];
    // One restricted search into the sub where people ask "what is this again?".
    const explainer = queries.subreddits[0];
    if (explainer !== undefined) {
      plan.push({ url: redditSearchUrl(queries.subject, explainer), label: `r/${explainer}` });
    }

    const out: EvidenceItem[] = [];
    for (const step of plan) {
      try {
        const items = parseRedditSearch(await this.http.json(step.url, ctx));
        // Top 6 per query: enough to see the shape of attention, not enough to
        // crowd out the encyclopedic sources at trim time.
        out.push(...items.slice(0, 6));
      } catch (error) {
        log.debug('search failed', { step: step.label, error: String(error) });
      }
    }
    return out;
  }
}
