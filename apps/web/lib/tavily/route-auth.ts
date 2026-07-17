import { NextRequest, NextResponse } from 'next/server';
import { db, agents, companies } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { validateRunToken, type RunTokenPayload } from '@/lib/auth/run-token';
import type { AgentRuntimeConfig } from '@tourbillon/shared';
import { getCompanySettingsFromDb, getResolvedTavilyApiKey } from '@/lib/tavily/config';
import { TavilyUpstreamError } from '@/lib/tavily/types';

export interface TavilyRouteContext {
  runCtx: RunTokenPayload;
  apiKey: string;
}

export async function authorizeTavilyRequest(
  req: NextRequest,
): Promise<NextResponse | TavilyRouteContext> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const runCtx = validateRunToken(token);
  if (!runCtx) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, runCtx.agentId),
  });

  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }

  if (!agent.assignedToolsets.includes('web-search-tavily')) {
    return NextResponse.json(
      { error: 'Forbidden', message: 'web-search-tavily toolset not enabled for this agent' },
      { status: 403 },
    );
  }

  const company = await db.query.companies.findFirst({
    where: eq(companies.id, runCtx.companyId),
  });
  const companySettings = getCompanySettingsFromDb(company?.settings);
  const runtimeConfig = agent.runtimeConfig as AgentRuntimeConfig;

  const apiKey = getResolvedTavilyApiKey(companySettings, runtimeConfig);
  if (!apiKey) {
    return NextResponse.json(
      {
        error: 'Tavily not configured',
        message: 'Set TAVILY_API_KEY in environment or company/agent settings',
      },
      { status: 503 },
    );
  }

  return {
    runCtx,
    apiKey,
  };
}

export function tavilyErrorResponse(err: unknown): NextResponse {
  if (err instanceof TavilyUpstreamError) {
    const status = err.statusCode >= 500 ? 502 : err.statusCode;
    return NextResponse.json(
      {
        error: 'UPSTREAM_ERROR',
        message: err.message,
        retryable: err.statusCode >= 500,
        statusCode: err.statusCode,
        snippet: err.bodyPreview,
      },
      { status },
    );
  }

  const message = err instanceof Error ? err.message : 'Unknown error';
  return NextResponse.json({ error: 'INTERNAL_ERROR', message }, { status: 500 });
}
