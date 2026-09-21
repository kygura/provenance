import Link from 'next/link';
import { FilterBar } from '@/components/FilterBar';
import {
  ChainBadge,
  Delta,
  EmptyState,
  Mark,
  Panel,
  SetupScreen,
  SiteNav,
  Stat,
  TierChip,
  VerdictChip,
} from '@/components/ui';
import { latestRun, listDossiers } from '@/lib/data';
import {
  clean,
  formatAgo,
  formatCostUsd,
  formatDateTime,
  formatPctPlain,
  formatCount,
  nextRunEstimate,
} from '@/lib/format';
import { applyFilters, applySort, parseQuery, type SearchParams } from '@/lib/query';
import { severityToken } from '@/lib/vocab';
import { formatUsd } from '@provenance/core';

// The underlying run changes twice a day; a statically built page would pin the
// dashboard to whichever run was current at deploy time.
export const dynamic = 'force-dynamic';

export default async function DashboardPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const query = parseQuery(params);

  const [runResult, dossierResult] = await Promise.all([
    latestRun(),
    listDossiers(query.runId !== undefined ? { runId: query.runId } : {}),
  ]);

  if (!runResult.ok) return <Shell><SetupScreen {...runResult.problem} /></Shell>;
  if (!dossierResult.ok) return <Shell><SetupScreen {...dossierResult.problem} /></Shell>;

  const run = runResult.value;
  const all = dossierResult.value;

  if (!run) {
    return (
      <Shell>
        <EmptyState title="No runs yet">
          Nothing has been written to this database. Run{' '}
          <code className="num">bun run apps/worker/src/cli.ts run</code>, or{' '}
          <code className="num">seed</code> for demo data.
        </EmptyState>
      </Shell>
    );
  }

  const rows = applySort(applyFilters(all, query), query);
  const alertCount = all.reduce((sum, row) => sum + row.alerts.length, 0);
  const chains = [...new Set(all.map((row) => row.snapshot.chain))].sort();
  const tiers = [...new Set(all.flatMap((row) => (row.score ? [row.score.tier] : [])))].sort();
  const verdicts = [...new Set(all.flatMap((row) => (row.provenance ? [row.provenance.recycleVerdict] : [])))].sort();

  return (
    <Shell>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-hair px-3 py-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Run" value={formatDateTime(run.startedAt)} hint={formatAgo(run.startedAt)} />
        <Stat label="Status" value={run.status} hint={`${run.stats.analysed} analysed, ${run.stats.reused} reused`} />
        <Stat label="Tokens" value={formatCount(all.length)} hint={`${run.stats.discovered} discovered`} />
        <Stat label="Alerts" value={formatCount(alertCount)} hint={alertCount > 0 ? 'see Alerts' : 'none fired'} />
        <Stat label="LLM cost" value={formatCostUsd(run.stats.llmCostUsd)} hint="this run" />
        <Stat label="Next run" value={nextRunEstimate(run.startedAt)} hint="approximate; the cron is best-effort" />
      </dl>

      <FilterBar query={query} chains={chains} tiers={tiers} verdicts={verdicts} total={all.length} shown={rows.length} />

      {rows.length === 0 ? (
        <div className="px-3 py-4">
          <EmptyState title="Nothing matches">No token in this run matches the current filters.</EmptyState>
        </div>
      ) : (
        <div className="overflow-x-auto px-3 py-3">
          <table className="w-full min-w-[900px] border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-axis text-left text-[10px] uppercase tracking-[0.1em] text-ink-muted">
                <th scope="col" className="sticky left-0 z-10 bg-plane py-1.5 pr-3">Token</th>
                <th scope="col" className="py-1.5 pr-3">Score</th>
                <th scope="col" className="py-1.5 pr-3">Verdict</th>
                <th scope="col" className="py-1.5 pr-3">Meme</th>
                <th scope="col" className="py-1.5 pr-3 text-right">Origin</th>
                <th scope="col" className="py-1.5 pr-3 text-right">Mkt cap</th>
                <th scope="col" className="py-1.5 pr-3 text-right">Liquidity</th>
                <th scope="col" className="py-1.5 pr-3 text-right">Vol 24h</th>
                <th scope="col" className="py-1.5 pr-3 text-right">24h</th>
                <th scope="col" className="py-1.5 pr-3 text-right">Top 10</th>
                <th scope="col" className="py-1.5">Risk</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const { snapshot, score, provenance, chain } = row;
                const critical = chain?.flags.filter((f) => f.severity === 'critical').length ?? 0;
                const warn = chain?.flags.filter((f) => f.severity === 'warn').length ?? 0;
                return (
                  <tr key={snapshot.tokenId} className="border-b border-grid hover:bg-raise">
                    <th scope="row" className="sticky left-0 z-10 bg-plane py-2 pr-3 text-left font-normal">
                      <Link
                        href={`/token/${encodeURIComponent(snapshot.tokenId)}`}
                        className="flex items-baseline gap-2 hover:underline"
                      >
                        <span className="num text-[13px] font-semibold text-ink">{clean(snapshot.symbol)}</span>
                        <span className="max-w-[14ch] truncate text-[11px] text-ink-muted">{clean(snapshot.name)}</span>
                      </Link>
                      <ChainBadge chain={snapshot.chain} />
                    </th>
                    <td className="py-2 pr-3"><TierChip tier={score?.tier} /></td>
                    <td className="py-2 pr-3"><VerdictChip verdict={provenance?.recycleVerdict} /></td>
                    <td className="max-w-[20ch] truncate py-2 pr-3 text-ink-2" title={provenance?.memeName}>
                      {provenance ? clean(provenance.memeName) : <span className="text-ink-muted">—</span>}
                    </td>
                    <td className="num py-2 pr-3 text-right">{provenance?.originYear ?? <span className="text-ink-muted">—</span>}</td>
                    <td className="num py-2 pr-3 text-right">{formatUsd(snapshot.metrics.marketCapUsd ?? snapshot.metrics.fdvUsd)}</td>
                    <td className="num py-2 pr-3 text-right">{formatUsd(snapshot.metrics.liquidityUsd)}</td>
                    <td className="num py-2 pr-3 text-right">{formatUsd(snapshot.metrics.volume24hUsd)}</td>
                    <td className="num py-2 pr-3 text-right">
                      <Delta value={snapshot.metrics.priceChange24h} text={formatPctPlain(snapshot.metrics.priceChange24h)} />
                    </td>
                    <td className="num py-2 pr-3 text-right">{formatPctPlain(chain?.top10Pct)}</td>
                    <td className="py-2">
                      {critical === 0 && warn === 0 ? (
                        <span className="text-ink-muted">—</span>
                      ) : (
                        <span className="flex items-center gap-2">
                          {critical > 0 && (
                            <span className="num flex items-center gap-1 text-[11px]" title={`${critical} critical`}>
                              <Mark token={severityToken('critical')} />
                              {critical}
                            </span>
                          )}
                          {warn > 0 && (
                            <span className="num flex items-center gap-1 text-[11px]" title={`${warn} warning`}>
                              <Mark token={severityToken('warn')} />
                              {warn}
                            </span>
                          )}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="px-3 pb-6 text-[11px] text-ink-muted">
        Scores describe narrative lineage and distribution structure. They are not predictions and not advice.
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteNav current="run" />
      {children}
    </>
  );
}
