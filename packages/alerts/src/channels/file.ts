/**
 * JSONL file sink. One alert per line, appended. Cheap to diff, trivial to upload as a
 * CI artifact, and the only channel that works with no configuration beyond a path.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { Alert } from '@provenance/core';

import { errorMessage, fail, ok, type BaseSinkOptions, type SinkDeliveryResult } from './types';

export interface FileSinkOptions extends Partial<BaseSinkOptions> {
  path?: string;
}

export class FileSink {
  readonly channel = 'file' as const;
  readonly enabled: boolean;
  private readonly path: string;
  private ensured = false;

  constructor(private readonly options: FileSinkOptions = {}) {
    this.path = options.path ?? '';
    this.enabled = this.path !== '';
  }

  async send(alert: Alert): Promise<SinkDeliveryResult> {
    if (!this.enabled) return fail('file', 'file sink is not configured');
    try {
      if (!this.ensured) {
        // Recursive mkdir is idempotent; doing it once per process keeps the hot path clean.
        await mkdir(dirname(this.path), { recursive: true });
        this.ensured = true;
      }
      await appendFile(this.path, `${JSON.stringify(alert)}\n`, 'utf8');
      return ok('file');
    } catch (error) {
      this.options.logger?.warn('file sink failed', { path: this.path, error: errorMessage(error) });
      return fail('file', errorMessage(error), { transient: true });
    }
  }
}
