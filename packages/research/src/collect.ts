/**
 * Fan out across every collector, then reduce to an evidence pack that fits in
 * a prompt. Concurrency is bounded because each collector already has its own
 * per-host rate limiter — the limit here is about not opening five sockets at
 * once, not about politeness to any single host.
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
import { KnowYourMemeCollector } from './collectors/knowyourmeme';
import { RedditCollector } from './collectors/reddit';
import { TokenMetaCollector } from './collectors/tokenmeta';
import { WebSearchCollector } from './collectors/websearch';
import { WikipediaCollector } from './collectors/wikipedia';

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
 * tokenmeta is last because it is the one that cannot fail.
 */
export function defaultCollectors(chain?: ChainAnalysis): EvidenceCollector[] {
  return [
    new WikipediaCollector(),
    new KnowYourMemeCollector(),
    new RedditCollector(),
    new WebSearchCollector(),
    new TokenMetaCollector(chain),
  ];
}

/**
 * Gather public evidence about a token's meme.
 *
 * Contract: never throws. A collector that fails contributes nothing and is
 * logged; a run where every web collector fails still returns the zero-network
 * evidence, so the LLM step always has something to reason over.
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
