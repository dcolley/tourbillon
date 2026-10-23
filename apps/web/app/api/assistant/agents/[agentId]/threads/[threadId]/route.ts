import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveChatAgent } from '@/lib/chat';
import { assistantErrorResponse, openAssistantSession, updateAssistantThread } from '@/lib/assistant/threads';

export const dynamic = 'force-dynamic';

const patchBodySchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    pinned: z.boolean().optional(),
    read: z.literal(true).optional(),
  })
  .strict()
  .refine((b) => b.title !== undefined || b.pinned !== undefined || b.read !== undefined, {
    message: 'Nothing to update',
  });

/** UI-2: rename, pin/unpin, or mark read one of the agent's assistant threads. */
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
    const thread = await updateAssistantThread(session, agent, threadId, parsed.data);
    return NextResponse.json({ thread });
  } catch (err) {
    return assistantErrorResponse(err);
  }
}
