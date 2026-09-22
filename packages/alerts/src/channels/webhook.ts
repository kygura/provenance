/** Generic webhook sink: the `Alert` as JSON, unmodified, so downstream can re-render it. */

import type { Alert } from '@provenance/core';

import {
  errorMessage,
  fail,
  HttpSink,
  isTransientStatus,
  ok,
  parseRetryAfterMs,
  type BaseSinkOptions,
  type SinkDeliveryResult,
} from './types';

export interface WebhookSinkOptions extends BaseSinkOptions {
  url?: string;
  /** Extra headers, e.g. a shared-secret signature the receiver checks. */
  headers?: Record<string, string>;
}

export class WebhookSink extends HttpSink {
  readonly channel = 'webhook' as const;
  readonly enabled: boolean;
  private readonly url: string;
  private readonly headers: Record<string, string>;

  constructor(options: WebhookSinkOptions) {
    super(options);
    this.url = options.url ?? '';
    this.headers = options.headers ?? {};
    this.enabled = this.url !== '';
  }

  async send(alert: Alert): Promise<SinkDeliveryResult> {
    if (!this.enabled) return fail('webhook', 'webhook sink is not configured');

    if (this.dryRun) {
      this.logger.info('dry-run: would POST alert to webhook', { url: this.url, alertId: alert.id, rule: alert.rule });
      return ok('webhook');
    }

    try {
      const response = await this.post(this.url, alert, this.headers);
      if (!response.ok) {
        const retryAfterMs = parseRetryAfterMs(response.headers?.get?.('retry-after'));
        return fail('webhook', `HTTP ${response.status}: ${response.statusText}`, {
          status: response.status,
          transient: isTransientStatus(response.status),
          retryAfterMs,
        });
      }
      return ok('webhook');
    } catch (error) {
      return fail('webhook', errorMessage(error), { transient: true });
    }
  }
}
