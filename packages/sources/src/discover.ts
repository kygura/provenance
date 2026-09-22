import type { AppConfig, Logger, SourceConfig, SourceContext, TrendingEntry, TrendingSource } from '@provenance/core';

import { DexScreenerSource } from './dexscreener';
import { DexToolsSource } from './dextools';
import { GeckoTerminalSource } from './geckoterminal';

export interface SourceError {
  source: string;
  error: string;
}

export interface DiscoveryResult {
  entries: TrendingEntry[];
  errors: SourceError[];
}

/** A source that can report non-fatal problems without failing the run. */
interface ErrorReporting {
  drainErrors(): SourceError[];
}

function canReportErrors(source: TrendingSource): source is TrendingSource & ErrorReporting {
  return typeof (source as Partial<ErrorReporting>).drainErrors === 'function';
}

/**
 * Builds one source instance per enabled entry in `pipeline.sources`. The
 * `manual` id exists in the contract for hand-seeded rows and has no scraper,
 * so it is skipped rather than throwing.
 */
export function createSources(app: AppConfig, logger: Logger): TrendingSource[] {
  const sources: TrendingSource[] = [];

  for (const config of app.pipeline.sources) {
    if (!config.enabled) {
      logger.debug('source disabled', { source: config.id });
      continue;
    }
    switch (config.id) {
      case 'geckoterminal':
        sources.push(new GeckoTerminalSource(config));
        break;
      case 'dexscreener':
        sources.push(new DexScreenerSource(config));
        break;
      case 'dextools':
        sources.push(new DexToolsSource(config));
        break;
      default:
        logger.debug('no implementation for source', { source: config.id });
        break;
    }
  }

  return sources;
}

function configFor(app: AppConfig, source: TrendingSource): SourceConfig {
  const found = app.pipeline.sources.find((entry) => entry.id === source.id);
  return found ?? { id: source.id, enabled: true, limit: 30, rateLimitMs: 1500 };
}

/**
 * Runs every enabled source concurrently and returns whatever came back.
 *
 * Contract: this never throws. A source that rejects, hangs past its own
 * timeouts or returns nonsense contributes an entry to `errors` and zero rows;
 * the remaining sources still produce a usable run. Sources are always
 * disposed, including on an abort.
 */
export async function discoverTrending(
  app: AppConfig,
  logger: Logger,
  signal?: AbortSignal,
): Promise<DiscoveryResult> {
  const log = logger.child('discover');
  const sources = createSources(app, log);
  const entries: TrendingEntry[] = [];
  const errors: SourceError[] = [];

  if (sources.length === 0) {
    log.warn('no trending sources enabled');
    return { entries, errors };
  }

  try {
    const results = await Promise.allSettled(
      sources.map(async (source) => {
        const ctx: SourceContext = { config: configFor(app, source), app, logger: log, signal };
        const started = Date.now();
        const rows = await source.fetchTrending(ctx);
        log.info('source finished', {
          source: source.id,
          rows: rows.length,
          ms: Date.now() - started,
        });
        return rows;
      }),
    );

    results.forEach((result, index) => {
      const source = sources[index];
      if (!source) return;
      if (result.status === 'fulfilled') {
        entries.push(...result.value);
      } else {
        const message =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        errors.push({ source: source.id, error: message });
        log.error('source threw', { source: source.id, error: message });
      }
      if (canReportErrors(source)) errors.push(...source.drainErrors());
    });
  } finally {
    await Promise.allSettled(
      sources.map(async (source) => {
        try {
          await source.dispose?.();
        } catch (error) {
          log.debug('dispose failed', {
            source: source.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  }

  log.info('discovery complete', {
    entries: entries.length,
    sources: sources.length,
    errors: errors.length,
  });
  return { entries, errors };
}
