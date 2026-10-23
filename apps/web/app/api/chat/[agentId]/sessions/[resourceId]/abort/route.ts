import { NextRequest, NextResponse } from 'next/server';
import {
  getOrCreateChatController,
  resolveChatAgent,
} from '@/lib/chat';
import { chatErrorResponse, decodeResourceId, openChatRouteSession, assertChatSessionGuard, controlChatDisabledResponse } from '@/lib/chat/route-helpers';
import { chatModelIdFromSearch } from '@/lib/chat/model-query';

/**
 * Abort the in-flight chat run. Mastra 1.63+ Session.abort() clears running
 * state internally (displayState is read-only). UI will receive agent_end event.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string; resourceId: string }> },
) {
  const disabled = controlChatDisabledResponse();
  if (disabled) return disabled;
  try {
    const { agentId: agentKey, resourceId: rawResourceId } = await params;
    const resourceId = decodeResourceId(rawResourceId);
    const sessionScope = req.nextUrl.searchParams.get('sessionScope') ?? undefined;

    const agent = await resolveChatAgent(agentKey);
    const controller = await getOrCreateChatController(agent, { modelIdOverride: chatModelIdFromSearch(req) });
    const session = await openChatRouteSession(controller, agent, {
      resourceId,
      scope: sessionScope,
    });
    await assertChatSessionGuard(session, 'abort');
    session.abort();
    
    return NextResponse.json({ ok: true });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
