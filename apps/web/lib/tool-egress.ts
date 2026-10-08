/**
 * Route side of the outbound host allow-list for agent tools (web search, Nitter).
 * The live tool gate denies a call whose configured host is off the list before it runs; these
 * helpers cover the request itself (the configured URL as the web app resolves it, and every
 * redirect hop): a refusal answers 403 and writes an `agent.tool_denied` activity row with the
 * host only.
 */
import { NextResponse } from 'next/server';
import { db, activityLog } from '@tourbillon/db';
import {
  isToolEgressBlockedError,
  resolveToolEgressPolicy,
  type AgentRuntimeConfig,
  type CompanySettings,
  type ToolEgressPolicy,
} from '@tourbillon/shared';

export function toolEgressPolicyFor(
  companySettings: CompanySettings | null | undefined,
  agentRuntime: AgentRuntimeConfig | null | undefined,
): ToolEgressPolicy {
  return resolveToolEgressPolicy(companySettings ?? null, agentRuntime ?? null);
}

export interface ToolEgressDenialContext {
  runCtx: { agentId: string; companyId: string; runId?: string };
  agentName?: string | null;
}

export const TOOL_EGRESS_DENIED_MESSAGE =
  'The outbound host for this tool is not on the allow-list for agent tools; the request was not sent.';

export function toolEgressDeniedResponse(host: string | null): NextResponse {
  return NextResponse.json(
    {
      error: 'tool_not_allowed',
      reason: 'egress_not_allowed',
      ...(host ? { host } : {}),
      message: TOOL_EGRESS_DENIED_MESSAGE,
    },
    { status: 403 },
  );
}

type RecordFn = (row: typeof activityLog.$inferInsert) => Promise<unknown>;

let recordRow: RecordFn = (row) => db.insert(activityLog).values(row);

/** Test hook: capture activity rows instead of writing them. Pass nothing to restore. */
export function setToolEgressRecorderForTests(fn?: RecordFn): void {
  recordRow = fn ?? ((row) => db.insert(activityLog).values(row));
}

/**
 * When `err` is an allow-list refusal: write the activity row (host only) and return the 403.
 * Otherwise null, so the route falls through to its own error handling.
 */
export async function handleToolEgressError(
  err: unknown,
  ctx: ToolEgressDenialContext,
  tool: string,
): Promise<NextResponse | null> {
  if (!isToolEgressBlockedError(err)) return null;
  const host = err.host;
  try {
    await recordRow({
      companyId: ctx.runCtx.companyId,
      actorType: 'agent',
      actorId: ctx.runCtx.agentId,
      actorName: ctx.agentName ?? null,
      action: 'agent.tool_denied',
      entityType: 'agent',
      entityId: ctx.runCtx.agentId,
      details: {
        tool,
        reason: 'egress_not_allowed',
        ...(host ? { host } : {}),
        stage: 'request',
        ...(ctx.runCtx.runId ? { runId: ctx.runCtx.runId } : {}),
      },
    });
  } catch (recordErr) {
    console.warn(
      '[tool-egress] failed to record tool denial:',
      recordErr instanceof Error ? recordErr.message : String(recordErr),
    );
  }
  return toolEgressDeniedResponse(host);
}
