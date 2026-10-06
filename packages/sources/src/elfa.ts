import {
  type AppConfig,
  type Logger,
  type SocialFetchResult,
  type SocialPlatform,
  type SocialSighting,
  normalizeChain,
  nowIso,
  tokenId,
} from '@provenance/core';

import { readJsonFixtures } from './fixtures';
import { JsonClient } from './http';
import { asArray, isRecord, toNumber } from './normalize';

export const ELFA_BASE_URL = 'https://api.elfa.ai';

/**
 * Elfa wants a window like `30m`, `4h` or `7d`. The window matches the fetch
 * interval, rounded up to whole hours, so back-to-back fetches overlap a
 * little rather than leave a gap. A skipped run widens nothing: the earliest
 * sighting is kept on upsert, so an overlap costs no accuracy.
 */
export function elfaTimeWindow(hours: number): string {
  return `${Math.max(1, Math.ceil(Number.isFinite(hours) ? hours : 1))}h`;
}

export interface ElfaParseResult {
  sightings: SocialSighting[];
  /** Rows dropped for a missing address or a chain we do not track. */
  skipped: number;
}

/**
 * Pure parser for `/v2/aggregations/trending-cas/{twitter,telegram}`, whose
 * body is `{ success, data: { data: [{ contractAddress, chain, mentionCount }] } }`.
 * Parses leniently, as Elfa asks: extra fields are ignored, and a bare array
 * at either level is accepted. Never throws.
 *
 * A contract on a chain we cannot name is dropped, not kept as `unknown`: the
 * token id would never match a watchlist entry, so the row could only add
 * noise to the new-token count.
 */
export function parseElfaTrendingCas(payload: unknown, platform: SocialPlatform, seenAt: string): ElfaParseResult {
  const outer = isRecord(payload) ? payload.data : payload;
  const rows = Array.isArray(outer) ? outer : isRecord(outer) ? asArray(outer.data) : [];

  const byToken = new Map<string, SocialSighting>();
  let skipped = 0;
  for (const row of rows) {
    if (!isRecord(row)) {
      skipped += 1;
      continue;
    }
    const address = typeof row.contractAddress === 'string' ? row.contractAddress.trim() : '';
    const chain = normalizeChain(typeof row.chain === 'string' ? row.chain : undefined);
    if (!address || chain === 'unknown') {
      skipped += 1;
      continue;
    }
    const id = tokenId(chain, address);
    const mentionCount = Math.max(0, Math.trunc(toNumber(row.mentionCount) ?? 0));
    const prior = byToken.get(id);
    if (prior && prior.mentionCount >= mentionCount) continue;
    byToken.set(id, { tokenId: id, chain, tokenAddress: address, platform, mentionCount, seenAt });
  }
  return { sightings: [...byToken.values()], skipped };
}

const FIXTURE_PLATFORM = /trending-cas-(twitter|telegram)\.json$/i;

async function fromFixtures(platforms: SocialPlatform[], seenAt: string): Promise<SocialSighting[]> {
  const out: SocialSighting[] = [];
  for (const file of await readJsonFixtures('elfa')) {
    const platform = FIXTURE_PLATFORM.exec(file.name)?.[1]?.toLowerCase() as SocialPlatform | undefined;
    if (!platform || !platforms.includes(platform)) continue;
    out.push(...parseElfaTrendingCas(file.data, platform, seenAt).sightings);
  }
  return out;
}

export interface SocialFetchOptions {
  baseUrl?: string;
  signal?: AbortSignal;
}

/**
 * One page of each enabled trending-CA feed, one credit each. Contract: never
 * throws. A feed that fails is an entry in `errors`; the other still counts.
 * The caller decides whether to fetch at all (key present, interval elapsed).
 */
export async function fetchSocialTrending(
  app: AppConfig,
  logger: Logger,
  options: SocialFetchOptions = {},
): Promise<SocialFetchResult> {
  const log = logger.child('elfa');
  const { social } = app;
  const seenAt = nowIso();

  if (app.pipeline.useFixtures) {
    const sightings = await fromFixtures(social.platforms, seenAt);
    log.info('social sightings from fixtures', { count: sightings.length });
    return { sightings, errors: [] };
  }
  if (!social.elfaApiKey) return { sightings: [], errors: [] };

  const client = new JsonClient({
    baseUrl: options.baseUrl ?? ELFA_BASE_URL,
    rateLimitMs: social.rateLimitMs,
    logger: log,
    headers: { 'x-elfa-api-key': social.elfaApiKey },
  });
  const query = new URLSearchParams({
    timeWindow: elfaTimeWindow(social.minIntervalHours),
    minMentions: String(Math.max(1, Math.trunc(social.minMentions))),
    pageSize: String(Math.max(1, Math.trunc(social.pageSize))),
    page: '1',
  });

  const sightings: SocialSighting[] = [];
  const errors: SocialFetchResult['errors'] = [];
  // Sequential on purpose: two requests, one limiter, and Elfa's per-minute cap.
  for (const platform of social.platforms) {
    try {
      const body = await client.getJson(`/v2/aggregations/trending-cas/${platform}?${query}`, options.signal);
      const parsed = parseElfaTrendingCas(body, platform, seenAt);
      sightings.push(...parsed.sightings);
      log.info('trending contracts fetched', { platform, rows: parsed.sightings.length, skipped: parsed.skipped });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ source: `elfa:${platform}`, error: message });
      log.warn('trending contracts failed', { platform, error: message });
    }
  }
  return { sightings, errors };
}
