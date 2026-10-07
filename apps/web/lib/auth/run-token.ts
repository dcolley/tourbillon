/**
 * Run-scoped (and chat-scoped) token validation.
 *
 * #110: tokens are HMAC-SHA256 signed with TOURBILLON_AGENT_TOKEN_SECRET and carry `exp`:
 *   pm_run_{base64url(JSON{ v, runId, agentId, companyId, iat, exp })}.{hmac}   (scheduler)
 *   pm_chat_{base64url(JSON{ v, chatSessionId, agentId, companyId, iat, exp })}.{hmac} (web chat)
 * Chat tokens are accepted here with runId = chatSessionId so agent tools work unchanged.
 *
 * `validateRunToken` is pure (signature + expiry, no DB) so it stays usable from edge-ish code.
 * Route handlers must use `authenticateAgentToken` (lib/auth/agent-token-auth.ts), which also
 * checks the DB (run is running and matches agent/company; chat agent belongs to the company).
 * Legacy unsigned tokens are rejected.
 */
import { verifyAgentTokenSignature } from '@tourbillon/shared/agent-token';

export interface RunTokenPayload {
  runId: string;
  agentId: string;
  companyId: string;
  iat: number;
  /** #110: expiry (unix seconds). */
  exp?: number;
  /** #110: which kind of token this came from. */
  kind?: 'run' | 'chat';
}

export function validateRunToken(token: string): RunTokenPayload | null {
  const claims = verifyAgentTokenSignature(token);
  if (!claims) return null;
  return {
    runId: claims.kind === 'run' ? claims.runId : claims.chatSessionId,
    agentId: claims.agentId,
    companyId: claims.companyId,
    iat: claims.iat,
    exp: claims.exp,
    kind: claims.kind,
  };
}
