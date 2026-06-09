/**
 * Run-scoped token validation.
 *
 * Tokens are issued by the heartbeat worker with format:
 *   pm_run_{base64url(JSON.stringify({ runId, agentId, companyId, iat }))}
 *
 * Production: replace with JWT + HMAC signature verification.
 * Prototype: decode and trust the payload directly.
 */

interface RunTokenPayload {
  runId: string;
  agentId: string;
  companyId: string;
  iat: number;
}

export function validateRunToken(token: string): RunTokenPayload | null {
  try {
    if (!token.startsWith('pm_run_')) return null;
    const encoded = token.slice('pm_run_'.length);
    const decoded = Buffer.from(encoded, 'base64url').toString('utf-8');
    const payload = JSON.parse(decoded) as RunTokenPayload;
    if (!payload.runId || !payload.agentId || !payload.companyId) return null;
    // Prototype: no expiry check. Production: check payload.iat + TTL.
    return payload;
  } catch {
    return null;
  }
}
