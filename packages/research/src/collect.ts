/**
 * Assemble the evidence pack the research pass starts from.
 *
 * This used to fan out across scrapers for Wikipedia, Know Your Meme, Reddit
 * and DuckDuckGo's HTML. Search is now the model's own server-side tool, which
 * does that job without breaking every time one of those sites reflows its
 * markup — so what is left here is the zero-network collector, which turns what
 * the pipeline already measured into evidence rows.
 *
 * The fan-out shape is kept because `collectors` is injectable: a deployment
 * that wants a private corpus, an internal index or a paid search API adds a
 * collector here without touching the analyst.
 */
import type {
  ChainAnalysis,
  EvidenceCollector,
  EvidenceItem,
  ResearchContext,
  TokenSnapshot,
} from '@provenance/core';
import { mapLimit } from '@provenance/core';
import { MAX_EVIDENCE_CHARS, MAX_EVIDENCE_ITEMS, normalizeEvidence, type TrimOptions } from './evidence';
import { TokenMetaCollector } from './collectors/tokenmeta';

export interface CollectOptions extends TrimOptions {
  /** Feeds the zero-network collector; omitted when chain analysis failed. */
  chain?: ChainAnalysis;
  /** Override the collector set (tests, or a reduced run). */
  collectors?: EvidenceCollector[];
  /** How many collectors run at once. */
  concurrency?: number;
}

/**
 * Collector order matters only for logs; quality ordering happens at trim time.
 * tokenmeta is the one that cannot fail, which is why it is the whole default
 * set: the research pass must always have something to open on.
 */
export function defaultCollectors(chain?: ChainAnalysis): EvidenceCollector[] {
  return [new TokenMetaCollector(chain)];
}

/**
 * Gather starting evidence about a token's meme.
 *
 * Contract: never throws. A collector that fails contributes nothing and is
 * logged; a run where every collector fails still returns an empty pack, and
 * the research pass treats that as a signal rather than an error.
 */
export async function collectEvidence(
  snapshot: TokenSnapshot,
  ctx: ResearchContext,
  options: CollectOptions = {},
): Promise<EvidenceItem[]> {
  const log = ctx.logger.child('collect');
  const collectors = options.collectors ?? defaultCollectors(options.chain);

  const batches = await mapLimit(collectors, options.concurrency ?? 3, async (collector) => {
    const started = Date.now();
    try {
      const items = await collector.collect(snapshot, ctx);
      log.debug('collector finished', {
        collector: collector.id,
        items: items.length,
        ms: Date.now() - started,
      });
      return items;
    } catch (error) {
      // EvidenceCollector.collect is documented as non-throwing; this is the
      // backstop for the ones that break that promise.
      log.warn('collector threw', { collector: collector.id, error: String(error) });
      return [];
    }
  });

  const flat = batches.flat();
  const kept = normalizeEvidence(flat, {
    maxItems: options.maxItems ?? MAX_EVIDENCE_ITEMS,
    maxChars: options.maxChars ?? MAX_EVIDENCE_CHARS,
    ...(options.maxSnippetChars !== undefined ? { maxSnippetChars: options.maxSnippetChars } : {}),
  });

  log.info('evidence collected', {
    tokenId: snapshot.tokenId,
    raw: flat.length,
    kept: kept.length,
    chars: kept.reduce((sum, item) => sum + item.snippet.length, 0),
  });
  return kept;
}
