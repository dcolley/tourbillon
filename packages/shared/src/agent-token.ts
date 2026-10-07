/**
 * Signed agent API tokens (#110).
 *
 * Format:  pm_run_<b64url(payload)>.<b64url(hmac)>   (heartbeat run)
 *          pm_chat_<b64url(payload)>.<b64url(hmac)>  (interactive chat)
 * HMAC-SHA256 over everything before the "." (prefix included, so a run token can't be replayed as
 * a chat token) keyed with TOURBILLON_AGENT_TOKEN_SECRET. The payload carries `exp` (unix seconds).
 *
 * There is no default secret. When it's unset (or shorter than 32 chars), minting throws
 * AgentTokenConfigError and verification returns null, so callers fail closed in every environment.
 * The legacy unsigned format (no ".sig") is rejected.
 *
 * Never log tokens. This module logs nothing.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const AGENT_TOKEN_SECRET_ENV = 'TOURBILLON_AGENT_TOKEN_SECRET';
export const AGENT_TOKEN_SECRET_MIN_LENGTH = 32;
export const RUN_TOKEN_PREFIX = 'pm_run_';
export const CHAT_TOKEN_PREFIX = 'pm_chat_';
/** Added to the run's wall-clock timeout so a run that is just finishing can still call home. */
export const RUN_TOKEN_GRACE_SEC = 15 * 60;
/** Upper bound for run tokens (also used when the run has no wall-clock timeout). */
export const RUN_TOKEN_MAX_TTL_SEC = 24 * 60 * 60;
/** Chat tokens are short-lived; the web app re-mints them per request when near expiry. */
export const CHAT_TOKEN_TTL_SEC = 2 * 60 * 60;
const TOKEN_VERSION = 1;

export class AgentTokenConfigError extends Error {
  constructor() {
    super(
      `${AGENT_TOKEN_SECRET_ENV} is not set (or shorter than ${AGENT_TOKEN_SECRET_MIN_LENGTH} chars); ` +
        'agent tokens cannot be issued or verified',
    );
    this.name = 'AgentTokenConfigError';
  }
}

export interface RunTokenClaims {
  kind: 'run';
  runId: string;
  agentId: string;
  companyId: string;
  iat: number;
  exp: number;
}

export interface ChatTokenClaims {
  kind: 'chat';
  chatSessionId: string;
  agentId: string;
  companyId: string;
  iat: number;
  exp: number;
}

export type AgentTokenClaims = RunTokenClaims | ChatTokenClaims;

function secretKey(): Buffer | null {
  const secret = process.env[AGENT_TOKEN_SECRET_ENV]?.trim();
  if (!secret || secret.length < AGENT_TOKEN_SECRET_MIN_LENGTH) return null;
  return Buffer.from(secret, 'utf8');
}

export function isAgentTokenSecretConfigured(): boolean {
  return secretKey() !== null;
}

function sign(key: Buffer, body: string): string {
  return createHmac('sha256', key).update(body).digest('base64url');
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function mint(prefix: string, claims: Record<string, unknown>, ttlSec: number): string {
  const key = secretKey();
  if (!key) throw new AgentTokenConfigError();
  const iat = nowSec();
  const ttl = Math.max(1, Math.floor(ttlSec));
  const payload = Buffer.from(JSON.stringify({ v: TOKEN_VERSION, ...claims, iat, exp: iat + ttl })).toString(
    'base64url',
  );
  const body = `${prefix}${payload}`;
  return `${body}.${sign(key, body)}`;
}

/** TTL for a run token: the run's wall-clock timeout + grace, capped (no timeout → cap). */
export function runTokenTtlSec(timeoutSec: number | null | undefined): number {
  if (!timeoutSec || timeoutSec <= 0) return RUN_TOKEN_MAX_TTL_SEC;
  return Math.min(Math.floor(timeoutSec) + RUN_TOKEN_GRACE_SEC, RUN_TOKEN_MAX_TTL_SEC);
}

export function mintRunToken(
  input: { runId: string; agentId: string; companyId: string },
  ttlSec: number,
): string {
  return mint(RUN_TOKEN_PREFIX, { runId: input.runId, agentId: input.agentId, companyId: input.companyId }, ttlSec);
}

export function mintChatToken(
  input: { chatSessionId: string; agentId: string; companyId: string },
  ttlSec: number = CHAT_TOKEN_TTL_SEC,
): string {
  return mint(
    CHAT_TOKEN_PREFIX,
    { chatSessionId: input.chatSessionId, agentId: input.agentId, companyId: input.companyId },
    ttlSec,
  );
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Verify signature (constant time), version and expiry. Pure: no DB. Returns null for anything
 * invalid, including the legacy unsigned format and a missing secret. Never throws.
 */
export function verifyAgentTokenSignature(token: string | null | undefined): AgentTokenClaims | null {
  try {
    if (typeof token !== 'string') return null;
    const prefix = token.startsWith(RUN_TOKEN_PREFIX)
      ? RUN_TOKEN_PREFIX
      : token.startsWith(CHAT_TOKEN_PREFIX)
        ? CHAT_TOKEN_PREFIX
        : null;
    if (!prefix) return null;
    const dot = token.lastIndexOf('.');
    if (dot <= prefix.length) return null; // legacy unsigned token or malformed
    const key = secretKey();
    if (!key) return null;

    const body = token.slice(0, dot);
    const provided = Buffer.from(token.slice(dot + 1), 'base64url');
    const expected = Buffer.from(sign(key, body), 'base64url');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

    const payload = JSON.parse(Buffer.from(body.slice(prefix.length), 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    if (payload.v !== TOKEN_VERSION) return null;
    if (typeof payload.exp !== 'number' || typeof payload.iat !== 'number') return null;
    if (payload.exp <= nowSec()) return null;
    if (!isNonEmptyString(payload.agentId) || !isNonEmptyString(payload.companyId)) return null;

    if (prefix === RUN_TOKEN_PREFIX) {
      if (!isNonEmptyString(payload.runId)) return null;
      return {
        kind: 'run',
        runId: payload.runId,
        agentId: payload.agentId,
        companyId: payload.companyId,
        iat: payload.iat,
        exp: payload.exp,
      };
    }
    if (!isNonEmptyString(payload.chatSessionId)) return null;
    return {
      kind: 'chat',
      chatSessionId: payload.chatSessionId,
      agentId: payload.agentId,
      companyId: payload.companyId,
      iat: payload.iat,
      exp: payload.exp,
    };
  } catch {
    return null;
  }
}

/** The only chat session id format the web app issues (one stable session per agent). */
export function chatSessionIdForAgent(agentId: string): string {
  return `chat-${agentId}`;
}
