import { describe, expect, test } from 'bun:test';
import { isFatalLlmError, redactUrl, retry } from './util';

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

describe('redactUrl', () => {
  test('masks a key in the path and keeps the origin', () => {
    expect(redactUrl('https://eth-mainnet.g.alchemy.com/v2/AbCdEf0123456789AbCdEf0123456789')).toBe(
      'https://eth-mainnet.g.alchemy.com/v2/***',
    );
  });

  test('masks secret query values and userinfo', () => {
    expect(redactUrl('https://mainnet.helius-rpc.com/?api-key=0123abcd-4567&cluster=main')).toBe(
      'https://mainnet.helius-rpc.com/?api-key=***&cluster=main',
    );
    expect(redactUrl('https://user:hunter2@node.example/rpc')).toBe('https://***@node.example/rpc');
  });

  test('leaves keyless public endpoints and 0x addresses alone', () => {
    expect(redactUrl('https://ethereum-rpc.publicnode.com')).toBe('https://ethereum-rpc.publicnode.com/');
    expect(redactUrl('https://1rpc.io/eth')).toBe('https://1rpc.io/eth');
    expect(redactUrl('https://x.example/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2')).toBe(
      'https://x.example/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    );
  });

  test('masks something that is not a URL whole', () => {
    expect(redactUrl('not a url with a secret')).toBe('***');
  });
});
