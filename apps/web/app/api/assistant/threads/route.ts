import { NextRequest, NextResponse } from 'next/server';
import { ChatAgentError, resolveChatAgent } from '@/lib/chat';
import { getActiveCompany } from '@/lib/company';
import { assistantErrorResponse } from '@/lib/assistant/threads';
import { assistantViewerKey } from '@/lib/assistant/viewer';
import { loadAgentThreadsPayload, parseAssistantThreadsLimit } from '@/lib/assistant/agent-threads-payload';
import { parseAssistantAgentIdsParam } from '@/lib/assistant/sidebar';

export const dynamic = 'force-dynamic';

/** Agents resolved/listed at once inside one batch request (bounded server-side fan-out). */
const BATCH_CONCURRENCY = 4;

type AgentThreadsPayload = Awaited<ReturnType<typeof loadAgentThreadsPayload>>;

/**
 * S306-S4: every requested agent's sidebar thread list in ONE request — the sidebar used to
 * send one `GET /api/assistant/agents/[agentId]/threads` per agent.
 *
 * `?agentIds=a,b,c` (ids or url keys; the param may repeat; blanks dropped, duplicates collapse)
 * and optional `?limit=` (per agent, as on the per-agent route). 400 when `agentIds` is
 * missing/empty, names more than ASSISTANT_THREADS_BATCH_MAX_AGENTS agents, or holds an
 * over-long key. No active company → the per-agent route's error (nothing opened).
 *
 * Auth and scope are per agent and identical to the per-agent route: each key goes through
 * `resolveChatAgent` (active company only, id or url key), then the same payload builder. A key
 * that does not resolve — another company's agent, or no such agent — is FILTERED: it gets no
 * threads and is only echoed back in `missing` (the same "not found" either way, so the batch
 * reveals nothing the per-agent 404 would not). Any other per-agent failure lands in `errors`
 * (500 text is never returned) without failing the other agents.
 *
 * Response: `{ agents: [{ agentKey, agentId, threads, initialThreadId, observationalMemory }],
 *   missing: string[], errors: [{ agentKey, status, error }] }` — `agents` in request order,
 *   one entry per distinct resolved agent.
 */
export async function GET(req: NextRequest) {
  try {
    const parsed = parseAssistantAgentIdsParam(req.nextUrl.searchParams.getAll('agentIds'));
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const limit = parseAssistantThreadsLimit(req.nextUrl.searchParams.get('limit'));
    // Whole-request auth first: no active company fails the request before any agent lookup.
    await getActiveCompany();
    const viewerKey = await assistantViewerKey();

    const results: Array<
      | { kind: 'ok'; agentKey: string; payload: AgentThreadsPayload }
      | { kind: 'missing'; agentKey: string }
      | { kind: 'error'; agentKey: string; status: number; error: string }
      | undefined
    > = new Array(parsed.agentIds.length);
    const resolvedIds = new Set<string>();
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < parsed.agentIds.length; i = next++) {
        const agentKey = parsed.agentIds[i]!;
        try {
          const agent = await resolveChatAgent(agentKey);
          // `alice` and `agent-a` may name the same agent: list it once.
          if (resolvedIds.has(agent.id)) continue;
          resolvedIds.add(agent.id);
          results[i] = { kind: 'ok', agentKey, payload: await loadAgentThreadsPayload(agent, { limit, viewerKey }) };
        } catch (err) {
          if (err instanceof ChatAgentError && err.status === 404) {
            results[i] = { kind: 'missing', agentKey };
            continue;
          }
          const res = assistantErrorResponse(err);
          if (res.status === 400 || res.status === 401) throw err; // whole-request auth (company gone mid-batch)
          const body = (await res.json().catch(() => ({}))) as { error?: unknown };
          results[i] = {
            kind: 'error',
            agentKey,
            status: res.status,
            error: typeof body.error === 'string' ? body.error : 'Internal error',
          };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, parsed.agentIds.length) }, worker));

    const agents: Array<{ agentKey: string } & AgentThreadsPayload> = [];
    const missing: string[] = [];
    const errors: Array<{ agentKey: string; status: number; error: string }> = [];
    for (const r of results) {
      if (!r) continue;
      if (r.kind === 'ok') agents.push({ agentKey: r.agentKey, ...r.payload });
      else if (r.kind === 'missing') missing.push(r.agentKey);
      else errors.push({ agentKey: r.agentKey, status: r.status, error: r.error });
    }
    return NextResponse.json({ agents, missing, errors });
  } catch (err) {
    return assistantErrorResponse(err);
  }
}
