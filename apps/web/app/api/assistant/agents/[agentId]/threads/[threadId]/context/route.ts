/**
 * CTX-1: context meter for one assistant thread.
 *
 * GET → { meter }: estimated prompt tokens vs the chat context budget of the model the thread runs
 * on (lib/assistant/context-meter.ts documents the estimate). Same auth and scope as the other
 * assistant thread routes; 404 when the thread is not the agent's. Read only, never cached.
 */
import { NextRequest, NextResponse } from 'next/server';
import { resolveChatAgent } from '@/lib/chat';
import {
  assistantErrorResponse,
  listAssistantThreadMessages,
  openAssistantSession,
  requireAssistantThread,
} from '@/lib/assistant/threads';
import { defaultContextMeterDeps, threadContextMeter } from '@/lib/assistant/context-meter-service';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ agentId: string; threadId: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { agentId, threadId } = await params;
    const agent = await resolveChatAgent(agentId);
    const session = await openAssistantSession(agent);
    const thread = await requireAssistantThread(session, agent, threadId);
    const messages = await listAssistantThreadMessages(session, agent, threadId);
    const meter = await threadContextMeter(agent, thread.metadata, messages, defaultContextMeterDeps);
    return NextResponse.json({ meter }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return assistantErrorResponse(err);
  }
}
