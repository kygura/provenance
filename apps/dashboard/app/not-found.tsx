import Link from 'next/link';
import { EmptyState, SiteNav } from '@/components/ui';

export default function NotFound() {
  return (
    <>
      <SiteNav current="run" />
      <div className="px-3 py-3">
        <EmptyState title="Not found">That token is not in the database, or the id is malformed.</EmptyState>
        <p className="mt-3 text-[12px]">
          <Link href="/" className="text-ink-muted hover:text-ink hover:underline">← all tokens</Link>
        </p>
      </div>
    </>
  );
}
