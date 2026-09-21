/**
 * Fixture builders shared by the tests in this package. Test-only: deliberately not
 * re-exported from `index.ts`.
 */

import {
  loadConfig,
  type AlertRuleInput,
  type AppConfig,
  type ChainAnalysis,
  type ProvenanceReport,
  type ProvenanceScore,
  type TokenSnapshot,
} from '@provenance/core';

import { scoreToken } from './scoring';

export const NOW = new Date('2026-06-01T12:00:00.000Z');

export function makeSnapshot(over: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    tokenId: 'solana:9xQeWvG816bUx9EPa2rQ5HvJ1Z5j5sLpBuXsdRwbump',
    chain: 'solana',
    tokenAddress: '9xQeWvG816bUx9EPa2rQ5HvJ1Z5j5sLpBuXsdRwbump',
    symbol: 'REVIVE',
    name: 'Revival Frog',
    socials: {},
    metrics: {},
    pairs: [],
    appearances: [],
    bestRank: 3,
    sourceCount: 1,
    capturedAt: NOW.toISOString(),
    ...over,
  };
}

export function makeChain(over: Partial<ChainAnalysis> = {}): ChainAnalysis {
  return {
    tokenId: 'solana:9xQeWvG816bUx9EPa2rQ5HvJ1Z5j5sLpBuXsdRwbump',
    chain: 'solana',
    tokenAddress: '9xQeWvG816bUx9EPa2rQ5HvJ1Z5j5sLpBuXsdRwbump',
    method: 'rpc',
    topHolders: [],
    flags: [],
    notes: [],
    fetchedAt: NOW.toISOString(),
    ...over,
  };
}

export function makeReport(over: Partial<ProvenanceReport> = {}): ProvenanceReport {
  return {
    tokenId: 'solana:9xQeWvG816bUx9EPa2rQ5HvJ1Z5j5sLpBuXsdRwbump',
    memeName: 'Rare Pepe',
    narrativeCluster: 'frog',
    originYear: 2005,
    originSummary: 'A frog cartoon that became the internet default reaction image.',
    lineage: [],
    priorCycles: [],
    recycleVerdict: 'unclear',
    recycleGeneration: 0,
    memeticDurability: 50,
    culturalReach: 50,
    authenticityScore: 50,
    speculativeSetup: 'Dormant narrative, new participants.',
    risks: [],
    confidence: 0.8,
    evidence: [],
    model: 'claude-opus-5',
    promptVersion: 'v1',
    generatedAt: NOW.toISOString(),
    ...over,
  };
}

export function makeConfig(over: Partial<AppConfig> = {}): AppConfig {
  return { ...loadConfig({}), ...over };
}

export interface RuleInputOver {
  snapshot?: Partial<TokenSnapshot>;
  chain?: Partial<ChainAnalysis> | null;
  provenance?: Partial<ProvenanceReport> | null;
  config?: Partial<AppConfig>;
  history?: ProvenanceScore[];
  score?: ProvenanceScore;
}

/** A fully-populated `AlertRuleInput` whose score is really computed from the parts. */
export function makeRuleInput(over: RuleInputOver = {}): AlertRuleInput {
  const snapshot = makeSnapshot(over.snapshot ?? {});
  const chain = over.chain === null ? undefined : makeChain({ tokenId: snapshot.tokenId, ...(over.chain ?? {}) });
  const provenance =
    over.provenance === null ? undefined : makeReport({ tokenId: snapshot.tokenId, ...(over.provenance ?? {}) });
  const score = over.score ?? scoreToken({ snapshot, chain, provenance }, { now: NOW });
  return {
    snapshot,
    chain,
    provenance,
    score,
    config: makeConfig(over.config ?? {}),
    history: over.history ?? [],
  };
}

/** A strong, clean setup: dormant meme with real prior cycles and a healthy book. */
export function strongInput(over: RuleInputOver = {}): AlertRuleInput {
  return makeRuleInput({
    snapshot: {
      symbol: 'REVIVE',
      sourceCount: 3,
      socials: { website: 'https://example.com', twitter: 'https://x.com/example' },
      metrics: {
        priceUsd: 0.0021,
        marketCapUsd: 2_400_000,
        liquidityUsd: 320_000,
        volume24hUsd: 640_000,
        priceChange1h: 4,
        priceChange6h: 18,
        priceChange24h: 46,
        txns24h: { buys: 1840, sells: 1320 },
      },
      ...(over.snapshot ?? {}),
    },
    chain: over.chain === null ? null : {
      holderCount: 6200,
      top10Pct: 18,
      herfindahl: 0.012,
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
      lpBurnedPct: 100,
      creatorHoldingPct: 1.2,
      topHolders: [{ address: 'Aaa', balance: 100, pct: 4.1 }],
      flags: [],
      ...(over.chain ?? {}),
    },
    provenance: over.provenance === null ? null : {
      memeName: 'Rare Pepe',
      recycleVerdict: 'revival',
      recycleGeneration: 2,
      memeticDurability: 88,
      culturalReach: 76,
      authenticityScore: 84,
      confidence: 0.82,
      priorCycles: [
        { name: 'PEPE', ticker: 'PEPE', chain: 'ethereum', year: 2023, outcome: 'still-alive', peakMarketCapUsd: 1.6e9 },
        { name: 'Rare Pepe Cards', year: 2016, outcome: 'faded' },
      ],
      ...(over.provenance ?? {}),
    },
    ...(over.config ? { config: over.config } : {}),
    ...(over.history ? { history: over.history } : {}),
    ...(over.score ? { score: over.score } : {}),
  });
}
