import { NextRequest, NextResponse } from 'next/server';
import { getActiveCompany } from '@/lib/company';
import { getObservabilityEvent } from '@/lib/observability';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ eventId: string }> }
) {
  const { eventId } = await params;
  const company = await getActiveCompany();
  const event = await getObservabilityEvent(company.id, eventId);
  if (!event) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.json(event);
}
