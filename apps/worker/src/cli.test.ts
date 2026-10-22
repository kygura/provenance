import { describe, expect, test } from 'bun:test';
import { EXIT_CONFIG, EXIT_FAILED, EXIT_OK, main } from './cli';
import { makeAlert, makeHarness, makeScore, makeSnapshot } from './test-fakes';

const QUIET = { NO_COLOR: '1', LOG_LEVEL: 'error' } as Record<string, string | undefined>;

/** Runs the CLI with stdout/stderr captured so the test output stays readable. */
async function run(
  argv: string[],
  overrides: Parameters<typeof main>[1] = {},
): Promise<{ code: number; out: string }> {
  const chunks: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => chunks.push(args.join(' '));
  console.error = (...args: unknown[]) => chunks.push(args.join(' '));
  try {
    const code = await main(argv, { env: QUIET, ...overrides });
    return { code, out: chunks.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

describe('usage and exit codes', () => {
  test('no command prints help and exits 2', async () => {
    const { code, out } = await run([]);
    expect(code).toBe(EXIT_CONFIG);
    expect(out).toContain('usage:');
  });

  test('help exits 0', async () => {
    expect((await run(['help'])).code).toBe(EXIT_OK);
    expect((await run(['run', '--help'])).code).toBe(EXIT_OK);
  });

  test('an unknown flag is a configuration error', async () => {
    const { code, out } = await run(['run', '--turbo']);
    expect(code).toBe(EXIT_CONFIG);
    expect(out).toContain('unknown flag: --turbo');
  });

  test('a missing API key names the variable', async () => {
    const { code, out } = await run(['run']);
    expect(code).toBe(EXIT_CONFIG);
    // The default models are Kimi on Moonshot.
    expect(out).toContain('MOONSHOT_API_KEY');
  });

  test('version prints and exits 0', async () => {
    const { code, out } = await run(['version']);
    expect(code).toBe(EXIT_OK);
    expect(out).toContain('provenance-worker');
  });
});

describe('commands', () => {
  test('run --fixtures --no-llm completes without a key', async () => {
    const harness = makeHarness({ snapshots: [makeSnapshot('solana:aaa')] });
    const { code } = await run(['run', '--fixtures', '--no-llm', '--limit', '1'], {
      deps: harness.deps,
    });
    expect(code).toBe(EXIT_OK);
    expect(harness.researchCalls).toEqual([]);
    expect(harness.store.snapshots).toHaveLength(1);
  });

  test('a failed run exits 1', async () => {
    const harness = makeHarness({
      snapshots: [makeSnapshot('solana:aaa')],
      scoreToken: () => {
        throw new Error('nope');
      },
    });
    const { code } = await run(['run', '--no-llm'], { deps: harness.deps });
    expect(code).toBe(EXIT_FAILED);
  });

  test('--dry-run keeps remote channels quiet', async () => {
    const harness = makeHarness({
      snapshots: [makeSnapshot('solana:aaa')],
      createAlerts: (runId, input) => [makeAlert(runId, input.snapshot.tokenId)],
    });
    const { code } = await run(['run', '--dry-run', '--no-llm'], { deps: harness.deps });
    expect(code).toBe(EXIT_OK);
    expect(harness.sinkFilter[0]).toEqual(['console']);
  });

  test('migrate applies migrations', async () => {
    const harness = makeHarness();
    const { code } = await run(['migrate'], { deps: harness.deps });
    expect(code).toBe(EXIT_OK);
    expect(harness.store.calls).toContain('migrate');
    expect(harness.store.closed).toBe(true);
  });

  test('seed delegates to seedDemoData', async () => {
    const harness = makeHarness();
    const { code } = await run(['seed'], { deps: harness.deps });
    expect(code).toBe(EXIT_OK);
    expect(harness.stages).toContain('seed');
  });

  test('discover prints the triaged table without analysing', async () => {
    const harness = makeHarness({ snapshots: [makeSnapshot('solana:aaa')] });
    const { code, out } = await run(['discover'], { deps: harness.deps });
    expect(code).toBe(EXIT_OK);
    expect(out).toContain('SYMBOL');
    expect(harness.stages).toContain('triage');
    expect(harness.stages.some((stage) => stage.startsWith('analyze:'))).toBe(false);
  });

  test('analyze prints a dossier for one token', async () => {
    const harness = makeHarness({ snapshots: [makeSnapshot('solana:aaa')] });
    const { code, out } = await run(['analyze', 'solana:aaa', '--no-llm'], { deps: harness.deps });
    expect(code).toBe(EXIT_OK);
    expect(out).toContain('On-chain');
    expect(out).toContain('Score');
  });

  test('analyze without a token exits 2', async () => {
    const harness = makeHarness();
    const { code, out } = await run(['analyze', '--no-llm'], { deps: harness.deps });
    expect(code).toBe(EXIT_CONFIG);
    expect(out).toContain('analyze needs a token');
  });

  test('report with no runs exits 1, and renders the run once there is one', async () => {
    const harness = makeHarness({
      snapshots: [makeSnapshot('solana:aaa')],
      scoreToken: (input) => makeScore(input.snapshot.tokenId, 88),
    });
    expect((await run(['report'], { deps: harness.deps })).code).toBe(EXIT_FAILED);

    await run(['run', '--no-llm'], { deps: harness.deps });
    const table = await run(['report'], { deps: harness.deps });
    expect(table.code).toBe(EXIT_OK);
    expect(table.out).toContain('SCORE');

    const json = await run(['report', '--format', 'json'], { deps: harness.deps });
    expect(JSON.parse(json.out).run.status).toBe('ok');

    const markdown = await run(['report', '--format', 'markdown'], { deps: harness.deps });
    expect(markdown.out).toContain('| Symbol | Chain |');
  });

  test('alerts:test pushes a synthetic alert through every enabled sink', async () => {
    const harness = makeHarness();
    const { code, out } = await run(['alerts:test'], {
      deps: harness.deps,
      env: { ...QUIET, DISCORD_WEBHOOK_URL: 'https://discord.test/hook' },
    });
    expect(code).toBe(EXIT_OK);
    expect(harness.dispatched[0]?.[0]?.rule).toBe('synthetic');
    expect(out).toContain('console');
    expect(out).toContain('telegram');
  });

  test('alerts:test with nothing configured exits 2 naming the variables', async () => {
    const harness = makeHarness();
    const { code, out } = await run(['alerts:test'], { deps: harness.deps });
    expect(code).toBe(EXIT_CONFIG);
    expect(out).toContain('DISCORD_WEBHOOK_URL');
  });
});

describe('outcomes and calibrate', () => {
  test('calibrate reads labels and prints a report; --json prints the JSON; it writes nothing', async () => {
    const harness = makeHarness();
    harness.store.calibration = Array.from({ length: 5 }, (_, i) => ({
      tokenId: `solana:t${i}`,
      runId: 'r',
      scoredAt: '2026-10-01T06:00:00.000Z',
      total: 60,
      tier: 'B' as const,
      components: { recycling: 50, memetic: 50, distribution: 50, liquidity: 50, momentum: 50, authenticity: 50 },
      survived: i < 2,
    }));
    const text = await run(['calibrate'], { deps: harness.deps });
    expect(text.code).toBe(EXIT_OK);
    expect(text.out).toContain('calibration · insufficient · 5 labelled at 72 h');
    const json = await run(['calibrate', '--json'], { deps: harness.deps });
    expect(JSON.parse(json.out)).toMatchObject({ status: 'insufficient', n: 5, survived: 2 });
    expect(harness.store.calls.filter((call) => call !== 'calibrationRows' && call !== 'close')).toEqual([]);
  });

  test('outcomes --dry-run counts pending labels without fetching', async () => {
    const harness = makeHarness();
    harness.store.candidates = [
      { tokenId: 'solana:a', chain: 'solana', address: 'a', runId: 'r1', scoredAt: '2026-10-18T06:00:00.000Z', liqAtScore: 1 },
      { tokenId: 'solana:a', chain: 'solana', address: 'a', runId: 'r2', scoredAt: '2026-10-18T07:00:00.000Z', liqAtScore: 1 },
    ];
    harness.deps.createPairFetcher = () => {
      throw new Error('must not fetch');
    };
    const { code, out } = await run(['outcomes', '--dry-run'], { deps: harness.deps });
    expect(code).toBe(EXIT_OK);
    expect(out).toContain('1 score(s) past 72 h await a label');
  });
});
