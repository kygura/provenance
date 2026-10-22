import { describe, expect, test } from 'bun:test';
import type { PrivilegedFunction } from '@provenance/core';
import { evaluateFlags, PRIVILEGED_SEVERITY, type FlagAnalysis } from './flags';

function analysis(extra: Partial<FlagAnalysis>): FlagAnalysis {
  // holderCount set so the unrelated `holder-count-unknown` info flag stays quiet.
  return { method: 'rpc', holderCount: 100, ...extra };
}

function find(flags: ReturnType<typeof evaluateFlags>, code: string) {
  return flags.find((flag) => flag.code === code);
}

const KINDS: PrivilegedFunction[] = ['mint', 'blacklist', 'pause', 'fee', 'max-tx'];
const LIVE: Record<PrivilegedFunction, 'critical' | 'warn'> = {
  mint: 'critical',
  blacklist: 'critical',
  pause: 'critical',
  fee: 'warn',
  'max-tx': 'warn',
};

describe('privileged-* flags', () => {
  test('severity table matches the documented contract', () => {
    expect(PRIVILEGED_SEVERITY).toEqual(LIVE);
  });

  for (const kind of KINDS) {
    const code = `privileged-${kind}`;

    test(`${code}: ${LIVE[kind]} while ownership is not renounced`, () => {
      const flags = evaluateFlags({ analysis: analysis({ privilegedFunctions: [kind], ownerRenounced: false }) });
      expect(find(flags, code)?.severity).toBe(LIVE[kind]);
    });

    test(`${code}: ${LIVE[kind]} when ownership is undetermined`, () => {
      const flags = evaluateFlags({ analysis: analysis({ privilegedFunctions: [kind] }) });
      expect(find(flags, code)?.severity).toBe(LIVE[kind]);
      expect(find(flags, code)?.detail).toContain('undetermined');
    });

    test(`${code}: info once ownership is renounced`, () => {
      const flags = evaluateFlags({ analysis: analysis({ privilegedFunctions: [kind], ownerRenounced: true }) });
      expect(find(flags, code)?.severity).toBe('info');
    });
  }

  test('an empty list (code read, nothing found) raises nothing', () => {
    const flags = evaluateFlags({ analysis: analysis({ privilegedFunctions: [], ownerRenounced: false }) });
    expect(flags.filter((flag) => flag.code.startsWith('privileged-'))).toEqual([]);
  });

  test('undefined (code not read) raises nothing either', () => {
    const flags = evaluateFlags({ analysis: analysis({ ownerRenounced: false }) });
    expect(flags.filter((flag) => flag.code.startsWith('privileged-'))).toEqual([]);
  });

  test('duplicates collapse to one flag per kind', () => {
    const flags = evaluateFlags({ analysis: analysis({ privilegedFunctions: ['mint', 'mint'] }) });
    expect(flags.filter((flag) => flag.code === 'privileged-mint')).toHaveLength(1);
  });
});

describe('contract-unverified', () => {
  test('warn only on an explicit false', () => {
    expect(find(evaluateFlags({ analysis: analysis({ contractVerified: false }) }), 'contract-unverified')?.severity).toBe(
      'warn',
    );
    expect(find(evaluateFlags({ analysis: analysis({ contractVerified: true }) }), 'contract-unverified')).toBeUndefined();
    expect(find(evaluateFlags({ analysis: analysis({}) }), 'contract-unverified')).toBeUndefined();
  });
});

describe('lp-not-burned with measured LP', () => {
  test('locked LP alone clears the threshold', () => {
    const flags = evaluateFlags({ analysis: analysis({ lpBurnedPct: 0, lpLockedPct: 50 }) });
    expect(find(flags, 'lp-not-burned')).toBeUndefined();
  });

  test('fires just below it', () => {
    const flags = evaluateFlags({ analysis: analysis({ lpBurnedPct: 49.99, lpLockedPct: 10 }) });
    expect(find(flags, 'lp-not-burned')?.severity).toBe('warn');
  });
});

describe('funded-cluster', () => {
  const flagsFor = (clusteredPct: number) =>
    evaluateFlags({
      analysis: {
        method: 'rpc',
        holderCount: 300,
        funding: {
          windowBlocks: 150,
          traced: 20,
          untraced: 0,
          clusters: [{ funder: '0xfunder', wallets: 7, boughtPct: clusteredPct }],
          clusteredPct,
        },
      },
    }).filter((flag) => flag.code === 'funded-cluster');

  test('warn at 10%, critical at 25%, nothing below', () => {
    expect(flagsFor(9.9)).toEqual([]);
    expect(flagsFor(10)[0]).toMatchObject({ code: 'funded-cluster', severity: 'warn' });
    const critical = flagsFor(25)[0];
    expect(critical).toMatchObject({ code: 'funded-cluster', severity: 'critical' });
    expect(critical?.detail).toContain('7 wallets funded by 0xfunder');
  });
});
