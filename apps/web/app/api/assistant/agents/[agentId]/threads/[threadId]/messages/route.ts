import { NextRequest, NextResponse } from 'next/server';
import { resolveChatAgent } from '@/lib/chat';
import { assistantErrorResponse, listAssistantThreadMessages, openAssistantSession } from '@/lib/assistant/threads';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ agentId: string; threadId: string }> };

/**
 * P0 (agent switch): the persisted messages of one of the agent's assistant threads, oldest first.
 * The assistant chat loads them every time it opens (agent switch, reload), so the transcript always
 * shows the conversation up to now. Never cached. 404 when the thread is not the agent's.
 */
export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { agentId, threadId } = await params;
    const agent = await resolveChatAgent(agentId);
    const session = await openAssistantSession(agent);
    const messages = await listAssistantThreadMessages(session, agent, threadId);
    return NextResponse.json({ messages }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return assistantErrorResponse(err);
  }
}
