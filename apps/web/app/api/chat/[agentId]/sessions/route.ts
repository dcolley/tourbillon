import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  getOrCreateChatController,
  resolveChatAgent,
  chatResourceId,
  chatContextFromTags,
} from '@/lib/chat';
import { chatErrorResponse, openChatRouteSession } from '@/lib/chat/route-helpers';

const bodySchema = z.object({
  /** Accepted for older clients but ignored: the resource is derived on the server. */
  resourceId: z.string().optional(),
  tags: z.record(z.string(), z.string()).optional(),
  threadId: z.string().optional(),
  sessionScope: z.string().optional(),
  modelId: z.string().optional(),
});

/** Create or resume a chat AgentController session. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  try {
    const { agentId: agentKey } = await params;
    const agent = await resolveChatAgent(agentKey);
    const json = await req.json().catch(() => ({}));
    const body = bodySchema.parse(json);

    const context = chatContextFromTags(body.tags);
    // Always derived from the agent's company and the chat context, never taken from the client.
    const resourceId = chatResourceId(agent.companyId, context);
    const sessionScope =
      body.sessionScope ??
      (context.contextId
        ? `${context.contextType ?? 'free'}:${context.contextId}`
        : context.contextType ?? 'free');

    const controller = await getOrCreateChatController(agent, {
      modelIdOverride: body.modelId,
    });
    // Ownership keys come last so request tags cannot set or override them (as in POST threads).
    const tags: Record<string, string> = {
      ...(body.tags ?? {}),
      kind: 'chat',
      agentId: agent.id,
    };
    const session = await openChatRouteSession(controller, agent, {
      resourceId,
      threadId: body.threadId,
      tags,
      scope: sessionScope,
    });

    return NextResponse.json({
      controllerId: controller.id,
      resourceId,
      threadId: session.thread.getId() ?? undefined,
      agentId: agent.id,
      agentUrlKey: agent.urlKey,
      agentName: agent.name,
      modelId: body.modelId ?? agent.modelId ?? session.model.get() ?? undefined,
    });
  } catch (err) {
    return chatErrorResponse(err);
  }
}
