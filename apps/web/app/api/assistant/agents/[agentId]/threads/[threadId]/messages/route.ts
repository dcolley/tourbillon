import { NextRequest, NextResponse } from 'next/server';
import { resolveChatAgent } from '@/lib/chat';
import {
  assistantErrorResponse,
  listAssistantThreadMessages,
  listAssistantThreadMessagesPage,
  openAssistantSession,
} from '@/lib/assistant/threads';
import { parseTranscriptPageQuery } from '@/lib/assistant/transcript-page';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ agentId: string; threadId: string }> };

/**
 * P0 (agent switch): the persisted messages of one of the agent's assistant threads, oldest first.
 * The assistant chat loads them every time it opens (agent switch, reload), so the transcript always
 * shows the conversation up to now. Never cached. 404 when the thread is not the agent's.
 *
 * CHAT-PAGE-1: paged by query params (lib/assistant/transcript-page.ts):
 * - `?limit=N` → the newest N messages; `?limit=N&before=<messageId>` → the N messages before that one.
 * - Answer `{ messages, hasMore }`; `hasMore` says whether older messages exist before the page.
 * - Without `limit` / `before`: every message (`hasMore: false`), as before. Bad params → 400.
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  try {
    const { agentId, threadId } = await params;
    const parsed = parseTranscriptPageQuery(req.nextUrl.searchParams);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const agent = await resolveChatAgent(agentId);
    const session = await openAssistantSession(agent);
    const body = parsed.query
      ? await listAssistantThreadMessagesPage(session, agent, threadId, parsed.query)
      : { messages: await listAssistantThreadMessages(session, agent, threadId), hasMore: false };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return assistantErrorResponse(err);
  }
}
