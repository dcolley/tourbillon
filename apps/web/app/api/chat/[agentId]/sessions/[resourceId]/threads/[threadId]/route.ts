import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getOrCreateChatController,
  resolveChatAgent,
} from '@/lib/chat';
import { chatErrorResponse, decodeResourceId, openChatRouteSession, requireChatThread, assertChatSessionGuard, controlChatDisabledResponse } from '@/lib/chat/route-helpers';
import { chatModelIdFromSearch } from '@/lib/chat/model-query';

const renameBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
});

/** Rename a chat thread (binds briefly if it is not the active thread). */
export async function PATCH(
  req: NextRequest,
  {
    params,
  }: { params: Promise<{ agentId: string; resourceId: string; threadId: string }> },
) {
  const disabled = controlChatDisabledResponse();
  if (disabled) return disabled;
  try {
    const {
      agentId: agentKey,
      resourceId: rawResourceId,
      threadId,
    } = await params;
    const resourceId = decodeResourceId(rawResourceId);
    const sessionScope = req.nextUrl.searchParams.get('sessionScope') ?? undefined;
    const body = renameBodySchema.parse(await req.json());

    const agent = await resolveChatAgent(agentKey);
    const controller = await getOrCreateChatController(agent, {
      modelIdOverride: chatModelIdFromSearch(req),
    });
    const session = await openChatRouteSession(controller, agent, {
      resourceId,
      scope: sessionScope,
    });

    await requireChatThread(session, agent, resourceId, threadId);
    await assertChatSessionGuard(session, 'rename-thread', threadId);

    const previousThreadId = session.thread.getId();
    if (previousThreadId !== threadId) {
      await session.thread.switch({ threadId });
    }

    await session.thread.rename({ title: body.title });

    if (previousThreadId && previousThreadId !== threadId) {
      await session.thread.switch({ threadId: previousThreadId });
    }

    return NextResponse.json({
      id: threadId,
      title: body.title,
    });
  } catch (err) {
    return chatErrorResponse(err);
  }
}

/** Delete a chat thread. Clears the session binding when deleting the active thread. */
export async function DELETE(
  req: NextRequest,
  {
    params,
  }: { params: Promise<{ agentId: string; resourceId: string; threadId: string }> },
) {
  const disabled = controlChatDisabledResponse();
  if (disabled) return disabled;
  try {
    const {
      agentId: agentKey,
      resourceId: rawResourceId,
      threadId,
    } = await params;
    const resourceId = decodeResourceId(rawResourceId);
    const sessionScope = req.nextUrl.searchParams.get('sessionScope') ?? undefined;

    const agent = await resolveChatAgent(agentKey);
    const controller = await getOrCreateChatController(agent, {
      modelIdOverride: chatModelIdFromSearch(req),
    });
    const session = await openChatRouteSession(controller, agent, {
      resourceId,
      scope: sessionScope,
    });

    await requireChatThread(session, agent, resourceId, threadId);
    await assertChatSessionGuard(session, 'delete-thread', threadId);

    const deletedCurrent = session.thread.getId() === threadId;
    await session.thread.delete({ threadId });

    return NextResponse.json({ ok: true, deletedCurrent });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
