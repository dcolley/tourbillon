import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getOrCreateChatController,
  getChatSession,
  createChatRequestContext,
  resolveChatAgent,
} from '@/lib/chat';
import {
  chatDashboardContextSchema,
  wrapMessageWithDashboardContext,
} from '@/lib/chat/dashboard-context';
import { chatErrorResponse, decodeResourceId } from '@/lib/chat/route-helpers';
import { chatModelIdFromSearch } from '@/lib/chat/model-query';

const bodySchema = z.object({
  message: z.string().min(1),
  context: chatDashboardContextSchema,
});

/** Queue a follow-up (or send immediately when idle). */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string; resourceId: string }> },
) {
  try {
    const { agentId: agentKey, resourceId: rawResourceId } = await params;
    const resourceId = decodeResourceId(rawResourceId);
    const sessionScope = req.nextUrl.searchParams.get('sessionScope') ?? undefined;
    const body = bodySchema.parse(await req.json());

    const agent = await resolveChatAgent(agentKey);
    const controller = await getOrCreateChatController(agent, { modelIdOverride: chatModelIdFromSearch(req) });
    const session = await getChatSession(controller, agent, {
      resourceId,
      scope: sessionScope,
    });
    const requestContext = createChatRequestContext(agent);
    void session.followUp({
      content: wrapMessageWithDashboardContext(body.message, body.context),
      requestContext: requestContext as never,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
