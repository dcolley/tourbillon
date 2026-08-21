import { NextRequest, NextResponse } from 'next/server';
import {
  getOrCreateChatController,
  getChatSession,
  resolveChatAgent,
} from '@/lib/chat';
import { chatErrorResponse, decodeResourceId } from '@/lib/chat/route-helpers';
import { chatModelIdFromSearch } from '@/lib/chat/model-query';

/** Hydrate session state (running, mode, thread). */
export async function GET(
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

    const ds = session.displayState.get();
    return NextResponse.json({
      controllerId: controller.id,
      resourceId,
      threadId: session.thread.getId() ?? undefined,
      modeId: session.mode.get(),
      modelId: session.model.get(),
      running: ds.isRunning === true,
      agentId: agent.id,
      agentUrlKey: agent.urlKey,
      agentName: agent.name,
    });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
