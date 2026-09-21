import type { ProvenanceScore } from '@provenance/core';
import { SCORE_COMPONENTS } from '@/lib/vocab';
import { formatPctPlain, formatScore, num } from '@/lib/format';
import { EmptyState, Mark } from './ui';

/**
 * Hand-written SVG/CSS visuals. No chart library: every mark here is one of four
 * shapes, and a dependency would cost more than it saves.
 *
 * Shared specs, from the data-viz method:
 *  - 2px lines, ≥8px markers, marks capped well under 24px thick
 *  - a 2px gap in the *surface* colour separates touching fills; no borders on marks
 *  - the unfilled part of a meter is a darker step of the fill's own ramp, so the
 *    state reads across the whole bar on a dark surface
 *  - text never wears the data colour; a coloured mark sits beside it instead
 */

const TRACK = 'var(--color-blue-700)';
const FILL = 'var(--color-blue-400)';

function pct01(value: number | undefined, max = 100): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value / max));
}

/**
 * A single 0-100 magnitude. Used for durability / reach / authenticity and for the
 * score components — all plain magnitudes, so one hue, never a severity ramp.
 */
export function Meter({
  label,
  value,
  hint,
  suffix = '',
}: {
  label: string;
  value: number | undefined;
  hint?: string;
  suffix?: string;
}) {
  const v = num(value);
  const width = `${(pct01(v) * 100).toFixed(2)}%`;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2">
      <span className="truncate text-[12px] text-ink-2" title={hint}>
        {label}
      </span>
      <span className="num text-[12px] text-ink">
        {v === undefined ? 'n/a' : `${Math.round(v)}${suffix}`}
      </span>
      <div
        className="col-span-2 mt-1 h-2 w-full overflow-hidden rounded-[2px]"
        style={{ backgroundColor: TRACK }}
        role="img"
        aria-label={`${label}: ${v === undefined ? 'not determined' : `${Math.round(v)} of 100`}`}
      >
        {v !== undefined && v > 0 && (
          <div
            className="h-full rounded-r-[4px]"
            style={{ width, backgroundColor: FILL }}
          />
        )}
      </div>
    </div>
  );
}

