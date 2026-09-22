import { NextResponse } from 'next/server';
import { listDossiers } from '@/lib/data';
import { parseQuery, toDossierQuery, type SearchParams } from '@/lib/query';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const params: SearchParams = Object.fromEntries(url.searchParams.entries());
  const result = await listDossiers(toDossierQuery(parseQuery(params)));
  if (!result.ok) {
    return NextResponse.json({ error: result.problem.title, hint: result.problem.hint }, { status: 503 });
  }
  return NextResponse.json({ count: result.value.length, tokens: result.value });
}
