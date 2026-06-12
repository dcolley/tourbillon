import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getOrCreateDefaultCompany } from '@/lib/company';
import {
  isObservabilityEventStatus,
  isObservabilityEventType,
  isObservabilityPageSize,
  listObservabilityEvents,
} from '@/lib/observability';

const querySchema = z.object({
  issueId: z.string().optional(),
  projectId: z.string().optional(),
  goalId: z.string().optional(),
  agentId: z.string().optional(),
  eventType: z.string().optional(),
  status: z.string().optional(),
  traceId: z.string().optional(),
  heartbeatRunId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  search: z.string().optional(),
  page: z.coerce.number().int().min(0).optional(),
  pageSize: z.coerce.number().int().optional(),
});

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const query = parsed.data;
  const company = await getOrCreateDefaultCompany();

  if (query.eventType && !isObservabilityEventType(query.eventType)) {
    return NextResponse.json({ error: 'Invalid eventType' }, { status: 400 });
  }
  if (query.status && !isObservabilityEventStatus(query.status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
  }

  const pageSizeRaw = query.pageSize ?? 25;
  const pageSize = isObservabilityPageSize(pageSizeRaw) ? pageSizeRaw : 25;

  const from = query.from ? new Date(query.from) : undefined;
  const to = query.to ? new Date(query.to) : undefined;
  if (from && Number.isNaN(from.getTime())) {
    return NextResponse.json({ error: 'Invalid from date' }, { status: 400 });
  }
  if (to && Number.isNaN(to.getTime())) {
    return NextResponse.json({ error: 'Invalid to date' }, { status: 400 });
  }

  const result = await listObservabilityEvents({
    companyId: company.id,
    issueId: query.issueId,
    projectId: query.projectId,
    goalId: query.goalId,
    agentId: query.agentId,
    eventType: query.eventType as Parameters<typeof listObservabilityEvents>[0]['eventType'],
    status: query.status as Parameters<typeof listObservabilityEvents>[0]['status'],
    traceId: query.traceId,
    heartbeatRunId: query.heartbeatRunId,
    from,
    to,
    search: query.search,
    page: query.page ?? 0,
    pageSize,
  });

  return NextResponse.json(result);
}
