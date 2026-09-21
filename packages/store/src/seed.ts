import type {
  Alert,
  Chain,
  ChainAnalysis,
  DeliveryResult,
  MarketMetrics,
  PairInfo,
  ProvenanceReport,
  ProvenanceScore,
  ProvenanceStore,
  RunStats,
  SocialLinks,
  SourceId,
  TokenSnapshot,
  TrendingEntry,
} from '@provenance/core';
import { runId as makeRunId, tokenId } from '@provenance/core';
import { LibsqlStore } from './libsql-store';

/**
 * Demo data for the dashboard, screenshots and manual pokes at the pipeline.
 *
 * It is written to be *argued with*, not just rendered: the eight tokens are
 * chosen so the thesis is legible from the list alone — a clean multi-year
 * revival of a proven meme at the top (NYAN), a shameless copycat of a meme that
 * is still running at the bottom (BOOMJAK), and an honest `unclear` in the
 * middle (IDLE) where the evidence genuinely does not support a verdict. If the
 * scores all pointed the same way the product would be a ranking, not a claim.
 *
 * Addresses are plausible-looking but fabricated. The memes are real culture;
 * the tokens are not.
 */

export interface SeedOptions {
  /** Id for the current run. Defaults to a freshly generated one. */
  runId?: string;
  /** Anchor for every timestamp. Defaults to now. */
  now?: Date | string;
  /**
   * Also write an earlier run covering three of the tokens, so `first_seen_at`,
   * `scoreHistory()` and "seen before" badges have something to show.
   */
  withHistory?: boolean;
}

export interface SeedResult {
  runId: string;
  priorRunId?: string;
  tokenIds: string[];
  alerts: number;
}

interface DemoToken {
  chain: Chain;
  address: string;
  symbol: string;
  name: string;
  description: string;
  imageUrl: string;
  socials: SocialLinks;
  bestRank: number;
  sources: { source: SourceId; rank: number }[];
  metrics: MarketMetrics;
  pair: Omit<PairInfo, 'createdAt'>;
  chainAnalysis: Omit<ChainAnalysis, 'tokenId' | 'chain' | 'tokenAddress' | 'fetchedAt'>;
  report: Omit<ProvenanceReport, 'tokenId' | 'model' | 'promptVersion' | 'generatedAt'>;
  score: Omit<ProvenanceScore, 'tokenId' | 'computedAt'>;
  /** Included in the earlier run too, with the metrics/score below. */
  history?: { total: number; tier: ProvenanceScore['tier']; volume24hUsd: number; bestRank: number };
}

const MODEL = 'claude-opus-5';
const PROMPT_VERSION = 'provenance-v3';

// ---------------------------------------------------------------------------
// the eight
// ---------------------------------------------------------------------------

