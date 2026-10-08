import { NextResponse } from 'next/server';
import { isProviderConfigError } from '@tourbillon/shared';
import { ActiveCompanyError } from '@/lib/company';
import { ChatAgentError } from '@/lib/chat';
import { agentTokenConfigErrorResponse, isAgentTokenConfigError } from '@/lib/auth/agent-token-config';

export function chatErrorResponse(err: unknown): NextResponse {
  if (err instanceof ChatAgentError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof ActiveCompanyError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  // Provider config that can never be used safely, e.g. llm_provider_base_url_host_mismatch
  // (agent base URL override on another host from its provider): 409 + code, like /api/models.
  if (isProviderConfigError(err)) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  // #110: no/short TOURBILLON_AGENT_TOKEN_SECRET → 401 + server log (same as agent API routes).
  if (isAgentTokenConfigError(err)) {
    return agentTokenConfigErrorResponse('chat');
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
