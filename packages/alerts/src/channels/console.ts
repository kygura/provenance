/**
 * Console sink. Always enabled: a run that produced alerts should say so on stdout even
 * when every remote channel is unconfigured, which is the normal state in local dev and CI.
 */

import type { Alert, Logger } from '@provenance/core';

import { errorMessage, fail, ok, type SinkDeliveryResult } from './types';

export interface ConsoleSinkOptions {
  logger?: Logger;
  /** Where the formatted block goes. Injectable so tests can capture it. */
  write?: (line: string) => void;
  /** Terminal width used to draw the rules. */
  width?: number;
}

const SEVERITY_TAG: Record<Alert['severity'], string> = {
  info: 'INFO',
  warn: 'WARN',
  critical: 'CRIT',
};

export function formatForConsole(alert: Alert, width = 78): string {
  const bar = '─'.repeat(Math.max(20, width));
  const header = `${SEVERITY_TAG[alert.severity] ?? 'INFO'}  ${alert.title}`;
  const meta = `rule=${alert.rule}  token=${alert.tokenId}  id=${alert.id}`;
  return [bar, header, meta, bar, alert.body, bar].join('\n');
}

export class ConsoleSink {
  readonly channel = 'console' as const;
  readonly enabled = true;
  private readonly write: (line: string) => void;
  private readonly width: number;

  constructor(private readonly options: ConsoleSinkOptions = {}) {
    this.write = options.write ?? ((line: string) => console.log(line));
    this.width = options.width ?? 78;
  }

  async send(alert: Alert): Promise<SinkDeliveryResult> {
    try {
      this.write(formatForConsole(alert, this.width));
      return ok('console');
    } catch (error) {
      this.options.logger?.warn('console sink failed', { error: errorMessage(error) });
      return fail('console', errorMessage(error));
    }
  }
}
