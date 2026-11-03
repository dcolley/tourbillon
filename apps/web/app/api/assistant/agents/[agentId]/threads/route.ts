import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveChatAgent } from '@/lib/chat';
import {
  assertAgentWritable,
  assistantErrorResponse,
  assistantThreadTitleSchema,
  createAssistantThread,
  openAssistantSession,
} from '@/lib/assistant/threads';
import { activateAssistantThread, assistantOmSummary } from '@/lib/assistant/active-thread';
import { loadAgentThreadsPayload, parseAssistantThreadsLimit } from '@/lib/assistant/agent-threads-payload';
import { assistantViewerKey } from '@/lib/assistant/viewer';
import { takeThreadCreateSlot } from '@/lib/assistant/create-limit';

export const dynamic = 'force-dynamic';

const createBodySchema = z.object({ title: assistantThreadTitleSchema.optional() }).strict();

type Ctx = { params: Promise<{ agentId: string }> };

/**
 * UI-2: the agent's threads for the assistant sidebar (active company only).
 * `?q=` filters by title, `?limit=` caps the list (default 50). Pinned first, then latest activity.
 * `initialThreadId` is the thread to open when the agent is selected (null = start a new one).
 * ASYNC-0 (Slice B): that is the agent's pinned active thread (lib/assistant/active-thread.ts), never
 * "latest by activity", so a thread from before Clear chat cannot come back. `observationalMemory`
 * is the agent's OM mode for the chat ⋯ menu.
 * S306-S4: the sidebar loads every agent's list at once through GET /api/assistant/threads?agentIds=…;
 * this per-agent route stays for single-agent reloads (retry, select, search).
 */
export async function GET(req: NextRequest, { params }: Ctx) {
  try {
    const { agentId } = await params;
    const agent = await resolveChatAgent(agentId);
    const limit = parseAssistantThreadsLimit(req.nextUrl.searchParams.get('limit'));
    const query = req.nextUrl.searchParams.get('q');
    // S306-S4: same per-agent payload as the batch list (GET /api/assistant/threads?agentIds=…).
    return NextResponse.json(await loadAgentThreadsPayload(agent, { query, limit, viewerKey: await assistantViewerKey() }));
  } catch (err) {
    return assistantErrorResponse(err);
  }
}

/**
 * UI-2: start a new thread for the agent in the company's assistant resource.
 * ASYNC-0 (Slice B): the new thread becomes the agent's active thread (Clear chat / first thread):
 * it is pinned, and the agent's idle AG-UI session (AgentController + Observational Memory) is moved
 * onto it.
 * 409 for an archived agent; 429 (with Retry-After) past the per-company creation limit.
 */
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const { agentId } = await params;
    const agent = await resolveChatAgent(agentId);
    const parsed = createBodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    assertAgentWritable(agent);

    // Every accepted attempt counts, so a failing request cannot be retried past the limit.
    const slot = takeThreadCreateSlot(agent.companyId);
    if (!slot.ok) {
      return NextResponse.json(
        { error: `Too many new threads for this company; try again in ${slot.retryAfterSec}s` },
        { status: 429, headers: { 'Retry-After': String(slot.retryAfterSec) } },
      );
    }
    const session = await openAssistantSession(agent);
    const thread = await createAssistantThread(session, agent, parsed.data);
    await activateAssistantThread(agent, thread.id);
    return NextResponse.json(
      { thread, activeThreadId: thread.id, observationalMemory: await assistantOmSummary(agent) },
      { status: 201 },
    );
  } catch (err) {
    return assistantErrorResponse(err);
  }
}
