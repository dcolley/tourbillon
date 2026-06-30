import { NextRequest, NextResponse } from 'next/server';
import { db, agents } from '@tourbillon/db';
import { eq } from 'drizzle-orm';
import { validateRunToken, type RunTokenPayload } from '@/lib/auth/run-token';
import { getNitterUrl } from '@/lib/nitter/config';
import {
  NitterPayloadError,
  NitterRateLimitedError,
  NitterUpstreamError,
} from '@/lib/nitter/types';

export interface NitterRouteContext {
  runCtx: RunTokenPayload;
}

export async function authorizeNitterRequest(
  req: NextRequest,
): Promise<NextResponse | NitterRouteContext> {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const runCtx = validateRunToken(token);
  if (!runCtx) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 });
  }

  if (!getNitterUrl()) {
    return NextResponse.json(
      { error: 'Nitter not configured', message: 'Set NITTER_URL in environment' },
      { status: 503 },
    );
  }

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, runCtx.agentId),
  });

  if (!agent) {
    return NextResponse.json({ error: 'Agent not found' }, { status: 404 });
  }

  if (!agent.assignedToolsets.includes('nitter')) {
    return NextResponse.json(
      { error: 'Forbidden', message: 'nitter toolset not enabled for this agent' },
      { status: 403 },
    );
  }

  return { runCtx };
}

export function nitterErrorResponse(err: unknown): NextResponse {
  if (err instanceof NitterRateLimitedError) {
    const headers: Record<string, string> = {};
    if (err.details.retryAfterSeconds !== undefined) {
      headers['Retry-After'] = String(err.details.retryAfterSeconds);
    }
    return NextResponse.json(
      {
        error: 'RATE_LIMITED',
        message: err.message,
        retryable: true,
        details: err.details,
      },
      { status: 429, headers },
    );
  }

  if (err instanceof NitterUpstreamError) {
    const status = err.statusCode >= 500 ? 502 : err.statusCode;
    return NextResponse.json(
      {
        error: 'UPSTREAM_ERROR',
        message: err.message,
        retryable: err.statusCode >= 500,
        statusCode: err.statusCode,
        snippet: err.snippet,
      },
      { status },
    );
  }

  if (err instanceof NitterPayloadError) {
    return NextResponse.json(
      {
        error: 'INVALID_PAYLOAD',
        message: err.message,
        retryable: false,
      },
      { status: 502 },
    );
  }

  const message = err instanceof Error ? err.message : 'Unknown error';
  return NextResponse.json({ error: 'INTERNAL_ERROR', message }, { status: 500 });
}
