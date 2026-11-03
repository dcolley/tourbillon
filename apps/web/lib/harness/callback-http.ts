/**
 * #281 AC5 — HTTP glue for POST /api/harness/callback/chat (S327-S3).
 *
 * Kept out of the route file so the wire contract is unit-pinned:
 *  - invalid JSON is NOT answered early — it becomes `body: undefined`, so auth still runs
 *    first (401 for a bad/missing token) and only an authenticated caller gets the 400;
 *  - a `message/stream` 200 is sent as `text/event-stream` with no-cache / no-transform and
 *    `X-Accel-Buffering: no` (the SSE body itself is buffered: every frame is emitted at once
 *    after the DM completes);
 *  - everything else is JSON with the gate's status.
 */
import { NextResponse } from 'next/server';
import { handleHarnessChat, type HarnessCallbackDeps } from './callback-gate';

export const HARNESS_CHAT_SSE_HEADERS = {
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
} as const;

export async function harnessChatPost(req: Request, deps: HarnessCallbackDeps): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = undefined; // invalid JSON ⇒ 400 from the gate (after auth), never a throw
  }
  const result = await handleHarnessChat({
    authorization: req.headers.get('authorization'),
    body,
    deps,
  });
  if (result.status === 200 && typeof result.body === 'string' && result.contentType?.startsWith('text/event-stream')) {
    return new NextResponse(result.body, {
      status: 200,
      headers: { 'Content-Type': result.contentType, ...HARNESS_CHAT_SSE_HEADERS },
    });
  }
  return NextResponse.json(result.body, { status: result.status });
}
