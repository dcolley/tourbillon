import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getOrCreateChatController,
  getChatSession,
  resolveChatAgent,
  extractThreadTags,
  isReservedThreadMetadataKey,
} from '@/lib/chat';
import { chatErrorResponse, decodeResourceId } from '@/lib/chat/route-helpers';
import { chatModelIdFromSearch } from '@/lib/chat/model-query';

const createBodySchema = z.object({
  title: z.string().optional(),
  tags: z.record(z.string(), z.string()).optional(),
});

/** List chat threads for the session resource (newest first). */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string; resourceId: string }> },
) {
  try {
    const { agentId: agentKey, resourceId: rawResourceId } = await params;
    const resourceId = decodeResourceId(rawResourceId);
    const sessionScope = req.nextUrl.searchParams.get('sessionScope') ?? undefined;
    const limitRaw = req.nextUrl.searchParams.get('limit');
    const tagsRaw = req.nextUrl.searchParams.get('tags');

    let tags: Record<string, string> | undefined;
    if (tagsRaw) {
      try {
        tags = JSON.parse(tagsRaw) as Record<string, string>;
      } catch {
        tags = undefined;
      }
    }

    const agent = await resolveChatAgent(agentKey);
    const controller = await getOrCreateChatController(agent, { modelIdOverride: chatModelIdFromSearch(req) });
    const session = await getChatSession(controller, agent, {
      resourceId,
      scope: sessionScope,
    });

    const threads = await session.thread.list();
    
    // Apply context tag filters first (if provided)
    const tagEntries = tags
      ? Object.entries(tags).filter(([key]) => !isReservedThreadMetadataKey(key))
      : [];
    const contextFiltered =
      tagEntries.length > 0
        ? threads.filter((t) => {
            const metadata = (t.metadata as Record<string, unknown> | undefined) ?? {};
            return tagEntries.every(([key, value]) => metadata[key] === value);
          })
        : threads;
    
    // Separate into agent's own threads vs untagged shared threads
    const ownThreads = contextFiltered.filter((t) => {
      const metadata = (t.metadata as Record<string, unknown> | undefined) ?? {};
      return metadata.agentId === agent.id;
    });
    
    const sharedThreads = contextFiltered.filter((t) => {
      const metadata = (t.metadata as Record<string, unknown> | undefined) ?? {};
      return !metadata.agentId;
    });

    const toTime = (t: { updatedAt?: Date; createdAt?: Date }) =>
      (t.updatedAt ?? t.createdAt)?.getTime() ?? 0;
    
    // Sort each group separately (newest first)
    const sortedOwn = [...ownThreads].sort((a, b) => toTime(b) - toTime(a));
    const sortedShared = [...sharedThreads].sort((a, b) => toTime(b) - toTime(a));
    
    // Combine: own threads first, then shared threads
    const combined = [...sortedOwn, ...sortedShared];
    
    const max = limitRaw ? Number(limitRaw) : NaN;
    const limited = Number.isFinite(max) && max > 0 ? combined.slice(0, max) : combined;

    return NextResponse.json({
      threads: limited.map((t) => {
        const threadTags = extractThreadTags(t.metadata);
        const metadata = (t.metadata as Record<string, unknown> | undefined) ?? {};
        const isOwn = metadata.agentId === agent.id;
        const isShared = !metadata.agentId;
        
        return {
          id: t.id,
          title: t.title,
          tags: Object.keys(threadTags).length > 0 ? threadTags : undefined,
          updatedAt:
            t.updatedAt instanceof Date ? t.updatedAt.toISOString() : undefined,
          createdAt:
            t.createdAt instanceof Date ? t.createdAt.toISOString() : undefined,
          // Flag to help UI group threads
          isOwn,
          isShared,
        };
      }),
    });
  } catch (err) {
    return chatErrorResponse(err);
  }
}

/** Create a new chat thread and bind the session to it. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string; resourceId: string }> },
) {
  try {
    const { agentId: agentKey, resourceId: rawResourceId } = await params;
    const resourceId = decodeResourceId(rawResourceId);
    const sessionScope = req.nextUrl.searchParams.get('sessionScope') ?? undefined;
    const body = createBodySchema.parse(await req.json().catch(() => ({})));

    const agent = await resolveChatAgent(agentKey);
    const controller = await getOrCreateChatController(agent, { modelIdOverride: chatModelIdFromSearch(req) });
    const session = await getChatSession(controller, agent, {
      resourceId,
      scope: sessionScope,
      tags: {
        kind: 'chat',
        agentId: agent.id,
        ...(body.tags ?? {}),
      },
    });

    const thread = await session.thread.create({
      title: body.title,
    });

    // Ensure tags are on metadata even if the session was created earlier without them.
    const metadata: Record<string, string> = {
      kind: 'chat',
      agentId: agent.id,
      ...(body.tags ?? {}),
    };
    for (const [key, value] of Object.entries(metadata)) {
      await session.thread.setSetting({ key, value });
    }

    return NextResponse.json({
      id: thread.id,
      title: thread.title,
      resourceId: thread.resourceId,
      createdAt:
        thread.createdAt instanceof Date ? thread.createdAt.toISOString() : undefined,
      updatedAt:
        thread.updatedAt instanceof Date ? thread.updatedAt.toISOString() : undefined,
      tags: metadata,
    });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
