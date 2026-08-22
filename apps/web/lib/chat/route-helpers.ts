import { NextResponse } from 'next/server';
import { ActiveCompanyError } from '@/lib/company';
import { ChatAgentError } from '@/lib/chat';

export function chatErrorResponse(err: unknown): NextResponse {
  if (err instanceof ChatAgentError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  if (err instanceof ActiveCompanyError) {
    return NextResponse.json({ error: err.message }, { status: 400 });
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
