/**
 * Wiring and delivery.
 *
 * `createSinks` turns config into channels — a channel exists only when its credential
 * does, so the whole alerting layer is keyless-optional. `dispatchAlerts` then fans the
 * alerts out with bounded concurrency, retries the failures that are worth retrying,
 * and returns what happened per alert so the run record can persist it.
 */

import {
  mapLimit,
  retry,
  sleep,
  type Alert,
  type AlertChannelSink,
  type AppConfig,
  type DeliveryResult,
  type Logger,
} from '@provenance/core';

import { ConsoleSink } from './channels/console';
import { DiscordSink } from './channels/discord';
import { FileSink } from './channels/file';
import { TelegramSink } from './channels/telegram';
import { WebhookSink } from './channels/webhook';
import type { FetchLike, SinkDeliveryResult } from './channels/types';

export interface CreateSinksOptions {
  /** Injectable fetch, for tests and for proxied environments. */
  fetchImpl?: FetchLike;
  /** Where the console sink writes. */
  write?: (line: string) => void;
}

/**
 * Builds the sink list for a config. The console sink is unconditional; every other
 * channel is added only when its configuration is present, so an unconfigured run
 * still prints its alerts instead of silently dropping them.
 */
export function createSinks(app: AppConfig, logger: Logger, options: CreateSinksOptions = {}): AlertChannelSink[] {
  const base = {
    logger: logger.child('alerts'),
    dryRun: app.pipeline.dryRun,
    fetchImpl: options.fetchImpl,
  };
  const sinks: AlertChannelSink[] = [new ConsoleSink({ logger: base.logger, write: options.write })];

  const { telegramBotToken, telegramChatId, discordWebhookUrl, genericWebhookUrl, fileSink } = app.alerts;

  if (telegramBotToken && telegramChatId) {
    sinks.push(new TelegramSink({ ...base, botToken: telegramBotToken, chatId: telegramChatId }));
  }
  if (discordWebhookUrl) sinks.push(new DiscordSink({ ...base, webhookUrl: discordWebhookUrl }));
  if (genericWebhookUrl) sinks.push(new WebhookSink({ ...base, url: genericWebhookUrl }));
  if (fileSink) sinks.push(new FileSink({ logger: base.logger, path: fileSink }));

  return sinks.filter((sink) => sink.enabled);
}

export interface DispatchOptions {
  /** How many alerts are in flight at once. */
  concurrency?: number;
  /** Total attempts per sink per alert, including the first. */
  attempts?: number;
  /** Backoff base for `retry`; tests drive this to ~1ms. */
  baseDelayMs?: number;
  /** Upper bound on a server-requested wait, so a hostile `retry_after` cannot stall a run. */
  maxRetryAfterMs?: number;
}

/** Marker so `retry` can tell "worth another go" from "give up now". */
class TransientDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientDeliveryError';
  }
}

function asSinkResult(result: DeliveryResult): SinkDeliveryResult {
  return result as SinkDeliveryResult;
}

/**
 * Sends one alert to one sink, retrying transient failures.
 *
 * Sinks report failure as a value rather than an exception, so the retry loop converts
 * a transient result into a throw purely to drive `retry`'s backoff, and honours a
 * server-supplied `retry_after` before doing so — a 429 that says "3 seconds" means
 * three seconds, not whatever the exponential schedule happened to pick.
 */
async function sendWithRetry(
  sink: AlertChannelSink,
  alert: Alert,
  logger: Logger,
  options: Required<Pick<DispatchOptions, 'attempts' | 'baseDelayMs' | 'maxRetryAfterMs'>>,
): Promise<DeliveryResult> {
  let last: SinkDeliveryResult | undefined;

  try {
    await retry(
      async () => {
        const result = asSinkResult(await sink.send(alert));
        last = result;
        if (result.ok) return result;
        if (result.transient !== true) throw new Error(result.error ?? 'delivery failed');
        if (result.retryAfterMs !== undefined && result.retryAfterMs > 0) {
          await sleep(Math.min(result.retryAfterMs, options.maxRetryAfterMs));
        }
        throw new TransientDeliveryError(result.error ?? 'transient delivery failure');
      },
      {
        attempts: options.attempts,
        baseDelayMs: options.baseDelayMs,
        retryable: (error) => error instanceof TransientDeliveryError,
        onRetry: (error, attempt) => {
          logger.warn('alert delivery retry', {
            channel: sink.channel,
            alertId: alert.id,
            attempt,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      },
    );
  } catch {
    // Every failure path already produced a `last`; the throw only drove the backoff.
  }

  return (
    last ?? {
      channel: sink.channel,
      ok: false,
      error: 'sink produced no result',
      at: new Date().toISOString(),
    }
  );
}

/**
 * Delivers every alert to every enabled sink.
 *
 * Alerts run with bounded concurrency; the sinks for one alert run sequentially so a
 * burst does not hammer a single channel's rate limit from several directions at once.
 * Returns a map from alert id to that alert's per-channel results.
 */
export async function dispatchAlerts(
  alerts: readonly Alert[],
  sinks: readonly AlertChannelSink[],
  logger: Logger,
  options: DispatchOptions = {},
): Promise<Map<string, DeliveryResult[]>> {
  const settings = {
    attempts: options.attempts ?? 3,
    baseDelayMs: options.baseDelayMs ?? 500,
    maxRetryAfterMs: options.maxRetryAfterMs ?? 30_000,
  };
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const enabled = sinks.filter((sink) => sink.enabled);
  const out = new Map<string, DeliveryResult[]>();
  if (alerts.length === 0 || enabled.length === 0) {
    for (const alert of alerts) out.set(alert.id, []);
    return out;
  }

  const results = await mapLimit(alerts, concurrency, async (alert) => {
    const delivered: DeliveryResult[] = [];
    for (const sink of enabled) {
      delivered.push(await sendWithRetry(sink, alert, logger, settings));
    }
    const failed = delivered.filter((result) => !result.ok);
    if (failed.length > 0) {
      logger.warn('alert partially delivered', {
        alertId: alert.id,
        rule: alert.rule,
        failed: failed.map((result) => `${result.channel}: ${result.error ?? 'unknown'}`),
      });
    }
    return { id: alert.id, delivered };
  });

  for (const entry of results) out.set(entry.id, entry.delivered);
  return out;
}