const DEMO_TOKENS: DemoToken[] = [
  {
    chain: 'ethereum',
    address: '0x9F2C4b1eA7d0Ab3E6c5f81D2a94B7e03Cd15A8fE',
    symbol: 'NYAN',
    name: 'Nyan Cat',
    description: 'The 2011 Pop-Tart cat, tokenised properly and with the original artist on board.',
    imageUrl: 'https://static.example.cdn/tokens/nyan.png',
    socials: {
      website: 'https://nyan.example',
      twitter: 'https://x.com/nyanonchain',
      telegram: 'https://t.me/nyanportal',
      other: ['https://knowyourmeme.com/memes/nyan-cat'],
    },
    bestRank: 1,
    sources: [
      { source: 'dextools', rank: 1 },
      { source: 'dexscreener', rank: 2 },
      { source: 'geckoterminal', rank: 1 },
    ],
    metrics: {
      priceUsd: 0.0412,
      fdvUsd: 41_200_000,
      marketCapUsd: 39_800_000,
      liquidityUsd: 1_840_000,
      volume1hUsd: 910_000,
      volume6hUsd: 4_300_000,
      volume24hUsd: 12_600_000,
      priceChange1h: 4.8,
      priceChange6h: 19.4,
      priceChange24h: 64.2,
      txns24h: { buys: 9_140, sells: 6_020 },
      uniqueBuyers24h: 3_880,
      uniqueSellers24h: 2_410,
      ageHours: 182,
    },
    pair: {
      pairAddress: '0x2b81aF4C9e05D7f1B6C3a0E84d92F7Ab10cE6D33',
      dexId: 'uniswap',
      quoteSymbol: 'WETH',
      liquidityUsd: 1_840_000,
      url: 'https://dexscreener.com/ethereum/0x2b81af4c9e05d7f1b6c3a0e84d92f7ab10ce6d33',
    },
    chainAnalysis: {
      method: 'rpc',
      supply: { total: 1_000_000_000, circulating: 966_000_000, decimals: 18, burnedPct: 3.4 },
      holderCount: 8_421,
      top10Pct: 18.4,
      top20Pct: 24.9,
      top50Pct: 33.1,
      herfindahl: 0.011,
      gini: 0.62,
      creatorAddress: '0x74Ad9c2E1B5F308aC6e0D4713b8e2F95aC4b7712',
      creatorHoldingPct: 1.9,
      lpBurnedPct: 100,
      ownerRenounced: true,
      contractVerified: true,
      buyTaxPct: 0,
      sellTaxPct: 0,
      topHolders: [
        { address: '0x2b81aF4C9e05D7f1B6C3a0E84d92F7Ab10cE6D33', balance: 74_000_000, pct: 7.4, label: 'liquidity-pool', excludedFromConcentration: true },
        { address: '0x000000000000000000000000000000000000dEaD', balance: 34_000_000, pct: 3.4, label: 'burn', excludedFromConcentration: true },
        { address: '0x74Ad9c2E1B5F308aC6e0D4713b8e2F95aC4b7712', balance: 19_000_000, pct: 1.9, label: 'creator' },
        { address: '0xBe3A05f1cC7E42D9014bF8d6a7c02E518Ab91D44', balance: 16_200_000, pct: 1.62 },
        { address: '0x51F0b9E84a7c12D3b6A05Ed9f3C8014e7bB2a996', balance: 14_800_000, pct: 1.48 },
      ],
      flags: [
        { code: 'lp-burned', severity: 'info', detail: 'LP tokens sent to the burn address; liquidity cannot be pulled.' },
        { code: 'owner-renounced', severity: 'info', detail: 'Ownership renounced in block 21,441,902.' },
      ],
      notes: ['Holder set sampled from the top 500 transfers; tail beyond that estimated.'],
      durationMs: 4_120,
    },
    report: {
      memeName: 'Nyan Cat',
      narrativeCluster: 'nostalgia',
      originYear: 2011,
      originSummary:
        'Nyan Cat is a Pop-Tart-bodied cat trailing a rainbow, drawn by Christopher Torres in April 2011 and set to a sped-up Vocaloid track by a separate uploader days later. The mashup was one of the defining early-YouTube memes, passed 100 million views within a year, and became a shorthand for the whole 2011 internet rather than for any single joke.',
      lineage: [
        { label: 'Original "Pop Tart Cat" drawing posted to LOL-Comics', year: 2011, kind: 'origin' },
        { label: 'YouTube upload with the Nyanyanyan track; the meme as people know it', year: 2011, kind: 'derivative' },
        { label: 'Foundation NFT auction sells the original for ~300 ETH', year: 2021, kind: 'platform-shift', note: 'First time the meme itself was priced.' },
        { label: 'Unaffiliated ERC-20 launches and fades inside a month', year: 2022, kind: 'revival', note: 'No artist involvement, no liquidity lock.' },
        { label: 'This token: artist-endorsed, burned LP, renounced', year: 2026, kind: 'revival' },
      ],
      priorCycles: [
        { name: 'Nyan Cat NFT (Foundation)', year: 2021, peakMarketCapUsd: 590_000, outcome: 'still-alive', note: 'Single-edition sale at ~300 ETH; still the reference price for the IP.' },
        { name: 'NYANCAT (unaffiliated ERC-20)', ticker: 'NYANCAT', chain: 'ethereum', year: 2022, peakMarketCapUsd: 2_100_000, outcome: 'faded', note: 'Peaked in nine days, no creator involvement, liquidity pulled slowly.' },
      ],
      recycleVerdict: 'revival',
      recycleGeneration: 1,
      memeticDurability: 92,
      culturalReach: 88,
      authenticityScore: 94,
      speculativeSetup:
        'A fifteen-year-old meme with near-universal recognition outside crypto, one failed tokenisation behind it and the original artist attached to this one. The failed 2022 attempt is the useful part of the setup: it establishes demand for the meme while leaving the "real one" slot open, and this token is the instance the meme\'s audience would accept as canonical. Distribution is unusually clean for a launch this size. Not financial advice.',
      risks: [
        'Nostalgia revivals mean-revert hard once the initial rediscovery wave is spent.',
        'Trademark exposure: the IP is owned, and endorsement is not assignment.',
        'A 64% day means most of the easy repricing has already happened.',
      ],
      confidence: 0.86,
      evidence: [
        { kind: 'knowyourmeme', url: 'https://knowyourmeme.com/memes/nyan-cat', title: 'Nyan Cat', snippet: 'Nyan Cat is the subject of a YouTube video uploaded in April 2011, which became one of the most viewed videos of that year.', publishedAt: '2011-04-06', retrievedAt: '2026-09-21T09:12:00.000Z', sourceQuality: 0.9 },
        { kind: 'wiki', url: 'https://en.wikipedia.org/wiki/Nyan_Cat', title: 'Nyan Cat — Wikipedia', snippet: 'The original artwork sold as an NFT for 300 ether in February 2021.', retrievedAt: '2026-09-21T09:12:00.000Z', sourceQuality: 0.95 },
        { kind: 'onchain', title: 'Prior tokenisation trace', snippet: 'One prior ERC-20 using the name, deployed 2022-03, liquidity below $40k since 2022-05.', retrievedAt: '2026-09-21T09:13:00.000Z', sourceQuality: 0.7 },
      ],
      usage: { inputTokens: 18_420, outputTokens: 2_140, costUsd: 0.21 },
    },
    score: {
      total: 91,
      tier: 'S',
      components: { recycling: 95, memetic: 90, distribution: 88, liquidity: 84, momentum: 93, authenticity: 94 },
      penalties: [],
    },
    history: { total: 84, tier: 'A', volume24hUsd: 5_900_000, bestRank: 4 },
  },

  {
    chain: 'ethereum',
    address: '0x3Dd7A19eB40cF25a8e7B6031D9c4F82aB05e1C77',
    symbol: 'CHAD',
    name: 'Gigachad',
    description: 'The Ernest Khalimov edit, back for its second monetisation.',
    imageUrl: 'https://static.example.cdn/tokens/chad.png',
    socials: { twitter: 'https://x.com/gigachadeth', telegram: 'https://t.me/gigachaderc' },
    bestRank: 3,
    sources: [
      { source: 'dexscreener', rank: 3 },
      { source: 'geckoterminal', rank: 5 },
    ],
    metrics: {
      priceUsd: 0.00187,
      fdvUsd: 18_700_000,
      marketCapUsd: 18_700_000,
      liquidityUsd: 740_000,
      volume6hUsd: 1_900_000,
      volume24hUsd: 5_400_000,
      priceChange1h: -2.1,
      priceChange6h: 11.7,
      priceChange24h: 28.9,
      txns24h: { buys: 4_210, sells: 3_890 },
      ageHours: 96,
    },
    pair: { pairAddress: '0x77Ca0b91E5d3F28a6041B7cE9d2A85f30bE7c412', dexId: 'uniswap', quoteSymbol: 'WETH', liquidityUsd: 740_000 },
    chainAnalysis: {
      method: 'rpc',
      supply: { total: 10_000_000_000, decimals: 18, burnedPct: 0 },
      holderCount: 3_104,
      top10Pct: 31.2,
      top20Pct: 39.8,
      herfindahl: 0.026,
      gini: 0.71,
      creatorHoldingPct: 4.2,
      lpLockedPct: 100,
      ownerRenounced: true,
      contractVerified: true,
      topHolders: [
        { address: '0x77Ca0b91E5d3F28a6041B7cE9d2A85f30bE7c412', balance: 900_000_000, pct: 9.0, label: 'liquidity-pool', excludedFromConcentration: true },
        { address: '0xA41b7Cc2058Ef3149dB6a0c5E77321fAb9048e6D', balance: 420_000_000, pct: 4.2, label: 'creator' },
      ],
      flags: [
        { code: 'lp-locked', severity: 'info', detail: 'LP locked for 12 months via a third-party locker.' },
        { code: 'top10-elevated', severity: 'warn', detail: 'Top 10 non-LP holders control 31.2% of supply.' },
      ],
      notes: [],
      durationMs: 3_510,
    },
    report: {
      memeName: 'Gigachad',
      narrativeCluster: 'archetype',
      originYear: 2017,
      originSummary:
        'Gigachad is a heavily edited photograph of the model Ernest Khalimov from the Russian photographer Krista Sudmalis\'s "Sleek\'N\'Tears" series, which spread from 2017 onward as the ironic ideal of masculine self-assurance. It survived the transition from forum in-joke to mainstream reaction image, and the "yes, chad" template is still in active use.',
      lineage: [
        { label: 'Sleek\'N\'Tears photo series', year: 2017, kind: 'origin' },
        { label: '"Yes chad" wojak-adjacent reaction template', year: 2020, kind: 'derivative' },
        { label: 'First tokenisation wave on BSC and ETH', year: 2023, kind: 'revival' },
        { label: 'This token', year: 2026, kind: 'revival' },
      ],
      priorCycles: [
        { name: 'GIGA (Gigachad)', ticker: 'GIGA', chain: 'solana', year: 2024, peakMarketCapUsd: 780_000_000, outcome: 'still-alive', note: 'The heavyweight incumbent; still liquid.' },
        { name: 'CHAD (BSC)', ticker: 'CHAD', chain: 'bsc', year: 2023, peakMarketCapUsd: 14_000_000, outcome: 'faded' },
      ],
      recycleVerdict: 'revival',
      recycleGeneration: 2,
      memeticDurability: 81,
      culturalReach: 74,
      authenticityScore: 58,
      speculativeSetup:
        'A durable archetype meme on its second monetisation, but with a large, still-alive incumbent on another chain. The bull case is chain-local: ETH-native holders who will not bridge for the Solana instance. The bear case is that canonical status is already taken, which caps the ceiling regardless of how well this one is run.',
      risks: [
        'A far larger incumbent already owns the meme\'s canonical slot.',
        'Top 10 concentration at 31% leaves room for a coordinated exit.',
        'No differentiation beyond the chain it launched on.',
      ],
      confidence: 0.74,
      evidence: [
        { kind: 'knowyourmeme', url: 'https://knowyourmeme.com/memes/gigachad-berlin-creep', title: 'GigaChad', snippet: 'GigaChad refers to a series of black-and-white photographs of a heavily muscular male model.', retrievedAt: '2026-09-21T09:15:00.000Z', sourceQuality: 0.88 },
        { kind: 'onchain', title: 'Incumbent liquidity check', snippet: 'GIGA on Solana holds >$40m liquidity across three pools as of this run.', retrievedAt: '2026-09-21T09:16:00.000Z', sourceQuality: 0.8 },
      ],
      usage: { inputTokens: 14_900, outputTokens: 1_780, costUsd: 0.17 },
    },
    score: {
      total: 79,
      tier: 'A',
      components: { recycling: 82, memetic: 78, distribution: 62, liquidity: 71, momentum: 84, authenticity: 58 },
      penalties: [{ reason: 'Top 10 concentration above 30%', points: -4 }],
    },
    history: { total: 72, tier: 'B', volume24hUsd: 2_600_000, bestRank: 9 },
  },

  {
    chain: 'solana',
    address: '7xKq2mWfEr4tLpQ9vNdA3cZyB6HsJu1RgTnMaXeP5cUv',
    symbol: 'MOONMAN',
    name: 'Moon Man',
    description: 'The 2011 McDonald\'s mascot meme, third time around.',
    imageUrl: 'https://static.example.cdn/tokens/moonman.png',
    socials: { twitter: 'https://x.com/moonmansol', telegram: 'https://t.me/moonmansol' },
    bestRank: 2,
    sources: [
      { source: 'dextools', rank: 2 },
      { source: 'dexscreener', rank: 6 },
      { source: 'geckoterminal', rank: 4 },
    ],
    metrics: {
      priceUsd: 0.00934,
      fdvUsd: 9_340_000,
      marketCapUsd: 9_340_000,
      liquidityUsd: 420_000,
      volume1hUsd: 260_000,
      volume6hUsd: 1_100_000,
      volume24hUsd: 3_900_000,
      priceChange1h: 7.3,
      priceChange6h: 31.5,
      priceChange24h: 118.4,
      txns24h: { buys: 12_800, sells: 9_400 },
      ageHours: 31,
    },
    pair: { pairAddress: 'FzQ9mR2vTkLp7yXaB4nEdJu6WgHs1CcRtNvMxA3ePqZ8', dexId: 'raydium', quoteSymbol: 'SOL', liquidityUsd: 420_000 },
    chainAnalysis: {
      method: 'rpc',
      supply: { total: 1_000_000_000, decimals: 6 },
      holderCount: 2_690,
      top10Pct: 27.8,
      top20Pct: 35.4,
      herfindahl: 0.021,
      gini: 0.69,
      lpBurnedPct: 100,
      mintAuthorityActive: false,
      freezeAuthorityActive: false,
      topHolders: [
        { address: 'FzQ9mR2vTkLp7yXaB4nEdJu6WgHs1CcRtNvMxA3ePqZ8', balance: 62_000_000, pct: 6.2, label: 'liquidity-pool', excludedFromConcentration: true },
        { address: 'BpX4sK9wQe2rTy7uIo1aSd5fGh8jKl3zXc6VbNm0QaZr', balance: 41_000_000, pct: 4.1 },
      ],
      flags: [
        { code: 'mint-authority-revoked', severity: 'info', detail: 'Mint authority revoked; supply is fixed.' },
        { code: 'freeze-authority-revoked', severity: 'info', detail: 'Freeze authority revoked.' },
        { code: 'young-pool', severity: 'warn', detail: 'Pool is 31 hours old; distribution is still forming.' },
      ],
      notes: ['Holder count from getProgramAccounts; a public RPC truncated the tail at 5,000 accounts.'],
      durationMs: 6_840,
    },
    report: {
      memeName: 'Moon Man',
      narrativeCluster: 'nostalgia',
      originYear: 2011,
      originSummary:
        'Moon Man began as Mac Tonight, a 1986 McDonald\'s advertising mascot with a crescent-moon head, and was revived around 2011 as an ironic internet character on image boards. Its history is genuinely mixed: the 2011-2014 wave attached the character to deliberately offensive material, which is part of why it has never been picked up commercially since.',
      lineage: [
        { label: 'Mac Tonight McDonald\'s campaign', year: 1986, kind: 'origin' },
        { label: 'Image-board revival as "Moon Man"', year: 2011, kind: 'revival' },
        { label: 'First tokenisation on Ethereum', year: 2021, kind: 'revival' },
        { label: 'This token on Solana', year: 2026, kind: 'revival' },
      ],
      priorCycles: [
        { name: 'MOONMAN (ERC-20)', ticker: 'MOON', chain: 'ethereum', year: 2021, peakMarketCapUsd: 6_400_000, outcome: 'faded' },
        { name: 'Mac Tonight NFT set', year: 2022, outcome: 'faded', note: 'Small collection, no secondary volume after month two.' },
      ],
      recycleVerdict: 'revival',
      recycleGeneration: 2,
      memeticDurability: 64,
      culturalReach: 47,
      authenticityScore: 71,
      speculativeSetup:
        'A genuinely old meme with a small, loyal audience and one prior tokenisation that faded rather than rugged — which is the better of the two failure modes, because the holders who liked it are still around. The pool is 31 hours old and the chart shows it: distribution has not settled and the 118% day is not a base.',
      risks: [
        'The meme\'s 2011-2014 association with offensive material caps mainstream and exchange reach permanently.',
        'Pool is barely a day old; the holder set can still change shape entirely.',
        'Cultural reach outside the original image-board audience is thin.',
      ],
      confidence: 0.68,
      evidence: [
        { kind: 'knowyourmeme', url: 'https://knowyourmeme.com/memes/moon-man', title: 'Moon Man', snippet: 'Moon Man is a character based on the McDonald\'s mascot Mac Tonight, adopted by image-board users in the early 2010s.', retrievedAt: '2026-09-21T09:18:00.000Z', sourceQuality: 0.85 },
        { kind: 'onchain', title: 'Prior ERC-20 trace', snippet: 'A 2021 ERC-20 with the same name still holds ~$18k liquidity; no rug event in the transfer history.', retrievedAt: '2026-09-21T09:18:00.000Z', sourceQuality: 0.75 },
      ],
      usage: { inputTokens: 12_100, outputTokens: 1_520, costUsd: 0.14 },
    },
    score: {
      total: 68,
      tier: 'B',
      components: { recycling: 74, memetic: 56, distribution: 66, liquidity: 58, momentum: 91, authenticity: 71 },
      penalties: [{ reason: 'Pool younger than 48 hours', points: -6 }],
    },
  },

  {
    chain: 'base',
    address: '0x6E1a4C09Bd73F82a5c04E7b19Da38f6021cB5e90',
    symbol: 'PEPEVANA',
    name: 'Pepevana',
    description: 'Pepe drawn into the Nevermind cover. A crossover, not a clone.',
    imageUrl: 'https://static.example.cdn/tokens/pepevana.png',
    socials: { twitter: 'https://x.com/pepevana', website: 'https://pepevana.example' },
    bestRank: 7,
    sources: [
      { source: 'dexscreener', rank: 7 },
      { source: 'geckoterminal', rank: 11 },
    ],
    metrics: {
      priceUsd: 0.000214,
      fdvUsd: 4_280_000,
      marketCapUsd: 4_280_000,
      liquidityUsd: 310_000,
      volume6hUsd: 640_000,
      volume24hUsd: 1_900_000,
      priceChange1h: 1.2,
      priceChange6h: 6.8,
      priceChange24h: 22.4,
      txns24h: { buys: 2_940, sells: 2_610 },
      ageHours: 64,
    },
    pair: { pairAddress: '0xC40b7dE21a8f53906B4c1eD7a05F38c19Be04217', dexId: 'aerodrome', quoteSymbol: 'WETH', liquidityUsd: 310_000 },
    chainAnalysis: {
      method: 'rpc',
      supply: { total: 20_000_000_000, decimals: 18 },
      holderCount: 1_480,
      top10Pct: 34.6,
      herfindahl: 0.033,
      gini: 0.74,
      creatorHoldingPct: 6.8,
      lpBurnedPct: 100,
      ownerRenounced: true,
      contractVerified: true,
      topHolders: [
        { address: '0xC40b7dE21a8f53906B4c1eD7a05F38c19Be04217', balance: 1_600_000_000, pct: 8.0, label: 'liquidity-pool', excludedFromConcentration: true },
      ],
      flags: [{ code: 'creator-holding', severity: 'warn', detail: 'Creator wallet holds 6.8% with no vesting.' }],
      notes: [],
      durationMs: 2_980,
    },
    report: {
      memeName: 'Pepe x Nevermind',
      narrativeCluster: 'frog',
      originYear: 2005,
      originSummary:
        'Pepe the Frog comes from Matt Furie\'s 2005 comic Boy\'s Club and is the most monetised meme in crypto history. This token does not run Pepe straight: it runs the Nirvana Nevermind cover with Pepe as the swimming baby, which is a distinct visual joke with its own thirty-year-old cultural anchor.',
      lineage: [
        { label: 'Boy\'s Club comic', year: 2005, kind: 'origin' },
        { label: 'Rare Pepe trading cards on Counterparty', year: 2016, kind: 'platform-shift' },
        { label: 'PEPE ERC-20; the reference instance', year: 2023, kind: 'revival' },
        { label: 'Crossover derivatives wave', year: 2025, kind: 'derivative' },
        { label: 'This token', year: 2026, kind: 'derivative' },
      ],
      priorCycles: [
        { name: 'Rare Pepe (Counterparty)', year: 2016, peakMarketCapUsd: 3_000_000, outcome: 'still-alive' },
        { name: 'PEPE', ticker: 'PEPE', chain: 'ethereum', year: 2023, peakMarketCapUsd: 6_900_000_000, outcome: 'still-alive' },
        { name: 'PEPE 2.0', ticker: 'PEPE2', chain: 'ethereum', year: 2023, peakMarketCapUsd: 80_000_000, outcome: 'rugged' },
      ],
      recycleVerdict: 'derivative',
      recycleGeneration: 3,
      memeticDurability: 88,
      culturalReach: 79,
      authenticityScore: 44,
      speculativeSetup:
        'Third-generation Pepe with an actual twist rather than a number appended to the ticker. The crossover gives it a reason to exist and a second audience, but derivatives of a meme whose canonical instance is a multi-billion-dollar token compete for the same attention without any of the liquidity.',
      risks: [
        'The Pepe derivative field is crowded and its base rate is poor — see PEPE 2.0.',
        'Creator holds 6.8% unvested.',
        'Nirvana\'s label has litigated the Nevermind cover before.',
      ],
      confidence: 0.71,
      evidence: [
        { kind: 'knowyourmeme', url: 'https://knowyourmeme.com/memes/pepe-the-frog', title: 'Pepe the Frog', snippet: 'Pepe the Frog is an anthropomorphic frog character from the comic series Boy\'s Club by Matt Furie.', retrievedAt: '2026-09-21T09:20:00.000Z', sourceQuality: 0.9 },
        { kind: 'news', url: 'https://example.news/nevermind-cover-suit', title: 'Nevermind cover litigation dismissed again', snippet: 'The long-running suit over the Nevermind album cover was dismissed for a third time.', publishedAt: '2024-01-12', retrievedAt: '2026-09-21T09:20:00.000Z', sourceQuality: 0.7 },
      ],
      usage: { inputTokens: 13_400, outputTokens: 1_610, costUsd: 0.15 },
    },
    score: {
      total: 63,
      tier: 'B',
      components: { recycling: 61, memetic: 84, distribution: 54, liquidity: 52, momentum: 66, authenticity: 44 },
      penalties: [{ reason: 'Unvested creator allocation above 5%', points: -5 }],
    },
  },

  {
    chain: 'ethereum',
    address: '0xB1c7F03a94De28516bA0d7c4E389f2a6C05dE741',
    symbol: 'CLIPPY',
    name: 'Clippy',
    description: 'It looks like you\'re trying to launch a token.',
    imageUrl: 'https://static.example.cdn/tokens/clippy.png',
    socials: { twitter: 'https://x.com/clippyonchain' },
    bestRank: 12,
    sources: [{ source: 'geckoterminal', rank: 12 }],
    metrics: {
      priceUsd: 0.00061,
      fdvUsd: 6_100_000,
      marketCapUsd: 6_100_000,
      liquidityUsd: 190_000,
      volume6hUsd: 210_000,
      volume24hUsd: 880_000,
      priceChange1h: -4.4,
      priceChange6h: -9.1,
      priceChange24h: 12.6,
      txns24h: { buys: 1_140, sells: 1_320 },
      ageHours: 210,
    },
    pair: { pairAddress: '0x9d02Ae71C5B4f38016aE7c09D24b5F831cA0e6B7', dexId: 'uniswap', quoteSymbol: 'WETH', liquidityUsd: 190_000 },
    chainAnalysis: {
      method: 'partial',
      supply: { total: 10_000_000_000, decimals: 18 },
      holderCount: 902,
      top10Pct: 48.3,
      herfindahl: 0.061,
      gini: 0.83,
      lpBurnedPct: 100,
      ownerRenounced: true,
      contractVerified: false,
      topHolders: [
        { address: '0x9d02Ae71C5B4f38016aE7c09D24b5F831cA0e6B7', balance: 780_000_000, pct: 7.8, label: 'liquidity-pool', excludedFromConcentration: true },
        { address: '0x4F71cB90e2A5d38a16C0b7e4D95f8210aE3cB671', balance: 1_240_000_000, pct: 12.4 },
      ],
      flags: [
        { code: 'top10-high', severity: 'critical', detail: 'Top 10 non-LP holders control 48.3% of supply.' },
        { code: 'unverified-contract', severity: 'warn', detail: 'Source not verified on the public explorer.' },
      ],
      notes: ['Explorer rate-limited the holder page; concentration computed from a 250-holder sample.'],
      durationMs: 8_900,
    },
    report: {
      memeName: 'Clippy (Office Assistant)',
      narrativeCluster: 'nostalgia',
      originYear: 1997,
      originSummary:
        'Clippit — universally "Clippy" — was the animated paperclip assistant shipped with Microsoft Office 97 and retired in 2007. It has had a continuous second life as shorthand for intrusive software helpfulness, and the joke has been reactivated wholesale by the AI-assistant era.',
      lineage: [
        { label: 'Shipped in Office 97', year: 1997, kind: 'origin' },
        { label: 'Retired by Microsoft; becomes a nostalgia object', year: 2007, kind: 'platform-shift' },
        { label: 'Re-adopted as shorthand for AI assistants', year: 2023, kind: 'revival' },
        { label: 'First tokenisation — this one', year: 2026, kind: 'revival' },
      ],
      priorCycles: [],
      recycleVerdict: 'original',
      recycleGeneration: 0,
      memeticDurability: 77,
      culturalReach: 83,
      authenticityScore: 69,
      speculativeSetup:
        'Rare shape: a meme with thirty years of recognition and no prior tokenisation at all, so generation 0 here means untested rather than novel. The narrative timing is good — Clippy is the obvious joke about AI assistants. What undermines it is the token, not the meme: 48% in ten wallets and an unverified contract are the reasons this does not score where its cultural reach would put it.',
      risks: [
        'Top 10 concentration near 50% — one coordinated exit ends the chart.',
        'Contract source is not verified; behaviour cannot be audited from the explorer.',
        'Microsoft owns the character outright.',
        'No prior cycle means no evidence the meme converts attention into holders.',
      ],
      confidence: 0.79,
      evidence: [
        { kind: 'wiki', url: 'https://en.wikipedia.org/wiki/Office_Assistant', title: 'Office Assistant — Wikipedia', snippet: 'Clippit, nicknamed Clippy, was the default Office Assistant in Microsoft Office 97 through 2003.', retrievedAt: '2026-09-21T09:22:00.000Z', sourceQuality: 0.95 },
        { kind: 'onchain', title: 'Prior tokenisation search', snippet: 'No prior ERC-20 or SPL token using this name with meaningful liquidity was found.', retrievedAt: '2026-09-21T09:22:00.000Z', sourceQuality: 0.65 },
      ],
      usage: { inputTokens: 11_800, outputTokens: 1_430, costUsd: 0.13 },
    },
    score: {
      total: 55,
      tier: 'C',
      components: { recycling: 48, memetic: 80, distribution: 22, liquidity: 41, momentum: 44, authenticity: 69 },
      penalties: [
        { reason: 'Top 10 concentration above 45%', points: -12 },
        { reason: 'Contract source unverified', points: -5 },
      ],
    },
  },

  {
    chain: 'solana',
    address: '4pLm9xZaQw2eRt6yUi8oPa1sDf3gHj5kLz7xCv0bNm4Q',
    symbol: 'IDLE',
    name: 'Idle',
    description: 'A quiet-quitting coin. Nobody is sure where it came from.',
    imageUrl: 'https://static.example.cdn/tokens/idle.png',
    socials: { telegram: 'https://t.me/idlecoin' },
    bestRank: 9,
    sources: [
      { source: 'dexscreener', rank: 9 },
      { source: 'dextools', rank: 14 },
    ],
    metrics: {
      priceUsd: 0.00298,
      fdvUsd: 2_980_000,
      marketCapUsd: 2_980_000,
      liquidityUsd: 240_000,
      volume6hUsd: 380_000,
      volume24hUsd: 1_240_000,
      priceChange1h: 3.9,
      priceChange6h: 14.2,
      priceChange24h: 41.7,
      txns24h: { buys: 3_310, sells: 2_980 },
      ageHours: 52,
    },
    pair: { pairAddress: 'Hq3vT8nKp5wRe2yXa7bDcJu4WgFs9CmRtLvMxZ1ePq6U', dexId: 'orca', quoteSymbol: 'SOL', liquidityUsd: 240_000 },
    chainAnalysis: {
      method: 'rpc',
      supply: { total: 1_000_000_000, decimals: 9 },
      holderCount: 1_205,
      top10Pct: 29.4,
      herfindahl: 0.024,
      gini: 0.7,
      lpBurnedPct: 100,
      mintAuthorityActive: false,
      freezeAuthorityActive: true,
      topHolders: [
        { address: 'Hq3vT8nKp5wRe2yXa7bDcJu4WgFs9CmRtLvMxZ1ePq6U', balance: 58_000_000, pct: 5.8, label: 'liquidity-pool', excludedFromConcentration: true },
      ],
      flags: [{ code: 'freeze-authority-active', severity: 'critical', detail: 'Freeze authority is still live; holder accounts can be frozen.' }],
      notes: [],
      durationMs: 5_220,
    },
    report: {
      memeName: 'quiet quitting / antiwork',
      narrativeCluster: 'labour',
      originSummary:
        'The evidence here does not support a confident origin. "Quiet quitting" entered wide circulation in 2022 via TikTok and business press, and sits downstream of the r/antiwork surge of 2021, but the token\'s own branding references neither directly and the team has not claimed a lineage. It may also be an unrelated in-joke from a Telegram group that predates the ticker by a few weeks.',
      lineage: [
        { label: 'r/antiwork mainstream breakout', year: 2021, kind: 'origin', note: 'Plausible ancestor; not claimed by the token.' },
        { label: '"Quiet quitting" enters business press', year: 2022, kind: 'derivative', note: 'Same family, different framing.' },
      ],
      priorCycles: [],
      recycleVerdict: 'unclear',
      recycleGeneration: 0,
      memeticDurability: 38,
      culturalReach: 52,
      authenticityScore: 31,
      speculativeSetup:
        'Marked unclear on purpose. The narrative family is real and widely recognised, but nothing ties this token to it beyond a one-word ticker, and the collected evidence contains no origin claim, no lineage and no prior cycle. Confidence is low and the verdict should be read as "not determined", not as "probably fine". An active freeze authority is a separate and sufficient reason for caution.',
      risks: [
        'Freeze authority still live — holders can be frozen at will.',
        'No verifiable lineage; the meme attribution may be entirely retrofitted.',
        'Labour-politics narratives have no track record of sustaining token cycles.',
      ],
      confidence: 0.24,
      evidence: [
        { kind: 'web', url: 'https://example.news/quiet-quitting-explainer', title: 'What "quiet quitting" actually means', snippet: 'The phrase spread on TikTok in mid-2022 and was quickly picked up by business media.', publishedAt: '2022-08-19', retrievedAt: '2026-09-21T09:24:00.000Z', sourceQuality: 0.6 },
        { kind: 'model-knowledge', title: 'No lineage claim found', snippet: 'No project statement, thread or site connects this token to the antiwork or quiet-quitting narrative.', retrievedAt: '2026-09-21T09:24:00.000Z', sourceQuality: 0.3 },
      ],
      usage: { inputTokens: 9_600, outputTokens: 1_190, costUsd: 0.11 },
    },
    score: {
      total: 47,
      tier: 'C',
      components: { recycling: 30, memetic: 44, distribution: 58, liquidity: 46, momentum: 72, authenticity: 31 },
      penalties: [{ reason: 'Freeze authority active', points: -15 }],
    },
    history: { total: 44, tier: 'C', volume24hUsd: 640_000, bestRank: 16 },
  },

  {
    chain: 'solana',
    address: '9kQw3eRt5yUi7oPa2sDf4gHj6kLz8xCv1bNm0QaZrTp3',
    symbol: 'HAMPTER',
    name: 'Hampter Two',
    description: 'Hampter, again.',
    imageUrl: 'https://static.example.cdn/tokens/hampter2.png',
    socials: { telegram: 'https://t.me/hampter2' },
    bestRank: 18,
    sources: [{ source: 'dextools', rank: 18 }],
    metrics: {
      priceUsd: 0.000087,
      fdvUsd: 870_000,
      marketCapUsd: 870_000,
      liquidityUsd: 61_000,
      volume6hUsd: 140_000,
      volume24hUsd: 410_000,
      priceChange1h: -11.8,
      priceChange6h: -24.3,
      priceChange24h: 9.4,
      txns24h: { buys: 1_910, sells: 2_340 },
      ageHours: 19,
    },
    pair: { pairAddress: 'Lp7yXaB4nEdJu6WgHs1CcRtNvMxA3ePqZ8FzQ9mR2vTk', dexId: 'raydium', quoteSymbol: 'SOL', liquidityUsd: 61_000 },
    chainAnalysis: {
      method: 'rpc',
      supply: { total: 10_000_000_000, decimals: 6 },
      holderCount: 388,
      top10Pct: 71.2,
      herfindahl: 0.128,
      gini: 0.91,
      creatorHoldingPct: 18.4,
      lpBurnedPct: 0,
      lpLockedPct: 0,
      mintAuthorityActive: true,
      freezeAuthorityActive: false,
      topHolders: [
        { address: 'Lp7yXaB4nEdJu6WgHs1CcRtNvMxA3ePqZ8FzQ9mR2vTk', balance: 400_000_000, pct: 4.0, label: 'liquidity-pool', excludedFromConcentration: true },
        { address: 'Cr8atoRwQe2rTy7uIo1aSd5fGh8jKl3zXc6VbNm0QaZr', balance: 1_840_000_000, pct: 18.4, label: 'creator' },
      ],
      flags: [
        { code: 'mint-authority-active', severity: 'critical', detail: 'Mint authority live; supply can be inflated at any time.' },
        { code: 'lp-unlocked', severity: 'critical', detail: 'LP is neither burned nor locked.' },
        { code: 'top10-extreme', severity: 'critical', detail: 'Top 10 non-LP holders control 71.2% of supply.' },
      ],
      notes: [],
      durationMs: 3_310,
    },
    report: {
      memeName: 'Hampter',
      narrativeCluster: 'animal',
      originYear: 2020,
      originSummary:
        'Hampter is the deliberately misspelled hamster image that circulated from around 2020 and was tokenised on Solana in 2023, where it still trades. This is not a revival of a dormant meme: the original token is live, liquid and actively traded right now.',
      lineage: [
        { label: 'Hampter image spreads on Twitter/Discord', year: 2020, kind: 'origin' },
        { label: 'HAMPTER on Solana; still trading', year: 2023, kind: 'revival' },
        { label: 'Copy wave during the 2025 animal rotation', year: 2025, kind: 'derivative' },
        { label: 'This token', year: 2026, kind: 'derivative' },
      ],
      priorCycles: [
        { name: 'HAMPTER', ticker: 'HAMP', chain: 'solana', year: 2023, peakMarketCapUsd: 62_000_000, outcome: 'still-alive', note: 'The live incumbent this token is copying.' },
        { name: 'HAMPTR', ticker: 'HAMPTR', chain: 'solana', year: 2025, peakMarketCapUsd: 1_800_000, outcome: 'rugged' },
      ],
      recycleVerdict: 'copycat',
      recycleGeneration: 3,
      memeticDurability: 41,
      culturalReach: 22,
      authenticityScore: 8,
      speculativeSetup:
        'The negative case for the whole thesis, and worth keeping in the demo for that reason. Recycling a meme only works when the meme is dormant and the canonical slot is open. Here the original is still running, this is the third copy, the previous copy rugged, and the on-chain setup — live mint authority, unlocked LP, 71% in ten wallets, 18% with the creator — matches the shape of the one that rugged. There is no lineage argument to make.',
      risks: [
        'Mint authority is live: supply can be inflated without warning.',
        'LP is neither burned nor locked.',
        'Creator holds 18.4%; top 10 hold 71%.',
        'The meme\'s canonical token is still trading, so there is no vacancy to fill.',
      ],
      confidence: 0.81,
      evidence: [
        { kind: 'onchain', title: 'Incumbent still liquid', snippet: 'The 2023 HAMPTER token shows continuous daily volume and >$3m liquidity through this run.', retrievedAt: '2026-09-21T09:26:00.000Z', sourceQuality: 0.85 },
        { kind: 'onchain', title: 'Prior copy outcome', snippet: 'HAMPTR (2025) liquidity removed in a single transaction 11 days after launch.', retrievedAt: '2026-09-21T09:26:00.000Z', sourceQuality: 0.8 },
        { kind: 'social', url: 'https://x.com/example/status/1', title: 'Community reaction', snippet: 'Replies under the launch post are dominated by accusations of copying the original.', retrievedAt: '2026-09-21T09:26:00.000Z', sourceQuality: 0.4 },
      ],
      usage: { inputTokens: 10_400, outputTokens: 1_260, costUsd: 0.12 },
    },
    score: {
      total: 34,
      tier: 'D',
      components: { recycling: 12, memetic: 34, distribution: 6, liquidity: 18, momentum: 38, authenticity: 8 },
      penalties: [
        { reason: 'Mint authority active', points: -20 },
        { reason: 'LP neither burned nor locked', points: -15 },
        { reason: 'Top 10 concentration above 70%', points: -15 },
      ],
    },
  },

  {
    chain: 'base',
    address: '0xA05c7E31bD94f28a6c01E7b45Da38f9021cB6e77',
    symbol: 'BOOMJAK',
    name: 'Boomer Wojak',
    description: 'Wojak, but boomer. Launched four days after the one that worked.',
    imageUrl: 'https://static.example.cdn/tokens/boomjak.png',
    socials: { telegram: 'https://t.me/boomjak' },
    bestRank: 21,
    sources: [{ source: 'dexscreener', rank: 21 }],
    metrics: {
      priceUsd: 0.0000412,
      fdvUsd: 412_000,
      marketCapUsd: 412_000,
      liquidityUsd: 38_000,
      volume6hUsd: 62_000,
      volume24hUsd: 190_000,
      priceChange1h: -18.4,
      priceChange6h: -41.2,
      priceChange24h: -12.9,
      txns24h: { buys: 810, sells: 1_460 },
      ageHours: 26,
    },
    pair: { pairAddress: '0xD71cB90e2A5d38a16C0b7e4D95f8210aE3cB674F', dexId: 'aerodrome', quoteSymbol: 'WETH', liquidityUsd: 38_000 },
    chainAnalysis: {
      method: 'rpc',
      supply: { total: 10_000_000_000, decimals: 18 },
      holderCount: 214,
      top10Pct: 63.9,
      herfindahl: 0.104,
      gini: 0.88,
      creatorHoldingPct: 11.2,
      lpBurnedPct: 0,
      lpLockedPct: 30,
      ownerRenounced: false,
      contractVerified: true,
      buyTaxPct: 4,
      sellTaxPct: 9,
      topHolders: [
        { address: '0xD71cB90e2A5d38a16C0b7e4D95f8210aE3cB674F', balance: 320_000_000, pct: 3.2, label: 'liquidity-pool', excludedFromConcentration: true },
        { address: '0x11aC7b93e5D2f48016Ae0c79D34b5F821cA9e6B2', balance: 1_120_000_000, pct: 11.2, label: 'creator' },
      ],
      flags: [
        { code: 'asymmetric-tax', severity: 'critical', detail: 'Sell tax 9% against a 4% buy tax.' },
        { code: 'owner-not-renounced', severity: 'critical', detail: 'Owner retains the ability to change tax parameters.' },
        { code: 'lp-partially-locked', severity: 'warn', detail: 'Only 30% of LP is locked.' },
      ],
      notes: [],
      durationMs: 2_640,
    },
    report: {
      memeName: 'Boomer Wojak',
      narrativeCluster: 'wojak',
      originYear: 2010,
      originSummary:
        'Wojak ("Feels Guy") dates from a 2010 Polish image board, and the generational variants — Boomer, Zoomer, Doomer — were codified around 2018. The variants are a well-worn template, which is exactly why they are easy to copy and hard to own.',
      lineage: [
        { label: 'Wojak appears on vichan', year: 2010, kind: 'origin' },
        { label: 'Generational variant set codified', year: 2018, kind: 'derivative' },
        { label: 'ZOOMJAK launches on Base and runs', year: 2026, kind: 'derivative', note: 'Four days before this token.' },
        { label: 'This token', year: 2026, kind: 'derivative' },
      ],
      priorCycles: [
        { name: 'ZOOMJAK', ticker: 'ZOOMJAK', chain: 'base', year: 2026, peakMarketCapUsd: 24_000_000, outcome: 'still-alive', note: 'Currently running. This token is its copy.' },
        { name: 'WOJAK', ticker: 'WOJAK', chain: 'ethereum', year: 2023, peakMarketCapUsd: 90_000_000, outcome: 'faded' },
      ],
      recycleVerdict: 'copycat',
      recycleGeneration: 4,
      memeticDurability: 55,
      culturalReach: 36,
      authenticityScore: 5,
      speculativeSetup:
        'Launched four days after ZOOMJAK, into the same audience, on the same chain, with the same artwork style and no differentiation beyond swapping which generation the wojak belongs to. The thesis explicitly distinguishes this from a revival: nothing was rediscovered, a live trade was cloned. A 9% sell tax against a 4% buy tax and an un-renounced owner are the mechanism by which that gets monetised.',
      risks: [
        'Asymmetric sell tax with the owner still able to raise it.',
        'Only 30% of LP locked.',
        'Top 10 hold 63.9%; 214 holders in total.',
        'Down 41% in six hours with sells outnumbering buys nearly two to one.',
      ],
      confidence: 0.88,
      evidence: [
        { kind: 'onchain', title: 'Launch timing', snippet: 'Pool created 4 days and 6 hours after the ZOOMJAK pool on the same DEX.', retrievedAt: '2026-09-21T09:28:00.000Z', sourceQuality: 0.9 },
        { kind: 'knowyourmeme', url: 'https://knowyourmeme.com/memes/wojak-feels-guy', title: 'Wojak / Feels Guy', snippet: 'Wojak is a simple black-outlined drawing of a bald man with a melancholic expression.', retrievedAt: '2026-09-21T09:28:00.000Z', sourceQuality: 0.85 },
      ],
      usage: { inputTokens: 8_900, outputTokens: 1_050, costUsd: 0.1 },
    },
    score: {
      total: 27,
      tier: 'D',
      components: { recycling: 8, memetic: 46, distribution: 11, liquidity: 14, momentum: 9, authenticity: 5 },
      penalties: [
        { reason: 'Asymmetric sell tax with mutable owner', points: -18 },
        { reason: 'LP mostly unlocked', points: -10 },
        { reason: 'Top 10 concentration above 60%', points: -12 },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

function isoAt(base: Date, minutesAgo: number): string {
  return new Date(base.getTime() - minutesAgo * 60_000).toISOString();
}

function buildSnapshot(spec: DemoToken, capturedAt: string, overrides?: { volume24hUsd?: number; bestRank?: number }): TokenSnapshot {
  const id = tokenId(spec.chain, spec.address);
  const bestRank = overrides?.bestRank ?? spec.bestRank;
  const metrics: MarketMetrics = {
    ...spec.metrics,
    ...(overrides?.volume24hUsd !== undefined ? { volume24hUsd: overrides.volume24hUsd } : {}),
  };
  const appearances: TrendingEntry[] = spec.sources.map((entry) => ({
    source: entry.source,
    rank: entry.rank,
    chain: spec.chain,
    tokenAddress: spec.address,
    pairAddress: spec.pair.pairAddress,
    symbol: spec.symbol,
    name: spec.name,
    capturedAt,
    metrics,
    url: spec.pair.url,
  }));
  return {
    tokenId: id,
    chain: spec.chain,
    tokenAddress: spec.address,
    symbol: spec.symbol,
    name: spec.name,
    imageUrl: spec.imageUrl,
    description: spec.description,
    socials: spec.socials,
    metrics,
    pairs: [{ ...spec.pair, createdAt: new Date(Date.parse(capturedAt) - (spec.metrics.ageHours ?? 24) * 3_600_000).toISOString() }],
    appearances,
    bestRank,
    sourceCount: spec.sources.length,
    capturedAt,
  };
}

function buildChain(spec: DemoToken, fetchedAt: string): ChainAnalysis {
  return {
    ...spec.chainAnalysis,
    tokenId: tokenId(spec.chain, spec.address),
    chain: spec.chain,
    tokenAddress: spec.address,
    fetchedAt,
  };
}

function buildReport(spec: DemoToken, generatedAt: string): ProvenanceReport {
  return {
    ...spec.report,
    tokenId: tokenId(spec.chain, spec.address),
    model: MODEL,
    promptVersion: PROMPT_VERSION,
    generatedAt,
  };
}

function buildScore(
  spec: DemoToken,
  computedAt: string,
  overrides?: { total: number; tier: ProvenanceScore['tier'] },
): ProvenanceScore {
  return {
    ...spec.score,
    ...(overrides ?? {}),
    tokenId: tokenId(spec.chain, spec.address),
    computedAt,
  };
}

function delivered(at: string, discordOk = true): DeliveryResult[] {
  const results: DeliveryResult[] = [{ channel: 'telegram', ok: true, at }];
  results.push(
    discordOk
      ? { channel: 'discord', ok: true, at }
      : { channel: 'discord', ok: false, error: 'discord webhook returned 429', at },
  );
  return results;
}

/**
 * Alerts are hand-written rather than derived so the demo shows what the alert
 * rules are *supposed* to produce: one for the thesis working, two for it
 * failing, one for a pure on-chain risk.
 */
function buildAlerts(runId: string, byId: Map<string, DemoToken>, at: string): { alert: Alert; deliveries: DeliveryResult[] }[] {
  const idOf = (symbol: string): string => {
    for (const [id, spec] of byId) if (spec.symbol === symbol) return id;
    return '';
  };
  return [
    {
      alert: {
        id: `${runId}::alert::clean-revival::NYAN`,
        runId,
        tokenId: idOf('NYAN'),
        rule: 'clean-revival',
        severity: 'info',
        title: 'Clean revival: Nyan Cat (generation 1)',
        body:
          'NYAN scores 91 (tier S). Fifteen-year-old meme, one failed prior tokenisation, artist endorsement, LP burned, ownership renounced, top 10 at 18.4%.',
        markdown:
          '*Clean revival — NYAN (S, 91)*\n\n• Meme: Nyan Cat (2011), generation 1\n• Prior cycle: 2022 ERC-20, faded, no rug\n• LP burned, owner renounced, top 10 18.4%\n• 24h volume $12.6M, +64.2%',
        createdAt: at,
        payload: { total: 91, tier: 'S', verdict: 'revival', recycleGeneration: 1 },
      },
      deliveries: delivered(at),
    },
    {
      alert: {
        id: `${runId}::alert::score-threshold::CHAD`,
        runId,
        tokenId: idOf('CHAD'),
        rule: 'score-threshold',
        severity: 'info',
        title: 'Score above threshold: CHAD (79)',
        body: 'CHAD crossed the alert threshold at 79 (tier A), up from 72 in the previous run.',
        markdown: '*Score threshold — CHAD (A, 79)*\n\n• Previous run: 72 (B)\n• Verdict: revival, generation 2\n• Caution: a larger incumbent holds the canonical slot',
        createdAt: at,
        payload: { total: 79, previousTotal: 72, tier: 'A' },
      },
      deliveries: delivered(at, false),
    },
    {
      alert: {
        id: `${runId}::alert::copycat::BOOMJAK`,
        runId,
        tokenId: idOf('BOOMJAK'),
        rule: 'copycat-of-live-meme',
        severity: 'warn',
        title: 'Copycat of a live meme: BOOMJAK',
        body:
          'BOOMJAK launched 4 days after ZOOMJAK into the same audience on the same chain, with an asymmetric sell tax and an un-renounced owner. Scored 27 (tier D).',
        markdown: '*Copycat — BOOMJAK (D, 27)*\n\n• Copies ZOOMJAK, launched 4d earlier and still running\n• Sell tax 9% vs buy tax 4%, owner not renounced\n• 214 holders, top 10 at 63.9%',
        createdAt: at,
        payload: { total: 27, tier: 'D', verdict: 'copycat', copies: 'ZOOMJAK' },
      },
      deliveries: delivered(at),
    },
    {
      alert: {
        id: `${runId}::alert::concentration::HAMPTER`,
        runId,
        tokenId: idOf('HAMPTER'),
        rule: 'concentration-risk',
        severity: 'critical',
        title: 'Critical concentration: HAMPTER (top 10 at 71.2%)',
        body: 'HAMPTER has a live mint authority, unlocked LP and 71.2% of supply in ten wallets. The creator holds 18.4%.',
        markdown: '*Critical risk — HAMPTER (D, 34)*\n\n• Mint authority ACTIVE\n• LP neither burned nor locked\n• Top 10: 71.2%, creator 18.4%',
        createdAt: at,
        payload: { top10Pct: 71.2, mintAuthorityActive: true, lpBurnedPct: 0 },
      },
      deliveries: delivered(at),
    },
  ].filter((entry) => entry.alert.tokenId !== '');
}

/**
 * Writes one complete run (and, by default, a thinner earlier one) into any
 * `ProvenanceStore`. Idempotent: every write is an upsert keyed on
 * (run, token), so re-seeding the same run id replaces rather than duplicates.
 */
export async function seedDemoData(store: ProvenanceStore, opts: SeedOptions = {}): Promise<SeedResult> {
  const now = opts.now ? new Date(opts.now) : new Date();
  await store.migrate();

  const byId = new Map<string, DemoToken>();
  for (const spec of DEMO_TOKENS) byId.set(tokenId(spec.chain, spec.address), spec);

  const withHistory = opts.withHistory ?? true;
  let priorRunId: string | undefined;

  // ---- the earlier run, so first_seen_at and score history mean something ---
  if (withHistory) {
    const priorAt = isoAt(now, 12 * 60);
    priorRunId = makeRunId(new Date(Date.parse(priorAt)));
    await store.startRun(priorRunId);
    const returning = DEMO_TOKENS.filter((spec) => spec.history);
    for (const spec of returning) {
      const history = spec.history;
      if (!history) continue;
      await store.saveSnapshot(
        priorRunId,
        buildSnapshot(spec, priorAt, { volume24hUsd: history.volume24hUsd, bestRank: history.bestRank }),
      );
      await store.saveChainAnalysis(priorRunId, buildChain(spec, priorAt));
      await store.saveProvenance(priorRunId, buildReport(spec, priorAt));
      await store.saveScore(priorRunId, buildScore(spec, priorAt, { total: history.total, tier: history.tier }));
    }
    await store.finishRun(priorRunId, 'ok', {
      discovered: 74,
      afterFilter: 11,
      analysed: returning.length,
      reused: 0,
      alertsFired: 1,
      llmCostUsd: 0.38,
      sourceErrors: [],
      durationMs: 219_400,
    });
    // startRun() stamps started_at with wall-clock time, which would leave the
    // two demo runs microseconds apart. Backdate the earlier one where we can,
    // so latestRun() and the run picker look like a real twice-daily cadence.
    if (store instanceof LibsqlStore) {
      await store.raw.execute({
        sql: 'UPDATE runs SET started_at = ?, finished_at = ? WHERE id = ?',
        args: [priorAt, isoAt(now, 12 * 60 - 4), priorRunId],
      });
    }
  }

  // ---- the run the dashboard opens on ------------------------------------
  const runId = opts.runId ?? makeRunId(now);
  const capturedAt = isoAt(now, 35);
  const analysedAt = isoAt(now, 30);
  const reportedAt = isoAt(now, 22);
  const scoredAt = isoAt(now, 18);
  const alertedAt = isoAt(now, 16);

  await store.startRun(runId);
  for (const spec of DEMO_TOKENS) {
    await store.saveSnapshot(runId, buildSnapshot(spec, capturedAt));
    await store.saveChainAnalysis(runId, buildChain(spec, analysedAt));
    await store.saveProvenance(runId, buildReport(spec, reportedAt));
    await store.saveScore(runId, buildScore(spec, scoredAt));
  }

  const alerts = buildAlerts(runId, byId, alertedAt);
  for (const entry of alerts) await store.saveAlert(entry.alert, entry.deliveries);

  const stats: RunStats = {
    discovered: 87,
    afterFilter: DEMO_TOKENS.length,
    analysed: DEMO_TOKENS.length,
    reused: withHistory ? DEMO_TOKENS.filter((s) => s.history).length : 0,
    alertsFired: alerts.length,
    llmCostUsd: 1.13,
    sourceErrors: [{ source: 'dextools', error: 'trending page timed out on page 2 of 3' }],
    durationMs: 341_900,
  };
  await store.finishRun(runId, 'partial', stats);

  return {
    runId,
    priorRunId,
    tokenIds: DEMO_TOKENS.map((spec) => tokenId(spec.chain, spec.address)),
    alerts: alerts.length,
  };
}

/** Token ids the seed writes, for tests and for the dashboard's fixtures. */
export const DEMO_TOKEN_IDS: string[] = DEMO_TOKENS.map((spec) => tokenId(spec.chain, spec.address));

// `bun run packages/store/src/seed.ts`
if (import.meta.main) {
  const { loadConfig } = await import('@provenance/core');
  const { createStore } = await import('./libsql-store');
  const app = loadConfig();
  const store = createStore(app);
  const result = await seedDemoData(store);
  console.log(
    `seeded ${result.tokenIds.length} tokens, ${result.alerts} alerts into run ${result.runId} at ${app.databaseUrl}` +
      (result.priorRunId ? ` (prior run ${result.priorRunId})` : ''),
  );
  await store.close();
}
