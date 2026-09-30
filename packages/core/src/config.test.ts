import { describe, expect, test } from 'bun:test';
import { loadConfig } from './config';

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
