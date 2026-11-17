// Fires the two pipeline lanes on time. GitHub's own `schedule` trigger is
// best-effort and delivered about one launch-lane run in eight (Oct 2026);
// a `repository_dispatch` starts a run within seconds. Each lane still
// guards itself: the full run asks the cadence gate, and both share the
// `provenance-run` concurrency group, so an extra tick queues instead of
// overlapping. See README.md for setup.

const EVENTS = {
  // Keep in sync with `triggers.crons` in wrangler.toml.
  // Every 30 minutes at :15 and :45, off the full run's :00 slots so the two
  // don't queue on the shared concurrency group. About 48 Actions minutes a
  // day on a private repo (a run bills a minute); LAUNCHES_LOOKBACK_HOURS
  // (default 6) still covers every block between ticks.
  '15,45 * * * *': 'launches',
  // The cadence gate's base and elevated slots (06:00 anchor, every 4 h).
  // An hourly tick only matters at peak, which auto mode can't reach until
  // LLM_MAX_COST_USD_PER_DAY is set; the other 18 ticks were gate-only runs
  // billed a minute each. Go back to '0 * * * *' if you enable peak.
  '0 2,6,10,14,18,22 * * *': 'full-run',
};

async function dispatch(env, eventType) {
  const res = await fetch(`https://api.github.com/repos/${env.REPO}/dispatches`, {
    method: 'POST',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'user-agent': 'provenance-cron-trigger',
      'x-github-api-version': '2022-11-28',
    },
    body: JSON.stringify({ event_type: eventType }),
  });
  // 204 is success. Anything else is logged with the body, never the token.
  if (res.status !== 204) {
    throw new Error(`dispatch ${eventType} failed: ${res.status} ${await res.text()}`);
  }
}

export default {
  async scheduled(event, env, ctx) {
    const eventType = EVENTS[event.cron];
    if (!eventType) throw new Error(`no event for cron ${event.cron}`);
    ctx.waitUntil(dispatch(env, eventType));
  },
};
