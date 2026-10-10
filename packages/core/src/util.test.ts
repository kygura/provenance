import { describe, expect, test } from 'bun:test';
import { isFatalLlmError, retry } from './util';

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

describe('isFatalLlmError', () => {
  test('credit, auth and permission refusals are fatal for the run', () => {
    expect(isFatalLlmError('openrouter /chat/completions HTTP 402: {"error":{"message":"This request requires more credits"}}')).toBe(true);
    expect(isFatalLlmError('anthropic HTTP 401: invalid x-api-key')).toBe(true);
    expect(isFatalLlmError('This request would exceed your available credits given your current in-flight requests')).toBe(true);
  });

  test('transient failures are not', () => {
    expect(isFatalLlmError('openrouter /chat/completions HTTP 429: rate limited')).toBe(false);
    expect(isFatalLlmError('HTTP 529: overloaded')).toBe(false);
    expect(isFatalLlmError('socket hang up')).toBe(false);
  });
});
