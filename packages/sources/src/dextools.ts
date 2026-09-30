import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Browser, BrowserContext, Page, Response } from 'playwright';

import {
  type Chain,
  type SourceConfig,
  type SourceContext,
  type TrendingEntry,
  type TrendingSource,
  RateLimiter,
  nowIso,
} from '@provenance/core';

import type { EnrichedTrendingEntry } from './enrichment';
import { readJsonFixtures, readTextFixtures } from './fixtures';
import {
  dextoolsSlugFor,
  looksLikeDexToolsPayload,
  parseDexToolsHtml,
  parseDexToolsXhr,
} from './dextools-parse';
import { dedupeByToken } from './geckoterminal';

export const DEXTOOLS_BASE_URL = 'https://www.dextools.io';

/**
 * The Angular app fetches its own backend; these are the paths worth keeping.
 * Matching on the request URL is far more durable than any DOM selector.
 */
export const DEXTOOLS_XHR_PATTERN = /\/api\/(pair|token|ranking|hotpairs)/i;

/** Ordinary, current desktop Chrome. No spoofing beyond looking like a real browser. */
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export interface DexToolsSourceOptions {
  baseUrl?: string;
  /** Extra wait after the data calls land, for the Angular table to render. */
  settleMs?: number;
  navigationTimeoutMs?: number;
  /** How long to wait after DOMContentLoaded for the app's data calls. */
  dataWaitMs?: number;
}

export class DexToolsSource implements TrendingSource {
  readonly id = 'dextools' as const;
  readonly label = 'DexTools';

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private readonly errors: { source: string; error: string }[] = [];

  constructor(
    private readonly config: SourceConfig,
    private readonly options: DexToolsSourceOptions = {},
  ) {}

  /**
   * DexTools is the one source allowed to come back empty — the other two carry
   * the run — so failures are collected here instead of thrown.
   */
  drainErrors(): { source: string; error: string }[] {
    return this.errors.splice(0, this.errors.length);
  }

  async fetchTrending(ctx: SourceContext): Promise<TrendingEntry[]> {
    const config = ctx.config ?? this.config;
    const logger = ctx.logger.child('dextools');
    const capturedAt = nowIso();

    try {
      const entries = ctx.app.pipeline.useFixtures
        ? await this.fromFixtures(capturedAt)
        : await this.fromBrowser(ctx, config, capturedAt, logger);
      const limited = dedupeByToken(entries).slice(0, Math.max(0, config.limit));
      logger.info('hot pairs parsed', { count: limited.length, fixtures: ctx.app.pipeline.useFixtures });
      return limited;
    } catch (error) {
      // Belt and braces: fetchTrending must never reject.
      const message = error instanceof Error ? error.message : String(error);
      this.errors.push({ source: this.id, error: message });
      logger.warn('dextools failed, continuing without it', { error: message });
      return [];
    }
  }

  async dispose(): Promise<void> {
    try {
      await this.context?.close();
    } catch {
      // already gone
    }
    try {
      await this.browser?.close();
    } catch {
      // already gone
    }
    this.context = null;
    this.browser = null;
  }

  /** Fixture mode prefers the recorded XHR body and only falls back to the DOM. */
  private async fromFixtures(capturedAt: string): Promise<EnrichedTrendingEntry[]> {
    const entries: EnrichedTrendingEntry[] = [];
    for (const file of await readJsonFixtures('dextools')) {
      entries.push(...parseDexToolsXhr(file.data, { capturedAt, startRank: entries.length + 1 }));
    }
    if (entries.length > 0) return entries;

    for (const file of await readTextFixtures('dextools', '.html')) {
      entries.push(...parseDexToolsHtml(file.data, { capturedAt, startRank: entries.length + 1 }));
    }
    return entries;
  }

