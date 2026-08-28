import { NextRequest, NextResponse } from 'next/server';
import {
  getOrCreateChatController,
  getChatSession,
  resolveChatAgent,
} from '@/lib/chat';
import { chatErrorResponse, decodeResourceId } from '@/lib/chat/route-helpers';
import { chatModelIdFromSearch } from '@/lib/chat/model-query';

/** Abort the in-flight chat run and force-clear display state. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string; resourceId: string }> },
) {
  try {
    const { agentId: agentKey, resourceId: rawResourceId } = await params;
    const resourceId = decodeResourceId(rawResourceId);
    const sessionScope = req.nextUrl.searchParams.get('sessionScope') ?? undefined;

    const agent = await resolveChatAgent(agentKey);
    const controller = await getOrCreateChatController(agent, { modelIdOverride: chatModelIdFromSearch(req) });
    const session = await getChatSession(controller, agent, {
      resourceId,
      scope: sessionScope,
    });
    session.abort();
    
    // Force-clear display state in case agent_end event was missed (e.g. tripwire)
    const displayState = session.displayState.get();
    if (displayState.isRunning) {
      session.displayState.set({ ...displayState, isRunning: false });
    }
    
    return NextResponse.json({ ok: true });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
