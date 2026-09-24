import Link from 'next/link';
import type { AnchorVerdict } from '@provenance/core';
import { AnchorChip, EmptyState, Panel, SetupScreen, SiteNav } from '@/components/ui';
import { listWatch } from '@/lib/data';
import { clean, formatAgo, formatDateTime } from '@/lib/format';
import { formatUsd } from '@provenance/core';

export const dynamic = 'force-dynamic';

const VERDICTS: readonly AnchorVerdict[] = ['anchored', 'forced', 'unclear'];

/**
 * Every launch the lane judged, verdict first. The subtitle is the verdict's
 * track record: of the tokens called anchored, forced or unclear at launch,
 * how many went on to trend. That is the number that says whether the call
 * is worth acting on.
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
  const record = VERDICTS.map((verdict) => {
    const judged = entries.filter((entry) => entry.anchor.verdict === verdict);
    const trended = judged.filter((entry) => entry.expressedAt !== undefined).length;
    return judged.length > 0 ? `${verdict} ${trended}/${judged.length} trended` : undefined;
  }).filter((line): line is string => line !== undefined);
  const subtitle = [`${entries.length} judged at launch`, ...record].join(' · ');

  return (
    <>
      <SiteNav current="watchlist" />
      <div className="px-3 py-3">
        {entries.length === 0 ? (
          <EmptyState title="Nothing judged yet">
            Launches that clear the gate get an anchor verdict and appear here.
          </EmptyState>
        ) : (
          <Panel title="Verdicts at launch" subtitle={subtitle}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] border-collapse text-[12px]">
                <thead>
                  <tr className="border-b border-axis text-left text-[10px] uppercase tracking-[0.1em] text-ink-muted">
                    <th scope="col" className="py-1.5 pr-3">Token</th>
                    <th scope="col" className="py-1.5 pr-3">Verdict</th>
                    <th scope="col" className="py-1.5 pr-3">Anchor</th>
                    <th scope="col" className="py-1.5 pr-3">Dated</th>
                    <th scope="col" className="py-1.5 pr-3">Conf</th>
                    <th scope="col" className="py-1.5 pr-3">Judged</th>
                    <th scope="col" className="py-1.5 pr-3 text-right">To trend</th>
                    <th scope="col" className="py-1.5 pr-3 text-right">Liq at verdict</th>
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
                      <td className="py-2 pr-3">
                        <AnchorChip verdict={entry.anchor.verdict} />
                      </td>
                      <td className="py-2 pr-3 text-ink-2" title={clean(entry.anchor.summary, 600)}>
                        {clean(entry.anchor.subject, 60) || '—'}
                        {entry.anchor.type !== 'none' && (
                          <span className="ml-2 text-ink-muted">{entry.anchor.type.replace('-', ' ')}</span>
                        )}
                      </td>
                      <td className="num py-2 pr-3 text-ink-muted">
                        {entry.anchor.anchorDate ? clean(entry.anchor.anchorDate, 20) : '—'}
                        {entry.anchor.precedesLaunch === false && <span className="ml-1 text-ink">after launch</span>}
                      </td>
                      <td className="py-2 pr-3 text-ink-muted">{entry.anchor.confidence}</td>
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
