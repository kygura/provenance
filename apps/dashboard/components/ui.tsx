import Link from 'next/link';
import type { ReactNode } from 'react';
import type { RecycleVerdict, RiskSeverity, ScoreTier } from '@provenance/core';
import {
  chainLabel,
  runStatusToken,
  severityToken,
  tierToken,
  verdictToken,
  type Token,
} from '@/lib/vocab';
import { clean, safeHref } from '@/lib/format';

/**
 * Shared chrome. Every categorical chip here pairs its colour with a glyph and a
 * word, so nothing in the UI depends on hue alone.
 */

function soft(color: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

export function Panel({
  title,
  subtitle,
  action,
  children,
  className = '',
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      {title !== undefined && (
        <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 border-b border-hair px-3 py-2">
          <div>
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-2">
              {title}
            </h2>
            {subtitle !== undefined && (
              <p className="mt-0.5 text-[11px] text-ink-muted">{subtitle}</p>
            )}
          </div>
          {action}
        </header>
      )}
      <div className="p-3">{children}</div>
    </section>
  );
}

/** A coloured mark that sits *beside* text, never behind it. */
export function Mark({ token, size = 8 }: { token: Token; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block shrink-0 rounded-[2px]"
      style={{ width: size, height: size, backgroundColor: token.color }}
    />
  );
}

function Chip({
  token,
  showLabel = true,
  title,
}: {
  token: Token;
  showLabel?: boolean;
  title?: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-[3px] border px-1.5 py-[1px] text-[11px] leading-[16px] text-ink"
      style={{ borderColor: soft(token.color, 55), backgroundColor: soft(token.color, 16) }}
      title={title ?? token.hint ?? token.label}
    >
      <span aria-hidden="true" className="num font-semibold" style={{ color: 'inherit' }}>
        {token.glyph}
      </span>
      {showLabel && <span className="whitespace-nowrap">{token.label}</span>}
    </span>
  );
}

export function TierChip({ tier }: { tier?: ScoreTier }) {
  const token = tierToken(tier);
  return (
    <span
      className="num inline-flex h-[18px] w-[18px] items-center justify-center rounded-[3px] border text-[11px] font-semibold text-ink"
      style={{ borderColor: soft(token.color, 60), backgroundColor: soft(token.color, 20) }}
      title={`Tier ${token.label}${token.hint === undefined ? '' : ` — ${token.hint}`}`}
    >
      {token.glyph}
      <span className="sr-only">{` tier ${token.label}`}</span>
    </span>
  );
}

export function VerdictChip({ verdict }: { verdict?: RecycleVerdict }) {
  return <Chip token={verdictToken(verdict)} />;
}

export function SeverityChip({ severity }: { severity?: RiskSeverity }) {
  return <Chip token={severityToken(severity)} />;
}

export function RunStatusChip({ status }: { status?: string }) {
  return <Chip token={runStatusToken(status)} />;
}

export function ChainBadge({ chain }: { chain?: string }) {
  return (
    <span
      className="num inline-block rounded-[3px] border border-hair px-1 py-[1px] text-[10px] uppercase leading-[14px] text-ink-2"
      title={chain === undefined ? 'Unknown chain' : `Chain: ${chain}`}
    >
      {chainLabel(chain)}
    </span>
  );
}

/**
 * Signed 24h change. Direction is carried by the arrow and the sign; colour only
 * reinforces it, using the reserved delta tokens rather than a series hue.
 */
export function Delta({ value, text }: { value?: number; text: string }) {
  if (value === undefined || !Number.isFinite(value)) {
    return <span className="num text-ink-muted">{text}</span>;
  }
  const up = value > 0;
  const flat = value === 0;
  const color = flat
    ? 'var(--color-ink-muted)'
    : up
      ? 'var(--color-good)'
      : 'var(--color-critical)';
  return (
    <span className="num inline-flex items-center gap-1 whitespace-nowrap" style={{ color }}>
      <span aria-hidden="true">{flat ? '–' : up ? '▲' : '▼'}</span>
      {text}
    </span>
  );
}

export function Stat({
  label,
  value,
  hint,
  mono = true,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-[0.1em] text-ink-muted" title={hint}>
        {label}
      </dt>
      <dd className={`${mono ? 'num' : ''} truncate text-[13px] text-ink`}>{value}</dd>
    </div>
  );
}

export function EmptyState({
  title,
  children,
  glyph = '∅',
}: {
  title: string;
  children?: ReactNode;
  glyph?: string;
}) {
  return (
    <div className="flex flex-col items-start gap-1 rounded-[3px] border border-dashed border-axis px-3 py-4 text-ink-2">
      <p className="flex items-center gap-2 text-[13px] text-ink">
        <span aria-hidden="true" className="num text-ink-muted">
          {glyph}
        </span>
        {title}
      </p>
      {children !== undefined && <div className="text-[12px] text-ink-muted">{children}</div>}
    </div>
  );
}

/** External links are always noopener/noreferrer and always protocol-checked. */
export function ExternalLink({
  href,
  children,
  className = '',
}: {
  href: unknown;
  children: ReactNode;
  className?: string;
}) {
  const safe = safeHref(href);
  if (safe === undefined) return <span className={className}>{children}</span>;
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer"
      className={`underline decoration-axis underline-offset-2 hover:decoration-ink-2 ${className}`}
    >
      {children}
    </a>
  );
}

