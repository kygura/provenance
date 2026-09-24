import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  AnchorChip,
  ChainBadge,
  Delta,
  EmptyState,
  ExternalLink,
  Mark,
  Panel,
  SetupScreen,
  SeverityChip,
  SiteNav,
  Stat,
  TierChip,
  VerdictChip,
} from '@/components/ui';
import { ConcentrationBar, Meter, ScoreBreakdown, Sparkline } from '@/components/viz';
import { getDossier, scoreHistory } from '@/lib/data';
import {
  clean,
  cleanProse,
  formatAgo,
  formatCount,
  formatDateTime,
  formatPctPlain,
  hostOf,
  safeHref,
} from '@/lib/format';
import { evidenceQuality, lineageToken, methodHint, outcomeToken } from '@/lib/vocab';
import { formatUsd, shortAddress } from '@provenance/core';

export const dynamic = 'force-dynamic';

export default async function TokenPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tokenId = decodeURIComponent(id);

  const [dossierResult, historyResult] = await Promise.all([getDossier(tokenId), scoreHistory(tokenId)]);
  if (!dossierResult.ok) {
    return (
      <>
        <SiteNav current="run" />
        <SetupScreen {...dossierResult.problem} />
      </>
    );
  }
  const dossier = dossierResult.value;
  if (!dossier) notFound();

  const { snapshot, chain, provenance, score, alerts } = dossier;
  const history = historyResult.ok ? historyResult.value : [];
  const m = snapshot.metrics;

  return (
    <>
      <SiteNav current="run" />
      <div className="flex flex-col gap-3 px-3 py-3">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-hair pb-3">
          <div className="min-w-0">
            <h1 className="flex flex-wrap items-baseline gap-2">
              <span className="num text-[20px] font-semibold tracking-tight text-ink">{clean(snapshot.symbol)}</span>
              <span className="text-[13px] text-ink-2">{clean(snapshot.name)}</span>
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-muted">
              <ChainBadge chain={snapshot.chain} />
              <code className="num" title={snapshot.tokenAddress}>{shortAddress(snapshot.tokenAddress, 6, 6)}</code>
              <span>seen {formatAgo(snapshot.capturedAt)}</span>
              <span>{snapshot.sourceCount} source{snapshot.sourceCount === 1 ? '' : 's'}</span>
              <span>best rank #{snapshot.bestRank}</span>
            </div>
          </div>
          <TierChip tier={score?.tier} />
        </header>

        {alerts.length > 0 && (
          <Panel title="Alerts fired">
            <ul className="flex flex-col gap-2">
              {alerts.map((alert) => (
                <li key={alert.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <SeverityChip severity={alert.severity} />
                  <code className="num text-[11px] text-ink-muted">{clean(alert.rule)}</code>
                  <span className="text-[12px] text-ink-2">{clean(alert.title)}</span>
                </li>
              ))}
            </ul>
          </Panel>
        )}

        {/* The anchor verdict is the question the project answers, so it leads. */}
        {provenance?.anchor && (
          <Panel title="Anchor" subtitle="Is there a real anchor, or is the meme being pushed?">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-[16px] text-ink">
                  {clean(provenance.anchor.subject) || 'No anchor found'}
                </h2>
                <p className="mt-0.5 text-[11px] text-ink-muted">
                  {provenance.anchor.type.replace('-', ' ')}
                  {provenance.anchor.anchorDate && (
                    <>
                      {' · dated '}
                      <span className="num text-ink-2">{clean(provenance.anchor.anchorDate, 40)}</span>
                    </>
                  )}
                  {provenance.anchor.precedesLaunch === true && ' · before the token launched'}
                  {provenance.anchor.precedesLaunch === false && (
                    <span className="text-ink"> · AFTER the token launched</span>
                  )}
                  {` · ${provenance.anchor.confidence} confidence`}
                </p>
              </div>
              <AnchorChip verdict={provenance.anchor.verdict} />
            </div>
            <p className="mt-3 max-w-[70ch] text-[12px] leading-relaxed text-ink-2">
              {cleanProse(provenance.anchor.summary)}
            </p>
            {provenance.anchor.earliestSource && (
              <p className="mt-2 text-[11px] text-ink-muted">
                Earliest independent source:{' '}
                {safeHref(provenance.anchor.earliestSource.url) ? (
                  <a
                    href={safeHref(provenance.anchor.earliestSource.url)}
                    rel="noopener noreferrer nofollow"
                    target="_blank"
                    className="text-ink-2 hover:underline"
                  >
                    {clean(provenance.anchor.earliestSource.title)}
                  </a>
                ) : (
                  <span className="text-ink-2">{clean(provenance.anchor.earliestSource.title)}</span>
                )}
                {provenance.anchor.earliestSource.date && ` (${clean(provenance.anchor.earliestSource.date, 40)})`}
              </p>
            )}
          </Panel>
        )}

        {/* The lineage is the supporting detail behind the verdict. */}
        {provenance ? (
          <Panel
            title="Provenance"
            subtitle={`${clean(provenance.narrativeCluster)} · generation ${provenance.recycleGeneration}`}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-[16px] text-ink">{clean(provenance.memeName)}</h2>
                <p className="mt-0.5 text-[11px] text-ink-muted">
                  {provenance.originYear !== undefined ? (
                    <>meme dates to <span className="num text-ink-2">{provenance.originYear}</span></>
                  ) : (
                    'origin year not established'
                  )}
                </p>
              </div>
              <VerdictChip verdict={provenance.recycleVerdict} />
            </div>

            <p className="mt-3 max-w-[70ch] text-[12px] leading-relaxed text-ink-2">
              {cleanProse(provenance.originSummary)}
            </p>

            {provenance.lineage.length > 0 && (
              <section className="mt-4">
                <h3 className="text-[10px] uppercase tracking-[0.1em] text-ink-muted">Lineage</h3>
                <ol className="mt-2 border-l border-axis pl-3">
                  {provenance.lineage.map((node, i) => {
                    const token = lineageToken(node.kind);
                    return (
                      <li key={`${node.label}-${i}`} className="relative py-1.5">
                        <span className="absolute -left-[17px] top-2.5"><Mark token={token} /></span>
                        <div className="flex flex-wrap items-baseline gap-x-2">
                          <span className="num text-[11px] text-ink-muted">{node.year ?? '—'}</span>
                          <span className="text-[12px] text-ink">{clean(node.label)}</span>
                          <span className="text-[10px] uppercase tracking-[0.08em] text-ink-muted">{token.label}</span>
                        </div>
                        {node.note !== undefined && (
                          <p className="mt-0.5 text-[11px] text-ink-muted">{cleanProse(node.note)}</p>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </section>
            )}

            {provenance.priorCycles.length > 0 && (
              <section className="mt-4">
                <h3 className="text-[10px] uppercase tracking-[0.1em] text-ink-muted">Prior cycles</h3>
                <p className="mt-1 text-[11px] text-ink-muted">
                  Earlier attempts to monetise this same meme — the evidence that it has worked before.
                </p>
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[560px] border-collapse text-[12px]">
                    <thead>
                      <tr className="border-b border-axis text-left text-[10px] uppercase tracking-[0.1em] text-ink-muted">
                        <th scope="col" className="py-1 pr-3">Name</th>
                        <th scope="col" className="py-1 pr-3">Ticker</th>
                        <th scope="col" className="py-1 pr-3">Chain</th>
                        <th scope="col" className="py-1 pr-3 text-right">Year</th>
                        <th scope="col" className="py-1 pr-3 text-right">Peak cap</th>
                        <th scope="col" className="py-1">Outcome</th>
                      </tr>
                    </thead>
                    <tbody>
                      {provenance.priorCycles.map((cycle, i) => {
                        const token = outcomeToken(cycle.outcome);
                        return (
                          <tr key={`${cycle.name}-${i}`} className="border-b border-grid">
                            <td className="py-1.5 pr-3 text-ink-2">{clean(cycle.name)}</td>
                            <td className="num py-1.5 pr-3 text-ink-muted">{cycle.ticker !== undefined ? clean(cycle.ticker) : '—'}</td>
                            <td className="py-1.5 pr-3 text-ink-muted">{cycle.chain !== undefined ? clean(cycle.chain) : '—'}</td>
                            <td className="num py-1.5 pr-3 text-right">{cycle.year ?? '—'}</td>
                            <td className="num py-1.5 pr-3 text-right">{formatUsd(cycle.peakMarketCapUsd)}</td>
                            <td className="py-1.5">
                              <span className="flex items-center gap-1.5 text-[11px] text-ink-2">
                                <Mark token={token} />
                                {token.label}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            <section className="mt-4 grid gap-3 sm:grid-cols-3">
              <Meter label="Memetic durability" value={provenance.memeticDurability} hint="Survival across previous attention cycles" />
              <Meter label="Cultural reach" value={provenance.culturalReach} hint="Recognition outside crypto" />
              <Meter label="Authenticity" value={provenance.authenticityScore} hint="Whether this is the meme's canonical token" />
            </section>

            <section className="mt-4">
              <h3 className="text-[10px] uppercase tracking-[0.1em] text-ink-muted">Speculative setup</h3>
              <p className="mt-1 max-w-[70ch] text-[12px] leading-relaxed text-ink-2">
                {cleanProse(provenance.speculativeSetup)}
              </p>
            </section>

            {provenance.risks.length > 0 && (
              <section className="mt-4">
                <h3 className="text-[10px] uppercase tracking-[0.1em] text-ink-muted">Risks</h3>
                <ul className="mt-1 flex list-disc flex-col gap-1 pl-4 text-[12px] text-ink-2">
                  {provenance.risks.map((risk, i) => <li key={i}>{cleanProse(risk)}</li>)}
                </ul>
              </section>
            )}

            <footer className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-grid pt-2 text-[11px] text-ink-muted">
              <span>model <code className="num">{clean(provenance.model)}</code></span>
              <span>prompt <code className="num">{clean(provenance.promptVersion)}</code></span>
              <span>confidence <span className="num text-ink-2">{(provenance.confidence * 100).toFixed(0)}%</span></span>
              <span>{formatDateTime(provenance.generatedAt)}</span>
            </footer>
          </Panel>
        ) : (
          <Panel title="Provenance">
            <EmptyState title="No provenance report">
              This token was not researched in this run — the LLM stage was skipped, the cost ceiling was reached, or
              no API key was configured. Market and on-chain data below are unaffected.
            </EmptyState>
          </Panel>
        )}

        {provenance !== undefined && provenance.evidence.length > 0 && (
          <Panel title="Evidence" subtitle={`${provenance.evidence.length} item${provenance.evidence.length === 1 ? '' : 's'}`}>
            <ul className="flex flex-col divide-y divide-grid">
              {provenance.evidence.map((item, i) => {
                const q = evidenceQuality(item.sourceQuality);
                const href = safeHref(item.url);
                return (
                  <li key={`${item.url ?? item.title}-${i}`} className="py-2 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="num text-[10px] uppercase tracking-[0.08em] text-ink-muted">{item.kind}</span>
                      {href !== undefined ? (
                        <ExternalLink href={href} className="text-[12px] text-ink hover:underline">
                          {clean(item.title)}
                        </ExternalLink>
                      ) : (
                        <span className="text-[12px] text-ink">{clean(item.title)}</span>
                      )}
                    </div>
                    <p className="mt-0.5 max-w-[70ch] text-[11px] leading-relaxed text-ink-2">{cleanProse(item.snippet)}</p>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[10px] text-ink-muted">
                      {href !== undefined && <span>{hostOf(href)}</span>}
                      <span className="flex items-center gap-1"><Mark token={q} />{q.label}</span>
                      {item.publishedAt !== undefined && <span>{formatDateTime(item.publishedAt)}</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Panel>
        )}

        <div className="grid gap-3 lg:grid-cols-2">
          <Panel title="Market">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
              <Stat label="Price" value={formatUsd(m.priceUsd)} />
              <Stat
                label={m.marketCapUsd === undefined ? 'FDV' : 'Market cap'}
                value={formatUsd(m.marketCapUsd ?? m.fdvUsd)}
              />
              <Stat label="Liquidity" value={formatUsd(m.liquidityUsd)} />
              <Stat label="Volume 24h" value={formatUsd(m.volume24hUsd)} />
              <Stat label="1h" value={<Delta value={m.priceChange1h} text={formatPctPlain(m.priceChange1h)} />} />
              <Stat label="24h" value={<Delta value={m.priceChange24h} text={formatPctPlain(m.priceChange24h)} />} />
              <Stat label="Buys 24h" value={formatCount(m.txns24h?.buys)} />
              <Stat label="Sells 24h" value={formatCount(m.txns24h?.sells)} />
            </dl>
            {snapshot.pairs.length > 0 && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full border-collapse text-[12px]">
                  <thead>
                    <tr className="border-b border-axis text-left text-[10px] uppercase tracking-[0.1em] text-ink-muted">
                      <th scope="col" className="py-1 pr-3">Pair</th>
                      <th scope="col" className="py-1 pr-3">DEX</th>
                      <th scope="col" className="py-1 text-right">Liquidity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.pairs.map((pair) => (
                      <tr key={pair.pairAddress} className="border-b border-grid">
                        <td className="num py-1.5 pr-3 text-ink-2">{shortAddress(pair.pairAddress)}</td>
                        <td className="py-1.5 pr-3 text-ink-muted">{pair.dexId !== undefined ? clean(pair.dexId) : '—'}</td>
                        <td className="num py-1.5 text-right">{formatUsd(pair.liquidityUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title="Score">
            {score !== undefined ? (
              <>
                <ScoreBreakdown score={score} />
                {score.penalties.length > 0 && (
                  <ul className="mt-3 flex flex-col gap-1 text-[11px] text-ink-2">
                    {score.penalties.map((p, i) => (
                      <li key={i} className="flex gap-2">
                        <span className="num text-critical">−{p.points}</span>
                        <span>{cleanProse(p.reason)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {history.length > 1 && (
                  <div className="mt-3">
                    <h3 className="text-[10px] uppercase tracking-[0.1em] text-ink-muted">Score history</h3>
                    <Sparkline points={history.map((h) => ({ at: h.computedAt, value: h.total }))} />
                  </div>
                )}
              </>
            ) : (
              <EmptyState title="Not scored">No score was computed for this token in this run.</EmptyState>
            )}
          </Panel>
        </div>

        <Panel title="Holders and token economics" subtitle={chain !== undefined ? methodHint(chain.method) : undefined}>
          {chain === undefined || chain.method === 'unavailable' ? (
            <EmptyState title="Distribution not measured">
              {chain?.notes[0] ??
                'On-chain analysis was unavailable for this chain. An unmeasured distribution is not a clean one.'}
            </EmptyState>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
                <Stat
                  label="Holders"
                  value={chain.holderCount === undefined ? '—' : formatCount(chain.holderCount)}
                  hint={chain.holderCount === undefined ? 'Not determined by this method' : undefined}
                />
                <Stat label="Top 10" value={formatPctPlain(chain.top10Pct)} hint="Excludes LP and burn addresses" />
                <Stat label="HHI" value={chain.herfindahl === undefined ? '—' : chain.herfindahl.toFixed(3)} hint="Herfindahl index over sampled holders" />
                <Stat label="Gini" value={chain.gini === undefined ? '—' : chain.gini.toFixed(3)} hint="Over the sampled set, not all holders" />
                <Stat label="Supply" value={chain.supply !== undefined ? formatCount(Math.round(chain.supply.total)) : '—'} />
                <Stat label="LP burned" value={formatPctPlain(chain.lpBurnedPct)} />
              </dl>

              <div className="mt-3">
                <ConcentrationBar top10Pct={chain.top10Pct} top20Pct={chain.top20Pct} top50Pct={chain.top50Pct} />
              </div>

              {chain.topHolders.length > 0 && (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[520px] border-collapse text-[12px]">
                    <thead>
                      <tr className="border-b border-axis text-left text-[10px] uppercase tracking-[0.1em] text-ink-muted">
                        <th scope="col" className="py-1 pr-3 text-right">#</th>
                        <th scope="col" className="py-1 pr-3">Address</th>
                        <th scope="col" className="py-1 pr-3">Label</th>
                        <th scope="col" className="py-1 pr-3 text-right">Balance</th>
                        {/* Named for its basis: the bar above is ex-LP, this column is not. */}
                        <th scope="col" className="py-1 text-right" title="Share of total supply. The concentration bar above excludes LP and burn addresses, so the two use different denominators.">
                          Share of supply
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {chain.topHolders.map((holder, i) => (
                        <tr
                          key={holder.address}
                          className={`border-b border-grid ${holder.excludedFromConcentration === true ? 'text-ink-muted' : ''}`}
                        >
                          <td className="num py-1.5 pr-3 text-right text-ink-muted">{i + 1}</td>
                          <td className="num py-1.5 pr-3" title={holder.address}>{shortAddress(holder.address, 6, 6)}</td>
                          <td className="py-1.5 pr-3 text-[11px]">
                            {holder.label !== undefined ? clean(holder.label) : <span className="text-ink-muted">—</span>}
                          </td>
                          <td className="num py-1.5 pr-3 text-right">{formatCount(Math.round(holder.balance))}</td>
                          <td className="num py-1.5 text-right">{holder.pct.toFixed(2)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {chain.flags.length > 0 && (
                <ul className="mt-3 flex flex-col gap-1.5">
                  {chain.flags.map((flag) => (
                    <li key={flag.code} className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
                      <SeverityChip severity={flag.severity} />
                      <code className="num text-ink-2">{flag.code}</code>
                      <span className="text-ink-muted">{cleanProse(flag.detail)}</span>
                    </li>
                  ))}
                </ul>
              )}

              {chain.notes.length > 0 && (
                <ul className="mt-3 flex flex-col gap-1 border-t border-grid pt-2 text-[10px] text-ink-muted">
                  {chain.notes.map((note, i) => <li key={i}>{cleanProse(note)}</li>)}
                </ul>
              )}
            </>
          )}
        </Panel>

        <p className="pb-6 text-[12px]">
          <Link href="/" className="text-ink-muted hover:text-ink hover:underline">← all tokens</Link>
        </p>
      </div>
    </>
  );
}
