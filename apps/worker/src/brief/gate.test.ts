import { describe, expect, test } from 'bun:test';
import { checkProposal, gateProposals, type GateCandidate, type GateContext, type SetupProposal } from './gate';

const TOKEN = 'solana:Good1111111111111111111111111111';

const GOOD: SetupProposal = {
  token_id: TOKEN,
  direction: 'long',
  thesis: 'Anchored revival holding its range.',
  trigger: 'Daily close back inside the zone.',
  conviction: 'medium',
  // mid 1.1M (zone 18% wide), invalidation 0.88M (20% under mid), target 1.65M (2.5R)
  entry_mcap_low: 1_000_000,
  entry_mcap_high: 1_200_000,
  invalidation_mcap: 880_000,
  targets: [1_650_000, 2_200_000],
  expiry_days: 5,
};

const CANDIDATE: GateCandidate = {
  tokenId: TOKEN,
  inCur: true,
  onActiveWatchlist: false,
  tier: 'B',
  anchorVerdict: 'unclear',
  liquidityUsd: 120_000,
  top10Pct: 35,
  largestHolderPct: 8,
  mintActive: false,
  freezeActive: false,
  flags: [{ code: 'lp-partial', severity: 'warn', detail: 'd' }],
};

const WARM = { memeRegime: 'warm' as const, btcRiskOff: false };

function reasonsFor(proposal: Partial<SetupProposal>, candidate: Partial<GateCandidate> = {}, context = WARM): string[] {
  return checkProposal({ ...GOOD, ...proposal }, { ...CANDIDATE, ...candidate }, context).reasons;
}

describe('checkProposal', () => {
  test('a good proposal passes and carries the computed R:R', () => {
    expect(checkProposal(GOOD, CANDIDATE, WARM)).toEqual({ reasons: [], rr: 2.5 });
  });

  const rejections: [string, Partial<SetupProposal>, Partial<GateCandidate>, RegExp][] = [
    ['not in CUR and not on the watchlist', {}, { inCur: false, onActiveWatchlist: false }, /neither in the current run/],
    ['tier C', {}, { tier: 'C' }, /below B/],
    ['short', { direction: 'short' }, {}, /long only/],
    ['critical chain flag', {}, { flags: [{ code: 'honeypot', severity: 'critical', detail: '' }] }, /blocking chain flag: honeypot/],
    ['high chain flag', {}, { flags: [{ code: 'tax', severity: 'high', detail: '' }] }, /blocking chain flag/],
    ['mint authority active', {}, { mintActive: true }, /mint authority/],
    ['freeze authority active', {}, { freezeActive: true }, /freeze authority/],
    ['top-10 at 80%', {}, { top10Pct: 80 }, /top-10 80\.0%/],
    ['top-10 unknown', {}, { top10Pct: undefined }, /top-10 concentration unknown/],
    ['largest holder at 25%', {}, { largestHolderPct: 25 }, /largest holder/],
    ['liquidity under $50k', {}, { liquidityUsd: 49_999 }, /liquidity \$49,999/],
    ['liquidity unknown', {}, { liquidityUsd: undefined }, /liquidity unknown/],
    ['entry zone too wide', { entry_mcap_low: 900_000, entry_mcap_high: 1_300_000, invalidation_mcap: 700_000, targets: [2_000_000] }, {}, /entry zone 36% wide/],
    ['invalidation inside the zone', { invalidation_mcap: 1_050_000 }, {}, /below the entry zone/],
    ['invalidation too shallow', { invalidation_mcap: 990_000, targets: [1_400_000] }, {}, /under entry mid < 15%/],
    ['first target under 2R', { targets: [1_500_000] }, {}, /1\.82R from entry mid < 2R/],
    ['targets not ascending', { targets: [2_200_000, 1_650_000] }, {}, /ascending/],
    ['no target', { targets: [] }, {}, /at least one target/],
    ['negative level', { invalidation_mcap: -1 }, {}, /positive numbers/],
    ['inverted zone', { entry_mcap_low: 1_200_000, entry_mcap_high: 1_000_000 }, {}, /high must be above low/],
    ['expiry over 7 days', { expiry_days: 8 }, {}, /expiry 8 days/],
    ['expiry of zero', { expiry_days: 0 }, {}, /expiry 0 days/],
  ];
  for (const [name, proposal, candidate, pattern] of rejections) {
    test(`rejects: ${name}`, () => {
      const reasons = reasonsFor(proposal, candidate);
      expect(reasons.some((reason) => pattern.test(reason))).toBe(true);
    });
  }

  test('an unknown token is rejected', () => {
    expect(checkProposal(GOOD, undefined, WARM).reasons.join(' ')).toContain('neither in the current run');
  });

  test('an active watchlist token outside CUR can pass', () => {
    expect(reasonsFor({}, { inCur: false, onActiveWatchlist: true })).toEqual([]);
  });

  describe('regime', () => {
    const strict: GateCandidate = { ...CANDIDATE, tier: 'A', anchorVerdict: 'anchored' };
    for (const context of [
      { memeRegime: 'cold' as const, btcRiskOff: false },
      { memeRegime: 'warm' as const, btcRiskOff: true },
    ]) {
      const label = context.btcRiskOff ? 'BTC risk-off' : 'cold meme regime';
      test(`${label}: medium conviction, unanchored or tier B is rejected`, () => {
        expect(checkProposal(GOOD, strict, context).reasons.join(' ')).toContain('conviction must be high');
        expect(checkProposal({ ...GOOD, conviction: 'high' }, { ...strict, anchorVerdict: 'unclear' }, context).reasons.join(' ')).toContain(
          'must be anchored',
        );
        expect(checkProposal({ ...GOOD, conviction: 'high' }, { ...strict, tier: 'B' }, context).reasons.join(' ')).toContain(
          'tier must be S or A',
        );
      });
      test(`${label}: high conviction on an anchored A-tier token passes`, () => {
        expect(checkProposal({ ...GOOD, conviction: 'high' }, strict, context).reasons).toEqual([]);
      });
    }
  });
});

describe('gateProposals caps', () => {
  const candidates = new Map<string, GateCandidate>(
    ['a', 'b', 'c', 'd'].map((suffix) => [`solana:${suffix}`, { ...CANDIDATE, tokenId: `solana:${suffix}` }]),
  );
  const proposal = (suffix: string): SetupProposal => ({ ...GOOD, token_id: `solana:${suffix}` });
  const context = (openTokenIds: string[]): GateContext => ({ ...WARM, openTokenIds });

  test('at most 2 new per run', () => {
    const verdicts = gateProposals([proposal('a'), proposal('b'), proposal('c')], candidates, context([]));
    expect(verdicts.map((v) => v.accepted)).toEqual([true, true, false]);
    expect(verdicts[2]?.reasons.join(' ')).toContain('at most 2 new');
  });

  test('at most 4 open', () => {
    const verdicts = gateProposals([proposal('a'), proposal('b')], candidates, context(['solana:x', 'solana:y', 'solana:z']));
    expect(verdicts.map((v) => v.accepted)).toEqual([true, false]);
    expect(verdicts[1]?.reasons.join(' ')).toContain('at most 4 open');
  });

  test('one per token, against open setups and within the run', () => {
    expect(gateProposals([proposal('a')], candidates, context(['solana:a']))[0]?.accepted).toBe(false);
    const verdicts = gateProposals([proposal('a'), proposal('a')], candidates, context([]));
    expect(verdicts.map((v) => v.accepted)).toEqual([true, false]);
    expect(verdicts[1]?.reasons.join(' ')).toContain('one setup per token');
  });
});