export function SiteNav({ current }: { current: 'run' | 'alerts' | 'runs' }) {
  const items: { key: 'run' | 'alerts' | 'runs'; href: string; label: string }[] = [
    { key: 'run', href: '/', label: 'Run' },
    { key: 'alerts', href: '/alerts', label: 'Alerts' },
    { key: 'runs', href: '/runs', label: 'History' },
  ];
  return (
    <nav className="flex items-center gap-1 border-b border-hair bg-surface px-3 py-2">
      <Link href="/" className="mr-3 flex items-baseline gap-2">
        <span className="num text-[13px] font-semibold tracking-tight text-ink">provenance</span>
        <span className="hidden text-[11px] text-ink-muted sm:inline">
          recycled-narrative scanner
        </span>
      </Link>
      <div className="ml-auto flex items-center gap-1">
        {items.map((item) => (
          <Link
            key={item.key}
            href={item.href}
            aria-current={item.key === current ? 'page' : undefined}
            className={`rounded-[3px] px-2 py-1 text-[12px] ${
              item.key === current
                ? 'bg-raise text-ink'
                : 'text-ink-muted hover:bg-raise hover:text-ink-2'
            }`}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}

/** Rendered whenever the store cannot answer. Not an error page — a setup page. */
export function SetupScreen({
  title,
  hint,
  detail,
}: {
  title: string;
  hint: string;
  detail?: string;
}) {
  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <div className="panel p-4">
        <p className="text-[11px] uppercase tracking-[0.12em] text-ink-muted">
          Dashboard not connected
        </p>
        <h1 className="mt-2 text-[18px] font-semibold text-ink">{clean(title, 160)}</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{clean(hint, 400)}</p>

        <div className="mt-4 border-t border-hair pt-3">
          <p className="text-[11px] uppercase tracking-[0.12em] text-ink-muted">
            Environment the dashboard reads
          </p>
          <dl className="num mt-2 grid gap-1 text-[12px]">
            <div className="flex gap-2">
              <dt className="w-[184px] shrink-0 text-ink-2">DATABASE_URL</dt>
              <dd className="text-ink-muted">libsql://… or file:./data/provenance.db</dd>
            </div>
            <div className="flex gap-2">
              <dt className="w-[184px] shrink-0 text-ink-2">DATABASE_AUTH_TOKEN</dt>
              <dd className="text-ink-muted">required for a hosted Turso database</dd>
            </div>
          </dl>
        </div>

        {detail !== undefined && detail !== '' && (
          <details className="mt-4 border-t border-hair pt-3">
            <summary className="cursor-pointer text-[12px] text-ink-muted">
              Underlying error
            </summary>
            <pre className="num mt-2 overflow-x-auto whitespace-pre-wrap break-words text-[11px] text-ink-2">
              {clean(detail, 1200)}
            </pre>
          </details>
        )}
      </div>
    </div>
  );
}
