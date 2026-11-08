/**
 * #114: the run identity of an agent API request is the one in the signed token (runCtx.runId).
 *
 * Agent tools still send `X-Paperclip-Run-Id` (packages/mastra/src/tools/api-client.ts). The
 * header is NOT a credential: when it is present it must equal the authenticated run id, or the
 * request is refused with a fixed 403 before any lookup or mutation. It is never used as the
 * acting run. Absent header → the authenticated run id. Chat tokens: runCtx.runId is the chat
 * session id (`chat-<agentId>`), so the same rule applies unchanged.
 *
 * Board/session users never reach these handlers (they authenticate with an agent bearer only);
 * board writes go through server actions that do not read this header.
 */
import { NextResponse } from 'next/server';
import type { RunTokenPayload } from './run-token';

export const RUN_ID_HEADER = 'x-paperclip-run-id';
export const RUN_ID_MISMATCH_CODE = 'run_id_mismatch';

export type AuthenticatedRunId = { runId: string; denied?: undefined } | { runId?: undefined; denied: NextResponse };

export function authenticatedRunId(headers: Headers, runCtx: RunTokenPayload): AuthenticatedRunId {
  const header = headers.get(RUN_ID_HEADER);
  if (header === null) return { runId: runCtx.runId };
  if (header === runCtx.runId) return { runId: runCtx.runId };
  return {
    denied: NextResponse.json(
      { error: 'Forbidden: run id header does not match the authenticated run', code: RUN_ID_MISMATCH_CODE },
      { status: 403 },
    ),
  };
}
