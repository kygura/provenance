// Pure helpers for the box scheduler (scheduler.ts): the jobs that used to be GitHub Actions workflows, their UTC
// slots, and when each runs next.
//
// A slot is "HH:MM" (once a day) or "*:MM" (every hour at that minute), always UTC.

export interface Step {
  /** Arguments for `bun run apps/worker/src/cli.ts`. */
  args: string[];
  /** Exit codes that end the job quietly, as a skip (the cadence gate's "not due"). */
  skipOn?: number[];
}

export interface Job {
  name: string;
  /** Env var that can override the slots. */
  slotsEnv: string;
  slots: string;
  /** Jobs sharing a lock never run at the same time; the later one waits. */
  lock: string;
  timeoutMinutes: number;
  steps: Step[];
}

/** Same exit code as EXIT_NOT_DUE in cli.ts. */
export const CADENCE_NOT_DUE = 3;

/**
 * The three schedules from launches.yml, provenance.yml and brief.yml. The launch lane and the full run share
 * a lock, as they shared the `provenance-run` concurrency group: two runs judging the same new pool at once
 * would both pay for its research. The brief only reads pipeline tables, so it has its own.
 */
export const JOBS: Job[] = [
  {
    name: 'launches',
    slotsEnv: 'BOX_LAUNCHES_SLOTS',
    slots: '*:30',
    lock: 'run',
    timeoutMinutes: 20,
    steps: [{ args: ['migrate'] }, { args: ['run', '--lane', 'launches'] }],
  },
  {
    name: 'full-run',
    slotsEnv: 'BOX_FULL_RUN_SLOTS',
    slots: '02:00,06:00,10:00,14:00,18:00,22:00',
    lock: 'run',
    timeoutMinutes: 45,
    steps: [{ args: ['cadence', '--exit-code'], skipOn: [CADENCE_NOT_DUE] }, { args: ['migrate'] }, { args: ['run'] }],
  },
  {
    name: 'brief',
    slotsEnv: 'BOX_BRIEF_SLOTS',
    slots: '06:40,18:40',
    lock: 'brief',
    timeoutMinutes: 15,
    steps: [{ args: ['migrate'] }, { args: ['brief'] }],
  },
];

export interface Slot {
  /** null = every hour. */
  hour: number | null;
  minute: number;
}

export function parseSlots(spec: string): Slot[] {
  const slots: Slot[] = [];
  for (const raw of spec.split(',')) {
    const s = raw.trim();
    if (!s) continue;
    const m = /^(\*|\d{1,2}):(\d{2})$/.exec(s);
    const hour = m?.[1] === '*' ? null : Number(m?.[1]);
    const minute = Number(m?.[2]);
    if (!m || (hour !== null && hour > 23) || minute > 59) throw new Error(`slot "${s}" is not HH:MM or *:MM (UTC)`);
    slots.push({ hour, minute });
  }
  if (slots.length === 0) throw new Error('no slots');
  return slots;
}

/** The first slot strictly after `now` (ms since epoch). */
export function nextRun(now: number, slots: Slot[]): number {
  const d = new Date(now);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let best = Infinity;
  for (const slot of slots) {
    for (let day = 0; day <= 1; day++) {
      const hours = slot.hour === null ? Array.from({ length: 24 }, (_, h) => h) : [slot.hour];
      for (const h of hours) {
        const at = midnight + day * 86_400_000 + (h * 60 + slot.minute) * 60_000;
        if (at > now && at < best) best = at;
      }
    }
  }
  return best;
}
