/**
 * Discord webhook sink. Rich embed, coloured by severity, with the message split so
 * neither Discord limit is hit: 2000 characters of `content`, 4096 of embed description.
 */

import { truncate, type Alert, type RiskSeverity } from '@provenance/core';

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

export const DISCORD_MAX_CONTENT = 2000;
export const DISCORD_MAX_EMBED_DESCRIPTION = 4096;
export const DISCORD_MAX_EMBED_TITLE = 256;
export const DISCORD_MAX_FIELD_VALUE = 1024;

/** Blue for information, amber for something to watch, red for something structural. */
export const SEVERITY_COLORS: Record<RiskSeverity, number> = {
  info: 0x3b82f6,
  warn: 0xf59e0b,
  critical: 0xef4444,
};

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  timestamp?: string;
  footer?: { text: string };
  fields?: DiscordEmbedField[];
}

export interface DiscordPayload {
  content: string;
  embeds: DiscordEmbed[];
}

export function buildDiscordPayload(alert: Alert): DiscordPayload {
  const total = typeof alert.payload.total === 'number' ? alert.payload.total : undefined;
  const tier = typeof alert.payload.tier === 'string' ? alert.payload.tier : undefined;
  const verdict = typeof alert.payload.recycleVerdict === 'string' ? alert.payload.recycleVerdict : 'unknown';
  const meme = typeof alert.payload.memeName === 'string' ? alert.payload.memeName : 'unknown';

  const fields: DiscordEmbedField[] = [
    { name: 'Score', value: truncate(`${total?.toFixed(1) ?? 'n/a'} (tier ${tier ?? '?'})`, DISCORD_MAX_FIELD_VALUE), inline: true },
    { name: 'Verdict', value: truncate(verdict, DISCORD_MAX_FIELD_VALUE), inline: true },
    { name: 'Meme', value: truncate(meme, DISCORD_MAX_FIELD_VALUE), inline: true },
  ];

  return {
    // The content line is what shows in the channel list and in push notifications.
    content: truncate(`**${alert.title}**`, DISCORD_MAX_CONTENT),
    embeds: [
      {
        title: truncate(alert.title, DISCORD_MAX_EMBED_TITLE),
        description: truncate(alert.markdown, DISCORD_MAX_EMBED_DESCRIPTION),
        color: SEVERITY_COLORS[alert.severity] ?? SEVERITY_COLORS.info,
        timestamp: alert.createdAt,
        footer: { text: `${alert.rule} · ${alert.tokenId}` },
        fields,
      },
    ],
  };
}

export interface DiscordSinkOptions extends BaseSinkOptions {
  webhookUrl?: string;
}

export class DiscordSink extends HttpSink {
  readonly channel = 'discord' as const;
  readonly enabled: boolean;
  private readonly webhookUrl: string;

  constructor(options: DiscordSinkOptions) {
    super(options);
    this.webhookUrl = options.webhookUrl ?? '';
    this.enabled = this.webhookUrl !== '';
  }

  async send(alert: Alert): Promise<SinkDeliveryResult> {
    if (!this.enabled) return fail('discord', 'discord sink is not configured');

    const payload = buildDiscordPayload(alert);
    if (this.dryRun) {
      this.logger.info('dry-run: would post discord embed', {
        alertId: alert.id,
        rule: alert.rule,
        chars: payload.embeds[0]?.description.length ?? 0,
      });
      return ok('discord');
    }

    try {
      const response = await this.post(this.webhookUrl, payload);
      if (!response.ok) {
        const body = await this.safeJson(response);
        // Discord puts the wait in the body as fractional seconds.
        const retryAfterMs = parseRetryAfterMs(response.headers?.get?.('retry-after'), body.retry_after);
        const message = typeof body.message === 'string' ? body.message : response.statusText;
        return fail('discord', `HTTP ${response.status}: ${message}`, {
          status: response.status,
          transient: isTransientStatus(response.status),
          retryAfterMs,
        });
      }
      return ok('discord');
    } catch (error) {
      return fail('discord', errorMessage(error), { transient: true });
    }
  }
}
