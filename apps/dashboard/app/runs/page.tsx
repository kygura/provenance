import Link from 'next/link';
import { EmptyState, Panel, RunStatusChip, SetupScreen, SiteNav } from '@/components/ui';
import { listRuns } from '@/lib/data';
import { formatCostUsd, formatCount, formatDateTime, formatDuration } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function RunsPage() {
  const result = await listRuns(50);
  if (!result.ok) {
    return (
      <>
        <SiteNav current="runs" />
        <SetupScreen {...result.problem} />
      </>
    );
  }
  const runs = result.value;

  return (
    <>
      <SiteNav current="runs" />
      <div className="px-3 py-3">
        {runs.length === 0 ? (
          <EmptyState title="No runs yet">Run history appears here once the pipeline has executed.</EmptyState>
        ) : (
          <Panel title="Run history" subtitle={`${runs.length} run${runs.length === 1 ? '' : 's'}`}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-[12px]">
                <thead>
                  <tr className="border-b border-axis text-left text-[10px] uppercase tracking-[0.1em] text-ink-muted">
                    <th scope="col" className="py-1.5 pr-3">Started</th>
                    <th scope="col" className="py-1.5 pr-3">Status</th>
                    <th scope="col" className="py-1.5 pr-3 text-right">Found</th>
                    <th scope="col" className="py-1.5 pr-3 text-right">Analysed</th>
                    <th scope="col" className="py-1.5 pr-3 text-right">Reused</th>
                    <th scope="col" className="py-1.5 pr-3 text-right">Alerts</th>
                    <th scope="col" className="py-1.5 pr-3 text-right">Cost</th>
                    <th scope="col" className="py-1.5 pr-3 text-right">Duration</th>
                    <th scope="col" className="py-1.5">Source errors</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id} className="border-b border-grid hover:bg-raise">
                      <th scope="row" className="py-2 pr-3 text-left font-normal">
                        <Link href={`/?run=${encodeURIComponent(run.id)}`} className="num hover:underline">
                          {formatDateTime(run.startedAt)}
                        </Link>
                      </th>
                      <td className="py-2 pr-3"><RunStatusChip status={run.status} /></td>
                      <td className="num py-2 pr-3 text-right">{formatCount(run.stats.discovered)}</td>
                      <td className="num py-2 pr-3 text-right">{formatCount(run.stats.analysed)}</td>
                      <td className="num py-2 pr-3 text-right">{formatCount(run.stats.reused)}</td>
                      <td className="num py-2 pr-3 text-right">{formatCount(run.stats.alertsFired)}</td>
                      <td className="num py-2 pr-3 text-right">{formatCostUsd(run.stats.llmCostUsd)}</td>
                      <td className="num py-2 pr-3 text-right">{formatDuration(run.stats.durationMs)}</td>
                      <td className="py-2 text-ink-2">
                        {run.stats.sourceErrors.length === 0 ? (
                          <span className="text-ink-muted">—</span>
                        ) : (
                          run.stats.sourceErrors.map((e) => e.source).join(', ')
                        )}
                      </td>
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
