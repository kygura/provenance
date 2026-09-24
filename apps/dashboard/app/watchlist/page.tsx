import Link from 'next/link';
import { EmptyState, Panel, SetupScreen, SiteNav } from '@/components/ui';
import { listWatch } from '@/lib/data';
import { clean, formatAgo, formatDateTime } from '@/lib/format';
import { formatUsd } from '@provenance/core';

export const dynamic = 'force-dynamic';

const STATUS_CLASS: Record<string, string> = {
  expressed: 'text-ink',
  active: 'text-ink-2',
  dormant: 'text-ink-muted',
};

/**
 * Tokens caught by the launch lane, and what became of them. The lead time
 * column is the point of the page: how long supply-side detection ran ahead
 * of the trending lists, measured per token rather than guessed.
 */
export default async function WatchlistPage() {
  const result = await listWatch({ limit: 300 });
  if (!result.ok) {
    return (
      <>
        <SiteNav current="watchlist" />
        <SetupScreen {...result.problem} />
      </>
    );
  }
  const entries = result.value;
  const leads = entries
    .map((entry) => entry.leadHours)
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b);
  const median = leads.length > 0 ? leads[Math.floor(leads.length / 2)] : undefined;
  const subtitle =
    `${entries.length} catalogued · ${leads.length} expressed` +
    (median === undefined ? '' : ` · median lead ${median.toFixed(1)}h`);

  return (
    <>
      <SiteNav current="watchlist" />
      <div className="px-3 py-3">
        {entries.length === 0 ? (
          <EmptyState title="Watchlist is empty">
            Launches that clear the launch lane&apos;s gate and referent check appear here.
          </EmptyState>
        ) : (
          <Panel title="Watchlist" subtitle={subtitle}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-[12px]">
                <thead>
                  <tr className="border-b border-axis text-left text-[10px] uppercase tracking-[0.1em] text-ink-muted">
                    <th scope="col" className="py-1.5 pr-3">Token</th>
                    <th scope="col" className="py-1.5 pr-3">Status</th>
                    <th scope="col" className="py-1.5 pr-3">Referent</th>
                    <th scope="col" className="py-1.5 pr-3">Conf</th>
                    <th scope="col" className="py-1.5 pr-3">Catalogued</th>
                    <th scope="col" className="py-1.5 pr-3 text-right">Lead</th>
                    <th scope="col" className="py-1.5 pr-3 text-right">Liq at catalogue</th>
                    <th scope="col" className="py-1.5">Trended on</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.tokenId} className="border-b border-grid hover:bg-raise">
                      <th scope="row" className="py-2 pr-3 text-left font-normal">
                        <Link href={`/token/${encodeURIComponent(entry.tokenId)}`} className="num hover:underline">
                          ${clean(entry.symbol, 16)}
                        </Link>
                        <span className="ml-2 text-ink-muted">{clean(entry.chain)}</span>
                      </th>
                      <td className={`py-2 pr-3 ${STATUS_CLASS[entry.status] ?? ''}`}>{entry.status}</td>
                      <td className="py-2 pr-3 text-ink-2" title={clean(entry.referent.summary, 600)}>
                        {clean(entry.referent.referent, 60) || '—'}
                      </td>
                      <td className="py-2 pr-3 text-ink-muted">{entry.referent.confidence}</td>
                      <td className="py-2 pr-3">
                        <time dateTime={entry.firstSeenAt} title={formatDateTime(entry.firstSeenAt)}>
                          {formatAgo(entry.firstSeenAt)}
                        </time>
                      </td>
                      <td className="num py-2 pr-3 text-right">
                        {entry.leadHours === undefined ? '—' : `${entry.leadHours.toFixed(1)}h`}
                      </td>
                      <td className="num py-2 pr-3 text-right">{formatUsd(entry.liquidityUsdAtCatalog)}</td>
                      <td className="py-2 text-ink-muted">{entry.expressedOn?.join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        )}
      </div>
    </>
  );
}
