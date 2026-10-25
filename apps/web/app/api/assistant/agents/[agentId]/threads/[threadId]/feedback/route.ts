import { NextRequest, NextResponse } from 'next/server';
import { resolveChatAgent } from '@/lib/chat';
import { assistantErrorResponse, openAssistantSession } from '@/lib/assistant/threads';
import { assistantViewerKey } from '@/lib/assistant/viewer';
import { feedbackInputSchema } from '@/lib/assistant/feedback';
import { getAssistantThreadFeedback, saveAssistantMessageFeedback } from '@/lib/assistant/feedback-service';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ agentId: string; threadId: string }> };

/** OBS-2: the viewer's reactions on this thread's assistant messages, by message id. */
export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { agentId, threadId } = await params;
    const agent = await resolveChatAgent(agentId);
    const session = await openAssistantSession(agent);
    const feedback = await getAssistantThreadFeedback(session, agent, threadId, await assistantViewerKey());
    return NextResponse.json({ threadId, feedback });
  } catch (err) {
    return assistantErrorResponse(err);
  }
}

/**
 * OBS-2: set the viewer's reaction on one assistant message (`{ messageId, rating, reason?, tags? }`).
 * Saving again replaces it. The reaction is stored with the thread; the message's trace gets a
 * Phoenix annotation when Phoenix is configured (`annotation`: sent | skipped | failed).
 */
export async function PUT(req: NextRequest, { params }: Ctx) {
  try {
    const { agentId, threadId } = await params;
    const agent = await resolveChatAgent(agentId);
    const parsed = feedbackInputSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    const session = await openAssistantSession(agent);
    const saved = await saveAssistantMessageFeedback(session, agent, threadId, parsed.data, await assistantViewerKey());
    return NextResponse.json(saved);
  } catch (err) {
    return assistantErrorResponse(err);
  }
}