/** The composite score broken out by component, with the penalties that ate into it. */
export function ScoreBreakdown({ score }: { score?: ProvenanceScore }) {
  if (score === undefined) {
    return (
      <EmptyState title="No score for this token in this run">
        Scoring runs after the on-chain and provenance steps; a token filtered out
        before those steps has no composite.
      </EmptyState>
    );
  }

  const components = score.components as unknown as Record<string, unknown> | undefined;

  return (
    <div>
      <div className="flex items-baseline gap-2">
        {/* The dossier's hero figure: one number, proportional digits, no tabular-nums. */}
        <span className="font-sans text-[44px] font-semibold leading-none tracking-tight text-ink">
          {formatScore(score.total)}
        </span>
        <span className="text-[12px] text-ink-muted">/ 100 composite</span>
      </div>

      <div className="mt-4 grid gap-3">
        {SCORE_COMPONENTS.map((component) => (
          <Meter
            key={component.key}
            label={component.label}
            hint={component.hint}
            value={num(components?.[component.key])}
          />
        ))}
      </div>

      {Array.isArray(score.penalties) && score.penalties.length > 0 && (
        <div className="mt-4 border-t border-hair pt-3">
          <p className="text-[10px] uppercase tracking-[0.1em] text-ink-muted">Penalties</p>
          <ul className="mt-1 grid gap-1">
            {score.penalties.map((penalty, index) => (
              <li
                key={`${penalty?.reason ?? 'penalty'}-${index}`}
                className="flex items-baseline justify-between gap-3 text-[12px]"
              >
                <span className="min-w-0 flex-1 text-ink-2">{penalty?.reason ?? 'unspecified'}</span>
                <span className="num shrink-0" style={{ color: 'var(--color-critical)' }}>
                  −{Math.abs(num(penalty?.points) ?? 0)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Score over time for one token. One series, so no legend — the panel title names
 * it. Only the endpoint is labelled; every point is available in /api/token/[id].
 */
export function Sparkline({
  points,
  width = 260,
  height = 44,
}: {
  points: readonly { at: string; value: number }[];
  width?: number;
  height?: number;
}) {
  const usable = points.filter((point) => Number.isFinite(point.value));

  if (usable.length === 0) {
    return (
      <EmptyState title="No score history yet" glyph="⌁">
        A second run of this token draws the first line.
      </EmptyState>
    );
  }

  const values = usable.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = 6;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  // A flat series would divide by zero; centre it instead.
  const span = max - min < 1 ? 1 : max - min;
  const baseline = max - min < 1 ? min - 0.5 : min;

  const xy = usable.map((point, index) => {
    const x =
      usable.length === 1 ? pad + innerW : pad + (index / (usable.length - 1)) * innerW;
    const y = pad + innerH - ((point.value - baseline) / span) * innerH;
    return { x, y, ...point };
  });

  const last = xy[xy.length - 1];
  const first = xy[0];
  const path = xy.map((point, i) => `${i === 0 ? 'M' : 'L'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' ');

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Score history: ${usable.length} observations, from ${Math.round(
          first?.value ?? 0,
        )} to ${Math.round(last?.value ?? 0)}, low ${Math.round(min)}, high ${Math.round(max)}`}
        className="block"
      >
        {/* One recessive hairline baseline; solid, never dashed. */}
        <line
          x1={pad}
          y1={height - pad}
          x2={width - pad}
          y2={height - pad}
          stroke="var(--color-grid)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {xy.length > 1 && (
          <path
            d={path}
            fill="none"
            stroke={FILL}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {last !== undefined && (
          <>
            {/* 2px ring in the surface colour keeps the marker legible over the line. */}
            <circle cx={last.x} cy={last.y} r={5} fill="var(--color-surface)" />
            <circle cx={last.x} cy={last.y} r={4} fill={FILL} />
          </>
        )}
      </svg>
      <div className="mt-1 flex items-baseline justify-between text-[11px] text-ink-muted">
        <span className="num">low {Math.round(min)}</span>
        <span className="num">high {Math.round(max)}</span>
        <span className="num text-ink">
          now {Math.round(last?.value ?? 0)}
        </span>
      </div>
    </div>
  );
}

interface Band {
  label: string;
  value: number;
  color: string;
}

/**
 * Holder concentration as part-to-whole. Ordered bands, so a single-hue ordinal
 * ramp (validated `--ordinal` against the dark surface) rather than categorical
 * hues, with a 2px surface gap doing the separating and a labelled legend below.
 */
export function ConcentrationBar({
  top10Pct,
  top20Pct,
  top50Pct,
}: {
  top10Pct?: number;
  top20Pct?: number;
  top50Pct?: number;
}) {
  const t10 = num(top10Pct);
  const t20 = num(top20Pct);
  const t50 = num(top50Pct);

  if (t10 === undefined && t20 === undefined && t50 === undefined) {
    return (
      <EmptyState title="Concentration not determined">
        The on-chain step could not read enough of the holder set to compute it.
      </EmptyState>
    );
  }

  const bands: Band[] = [];
  let covered = 0;
  if (t10 !== undefined) {
    bands.push({ label: 'Top 10 holders', value: t10, color: 'var(--color-blue-150)' });
    covered = t10;
  }
  if (t20 !== undefined && t20 > covered) {
    bands.push({ label: 'Holders 11–20', value: t20 - covered, color: 'var(--color-blue-300)' });
    covered = t20;
  }
  if (t50 !== undefined && t50 > covered) {
    bands.push({ label: 'Holders 21–50', value: t50 - covered, color: 'var(--color-blue-450)' });
    covered = t50;
  }
  const rest = Math.max(0, 100 - covered);
  if (rest > 0) {
    bands.push({ label: 'Everyone else', value: rest, color: 'var(--color-blue-700)' });
  }

  const total = bands.reduce((sum, band) => sum + band.value, 0) || 100;

  return (
    <div>
      <div
        className="flex h-3 w-full gap-[2px] overflow-hidden rounded-[2px]"
        role="img"
        aria-label={bands
          .map((band) => `${band.label}: ${band.value.toFixed(1)} percent`)
          .join('; ')}
      >
        {bands.map((band) => (
          <div
            key={band.label}
            title={`${band.label} — ${formatPctPlain(band.value)}`}
            style={{
              width: `${((band.value / total) * 100).toFixed(2)}%`,
              backgroundColor: band.color,
            }}
          />
        ))}
      </div>
      <ul className="mt-2 grid gap-1 sm:grid-cols-2">
        {bands.map((band) => (
          <li key={band.label} className="flex items-baseline gap-2 text-[12px]">
            <Mark token={{ color: band.color, glyph: '', label: band.label }} />
            <span className="min-w-0 flex-1 truncate text-ink-2">{band.label}</span>
            <span className="num text-ink">{formatPctPlain(band.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
