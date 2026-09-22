import type { RiskSeverity } from './onchain';

export type AlertChannel = 'telegram' | 'discord' | 'webhook' | 'console' | 'file';

export interface Alert {
  id: string;
  runId: string;
  tokenId: string;
  /** Identifier of the rule that fired, e.g. "clean-revival". */
  rule: string;
  severity: RiskSeverity;
  title: string;
  /** Plain-text body, used by channels without formatting. */
  body: string;
  /** Markdown body for Telegram/Discord. */
  markdown: string;
  createdAt: string;
  payload: Record<string, unknown>;
}

export interface DeliveryResult {
  channel: AlertChannel;
  ok: boolean;
  error?: string;
  at: string;
}
