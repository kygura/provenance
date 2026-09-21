/**
 * Public surface of `@provenance/sources`. Other packages import these names —
 * do not rename them.
 */

// Orchestration
export { createSources, discoverTrending } from './discover';
export type { DiscoveryResult, SourceError } from './discover';

// Merge / triage
export { mergeToSnapshots, filterSnapshots, triageOrder, SOURCE_PRECEDENCE, sourcePrecedence } from './merge';
export type { DroppedSnapshot, FilterResult } from './merge';

// Source implementations
export { GeckoTerminalSource } from './geckoterminal';
export { DexScreenerSource } from './dexscreener';
export { DexToolsSource } from './dextools';

// Pure parse helpers (browser-free, fixture-testable)
export {
  parseGeckoTerminalPools,
  parseGeckoTerminalTokenInfo,
  splitGeckoId,
  tokenInfoKey,
  dedupeByToken,
  geckoNetworkFor,
  GECKOTERMINAL_BASE_URL,
  GECKOTERMINAL_ACCEPT,
  GECKOTERMINAL_NETWORKS,
} from './geckoterminal';
export type { GeckoParseOptions, GeckoTerminalSourceOptions } from './geckoterminal';

export {
  parseDexScreenerProfiles,
  parseDexScreenerPairs,
  buildDexScreenerEntries,
  dedupeCandidates,
  chunk,
  DEXSCREENER_BASE_URL,
  DEXSCREENER_BATCH_SIZE,
} from './dexscreener';
export type {
  DexScreenerCandidate,
  DexScreenerPairRow,
  DexScreenerSourceOptions,
} from './dexscreener';

export {
  parseDexToolsXhr,
  parseDexToolsHtml,
  collectRowArrays,
  looksLikeDexToolsPayload,
  resolveDexToolsChain,
  parseAgeText,
  dextoolsSlugFor,
  DEXTOOLS_CHAIN_SLUGS,
} from './dextools-parse';
export type { DexToolsParseOptions } from './dextools-parse';
export { DEXTOOLS_BASE_URL, DEXTOOLS_XHR_PATTERN } from './dextools';
export type { DexToolsSourceOptions } from './dextools';

// Shared building blocks other packages occasionally need
export { readEnrichment, compactEnrichment } from './enrichment';
export type { EnrichedTrendingEntry, TokenEnrichment } from './enrichment';
export { fixturesRoot, fixtureDir, readJsonFixtures, readTextFixtures } from './fixtures';
export { JsonClient, HttpError } from './http';
