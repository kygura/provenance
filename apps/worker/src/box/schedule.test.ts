import { describe, expect, test } from 'bun:test';
import { CADENCE_NOT_DUE, JOBS, nextRun, parseSlots } from './schedule';
import { EXIT_NOT_DUE } from '../cli';

const at = (iso: string) => Date.parse(iso);
const job = (name: string) => {
  const found = JOBS.find((j) => j.name === name);
  if (!found) throw new Error(name);
  return found;
};

describe('parseSlots', () => {
  test('daily and hourly slots', () => {
    expect(parseSlots('06:40, 18:40')).toEqual([
      { hour: 6, minute: 40 },
      { hour: 18, minute: 40 },
    ]);
    expect(parseSlots('*:30')).toEqual([{ hour: null, minute: 30 }]);
  });
  test('rejects bad input', () => {
    expect(() => parseSlots('24:00')).toThrow();
    expect(() => parseSlots('6.40')).toThrow();
    expect(() => parseSlots(' , ')).toThrow();
  });
});

describe('nextRun', () => {
  test('hourly launch lane at :30', () => {
    const slots = parseSlots(job('launches').slots);
    expect(nextRun(at('2026-11-16T10:05:00Z'), slots)).toBe(at('2026-11-16T10:30:00Z'));
    expect(nextRun(at('2026-11-16T10:30:00Z'), slots)).toBe(at('2026-11-16T11:30:00Z'));
    expect(nextRun(at('2026-11-16T23:45:00Z'), slots)).toBe(at('2026-11-17T00:30:00Z'));
  });
  test('full run on the 4-hour slots, as provenance.yml', () => {
    const slots = parseSlots(job('full-run').slots);
    expect(nextRun(at('2026-11-16T06:00:00Z'), slots)).toBe(at('2026-11-16T10:00:00Z'));
    expect(nextRun(at('2026-11-16T22:01:00Z'), slots)).toBe(at('2026-11-17T02:00:00Z'));
  });
  test('brief at 06:40 and 18:40, as brief.yml', () => {
    const slots = parseSlots(job('brief').slots);
    expect(nextRun(at('2026-11-16T07:00:00Z'), slots)).toBe(at('2026-11-16T18:40:00Z'));
    expect(nextRun(at('2026-11-30T19:00:00Z'), slots)).toBe(at('2026-12-01T06:40:00Z'));
  });
});

describe('jobs', () => {
  test('the launch lane and the full run share a lock; the brief does not', () => {
    expect(job('launches').lock).toBe(job('full-run').lock);
    expect(job('brief').lock).not.toBe(job('full-run').lock);
  });
  test('the full run asks the cadence gate first and skips on its not-due code', () => {
    const [gate] = job('full-run').steps;
    expect(gate?.args).toEqual(['cadence', '--exit-code']);
    expect(gate?.skipOn).toEqual([CADENCE_NOT_DUE]);
    expect(CADENCE_NOT_DUE).toBe(EXIT_NOT_DUE);
  });
});
