/**
 * #281 — GET /api/harness/callback/tools
 * Lists the capability-gated tool surface for the bound agent (same assembler as in-system
 * agent tool assembly). Self-gated: requires the run-scoped session token.
 */
import { NextRequest, NextResponse } from 'next/server';
import { handleHarnessToolList } from '../../../../../lib/harness/callback-gate';
import { buildHarnessCallbackDeps } from '../../../../../lib/harness/callback-deps';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const result = await handleHarnessToolList({
    authorization: req.headers.get('authorization'),
    deps: buildHarnessCallbackDeps(),
  });
  return NextResponse.json(result.body, { status: result.status });
}
