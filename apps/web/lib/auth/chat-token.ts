/**
 * Chat-scoped API tokens for interactive AgentController sessions.
 *
 * Format: pm_chat_{base64url(JSON.stringify({ chatSessionId, agentId, companyId, iat }))}
 *
 * Validated alongside run tokens so existing agent tools accept either.
 */

export interface ChatTokenPayload {
  chatSessionId: string;
  agentId: string;
  companyId: string;
  iat: number;
}

export function buildChatScopedApiKey(
  chatSessionId: string,
  agentId: string,
  companyId: string,
): string {
  const payload = JSON.stringify({
    chatSessionId,
    agentId,
    companyId,
    iat: Date.now(),
  } satisfies ChatTokenPayload);
  return `pm_chat_${Buffer.from(payload).toString('base64url')}`;
}

export function validateChatToken(token: string): ChatTokenPayload | null {
  try {
    if (!token.startsWith('pm_chat_')) return null;
    const encoded = token.slice('pm_chat_'.length);
    const decoded = Buffer.from(encoded, 'base64url').toString('utf-8');
    const payload = JSON.parse(decoded) as ChatTokenPayload;
    if (!payload.chatSessionId || !payload.agentId || !payload.companyId) return null;
    return payload;
  } catch {
    return null;
  }
}
