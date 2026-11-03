/**
 * #281 AC5 — POST /api/harness/callback/chat
 * A2A JSONRPC chat for a bound harness (Hermes / OpenCode) — only for the legs the bind
 * advertises (`adapterConfig.chat.sync` → `message/send`, `.stream` → `message/stream` SSE).
 * Delivery runs the agent's own capability-gated `sendToAgent` DM tool (no second chat stack).
 * All logic + gating lives in lib/harness/callback-gate.ts; HTTP glue (invalid JSON → 400 after
 * auth, SSE headers) in lib/harness/callback-http.ts — both unit-tested with injected deps.
 */
import { NextRequest } from 'next/server';
import { harnessChatPost } from '../../../../../lib/harness/callback-http';
import { buildHarnessCallbackDeps } from '../../../../../lib/harness/callback-deps';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  return harnessChatPost(req, buildHarnessCallbackDeps());
}