  /**
   * Chains to visit: explicit env override, else the configured pipeline chains
   * that DexTools has a page for, else the single cross-chain hot-pairs page.
   */
  private chainSlugs(chains: readonly Chain[]): string[] {
    const override = (process.env.PROVENANCE_DEXTOOLS_CHAINS ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (override.length > 0) return override;

    const mapped = chains.map(dextoolsSlugFor).filter((slug): slug is string => slug !== undefined);
    return mapped.length > 0 ? mapped : [''];
  }

  private pageUrl(slug: string): string {
    const base = this.options.baseUrl ?? DEXTOOLS_BASE_URL;
    return slug === '' ? `${base}/app/en/hot-pairs` : `${base}/app/${slug}/hot-pairs`;
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    // Imported lazily so fixture-mode runs (and CI without browsers) never touch it.
    const { chromium } = await import('playwright');
    this.browser = await chromium.launch({
      headless: process.env.PROVENANCE_HEADFUL !== '1',
    });
    this.context = await this.browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1680, height: 1050 },
      locale: 'en-US',
      timezoneId: 'UTC',
    });
    return this.context;
  }

  private async fromBrowser(
    ctx: SourceContext,
    config: SourceConfig,
    capturedAt: string,
    logger: SourceContext['logger'],
  ): Promise<EnrichedTrendingEntry[]> {
    const slugs = this.chainSlugs(ctx.app.pipeline.chains);
    const limiter = new RateLimiter(Math.max(0, config.rateLimitMs));
    const context = await this.ensureContext();
    const entries: EnrichedTrendingEntry[] = [];

    for (const slug of slugs) {
      try {
        const page = await limiter.run(() => this.scrapePage(context, slug, capturedAt, entries.length + 1, logger));
        entries.push(...page);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.errors.push({ source: `${this.id}:${slug || 'all'}`, error: message });
        logger.warn('dextools chain page failed', { chain: slug || 'all', error: message });
      }
    }

    return entries;
  }

  private async scrapePage(
    context: BrowserContext,
    slug: string,
    capturedAt: string,
    startRank: number,
    logger: SourceContext['logger'],
  ): Promise<EnrichedTrendingEntry[]> {
    const url = this.pageUrl(slug);
    const chain = slug === '' ? undefined : normalizeSlug(slug);
    const page: Page = await context.newPage();
    const captured: unknown[] = [];
    const pending: Promise<void>[] = [];

    // (a) Intercept the app's own backend calls. Attached BEFORE navigation.
    const onResponse = (response: Response): void => {
      const responseUrl = response.url();
      if (!DEXTOOLS_XHR_PATTERN.test(responseUrl)) return;
      pending.push(
        (async () => {
          try {
            const contentType = (response.headers()['content-type'] ?? '').toLowerCase();
            if (!contentType.includes('json')) return;
            captured.push(await response.json());
          } catch {
            // Aborted/streamed bodies are common; ignore and rely on the rest.
          }
        })(),
      );
    };
    page.on('response', onResponse);

    try {
      // DexTools keeps sockets and pollers open, so `networkidle` never comes
      // and the navigation used to burn its whole timeout. Wait for the DOM,
      // then for the app's own data calls to land, bounded either way.
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.options.navigationTimeoutMs ?? 30_000,
      });
      const deadline = Date.now() + (this.options.dataWaitMs ?? 20_000);
      while (Date.now() < deadline) {
        await Promise.allSettled(pending);
        if (captured.some(looksLikeDexToolsPayload)) break;
        await page.waitForTimeout(1_000);
      }
      await page.waitForTimeout(this.options.settleMs ?? 2_000);
      await Promise.allSettled(pending);

      await this.dumpCaptures(slug, captured);

      const fromXhr: EnrichedTrendingEntry[] = [];
      for (const payload of captured) {
        if (!looksLikeDexToolsPayload(payload)) continue;
        fromXhr.push(
          ...parseDexToolsXhr(payload, { capturedAt, chain, startRank: startRank + fromXhr.length }),
        );
      }
      if (fromXhr.length > 0) {
        logger.debug('dextools rows from intercepted xhr', { chain: slug || 'all', count: fromXhr.length });
        return fromXhr;
      }

      // (b) No usable XHR: fall back to the rendered table.
      const html = await page.content();
      const fromDom = parseDexToolsHtml(html, { capturedAt, chain, startRank });
      if (fromDom.length === 0) {
        // (c) Both routes failed. Record it; the run continues without DexTools.
        this.errors.push({
          source: `${this.id}:${slug || 'all'}`,
          error: `no rows from xhr (${captured.length} payloads) or DOM at ${url}`,
        });
        logger.warn('dextools yielded no rows', { chain: slug || 'all', capturedPayloads: captured.length });
      } else {
        logger.debug('dextools rows from DOM fallback', { chain: slug || 'all', count: fromDom.length });
      }
      return fromDom;
    } finally {
      page.off('response', onResponse);
      await page.close().catch(() => undefined);
    }
  }

  /**
   * Optional: write intercepted payloads to disk. This is how the guessed XHR
   * shape gets turned into a real fixture after the first run on a live network.
   */
  private async dumpCaptures(slug: string, captured: unknown[]): Promise<void> {
    const dir = process.env.PROVENANCE_DEXTOOLS_DUMP_DIR;
    if (!dir || captured.length === 0) return;
    try {
      await mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await writeFile(
        join(dir, `dextools-${slug || 'all'}-${stamp}.json`),
        JSON.stringify(captured, null, 2),
        'utf8',
      );
    } catch {
      // Diagnostics only.
    }
  }
}

function normalizeSlug(slug: string): Chain | undefined {
  // Reuse the alias table in core via the parse module's slug map, inverted.
  const entries = Object.entries({
    ether: 'ethereum',
    ethereum: 'ethereum',
    solana: 'solana',
    base: 'base',
    bnb: 'bsc',
    bsc: 'bsc',
    arbitrum: 'arbitrum',
    polygon: 'polygon',
    avalanche: 'avalanche',
    blast: 'blast',
    ton: 'ton',
    sui: 'sui',
  }) as [string, Chain][];
  return entries.find(([key]) => key === slug.toLowerCase())?.[1];
}
