import { NextRequest, NextResponse } from 'next/server';
import { getHeartbeatList } from '@/lib/heartbeats';
import { getAgentByUrlKey } from '@/lib/agents';
import {
  isHeartbeatListFilter,
  isHeartbeatPageSize,
  type HeartbeatListFilter,
} from '@/lib/heartbeat-list-storage';

export async function GET(req: NextRequest) {
  const filterParam = req.nextUrl.searchParams.get('filter') ?? 'all';
  const filter: HeartbeatListFilter = isHeartbeatListFilter(filterParam) ? filterParam : 'all';

  const pageParam = parseInt(req.nextUrl.searchParams.get('page') ?? '0', 10);
  const page = Number.isFinite(pageParam) && pageParam >= 0 ? pageParam : 0;

  const pageSizeParam = parseInt(req.nextUrl.searchParams.get('pageSize') ?? '25', 10);
  const pageSize = isHeartbeatPageSize(pageSizeParam) ? pageSizeParam : 25;

  const agentUrlKey = req.nextUrl.searchParams.get('agent');
  const agent = agentUrlKey ? await getAgentByUrlKey(agentUrlKey) : null;

  const result = await getHeartbeatList({
    filter,
    page,
    pageSize,
    agentId: agent?.id,
  });

  return NextResponse.json({
    ...result,
    entries: result.entries.map((entry) => ({
      ...entry,
      startedAt: entry.startedAt?.toISOString() ?? null,
      finishedAt: entry.finishedAt?.toISOString() ?? null,
    })),
  });
}
