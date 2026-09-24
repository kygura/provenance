/**
 * Judgement for the launch lane: dexscanner's hard filters, and the two alerts
 * the lane produces.
 *
 * The trending lane scores and ranks; this lane rejects. At launch there is no
 * demand signal yet to outweigh a structural problem, so a token either clears
 * every filter or is not catalogued. That also inverts the trending lane's
 * missing-data policy on purpose: there, unknown is kept for the chain stage to
 * resolve; here the chain stage has already run, so unknown means "could not be
 * shown safe", and that is a rejection.
 *
 * Every reason names the rule, the observed value and the threshold, so a
 * `[REJECT]` log line is enough to tune the config without a debugger.
 */

import {
  formatUsd,
  hashKey,
  isEvm,
  nowIso,
  shortAddress,
  type Alert,
  type ChainAnalysis,
  type LaunchConfig,
  type LaunchGateResult,
  type TokenSnapshot,
  type WatchEntry,
} from '@provenance/core';
import { renderMarketLines, renderRiskFlags, stripMarkdown } from './format';

function gate(reasons: string[]): LaunchGateResult {
  return { passed: reasons.length === 0, reasons };
}

/** Before any RPC: cheap checks on what the market data already says. */
export function gateLaunchMarket(snapshot: TokenSnapshot, config: LaunchConfig): LaunchGateResult {
  const reasons: string[] = [];
  if (!isEvm(snapshot.chain)) reasons.push(`chain: ${snapshot.chain} has no launch-lane contract checks`);
  const liquidity = snapshot.metrics.liquidityUsd;
  if (liquidity === undefined) {
    reasons.push('liquidity: unknown (not yet indexed by a market source)');
  } else if (liquidity < config.minLiquidityUsd) {
    reasons.push(`liquidity: ${formatUsd(liquidity)} < ${formatUsd(config.minLiquidityUsd)}`);
  }
  return gate(reasons);
}

/** Codes that reject outright whatever else the token has going for it. */
const REJECTING_FLAGS = new Set([
  'privileged-mint',
  'privileged-blacklist',
  'privileged-pause',
  'mint-authority-active',
  'freeze-authority-active',
  'single-holder-dominant',
  'top10-concentration-high',
]);

/** After chain analysis: contract safety, LP security, holder distribution. */
export function gateLaunchChain(chain: ChainAnalysis | undefined, config: LaunchConfig): LaunchGateResult {
  if (!chain || chain.method === 'unavailable') {
    return gate(['chain: on-chain analysis unavailable, safety could not be shown']);
  }
  const reasons: string[] = [];

  for (const flag of chain.flags) {
    if (flag.severity === 'critical' && REJECTING_FLAGS.has(flag.code)) {
      reasons.push(`${flag.code}: ${flag.detail}`);
    }
  }

  if (chain.contractVerified === false) reasons.push('contract: source not verified on the explorer');

  const burned = chain.lpBurnedPct;
  const locked = chain.lpLockedPct;
  if (burned === undefined && locked === undefined) {
    if (config.requireLpSecured) reasons.push('lp: burn/lock could not be measured');
  } else {
    // Burned and locked LP are disjoint balances of the same LP supply.
    const secured = Math.min(100, (burned ?? 0) + (locked ?? 0));
    if (secured < config.minLpSecuredPct) {
      reasons.push(`lp: ${secured.toFixed(1)}% burned or locked < ${config.minLpSecuredPct}%`);
    }
  }

  if (chain.holderCount === undefined) {
    reasons.push('holders: count unknown (partial log scan)');
  } else if (chain.holderCount < config.minHolderCount) {
    reasons.push(`holders: ${chain.holderCount} < ${config.minHolderCount}`);
  }

  if (chain.top10Pct === undefined) {
    reasons.push('concentration: top-10 share unknown');
  } else if (chain.top10Pct > config.maxTop10Pct) {
    reasons.push(`concentration: top-10 non-LP ${chain.top10Pct.toFixed(1)}% > ${config.maxTop10Pct}%`);
  }

  return gate(reasons);
}

// ---------------------------------------------------------------------------
// alerts
// ---------------------------------------------------------------------------

function explorerUrl(entry: WatchEntry): string | undefined {
  if (entry.chain === 'ethereum') return `https://etherscan.io/token/${entry.tokenAddress}`;
  if (entry.chain === 'base') return `https://basescan.org/token/${entry.tokenAddress}`;
  return undefined;
}

function build(
  runId: string,
  rule: string,
  entry: WatchEntry,
  severity: Alert['severity'],
  title: string,
  lines: string[],
  payload: Record<string, unknown>,
): Alert {
  const markdown = lines.join('\n');
  return {
    id: hashKey(`${runId}${entry.tokenId}${rule}`),
    runId,
    tokenId: entry.tokenId,
    rule,
    severity,
    title,
    body: stripMarkdown(markdown),
    markdown,
    createdAt: nowIso(),
    payload,
  };
}

/** A launch cleared the gate and the referent check: dexscanner's "new candidate". */
export function launchCataloguedAlert(
  runId: string,
  entry: WatchEntry,
  snapshot: TokenSnapshot,
  chain: ChainAnalysis | undefined,
): Alert {
  const url = explorerUrl(entry);
  const lines = [
    `**Catalogued at launch: $${entry.symbol}** — ${entry.name}`,
    `_Referent_: **${entry.referent.referent || 'unnamed'}** · confidence ${entry.referent.confidence.toUpperCase()}`,
    entry.referent.summary,
    '',
    ...renderMarketLines(snapshot.metrics, chain),
    ...(chain ? renderRiskFlags(chain.flags, 3) : []),
    '',
    `${entry.chain} · ${shortAddress(entry.tokenAddress)}${url ? ` · ${url}` : ''}`,
    '_Watching for its first trending appearance._',
  ];
  return build(
    runId,
    'launch-catalogued',
    entry,
    'info',
    `Catalogued at launch: $${entry.symbol} — ${entry.referent.referent || entry.name}`,
    lines,
    { referent: entry.referent.referent, confidence: entry.referent.confidence, launchedAt: entry.launchedAt },
  );
}

/** A catalogued token reached a trending list: the two perspectives agreeing. */
export function launchExpressedAlert(runId: string, entry: WatchEntry, snapshot: TokenSnapshot): Alert {
  const lead = entry.leadHours === undefined ? 'unknown' : `${entry.leadHours.toFixed(1)}h`;
  const lines = [
    `**Expressed: $${entry.symbol}** was catalogued at launch and is now trending on ${
      entry.expressedOn?.join(', ') || 'a tracked list'
    }.`,
    `_Lead time_: ${lead} from catalogue to first trending appearance.`,
    `_Referent_: ${entry.referent.referent || 'unnamed'} (${entry.referent.confidence})`,
    '',
    ...renderMarketLines(snapshot.metrics, undefined),
    entry.liquidityUsdAtCatalog !== undefined
      ? `• Liquidity at catalogue ${formatUsd(entry.liquidityUsdAtCatalog)}`
      : '',
  ].filter((line, index, all) => line !== '' || all[index - 1] !== '');
  return build(
    runId,
    'launch-expressed',
    entry,
    'warn',
    `Expressed after ${lead}: $${entry.symbol} (${entry.referent.referent || entry.name})`,
    lines,
    { leadHours: entry.leadHours, expressedOn: entry.expressedOn ?? [] },
  );
}
