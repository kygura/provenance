/**
 * Shared sink plumbing.
 *
 * Every sink implements `AlertChannelSink` from core and is non-throwing by contract:
 * a failure becomes `{ ok: false, error }`. Delivery must never take a run down.
 */

import { nowIso, type Alert, type DeliveryResult, type Logger } from '@provenance/core';

/** The subset of `fetch` the sinks use, so tests can inject a stub. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * `DeliveryResult` carries only `ok` and `error`, which is not enough for the
 * dispatcher to tell a 429 (wait and retry) from a 400 (never retry). Sinks return
 * this structurally-compatible superset; anything reading plain `DeliveryResult`
 * ignores the extra fields, and the dispatcher reads them defensively.
 */
export interface SinkDeliveryResult extends DeliveryResult {
  /** True when retrying the same request could plausibly succeed. */
  transient?: boolean;
  /** Server-requested wait before the next attempt, in milliseconds. */
  retryAfterMs?: number;
  /** HTTP status, when there was one. */
  status?: number;
}

export interface BaseSinkOptions {
  logger: Logger;
  /** In a dry run a remote sink logs what it would send and reports success. */
  dryRun?: boolean;
  /** Injectable fetch. Resolved per call so a globally-mocked fetch is picked up. */
  fetchImpl?: FetchLike;
  /** Per-request timeout. */
  timeoutMs?: number;
}

export function ok(channel: DeliveryResult['channel']): SinkDeliveryResult {
  return { channel, ok: true, at: nowIso() };
}

export function fail(
  channel: DeliveryResult['channel'],
  error: string,
  extra: Omit<SinkDeliveryResult, 'channel' | 'ok' | 'at' | 'error'> = {},
): SinkDeliveryResult {
  return { channel, ok: false, error, at: nowIso(), ...extra };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** HTTP statuses where the same request may work on a later attempt. */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status < 600);
}

/**
 * Parses the several shapes services use to say "wait": the standard `Retry-After`
 * header (seconds, or an HTTP date), Telegram's `parameters.retry_after` (seconds)
 * and Discord's `retry_after` (seconds, fractional).
 */
export function parseRetryAfterMs(headerValue: string | null | undefined, bodyValue?: unknown): number | undefined {
  const fromBody = numberish(bodyValue);
  if (fromBody !== undefined) return Math.max(0, Math.round(fromBody * 1000));
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const date = Date.parse(headerValue);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function numberish(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

/** Base for the three HTTP sinks: resolves fetch, applies a timeout, never throws. */
export abstract class HttpSink {
  protected constructor(protected readonly options: BaseSinkOptions) {}

  protected get logger(): Logger {
    return this.options.logger;
  }

  protected get dryRun(): boolean {
    return this.options.dryRun === true;
  }

  protected async post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const impl: FetchLike = this.options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    const timeoutMs = this.options.timeoutMs ?? 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await impl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Reads a JSON body without ever letting a malformed payload throw. */
  protected async safeJson(response: Response): Promise<Record<string, unknown>> {
    try {
      const parsed: unknown = await response.json();
      return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  abstract send(alert: Alert): Promise<SinkDeliveryResult>;
}
