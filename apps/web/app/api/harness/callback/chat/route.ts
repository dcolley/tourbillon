/**
 * #281 — POST /api/harness/callback/chat  (first-slice stub)
 * Board chat over the Hermes callback is a documented follow-up (PR body carries the measured
 * Hermes gateway evidence: agent card advertises streaming; message/stream wiring is the next
 * pack). Auth is still enforced so the surface shape is stable for harnesses.
 */
import { NextRequest, NextResponse } from 'next/server';
import { handleHarnessChat } from '../../../../../lib/harness/callback-gate';
import { buildHarnessCallbackDeps } from '../../../../../lib/harness/callback-deps';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const result = await handleHarnessChat({
    authorization: req.headers.get('authorization'),
    deps: buildHarnessCallbackDeps(),
  });
  return NextResponse.json(result.body, { status: result.status });
}
