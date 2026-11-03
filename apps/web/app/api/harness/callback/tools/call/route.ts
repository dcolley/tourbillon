/**
 * #281 — POST /api/harness/callback/tools/call  { tool, args }
 * External Hermes tool execution over the SAME capability gate as in-system agents.
 * Denied tools are refused 403 without executing; auth failures 401.
 */
import { NextRequest, NextResponse } from 'next/server';
import { handleHarnessToolCall } from '../../../../../../lib/harness/callback-gate';
import { buildHarnessCallbackDeps } from '../../../../../../lib/harness/callback-deps';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_request', message: 'Body must be JSON' }, { status: 400 });
  }
  const result = await handleHarnessToolCall({
    authorization: req.headers.get('authorization'),
    body,
    deps: buildHarnessCallbackDeps(),
  });
  return NextResponse.json(result.body, { status: result.status });
}
