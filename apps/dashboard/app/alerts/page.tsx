import Link from 'next/link';
import { EmptyState, Panel, SetupScreen, SeverityChip, SiteNav } from '@/components/ui';
import { listAlerts } from '@/lib/data';
import { clean, cleanProse, formatAgo, formatDateTime } from '@/lib/format';
import { SEVERITY_RANK } from '@/lib/vocab';

export const dynamic = 'force-dynamic';

export default async function AlertsPage() {
  const result = await listAlerts(100);
  if (!result.ok) {
    return (
      <>
        <SiteNav current="alerts" />
        <SetupScreen {...result.problem} />
      </>
    );
  }

  // Severity first, then recency: a critical alert from this morning matters
  // more than an informational one from ten minutes ago.
  const alerts = [...result.value].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    return bySeverity !== 0 ? bySeverity : Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });

  return (
    <>
      <SiteNav current="alerts" />
      <div className="px-3 py-3">
        {alerts.length === 0 ? (
          <EmptyState title="No alerts">No rule has fired yet. Alerts appear here as runs complete.</EmptyState>
        ) : (
          <Panel title="Alerts" subtitle={`${alerts.length} most recent`}>
            <ul className="divide-y divide-grid">
              {alerts.map((alert) => (
                <li key={alert.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <SeverityChip severity={alert.severity} />
                    <code className="num text-[11px] text-ink-2">{clean(alert.rule)}</code>
                    <Link
                      href={`/token/${encodeURIComponent(alert.tokenId)}`}
                      className="num text-[11px] text-ink-muted hover:text-ink hover:underline"
                    >
                      {clean(alert.tokenId)}
                    </Link>
                    <time
                      dateTime={alert.createdAt}
                      title={formatDateTime(alert.createdAt)}
                      className="ml-auto text-[11px] text-ink-muted"
                    >
                      {formatAgo(alert.createdAt)}
                    </time>
                  </div>
                  <h2 className="mt-1 text-[13px] text-ink">{clean(alert.title)}</h2>
                  <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-ink-2">
                    {cleanProse(alert.body)}
                  </p>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </>
  );
}
