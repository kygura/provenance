import { describe, expect, test } from 'bun:test';
import { retry } from './util';

describe('retry', () => {
  test('minDelayMs holds the next attempt back for errors that ask for it', async () => {
    let calls = 0;
    const started = Date.now();
    const value = await retry(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error('429');
        return 'ok';
      },
      { attempts: 2, baseDelayMs: 1, minDelayMs: (error) => ((error as Error).message === '429' ? 150 : 0) },
    );
    expect(value).toBe('ok');
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
  });
});
