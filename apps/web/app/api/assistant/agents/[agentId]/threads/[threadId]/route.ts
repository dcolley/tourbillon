import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveChatAgent } from '@/lib/chat';
import {
  assistantErrorResponse,
  assistantThreadTitleSchema,
  getAssistantThread,
  openAssistantSession,
  updateAssistantThread,
} from '@/lib/assistant/threads';
import { assistantViewerKey } from '@/lib/assistant/viewer';

export const dynamic = 'force-dynamic';

const patchBodySchema = z
  .object({
    title: assistantThreadTitleSchema.optional(),
    pinned: z.boolean().optional(),
    read: z.literal(true).optional(),
  })
  .strict()
  .refine((b) => b.title !== undefined || b.pinned !== undefined || b.read !== undefined, {
    message: 'Nothing to update',
  });

type Ctx = { params: Promise<{ agentId: string; threadId: string }> };

/** AGUI-1b: one of the agent's assistant threads, for opening it by id (404 when not the agent's). */
export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { agentId, threadId } = await params;
    const agent = await resolveChatAgent(agentId);
    const session = await openAssistantSession(agent);
    const thread = await getAssistantThread(session, agent, threadId, await assistantViewerKey());
    return NextResponse.json({ thread });
  } catch (err) {
    return assistantErrorResponse(err);
  }
}

/**
 * UI-2: rename, pin/unpin (per user), or mark read one of the agent's assistant threads.
 * Rename and pin are refused (409) for an archived agent; mark read is allowed.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ agentId: string; threadId: string }> },
) {
  try {
    const { agentId, threadId } = await params;
    const agent = await resolveChatAgent(agentId);
    const parsed = patchBodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });

    const session = await openAssistantSession(agent);
    const thread = await updateAssistantThread(session, agent, threadId, parsed.data, await assistantViewerKey());
    return NextResponse.json({ thread });
  } catch (err) {
    return assistantErrorResponse(err);
  }
}
