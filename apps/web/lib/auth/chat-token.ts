/**
 * Chat-scoped API tokens for interactive AgentController sessions.
 *
 * #110: HMAC-signed with TOURBILLON_AGENT_TOKEN_SECRET and short-lived (CHAT_TOKEN_TTL_SEC).
 * Format: pm_chat_{base64url(JSON{ v, chatSessionId, agentId, companyId, iat, exp })}.{hmac}
 *
 * Validated alongside run tokens so existing agent tools accept either.
 */
import {
  CHAT_TOKEN_TTL_SEC,
  mintChatToken,
  verifyAgentTokenSignature,
} from '@tourbillon/shared/agent-token';

export interface ChatTokenPayload {
  chatSessionId: string;
  agentId: string;
  companyId: string;
  iat: number;
  exp: number;
}

/** Throws AgentTokenConfigError when TOURBILLON_AGENT_TOKEN_SECRET is not configured. */
export function buildChatScopedApiKey(
  chatSessionId: string,
  agentId: string,
  companyId: string,
  ttlSec: number = CHAT_TOKEN_TTL_SEC,
): string {
  return mintChatToken({ chatSessionId, agentId, companyId }, ttlSec);
}

/** Signature + expiry only (no DB). Use authenticateAgentToken() in routes. */
export function validateChatToken(token: string): ChatTokenPayload | null {
  const claims = verifyAgentTokenSignature(token);
  if (!claims || claims.kind !== 'chat') return null;
  return {
    chatSessionId: claims.chatSessionId,
    agentId: claims.agentId,
    companyId: claims.companyId,
    iat: claims.iat,
    exp: claims.exp,
  };
}
