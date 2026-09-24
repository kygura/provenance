import { describe, expect, test } from 'bun:test';
import { loadConfig, type ChainAnalysis, type WatchEntry } from '@provenance/core';
import { gateLaunchChain, gateLaunchMarket, launchAnchoredAlert, launchExpressedAlert } from './launches';
import { makeSnapshot } from './test-support';

const config = loadConfig({}).launches;
const ADDRESS = '0x1111111111111111111111111111111111111111';

function evmSnapshot(liquidityUsd?: number) {
  return makeSnapshot({
    tokenId: `ethereum:${ADDRESS}`,
    chain: 'ethereum',
    tokenAddress: ADDRESS,
    symbol: 'SHREK',
    name: 'Shrek',
    metrics: liquidityUsd === undefined ? {} : { liquidityUsd },
  });
}

/** Clears every launch filter at the default config. */
function cleanChain(over: Partial<ChainAnalysis> = {}): ChainAnalysis {
  return {
    tokenId: `ethereum:${ADDRESS}`,
    chain: 'ethereum',
    tokenAddress: ADDRESS,
    method: 'rpc',
    holderCount: 250,
    top10Pct: 22,
    ownerRenounced: true,
    privilegedFunctions: [],
    lpBurnedPct: 100,
    topHolders: [],
    flags: [],
    notes: [],
    fetchedAt: '2026-09-24T00:00:00.000Z',
    ...over,
  };
}

describe('gateLaunchMarket', () => {
  test('liquidity at the floor passes; below, or unknown, rejects', () => {
    expect(gateLaunchMarket(evmSnapshot(config.minLiquidityUsd), config).passed).toBe(true);
    const thin = gateLaunchMarket(evmSnapshot(config.minLiquidityUsd - 1), config);
    expect(thin.passed).toBe(false);
    expect(thin.reasons[0]).toContain('liquidity');
    expect(gateLaunchMarket(evmSnapshot(undefined), config).reasons[0]).toContain('unknown');
  });

  test('non-EVM chains have no launch-lane checks', () => {
    const solana = makeSnapshot({ metrics: { liquidityUsd: 1_000_000 } });
    expect(gateLaunchMarket(solana, config).passed).toBe(false);
  });
});

describe('gateLaunchChain', () => {
  test('a clean analysis passes', () => {
    expect(gateLaunchChain(cleanChain(), config)).toEqual({ passed: true, reasons: [] });
  });

  test('missing analysis is a rejection, not a pass', () => {
    expect(gateLaunchChain(undefined, config).passed).toBe(false);
    expect(gateLaunchChain(cleanChain({ method: 'unavailable' }), config).passed).toBe(false);
  });

  test('holder and concentration boundaries', () => {
    expect(gateLaunchChain(cleanChain({ holderCount: config.minHolderCount }), config).passed).toBe(true);
    expect(gateLaunchChain(cleanChain({ holderCount: config.minHolderCount - 1 }), config).passed).toBe(false);
    expect(gateLaunchChain(cleanChain({ top10Pct: config.maxTop10Pct }), config).passed).toBe(true);
    expect(gateLaunchChain(cleanChain({ top10Pct: config.maxTop10Pct + 0.1 }), config).passed).toBe(false);
    expect(gateLaunchChain(cleanChain({ holderCount: undefined }), config).reasons).toEqual([
      'holders: count unknown (partial log scan)',
    ]);
  });

  test('burned and locked LP add up; unmeasured LP rejects only when required', () => {
    expect(gateLaunchChain(cleanChain({ lpBurnedPct: 50, lpLockedPct: 45 }), config).passed).toBe(true);
    expect(gateLaunchChain(cleanChain({ lpBurnedPct: 50, lpLockedPct: 30 }), config).passed).toBe(false);
    const unmeasured = cleanChain({ lpBurnedPct: undefined });
    expect(gateLaunchChain(unmeasured, config).passed).toBe(false);
    expect(gateLaunchChain(unmeasured, { ...config, requireLpSecured: false }).passed).toBe(true);
  });

  test('critical privileged-function flags reject; informational ones do not', () => {
    const live = cleanChain({
      ownerRenounced: false,
      flags: [{ code: 'privileged-blacklist', severity: 'critical', detail: 'blacklist(address) callable by owner' }],
    });
    expect(gateLaunchChain(live, config).reasons[0]).toStartWith('privileged-blacklist');
    const inert = cleanChain({
      flags: [{ code: 'privileged-blacklist', severity: 'info', detail: 'owner renounced' }],
    });
    expect(gateLaunchChain(inert, config).passed).toBe(true);
  });

  test('an explicitly unverified contract rejects; an unchecked one does not', () => {
    expect(gateLaunchChain(cleanChain({ contractVerified: false }), config).passed).toBe(false);
    expect(gateLaunchChain(cleanChain({ contractVerified: undefined }), config).passed).toBe(true);
  });
});

describe('launch alerts', () => {
  const entry: WatchEntry = {
    tokenId: `ethereum:${ADDRESS}`,
    chain: 'ethereum',
    tokenAddress: ADDRESS,
    symbol: 'SHREK',
    name: 'Shrek',
    status: 'expressed',
    firstSeenAt: '2026-09-20T00:00:00.000Z',
    expressedAt: '2026-09-21T12:00:00.000Z',
    leadHours: 36,
    expressedOn: ['dexscreener', 'geckoterminal'],
    liquidityUsdAtCatalog: 52_000,
    anchor: {
      verdict: 'anchored',
      type: 'cultural-artifact',
      subject: 'DreamWorks film character',
      anchorDate: '2001-04-22',
      precedesLaunch: true,
      summary: 'Recognised since 2001.',
      confidence: 'high',
      model: 'test',
      checkedAt: '2026-09-20T00:00:00.000Z',
      citations: [],
    },
    gate: { passed: true, reasons: [] },
    updatedAt: '2026-09-21T12:00:00.000Z',
  };

  test('ids are stable per run, token and rule, and the verdict leads', () => {
    const a = launchAnchoredAlert('run-1', entry, evmSnapshot(52_000), cleanChain());
    const b = launchAnchoredAlert('run-1', entry, evmSnapshot(52_000), cleanChain());
    expect(a.id).toBe(b.id);
    expect(a.rule).toBe('launch-anchored');
    expect(a.severity).toBe('critical');
    expect(a.body.split('\n')[1]).toContain('ANCHORED — DreamWorks film character');
    expect(a.body).toContain('before launch');
    expect(a.markdown).toContain('etherscan.io/token/');
    expect(a.payload.researched).toBe(false);
  });

  test('the expressed alert states the lead time and where it trended', () => {
    const alert = launchExpressedAlert('run-2', entry, evmSnapshot(180_000));
    expect(alert.title).toBe('Trending 36.0h after an anchored verdict: $SHREK');
    expect(alert.body).toContain('dexscreener, geckoterminal');
    expect(alert.body).not.toContain('**');
    expect(alert.payload.leadHours).toBe(36);
  });
});
