/**
 * Telegram Bot API sink.
 *
 * MarkdownV2 is the fiddliest of the formats here: an unescaped `.` or `-` anywhere in
 * the message makes the API reject the whole send with a 400, and because a rejected
 * send is not an exception it fails silently unless you look. So this sink never
 * forwards the rule's markdown verbatim — it escapes every dynamic character and adds
 * back only the markup it controls.
 */

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

/** Telegram rejects `sendMessage` above this many characters. */
export const TELEGRAM_MAX_CHARS = 4096;

/**
 * Every character Telegram requires to be escaped in MarkdownV2.
 * https://core.telegram.org/bots/api#markdownv2-style
 */
export const MARKDOWN_V2_SPECIALS = '_*[]()~`>#+-=|{}.!';

const ESCAPE_RE = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/** Escapes text for MarkdownV2. Backslash is escaped first-class, not by accident. */
export function escapeMarkdownV2(text: string): string {
  return String(text ?? '').replace(ESCAPE_RE, (char) => `\\${char}`);
}

/** Number of backslashes immediately before the end of the string. */
function trailingBackslashes(text: string): number {
  let count = 0;
  for (let i = text.length - 1; i >= 0 && text[i] === '\\'; i--) count++;
  return count;
}

/**
 * Truncates an already-escaped MarkdownV2 string to `max` characters.
 *
 * Cuts at a paragraph, then a line, then a word boundary, and finally mid-word; then
 * drops a dangling backslash, because slicing through an escape pair would leave an
 * unterminated escape and Telegram would reject the message outright.
 */
export function truncateMarkdownV2(text: string, max: number = TELEGRAM_MAX_CHARS): string {
  if (text.length <= max) return text;
  const suffix = '\n…';
  const limit = Math.max(1, max - suffix.length);
  let cut = text.slice(0, limit);

  const floor = Math.floor(limit * 0.5);
  const paragraph = cut.lastIndexOf('\n\n');
  const line = cut.lastIndexOf('\n');
  const space = cut.lastIndexOf(' ');
  if (paragraph >= floor) cut = cut.slice(0, paragraph);
  else if (line >= floor) cut = cut.slice(0, line);
  else if (space >= floor) cut = cut.slice(0, space);

  if (trailingBackslashes(cut) % 2 === 1) cut = cut.slice(0, -1);
  return `${cut}${suffix}`;
}

/** The full MarkdownV2 payload text for an alert: escaped, formatted, length-capped. */
export function buildTelegramMessage(alert: Alert, max: number = TELEGRAM_MAX_CHARS): string {
  const title = `*${escapeMarkdownV2(alert.title)}*`;
  const severity = `_${escapeMarkdownV2(alert.severity)}_ · \`${escapeMarkdownV2(alert.rule)}\``;
  const body = escapeMarkdownV2(alert.body.startsWith(alert.title) ? alert.body.slice(alert.title.length).trim() : alert.body);
  return truncateMarkdownV2([title, severity, body].filter(Boolean).join('\n\n'), max);
}

export interface TelegramSinkOptions extends BaseSinkOptions {
  botToken?: string;
  chatId?: string;
  /** Overridable for tests; defaults to the public Bot API host. */
  apiBase?: string;
}

export class TelegramSink extends HttpSink {
  readonly channel = 'telegram' as const;
  readonly enabled: boolean;
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly apiBase: string;

  constructor(options: TelegramSinkOptions) {
    super(options);
    this.botToken = options.botToken ?? '';
    this.chatId = options.chatId ?? '';
    this.apiBase = options.apiBase ?? 'https://api.telegram.org';
    // Keyless-optional: without both halves of the credential the sink is inert.
    this.enabled = this.botToken !== '' && this.chatId !== '';
  }

  async send(alert: Alert): Promise<SinkDeliveryResult> {
    if (!this.enabled) return fail('telegram', 'telegram sink is not configured');

    const text = buildTelegramMessage(alert);
    if (this.dryRun) {
      this.logger.info('dry-run: would send telegram message', {
        chatId: this.chatId,
        alertId: alert.id,
        rule: alert.rule,
        chars: text.length,
      });
      return ok('telegram');
    }

    try {
      const response = await this.post(`${this.apiBase}/bot${this.botToken}/sendMessage`, {
        chat_id: this.chatId,
        text,
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      });

      const payload = await this.safeJson(response);
      if (!response.ok) {
        const parameters = payload.parameters as Record<string, unknown> | undefined;
        const retryAfterMs = parseRetryAfterMs(response.headers?.get?.('retry-after'), parameters?.retry_after);
        const description = typeof payload.description === 'string' ? payload.description : response.statusText;
        return fail('telegram', `HTTP ${response.status}: ${description}`, {
          status: response.status,
          transient: isTransientStatus(response.status),
          retryAfterMs,
        });
      }
      if (payload.ok === false) {
        const description = typeof payload.description === 'string' ? payload.description : 'telegram rejected the message';
        return fail('telegram', description, { status: response.status, transient: false });
      }
      return ok('telegram');
    } catch (error) {
      // Network-level problems are worth another attempt; a bad payload is not.
      return fail('telegram', errorMessage(error), { transient: true });
    }
  }
}
