// Fires the two pipeline lanes on time. GitHub's own `schedule` trigger is
// best-effort and delivered about one launch-lane run in eight (Oct 2026);
// a `repository_dispatch` starts a run within seconds. Each lane still
// guards itself: the full run asks the cadence gate, and both share the
// `provenance-run` concurrency group, so an extra tick queues instead of
// overlapping. See README.md for setup.

const EVENTS = {
  // Keep in sync with `triggers.crons` in wrangler.toml.
  '*/15 * * * *': 'launches',
  '0 * * * *': 'full-run',
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
