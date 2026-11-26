/**
 * TB-364 (A14/A35): discard a failed message. Server-side, keyed by `clientMessageId`:
 * the stored user row's text is replaced by the placeholder (so the message leaves every later
 * model context — A35c/M50) and the marker (state `discarded`, original text preserved) keeps it
 * in the transcript greyed "Not sent". A keyed marker/queue signal row is rewritten in place.
 * 404 when the key is unknown (a message that failed before the run started was never stored —
 * the client keeps the local state and ignores this).
 */
import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { resolveChatAgent } from '@/lib/chat';
import { assistantErrorResponse, openAssistantSession, requireAssistantThread } from '@/lib/assistant/threads';
import { persistDiscardMarker, type MarkerSessionLike } from '@/lib/agui/failure-marker';

const CLIENT_KEY = /^[\w.:-]{1,200}$/;

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ agentId: string; threadId: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { agentId, threadId } = await params;
    const agent = await resolveChatAgent(agentId);
    const body = (await req.json().catch(() => null)) as { clientMessageId?: unknown } | null;
    const clientMessageId = body?.clientMessageId;
    if (typeof clientMessageId !== 'string' || !CLIENT_KEY.test(clientMessageId)) {
      return NextResponse.json({ error: 'Invalid clientMessageId' }, { status: 400 });
    }
    const session = await openAssistantSession(agent);
    // Ownership/scope first: 404 for a thread that is not this agent's, before touching storage.
    await requireAssistantThread(session, agent, threadId);
    const resourceId = (session as unknown as { identity?: { getResourceId?: () => string } }).identity?.getResourceId?.() ?? '';
    const found = await persistDiscardMarker(session as unknown as MarkerSessionLike, {
      resourceId,
      threadId,
      clientMessageId,
      newId: () => `tb364-${randomUUID()}`,
    });
    if (!found) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true, clientMessageId, state: 'discarded' });
  } catch (err) {
    return assistantErrorResponse(err);
  }
}
