/**
 * Judgement for the launch lane: the hard filters that keep garbage away from
 * the anchor check, and the two alerts the lane produces.
 *
 * The gates do not decide whether a token is worth anything — the anchor verdict
 * does. They only decide whether it is worth asking: a token whose deployer can
 * still mint or blacklist is not an investable carrier of any meme, however real. That also inverts the trending lane's
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
  type ProvenanceReport,
  type TokenSnapshot,
  type WatchEntry,
} from '@provenance/core';
import { renderAnchorLine, renderMarketLines, renderPriorCycles, renderRiskFlags, stripMarkdown } from './format';

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
  const age = snapshot.metrics.ageHours;
  if (age !== undefined && age > config.maxAgeHours) {
    reasons.push(`age: deepest pool is ${Math.round(age)} h old > ${config.maxAgeHours} h, an established token's new pool`);
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

  // What a top-10 ceiling misses: supply taken before anyone outside the
  // launch could see the pool, then spread thin.
  const snipe = chain.sniping;
  if (snipe === undefined) {
    reasons.push('sniping: early buying not measured (scan did not reach the start of trading)');
  } else if (snipe.earlyBuyPct > config.maxSnipedPct) {
    reasons.push(
      `sniping: ${snipe.earlyBuyPct.toFixed(1)}% of supply bought by ${snipe.earlyBuyers} wallet(s) in the first ` +
        `${snipe.windowBlocks} block(s) > ${config.maxSnipedPct}%`,
    );
  }

  // The same cabal spread over minutes: wallets funded from one source.
  const funding = chain.funding;
  if (funding !== undefined && funding.clusteredPct > config.maxClusteredPct) {
    reasons.push(
      `funding: ${funding.clusteredPct.toFixed(1)}% of supply bought by early wallets sharing a funder ` +
        `(${funding.clusters.length} cluster(s)) > ${config.maxClusteredPct}%`,
    );
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

/**
 * A launch cleared the gate and was judged anchored — the alert this project
 * exists to send, at launch rather than after the token trends. When the full
 * research already ran, its lineage rides along as supporting detail.
 */
export function launchAnchoredAlert(
  runId: string,
  entry: WatchEntry,
  snapshot: TokenSnapshot,
  chain: ChainAnalysis | undefined,
  report?: ProvenanceReport,
): Alert {
  const url = explorerUrl(entry);
  // The entry holds the lane's final verdict; the report's own anchor may be
  // a low-confidence one the lane chose not to act on.
  const anchor = entry.anchor;
  const lines = [
    `**Anchored at launch: $${entry.symbol}** — ${entry.name}`,
    ...renderAnchorLine(anchor),
    '',
    ...(report
      ? [
          `_Meme_: ${report.memeName}${report.originYear !== undefined ? ` (${report.originYear})` : ''} · ${report.recycleVerdict}, generation ${report.recycleGeneration}`,
          ...renderPriorCycles(report.priorCycles).slice(0, 3),
          '',
        ]
      : []),
    ...renderMarketLines(snapshot.metrics, chain),
    ...(chain ? renderRiskFlags(chain.flags, 3) : []),
    '',
    `${entry.chain} · ${shortAddress(entry.tokenAddress)}${url ? ` · ${url}` : ''}`,
  ];
  return build(
    runId,
    'launch-anchored',
    entry,
    anchor.confidence === 'high' ? 'critical' : 'warn',
    `Anchored at launch: $${entry.symbol} — ${anchor.subject || entry.name}`,
    lines,
    {
      verdict: anchor.verdict,
      anchorType: anchor.type,
      anchorDate: anchor.anchorDate,
      precedesLaunch: anchor.precedesLaunch,
      confidence: anchor.confidence,
      researched: report !== undefined,
      launchedAt: entry.launchedAt,
    },
  );
}

/**
 * A judged launch reached a trending list: the outcome, recorded against the
 * verdict that came first. Fires for dismissed tokens too — a forced meme that
 * trended anyway is worth knowing about, and is labelled as exactly that.
 */
export function launchExpressedAlert(runId: string, entry: WatchEntry, snapshot: TokenSnapshot): Alert {
  const lead = entry.leadHours === undefined ? 'unknown' : `${entry.leadHours.toFixed(1)}h`;
  const verdict = entry.anchor.verdict;
  const lines = [
    `**Trending: $${entry.symbol}**, judged **${verdict}** at launch, is now on ${
      entry.expressedOn?.join(', ') || 'a tracked list'
    }.`,
    `_Since verdict_: ${lead}.`,
    ...renderAnchorLine(entry.anchor),
    '',
    ...renderMarketLines(snapshot.metrics, undefined),
    ...(entry.liquidityUsdAtCatalog !== undefined
      ? [`• Liquidity at verdict ${formatUsd(entry.liquidityUsdAtCatalog)}`]
      : []),
  ];
  return build(
    runId,
    'launch-expressed',
    entry,
    verdict === 'anchored' ? 'warn' : 'info',
    `Trending ${lead} after an ${verdict} verdict: $${entry.symbol}`,
    lines,
    { leadHours: entry.leadHours, expressedOn: entry.expressedOn ?? [], verdict },
  );
}
