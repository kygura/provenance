import { NextResponse } from 'next/server';
import { listRuns } from '@/lib/data';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? 50);
  const result = await listRuns(Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50);
  if (!result.ok) {
    return NextResponse.json({ error: result.problem.title, hint: result.problem.hint }, { status: 503 });
  }
  return NextResponse.json({ count: result.value.length, runs: result.value });
}
