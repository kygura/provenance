#!/usr/bin/env bun
// Runs the pipeline on a server (the Hetzner box, next to Hypertrade) in place of the GitHub Actions schedules.
//
//   bun run apps/worker/src/box/scheduler.ts      (from the repo root; ops/box/Dockerfile does this)
//
// Each job in schedule.ts fires at its UTC slots and runs its steps as `bun run apps/worker/src/cli.ts <args>`,
// the same commands the workflows ran: the launch lane every hour at :30, the full run on the 4-hour slots
// behind the cadence gate, the brief at 06:40 and 18:40. The launch lane and the full run never overlap (the
// later one waits, as on the shared concurrency group); a job never overlaps itself. The database stays in
// Turso (DATABASE_URL); the chain-read cache and the alert file live in PROVENANCE_DATA_DIR (./data), which
// belongs on a persistent volume.
//
// Env (all optional, beyond what the worker itself reads):
//   BOX_LAUNCHES_SLOTS, BOX_FULL_RUN_SLOTS, BOX_BRIEF_SLOTS   override a job's slots ("HH:MM" or "*:MM", UTC)
//   BOX_RUN_ON_START   comma-separated job names to run once at boot (e.g. "launches" for a first check)
//   BOX_DISABLE        comma-separated job names to leave off
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { JOBS, nextRun, parseSlots, type Job } from './schedule';

const CLI = 'apps/worker/src/cli.ts';
const dataDir = process.env.PROVENANCE_DATA_DIR || './data';
const heartbeatFile = join(dataDir, 'box-scheduler.json');
const list = (v: string | undefined) => new Set((v ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const disabled = list(process.env.BOX_DISABLE);
const onStart = list(process.env.BOX_RUN_ON_START);

let stopping = false;
const running = new Set<ReturnType<typeof Bun.spawn>>();
const locks = new Map<string, Promise<void>>();
const state: Record<string, { next?: string; last?: { at: string; result: string; seconds: number } }> = {};

const log = (msg: string) => console.log(`[${new Date().toISOString()}] ${msg}`);

function heartbeat() {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(heartbeatFile, JSON.stringify({ beat: new Date().toISOString(), jobs: state }));
  } catch (error) {
    log(`heartbeat: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Runs `fn` after every earlier holder of `name` is done. */
function withLock(name: string, fn: () => Promise<void>): Promise<void> {
  const prev = locks.get(name) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(name, next.catch(() => undefined));
  return next;
}

async function step(args: string[], deadline: number): Promise<number> {
  const child = Bun.spawn(['bun', 'run', CLI, ...args], { stdout: 'inherit', stderr: 'inherit', env: process.env });
  running.add(child);
  const timer = setTimeout(() => {
    log(`${args[0]}: past the job's time limit, stopping it`);
    child.kill();
  }, Math.max(1_000, deadline - Date.now()));
  const code = await child.exited;
  clearTimeout(timer);
  running.delete(child);
  return code;
}

async function runJob(job: Job): Promise<void> {
  const started = Date.now();
  const deadline = started + job.timeoutMinutes * 60_000;
  let result = 'ok';
  log(`${job.name}: start`);
  for (const s of job.steps) {
    if (stopping) {
      result = 'stopped';
      break;
    }
    const code = await step(s.args, deadline);
    if (s.skipOn?.includes(code)) {
      result = 'skipped (not due)';
      break;
    }
    if (code !== 0) {
      result = `failed: ${s.args[0]} exited ${code}`;
      break;
    }
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  state[job.name] = { ...state[job.name], last: { at: new Date(started).toISOString(), result, seconds } };
  log(`${job.name}: ${result} after ${seconds}s`);
  heartbeat();
}

async function loop(job: Job, slotsSpec: string): Promise<void> {
  const slots = parseSlots(slotsSpec);
  if (onStart.has(job.name)) await withLock(job.lock, () => runJob(job));
  while (!stopping) {
    const at = nextRun(Date.now(), slots);
    state[job.name] = { ...state[job.name], next: new Date(at).toISOString() };
    while (!stopping && Date.now() < at) await Bun.sleep(Math.min(30_000, at - Date.now()));
    if (stopping) break;
    await withLock(job.lock, () => runJob(job));
  }
}

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: stopping${running.size ? ' after the running step' : ''}`);
    if (running.size === 0) process.exit(0);
    // A step can take minutes; let the platform's own stop timeout decide, and pass the signal on.
    for (const child of running) child.kill('SIGTERM');
    const wait = setInterval(() => {
      if (running.size === 0) process.exit(0);
    }, 500);
    wait.unref?.();
  });
}

const jobs = JOBS.filter((j) => !disabled.has(j.name));
for (const job of jobs) log(`${job.name}: slots ${process.env[job.slotsEnv]?.trim() || job.slots} UTC, lock ${job.lock}`);
heartbeat();
setInterval(heartbeat, 60_000);
await Promise.all(jobs.map((job) => loop(job, process.env[job.slotsEnv]?.trim() || job.slots)));
process.exit(0);
