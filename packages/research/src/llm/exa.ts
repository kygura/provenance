/**
 * Exa as the search primitive for models without a good hosted search tool.
 *
 * The model gets one function, `web_search`, and the client runs it against
 * Exa. Two things make this better for the anchor question than a provider's
 * own search: results carry a `publishedDate`, and the query can be bounded
 * with `endPublishedDate`, which is exactly "find the earliest source about
 * this thing from before the token existed". And every URL the model saw is
 * known, so citations are the pages consulted, not URLs scraped from prose.
 */

import type { ToolSpec } from './types';
import type { FetchLike } from './openai';

export const EXA_BASE_URL = 'https://api.exa.ai';
export const EXA_TOOL_NAME = 'web_search';

export interface ExaSearchOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  /** Results per query. Each one costs context, so a handful is the sweet spot. */
  numResults?: number;
  /** Characters of page text handed back per result. */
  maxCharacters?: number;
  timeoutMs?: number;
}

export interface ExaQuery {
  query: string;
  /** ISO date: only pages published on or before it. */
  endPublishedDate?: string;
  /** ISO date: only pages published on or after it. */
  startPublishedDate?: string;
}

export interface ExaHit {
  title: string;
  url: string;
  publishedDate?: string;
  text: string;
}

export interface ExaReply {
  hits: ExaHit[];
  /** USD Exa billed for the call, when it says. */
  costUsd?: number;
}

/** The function the model calls. Dates are optional; the prompt says when to use them. */
export function exaTool(): ToolSpec {
  return {
    name: EXA_TOOL_NAME,
    description:
      'Search the web. Returns pages with their title, URL, publish date and an excerpt. ' +
      'Use end_published_date (YYYY-MM-DD) to find sources from before a given date, ' +
      'e.g. the earliest mention of a meme before a token launched.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for, in plain words.' },
        end_published_date: { type: 'string', description: 'Optional. Only pages published on or before this date.' },
        start_published_date: { type: 'string', description: 'Optional. Only pages published on or after this date.' },
      },
      required: ['query'],
    },
  };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

/** The model's arguments, validated. Undefined when there is no usable query. */
export function parseExaArgs(raw: string): ExaQuery | undefined {
  let args: unknown;
  try {
    args = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof args !== 'object' || args === null) return undefined;
  const record = args as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query.trim() : '';
  if (query === '') return undefined;
  const out: ExaQuery = { query: query.slice(0, 300) };
  const end = record.end_published_date;
  const start = record.start_published_date;
  if (typeof end === 'string' && ISO_DATE.test(end)) out.endPublishedDate = end.slice(0, 10);
  if (typeof start === 'string' && ISO_DATE.test(start)) out.startPublishedDate = start.slice(0, 10);
  return out;
}

export class ExaSearch {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: ExaSearchOptions) {
    this.baseUrl = (options.baseUrl ?? EXA_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async search(query: ExaQuery): Promise<ExaReply> {
    const body: Record<string, unknown> = {
      query: query.query,
      type: 'auto',
      numResults: this.options.numResults ?? 5,
      contents: { text: { maxCharacters: this.options.maxCharacters ?? 1200 } },
    };
    // Exa wants full timestamps; a day bound is read inclusively.
    if (query.endPublishedDate) body.endPublishedDate = `${query.endPublishedDate}T23:59:59.999Z`;
    if (query.startPublishedDate) body.startPublishedDate = `${query.startPublishedDate}T00:00:00.000Z`;

    const response = await this.fetchImpl(`${this.baseUrl}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.options.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`exa /search HTTP ${response.status}: ${detail}`);
    }
    const reply = (await response.json()) as {
      results?: Array<{ title?: unknown; url?: unknown; publishedDate?: unknown; text?: unknown }>;
      costDollars?: { total?: unknown };
    };
    const hits: ExaHit[] = [];
    for (const result of reply.results ?? []) {
      if (typeof result.url !== 'string' || result.url === '') continue;
      const hit: ExaHit = {
        title: typeof result.title === 'string' ? result.title : '',
        url: result.url,
        text: typeof result.text === 'string' ? result.text.replace(/\s+/g, ' ').trim() : '',
      };
      if (typeof result.publishedDate === 'string') hit.publishedDate = result.publishedDate.slice(0, 10);
      hits.push(hit);
    }
    const total = reply.costDollars?.total;
    return { hits, ...(typeof total === 'number' ? { costUsd: total } : {}) };
  }
}

/** What the model reads back: compact, one block per page, dates up front. */
export function formatExaHits(hits: readonly ExaHit[]): string {
  if (hits.length === 0) return 'No results.';
  return hits
    .map((hit, index) =>
      [`[${index + 1}] ${hit.title || '(untitled)'}`, hit.url, `published: ${hit.publishedDate ?? 'unknown'}`, hit.text]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');
}
