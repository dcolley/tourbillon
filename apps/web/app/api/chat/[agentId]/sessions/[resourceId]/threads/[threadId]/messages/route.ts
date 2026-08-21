import { NextRequest, NextResponse } from 'next/server';
import {
  getOrCreateChatController,
  getChatSession,
  resolveChatAgent,
} from '@/lib/chat';
import { chatErrorResponse, decodeResourceId } from '@/lib/chat/route-helpers';
import { chatModelIdFromSearch } from '@/lib/chat/model-query';

/** List persisted messages for catch-up / hydrate. */
export async function GET(
  req: NextRequest,
  {
    params,
  }: { params: Promise<{ agentId: string; resourceId: string; threadId: string }> },
) {
  try {
    const {
      agentId: agentKey,
      resourceId: rawResourceId,
      threadId,
    } = await params;
    const resourceId = decodeResourceId(rawResourceId);
    const sessionScope = req.nextUrl.searchParams.get('sessionScope') ?? undefined;
    const limitRaw = req.nextUrl.searchParams.get('limit');
    const limit = limitRaw ? Number(limitRaw) : undefined;

    const agent = await resolveChatAgent(agentKey);
    const controller = await getOrCreateChatController(agent, { modelIdOverride: chatModelIdFromSearch(req) });
    const session = await getChatSession(controller, agent, {
      resourceId,
      scope: sessionScope,
    });

    const messages = await session.thread.listMessages({
      threadId,
      ...(Number.isFinite(limit) && limit! > 0 ? { limit } : {}),
    });

    return NextResponse.json({
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt:
          m.createdAt instanceof Date ? m.createdAt.toISOString() : undefined,
        threadId: m.threadId,
        resourceId: m.resourceId,
        type: m.type,
      })),
    });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
