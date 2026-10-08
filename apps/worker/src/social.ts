/**
 * The social step: crypto-social sightings as the launch lane's yardstick.
 *
 * Provenance judges a meme at its first pool. Whether that is early is a
 * question about the crowd: did crypto-social find the token after we judged
 * it, or was it already being passed around? Elfa's trending contract-address
 * feeds answer it, matched by exact address rather than by ticker.
 *
 * None of this feeds a verdict or a score. It records one number per watchlist
 * entry, `socialLeadHours`, so the lane's lead over the crowd can be measured
 * instead of assumed.
 *
 * Two steps, called from `runPipeline`:
 *   collect    throttled fetch of the feeds → `social_sightings`
 *   reconcile  watchlist entries with no sighting yet → first sighting + lead
 *
 * Collect runs before the launch lane and reconcile after it, so a launch
 * catalogued this run is matched against sightings that predate it: a negative
 * lead, which is the case that most needs recording.
 */
import {
  type AppConfig,
  type Logger,
  type ProvenanceStore,
  type RunStats,
  type SocialStats,
  type WatchEntry,
  hoursBetween,
  nowIso,
} from '@provenance/core';
import type { PipelineDeps } from './deps';

/**
 * Error sources the social step records: its own, and the `elfa:<platform>`
 * entries `fetchSocialTrending` returns. A run is never `failed` because of
 * them; the step measures the pipeline, it is not its output.
 */
export function isSocialSource(source: string): boolean {
  return source === 'social' || source.startsWith('elfa:');
}

export function emptySocialStats(): SocialStats {
  return { sightings: 0, newTokens: 0, matched: 0 };
}

/**
 * A run this close to the interval still fetches. GitHub's scheduler drifts by
 * minutes, so without slack a 2h interval on a 30-minute cron would mostly
 * fetch at 2.5h: a quarter fewer samples than the budget pays for.
 */
export const THROTTLE_SLACK_HOURS = 10 / 60;

/**
 * Runs are stateless GitHub Actions jobs, so the interval is measured from the
 * last run that recorded a fetch. The 30-minute lane keeps about 48 runs a day;
 * 200 covers any sensible interval with plenty to spare.
 */
async function lastFetchAt(store: ProvenanceStore): Promise<string | undefined> {
  let latest: string | undefined;
  for (const run of await store.listRuns(200)) {
    const at = run.stats.social?.fetchedAt;
    if (at && (!latest || at > latest)) latest = at;
  }
  return latest;
}

/**
 * Fetches the feeds when a key is set and the interval has passed, and records
 * every sighting. A fetch where every feed failed records no `fetchedAt`, so
 * the next run tries again; an unauthorised request costs no credits.
 */
export async function collectSocial(
  app: AppConfig,
  store: ProvenanceStore,
  deps: PipelineDeps,
  stats: RunStats,
  log: Logger,
): Promise<void> {
  const social = stats.social ?? emptySocialStats();
  stats.social = social;

  if (!app.social.elfaApiKey && !app.pipeline.useFixtures) {
    social.skipped = 'no-key';
    log.debug('social step off: no ELFA_API_KEY');
    return;
  }

  const last = await lastFetchAt(store);
  if (last && hoursBetween(last) < app.social.minIntervalHours - THROTTLE_SLACK_HOURS) {
    social.skipped = 'throttled';
    log.debug('social fetch throttled', { lastFetchAt: last, minIntervalHours: app.social.minIntervalHours });
    return;
  }

  const result = await deps.fetchSocialTrending(app, log);
  stats.sourceErrors.push(...result.errors);
  if (app.social.platforms.length > 0 && result.errors.length >= app.social.platforms.length) {
    log.warn('every social feed failed; retrying next run', { errors: result.errors.length });
    return;
  }

  const ids = [...new Set(result.sightings.map((sighting) => sighting.tokenId))];
  const known = new Set((await store.socialFirstSeen(ids)).map((row) => row.tokenId));
  await store.recordSocialSightings(result.sightings);
  social.fetchedAt = nowIso();
  social.sightings = result.sightings.length;
  social.newTokens = ids.filter((id) => !known.has(id)).length;
  log.info('social sightings recorded', { sightings: social.sightings, newTokens: social.newTokens });
}

/** Signed hours from `from` to `to`. `hoursBetween` is absolute; a lead is not. */
function signedHours(from: string, to: string): number {
  return Number(((Date.parse(to) - Date.parse(from)) / 3_600_000).toFixed(2));
}

/**
 * Gives each watchlist entry its first social sighting, once. Every status is
 * eligible: a dismissed (forced) token that the crowd picks up is exactly the
 * pairing worth having on record, as with `reconcileWatchlist`.
 */
export async function reconcileSocial(store: ProvenanceStore, stats: RunStats, log: Logger): Promise<void> {
  const social = stats.social ?? emptySocialStats();
  stats.social = social;
  if (social.skipped === 'no-key') return;

  const pending = (await store.listWatch({ limit: 5_000 })).filter((entry) => !entry.socialAt);
  if (pending.length === 0) return;
  const firsts = new Map((await store.socialFirstSeen(pending.map((entry) => entry.tokenId))).map((row) => [row.tokenId, row]));

  const at = nowIso();
  for (const entry of pending) {
    const first = firsts.get(entry.tokenId);
    if (!first) continue;
    const updated: WatchEntry = {
      ...entry,
      socialAt: first.firstSeenAt,
      socialLeadHours: signedHours(entry.firstSeenAt, first.firstSeenAt),
      socialOn: first.platforms,
      updatedAt: at,
    };
    try {
      await store.saveWatch(updated);
      social.matched += 1;
      log.info('watchlisted token reached crypto-social', {
        tokenId: entry.tokenId,
        leadHours: updated.socialLeadHours,
        on: updated.socialOn,
        verdict: entry.anchor.verdict,
      });
    } catch (error) {
      log.error('failed to record social sighting', {
        tokenId: entry.tokenId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
