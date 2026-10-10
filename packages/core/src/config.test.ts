import { describe, expect, test } from 'bun:test';
import { DEFAULT_LLM_MODEL, extractJwt, loadConfig } from './config';

describe('loadConfig', () => {
  test('a configured RPC leads and the public nodes follow it', () => {
    const app = loadConfig({ RPC_ETHEREUM: 'https://eth-mainnet.g.alchemy.com/v2/key, https://ethereum-rpc.publicnode.com' });
    expect(app.rpc.ethereum[0]).toBe('https://eth-mainnet.g.alchemy.com/v2/key');
    expect(app.rpc.ethereum).toContain('https://eth.drpc.org');
    expect(app.rpc.ethereum.filter((url) => url === 'https://ethereum-rpc.publicnode.com')).toHaveLength(1);
  });

  test('RPC_PUBLIC_FALLBACK=false keeps only the configured RPC list', () => {
    const app = loadConfig({ RPC_ETHEREUM: 'https://eth-mainnet.g.alchemy.com/v2/key', RPC_PUBLIC_FALLBACK: 'false' });
    expect(app.rpc.ethereum).toEqual(['https://eth-mainnet.g.alchemy.com/v2/key']);
  });

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
    expect(loadConfig({ LLM_MODEL: '  ' }).llm.model).toBe(DEFAULT_LLM_MODEL);
  });

  test('social sightings are off without a key and default to the free-tier cadence', () => {
    const social = loadConfig({}).social;
    expect(social.elfaApiKey).toBeUndefined();
    expect(social.minIntervalHours).toBe(2);
    expect(social.platforms).toEqual(['twitter', 'telegram']);
  });

  test('ELFA_PLATFORMS keeps known names and falls back to both on nonsense', () => {
    expect(loadConfig({ ELFA_PLATFORMS: 'Telegram, discord' }).social.platforms).toEqual(['telegram']);
    expect(loadConfig({ ELFA_PLATFORMS: 'discord' }).social.platforms).toEqual(['twitter', 'telegram']);
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
