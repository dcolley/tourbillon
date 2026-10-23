import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveChatAgent } from '@/lib/chat';
import {
  assistantErrorResponse,
  createAssistantThread,
  listAssistantThreads,
  openAssistantSession,
} from '@/lib/assistant/threads';
import { pickInitialThread } from '@/lib/assistant/sidebar';

export const dynamic = 'force-dynamic';

const createBodySchema = z.object({ title: z.string().trim().min(1).max(200).optional() }).strict();

type Ctx = { params: Promise<{ agentId: string }> };

/**
 * UI-2: the agent's threads for the assistant sidebar (active company only).
 * `?q=` filters by title, `?limit=` caps the list (default 50). Pinned first, then latest activity.
 * `initialThreadId` is the thread to open when the agent is selected (null = start a new one).
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  try {
    const { agentId } = await params;
    const agent = await resolveChatAgent(agentId);
    const limitRaw = Number(req.nextUrl.searchParams.get('limit'));
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : undefined;
    const query = req.nextUrl.searchParams.get('q');

    const session = await openAssistantSession(agent);
    const threads = await listAssistantThreads(session, agent, { query, limit });
    const initial = query ? null : pickInitialThread(threads, agent.id);
    return NextResponse.json({ agentId: agent.id, threads, initialThreadId: initial?.id ?? null });
  } catch (err) {
    return assistantErrorResponse(err);
  }
}

/** UI-2: start a new thread for the agent in the company's assistant resource. */
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { agentId } = await params;
    const agent = await resolveChatAgent(agentId);
    const parsed = createBodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });

    const session = await openAssistantSession(agent);
    const thread = await createAssistantThread(session, agent, parsed.data);
    return NextResponse.json({ thread }, { status: 201 });
  } catch (err) {
    return assistantErrorResponse(err);
  }
}
