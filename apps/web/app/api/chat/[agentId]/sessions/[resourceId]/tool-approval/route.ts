import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveChatRequestUser } from '@/lib/chat/request-user';
import {
  getOrCreateChatController,
  createChatRequestContext,
  resolveChatAgent,
} from '@/lib/chat';
import { chatErrorResponse, decodeResourceId, openChatRouteSession, controlChatDisabledResponse } from '@/lib/chat/route-helpers';
import { chatModelIdFromSearch } from '@/lib/chat/model-query';

const bodySchema = z.object({
  toolCallId: z.string().min(1),
  approved: z.boolean(),
});

/** Approve or decline a pending tool call. */
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
    const body = bodySchema.parse(await req.json());

    const agent = await resolveChatAgent(agentKey);
    const controller = await getOrCreateChatController(agent, { modelIdOverride: chatModelIdFromSearch(req) });
    const session = await openChatRouteSession(controller, agent, {
      resourceId,
      scope: sessionScope,
    });
    const requestContext = createChatRequestContext(agent, {
      threadId: session.thread.getId(),
      requestingUser: await resolveChatRequestUser(req.headers),
    });
    session.respondToToolApproval({
      toolCallId: body.toolCallId,
      decision: body.approved ? 'approve' : 'decline',
      requestContext: requestContext as never,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
