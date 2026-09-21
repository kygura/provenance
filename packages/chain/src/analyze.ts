/**
 * Chain-analysis entry point. Routes a snapshot to the analyser for its chain
 * and guarantees a well-formed `ChainAnalysis` in every case: an unsupported
 * chain, a dead endpoint and a thrown analyser all produce a result the
 * pipeline can store and the dashboard can render.
 */

import {
  nowIso,
  type AnalyzerContext,
  type AppConfig,
  type ChainAnalysis,
  type ChainAnalyzer,
  type Logger,
  type TokenSnapshot,
} from '@provenance/core';
import { createEvmAnalyzer } from './evm';
import { createSolanaAnalyzer } from './solana';
import { createFixtureTransport } from './fixtures';
import { HttpRpcTransport, type RpcTransport, type TransportProvider } from './rpc';

/** A result that says "not measured" without pretending anything was. */
export function unavailableAnalysis(snapshot: TokenSnapshot, note: string): ChainAnalysis {
  return {
    tokenId: snapshot.tokenId,
    chain: snapshot.chain,
    tokenAddress: snapshot.tokenAddress,
    method: 'unavailable',
    topHolders: [],
    flags: [{ code: 'analysis-unavailable', severity: 'info', detail: note }],
    notes: [note],
    fetchedAt: nowIso(),
    durationMs: 0,
  };
}

function defaultTransport(app: AppConfig, logger: Logger): TransportProvider {
  if (app.pipeline.useFixtures) {
    // Built once and reused: the fixture transport reads the fixture tree from
    // disk on construction.
    const pending = createFixtureTransport(logger);
    return () => pending;
  }
  const shared: RpcTransport = new HttpRpcTransport();
  return async () => shared;
}

export function createAnalyzers(app: AppConfig, logger: Logger): ChainAnalyzer[] {
  const transport = defaultTransport(app, logger);
  return [createSolanaAnalyzer(app, logger, transport), createEvmAnalyzer(app, logger, transport)];
}

let cached: { app: AppConfig; analyzers: ChainAnalyzer[] } | null = null;

/**
 * Analyse one token. Never throws: a failure becomes a note on an otherwise
 * valid result, because losing a token's market data over a flaky RPC call
 * would be a worse outcome than reporting that its holders are unknown.
 */
export async function analyzeToken(snapshot: TokenSnapshot, ctx: AnalyzerContext): Promise<ChainAnalysis> {
  const started = Date.now();
  try {
    if (!cached || cached.app !== ctx.app) {
      cached = { app: ctx.app, analyzers: createAnalyzers(ctx.app, ctx.logger) };
    }
    const analyzer = cached.analyzers.find((candidate) => candidate.chains.includes(snapshot.chain));
    if (!analyzer) {
      return unavailableAnalysis(snapshot, `No on-chain analyser implemented for ${snapshot.chain}.`);
    }
    const result = await analyzer.analyze(snapshot, ctx);
    return { ...result, durationMs: result.durationMs ?? Date.now() - started };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    ctx.logger.warn('chain analysis failed', { tokenId: snapshot.tokenId, error: detail });
    const fallback = unavailableAnalysis(snapshot, `Analysis failed: ${detail}`);
    return { ...fallback, durationMs: Date.now() - started };
  }
}
