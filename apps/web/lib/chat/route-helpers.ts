import { NextResponse } from 'next/server';
import { ActiveCompanyError } from '@/lib/company';
import { ChatAgentError } from '@/lib/chat';
import { agentTokenConfigErrorResponse, isAgentTokenConfigError } from '@/lib/auth/agent-token-config';
import { isEnvCredentialHostError } from '@tourbillon/shared';

export function chatErrorResponse(err: unknown): NextResponse {
  if (err instanceof ChatAgentError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof ActiveCompanyError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  // #110: no/short TOURBILLON_AGENT_TOKEN_SECRET → 401 + server log (same as agent API routes).
  if (isAgentTokenConfigError(err)) {
    return agentTokenConfigErrorResponse('chat');
  }
  // Env API key refused for an agent base URL on another host: 409 + code, nothing was sent.
  if (isEnvCredentialHostError(err)) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  console.error('[chat-api]', err);
  const message = err instanceof Error ? err.message : String(err);
  return NextResponse.json({ error: message }, { status: 500 });
}

export function decodeResourceId(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
