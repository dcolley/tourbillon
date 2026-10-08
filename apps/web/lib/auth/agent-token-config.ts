/**
 * #110: one behaviour for every agent-token path when TOURBILLON_AGENT_TOKEN_SECRET is missing
 * (or shorter than 32 chars): the caller gets 401 and the server logs the configuration error.
 *
 * - Agent API routes (pm_run_/pm_chat_ bearer): authenticateAgentToken logs and returns null → 401.
 * - Board chat routes (/api/chat/*), which mint a chat token: chatErrorResponse → 401 + log.
 * - Heartbeat runs (scheduler) still fail immediately with the same error text.
 *
 * The log line carries only the fixed config error and a short context label. Never pass a token,
 * header or request object here.
 */
import { NextResponse } from 'next/server';
import { AgentTokenConfigError, isAgentTokenSecretConfigured } from '@tourbillon/shared/agent-token';

export { isAgentTokenSecretConfigured };

/** True for AgentTokenConfigError (also when wrapped as an error `cause`, or across module copies). */
export function isAgentTokenConfigError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 5; depth += 1) {
    if (e instanceof AgentTokenConfigError) return true;
    if (e instanceof Error && e.name === 'AgentTokenConfigError') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** Log the missing/short secret. `context` is a fixed label such as "agent API" or "chat". */
export function logAgentTokenConfigError(context: string): void {
  console.error(`[agent-token] ${new AgentTokenConfigError().message}`, { context });
}

/** 401 for the caller + server-side config error log. */
export function agentTokenConfigErrorResponse(context: string): NextResponse {
  logAgentTokenConfigError(context);
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
