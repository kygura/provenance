import { describe, expect, test } from 'bun:test';
import { createClient, type Client } from '@libsql/client';
import { LibsqlStore } from './libsql-store';

/** A real in-memory client whose next `failures` calls die like a stale socket. */
function flakyClient(failures: number, message = 'The socket connection was closed unexpectedly.') {
  const inner = createClient({ url: ':memory:' });
  let remaining = 0;
  const client = new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if ((prop === 'execute' || prop === 'batch') && typeof value === 'function') {
        return (...args: unknown[]) => {
          if (remaining > 0) {
            remaining -= 1;
            return Promise.reject(new Error(message));
          }
          return value.apply(target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Client;
  return { client, arm: () => (remaining = failures) };
}

describe('LibsqlStore transport retry', () => {
  test('a dropped connection is retried and the write lands', async () => {
    const { client, arm } = flakyClient(2);
    const store = new LibsqlStore({ url: ':memory:', client });
    await store.migrate();
    arm();
    await store.startRun('run_retry');
    expect((await store.getRun('run_retry'))?.id).toBe('run_retry');
  });

  test('gives up after the last attempt', async () => {
    const { client, arm } = flakyClient(3);
    const store = new LibsqlStore({ url: ':memory:', client });
    await store.migrate();
    arm();
    await expect(store.startRun('run_down')).rejects.toThrow('socket connection was closed');
  });

  test('a statement error is not retried', async () => {
    const { client, arm } = flakyClient(1, 'SQLITE_CONSTRAINT: UNIQUE constraint failed');
    const store = new LibsqlStore({ url: ':memory:', client });
    await store.migrate();
    arm();
    await expect(store.startRun('run_bad')).rejects.toThrow('SQLITE_CONSTRAINT');
  });
});
