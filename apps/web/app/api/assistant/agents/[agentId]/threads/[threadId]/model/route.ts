/**
 * CHAT-5: the model and effort one assistant thread runs on.
 *
 * GET    → { state }: the thread's choice (or null: agent default), whether its provider is still
 *          available, the agent's default, and the providers switched on for the company.
 * PUT    { providerId, modelId, reasoningLevel? } → { state } after storing the choice.
 * DELETE → { state } after clearing it (back to the agent default).
 *
 * Same auth and scope as the other assistant thread routes (board session + active company, agent
 * in that company, thread tagged to the agent). Changes are refused with 409 while an AG-UI run is
 * open on the thread or when the provider is not on for the company (`provider_disabled_for_company`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { resolveChatAgent } from '@/lib/chat';
import { assistantErrorResponse, assistantResourceId, openAssistantSession, requireAssistantThread } from '@/lib/assistant/threads';
import { setAssistantThreadModelRow } from '@/lib/assistant/thread-store';
import { isAguiThreadRunClaimed } from '@/lib/agui/run-claims';
import { effectiveLlmProviderIdForCompany, listLlmProvidersForCompany } from '@/lib/llm-providers';
import { isReasoningLevel, isThreadModelId, isThreadProviderId } from '@/lib/assistant/thread-model';
import {
  ThreadModelError,
  saveThreadModelChoice,
  threadModelState,
  type ThreadModelAgent,
  type ThreadModelDeps,
} from '@/lib/assistant/thread-model-service';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ agentId: string; threadId: string }> };

const putBodySchema = z
  .object({
    providerId: z.string().refine(isThreadProviderId),
    modelId: z.string().refine(isThreadModelId),
    reasoningLevel: z.string().refine(isReasoningLevel).nullable().optional(),
  })
  .strict();

function deps(agent: ThreadModelAgent): ThreadModelDeps {
  const resourceId = assistantResourceId(agent.companyId);
  return {
    listProviders: (companyId) => listLlmProvidersForCompany(companyId),
    effectiveAgentProviderId: (companyId, providerId) => effectiveLlmProviderIdForCompany(companyId, providerId),
    isRunOpen: (threadId) => isAguiThreadRunClaimed(resourceId, threadId),
    writeChoice: (threadId, choice) => setAssistantThreadModelRow({ threadId, resourceId, agentId: agent.id }, choice),
  };
}

function errorResponse(err: unknown) {
  if (err instanceof ThreadModelError) {
    return NextResponse.json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, { status: err.status });
  }
  return assistantErrorResponse(err);
}

async function load(params: Ctx['params']) {
  const { agentId, threadId } = await params;
  const agent = await resolveChatAgent(agentId);
  const session = await openAssistantSession(agent);
  await requireAssistantThread(session, agent, threadId);
  return { agent, session, threadId };
}

async function stateResponse(agent: ThreadModelAgent, session: Awaited<ReturnType<typeof openAssistantSession>>, threadId: string) {
  const thread = await session.thread.getById({ threadId });
  const state = await threadModelState(agent, thread?.metadata, deps(agent));
  return NextResponse.json({ state });
}

export async function GET(_req: NextRequest, { params }: Ctx) {
  try {
    const { agent, session, threadId } = await load(params);
    return await stateResponse(agent, session, threadId);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  try {
    const { agentId, threadId } = await params;
    const agent = await resolveChatAgent(agentId);
    const parsed = putBodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    const session = await openAssistantSession(agent);
    await requireAssistantThread(session, agent, threadId);
    const { providerId, modelId, reasoningLevel } = parsed.data;
    await saveThreadModelChoice(
      agent,
      threadId,
      { providerId, modelId, ...(reasoningLevel && isReasoningLevel(reasoningLevel) ? { reasoningLevel } : {}) },
      deps(agent),
    );
    return await stateResponse(agent, session, threadId);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  try {
    const { agent, session, threadId } = await load(params);
    await saveThreadModelChoice(agent, threadId, null, deps(agent));
    return await stateResponse(agent, session, threadId);
  } catch (err) {
    return errorResponse(err);
  }
}
