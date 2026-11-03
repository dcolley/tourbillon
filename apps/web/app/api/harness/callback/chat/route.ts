/**
 * #281 AC5 — POST /api/harness/callback/chat
 * A2A JSONRPC chat for a bound harness (Hermes / OpenCode) — only for the legs the bind
 * advertises (`adapterConfig.chat.sync` → `message/send`, `.stream` → `message/stream` SSE).
 * Delivery runs the agent's own capability-gated `sendToAgent` DM tool (no second chat stack).
 * All logic + gating lives in lib/harness/callback-gate.ts (unit-tested with injected deps).
 */
import { NextRequest, NextResponse } from 'next/server';
import { handleHarnessChat } from '../../../../../lib/harness/callback-gate';
import { buildHarnessCallbackDeps } from '../../../../../lib/harness/callback-deps';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = undefined; // invalid JSON ⇒ 400 from the gate (after auth), never a throw
  }
  const result = await handleHarnessChat({
    authorization: req.headers.get('authorization'),
    body,
    deps: buildHarnessCallbackDeps(),
  });
  if (result.status === 200 && typeof result.body === 'string' && result.contentType?.startsWith('text/event-stream')) {
    return new NextResponse(result.body, {
      status: 200,
      headers: {
        'Content-Type': result.contentType,
        'Cache-Control': 'no-cache, no-transform',
        'X-Accel-Buffering': 'no',
      },
    });
  }
  return NextResponse.json(result.body, { status: result.status });
}
