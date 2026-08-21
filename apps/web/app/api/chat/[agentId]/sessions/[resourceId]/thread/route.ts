import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getOrCreateChatController,
  getChatSession,
  resolveChatAgent,
} from '@/lib/chat';
import { chatErrorResponse, decodeResourceId } from '@/lib/chat/route-helpers';
import { chatModelIdFromSearch } from '@/lib/chat/model-query';

const bodySchema = z.object({
  threadId: z.string().min(1),
});

/** Switch the session to an existing thread. */
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

    if (session.thread.getId() !== body.threadId) {
      await session.thread.switch({ threadId: body.threadId });
    }

    return NextResponse.json({ ok: true, threadId: body.threadId });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
