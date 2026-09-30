import { describe, expect, test } from 'bun:test';
import { extractJwt, loadConfig } from './config';

describe('loadConfig', () => {
  test('strips whitespace pasted around secrets', () => {
    const app = loadConfig({
      DATABASE_URL: ' libsql://db.turso.io\n',
      DATABASE_AUTH_TOKEN: ' eyJhbGciOiJFZERTQSJ9.payload.sig\n',
      OPENROUTER_API_KEY: '\tsk-or-v1-abc ',
      TELEGRAM_CHAT_ID: ' -5222707171',
    });
    expect(app.databaseUrl).toBe('libsql://db.turso.io');
    expect(app.databaseAuthToken).toBe('eyJhbGciOiJFZERTQSJ9.payload.sig');
    expect(app.llm.providers.openrouter.apiKey).toBe('sk-or-v1-abc');
    expect(app.alerts.telegramChatId).toBe('-5222707171');
  });

  test('a whitespace-only value counts as unset where a default exists', () => {
    expect(loadConfig({ LLM_MODEL: '  ' }).llm.model).toBe('claude-opus-5');
  });
});

describe('extractJwt', () => {
  const jwt = 'eyJhbGciOiJFZERTQSJ9.eyJhIjoicncifQ.c2lnbmF0dXJl';

  test('pulls the token out of a pasted NAME= line, quotes or wrapped lines', () => {
    expect(extractJwt(`DATABASE_TOKEN= ${jwt}`)).toBe(jwt);
    expect(extractJwt(`"${jwt}"`)).toBe(jwt);
    expect(extractJwt(`${jwt.slice(0, 20)}\n${jwt.slice(20)}`)).toBe(jwt);
    expect(loadConfig({ DATABASE_AUTH_TOKEN: ` DATABASE_TOKEN= ${jwt}\n` }).databaseAuthToken).toBe(jwt);
  });

  test('leaves a clean token, an empty value or a non-JWT alone', () => {
    expect(extractJwt(jwt)).toBe(jwt);
    expect(extractJwt(undefined)).toBeUndefined();
    expect(extractJwt('not a token')).toBe('not a token');
  });
});

describe('extractJwt with rich-text pastes', () => {
  const jwt = 'eyJhbGciOiJFZERTQSJ9.eyJhIjoicncifQ.c2ln-bmF0-dXJl';

  test('folds look-alike dashes and drops zero-width characters', () => {
    expect(extractJwt(jwt.replaceAll('-', '‑'))).toBe(jwt);
    expect(extractJwt(jwt.replaceAll('-', '–'))).toBe(jwt);
    expect(extractJwt(`​${jwt.slice(0, 10)}​${jwt.slice(10)}`)).toBe(jwt);
  });
});
