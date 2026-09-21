'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useRef, type FormEvent } from 'react';
import type { TableQuery } from '@/lib/query';

/**
 * Filters are URL state, so a filtered view is a link you can paste into a chat.
 *
 * This is a real `<form method="get">`: with JavaScript disabled the Apply button
 * still navigates, and with it enabled a change to any control submits straight
 * away and empty fields are stripped so the URL stays readable.
 *
 * One filter row, above everything it scopes — never per-panel filters.
 */
export function FilterBar({
  query,
  chains,
  tiers,
  verdicts,
  total,
  shown,
}: {
  query: TableQuery;
  chains: readonly string[];
  tiers: readonly string[];
  verdicts: readonly string[];
  total: number;
  shown: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const formRef = useRef<HTMLFormElement>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const params = new URLSearchParams();
    for (const [key, value] of data.entries()) {
      if (typeof value !== 'string') continue;
      const trimmed = value.trim();
      if (trimmed === '' || trimmed === '0') continue;
      params.set(key, trimmed);
    }
    const qs = params.toString();
    router.push(qs === '' ? pathname : `${pathname}?${qs}`);
  }

  const nudge = () => formRef.current?.requestSubmit();

  const control =
    'rounded-[3px] border border-hair bg-plane px-2 py-1 text-[12px] text-ink ' +
    'hover:border-axis focus:border-series-1';

  return (
    <form
      ref={formRef}
      method="get"
      action={pathname}
      onSubmit={submit}
      className="flex flex-wrap items-end gap-2"
    >
      {query.runId !== undefined && <input type="hidden" name="run" value={query.runId} />}
      {query.sort !== 'score' && <input type="hidden" name="sort" value={query.sort} />}
      {query.dir !== 'desc' && <input type="hidden" name="dir" value={query.dir} />}

      <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1">
        <span className="text-[10px] uppercase tracking-[0.1em] text-ink-muted">Search</span>
        <input
          type="search"
          name="q"
          defaultValue={query.search ?? ''}
          placeholder="ticker, name, meme, address"
          className={`${control} w-full`}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-[0.1em] text-ink-muted">Chain</span>
        <select name="chain" defaultValue={query.chain ?? ''} onChange={nudge} className={control}>
          <option value="">all</option>
          {chains.map((chain) => (
            <option key={chain} value={chain}>
              {chain}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-[0.1em] text-ink-muted">Tier</span>
        <select name="tier" defaultValue={query.tier ?? ''} onChange={nudge} className={control}>
          <option value="">all</option>
          {tiers.map((tier) => (
            <option key={tier} value={tier}>
              {tier}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-[0.1em] text-ink-muted">Verdict</span>
        <select
          name="verdict"
          defaultValue={query.verdict ?? ''}
          onChange={nudge}
          className={control}
        >
          <option value="">all</option>
          {verdicts.map((verdict) => (
            <option key={verdict} value={verdict}>
              {verdict}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-[0.1em] text-ink-muted">Min score</span>
        <input
          type="number"
          name="minScore"
          min={0}
          max={100}
          step={5}
          defaultValue={query.minScore ?? ''}
          placeholder="0"
          className={`${control} num w-[84px]`}
        />
      </label>

      <button
        type="submit"
        className="rounded-[3px] border border-hair bg-raise px-3 py-1 text-[12px] text-ink hover:border-axis"
      >
        Apply
      </button>
      <a
        href={query.runId === undefined ? pathname : `${pathname}?run=${encodeURIComponent(query.runId)}`}
        className="rounded-[3px] px-2 py-1 text-[12px] text-ink-muted hover:text-ink-2"
      >
        Reset
      </a>

      <span className="num ml-auto self-center whitespace-nowrap text-[11px] text-ink-muted">
        {shown === total ? `${total} tokens` : `${shown} of ${total} tokens`}
      </span>
    </form>
  );
}
