/**
 * #110: authenticate an agent run/chat token for a route handler.
 *
 * 1. Signature (constant time) + version + expiry via validateRunToken (no DB).
 * 2. DB checks:
 *    - run token: heartbeat_runs row exists, status is 'running', and its agentId/companyId match
 *      the token; the agent row exists in that company.
 *    - chat token: chatSessionId is the agent's chat session (`chat-<agentId>`), and the agent
 *      exists in the token's company and is not archived.
 * Returns the payload or null (callers answer 401). Never logs the token.
 */
import { db, agents, heartbeatRuns } from '@tourbillon/db';
import { and, eq } from 'drizzle-orm';
import { chatSessionIdForAgent } from '@tourbillon/shared/agent-token';
import { validateRunToken, type RunTokenPayload } from './run-token';

export async function authenticateAgentToken(
  token: string | null | undefined,
): Promise<RunTokenPayload | null> {
  if (!token) return null;
  const payload = validateRunToken(token);
  if (!payload) return null;

  try {
    const agent = await db.query.agents.findFirst({
      where: and(eq(agents.id, payload.agentId), eq(agents.companyId, payload.companyId)),
    });
    if (!agent) return null;

    if (payload.kind === 'chat') {
      if (payload.runId !== chatSessionIdForAgent(agent.id)) return null;
      if (agent.status === 'archived') return null;
      return payload;
    }

    const run = await db.query.heartbeatRuns.findFirst({
      where: eq(heartbeatRuns.id, payload.runId),
    });
    if (!run) return null;
    if (run.status !== 'running') return null;
    if (run.agentId !== payload.agentId || run.companyId !== payload.companyId) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Bearer token from an Authorization header value. */
export function bearerToken(authorization: string | null | undefined): string | null {
  const t = authorization?.replace(/^Bearer\s+/i, '').trim();
  return t ? t : null;
}
