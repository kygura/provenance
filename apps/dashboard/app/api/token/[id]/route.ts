import { NextResponse } from 'next/server';
import { getDossier, scoreHistory } from '@/lib/data';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const tokenId = decodeURIComponent(id);

  const [dossier, history] = await Promise.all([getDossier(tokenId), scoreHistory(tokenId)]);
  if (!dossier.ok) {
    return NextResponse.json({ error: dossier.problem.title, hint: dossier.problem.hint }, { status: 503 });
  }
  if (!dossier.value) {
    return NextResponse.json({ error: 'Token not found', tokenId }, { status: 404 });
  }
  return NextResponse.json({
    ...dossier.value,
    scoreHistory: history.ok ? history.value : [],
  });
}
