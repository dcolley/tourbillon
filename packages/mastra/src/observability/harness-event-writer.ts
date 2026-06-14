import { db, agentObservabilityEvents, heartbeatRuns } from '@tourbillon/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import {
  observabilityMaxPayloadBytes,
  observabilityPreviewChars,
} from '@tourbillon/shared';
import type { HarnessEvent } from '@mastra/core/harness';

export const HARNESS_OBSERVABLE_EVENT_TYPES = new Set<string>([
  'agent_start',
  'agent_end',
  'message_start',
  'message_update',
  'message_end',
  'tool_start',
  'tool_end',
  'tool_approval_required',
  'tool_suspended',
  'tool_input_start',
  'tool_input_delta',
  'tool_input_end',
  'usage_update',
  'error',
  'mode_changed',
  'subagent_start',
  'subagent_end',
  'om_observation',
  'om_reflection',
]);

export interface HarnessObservabilityContext {
  companyId: string;
  agentId: string;
  issueId?: string;
  goalId?: string;
  projectId?: string;
  heartbeatRunId: string;
  jobId?: string;
  traceId: string;
  /** Maps harness toolCallId → toolName (tool_end omits toolName). */
  toolCallNames?: Map<string, string>;
}

function serializePreview(value: unknown): string | null {
  if (value == null) return null;
  const max = observabilityPreviewChars();
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > max ? `${text.slice(0, max)}…` : text;
  } catch {
    return String(value).slice(0, max);
  }
}

function capPayload(value: unknown): Record<string, unknown> {
  const maxBytes = observabilityMaxPayloadBytes();
  try {
    const json = JSON.stringify(value ?? {});
    if (json.length <= maxBytes) {
      return (value && typeof value === 'object' && !Array.isArray(value))
        ? (value as Record<string, unknown>)
        : { value };
    }
    return { truncated: true, preview: json.slice(0, maxBytes) };
  } catch {
    return { truncated: true };
  }
}

function resolveToolName(
  ctx: HarnessObservabilityContext,
  event: HarnessEvent,
): string | undefined {
  if ('toolName' in event && typeof event.toolName === 'string' && event.toolName) {
    return event.toolName;
  }
  if ('toolCallId' in event && typeof event.toolCallId === 'string') {
    return ctx.toolCallNames?.get(event.toolCallId);
  }
  return undefined;
}

function eventDisplayName(ctx: HarnessObservabilityContext, event: HarnessEvent): string {
  const toolName = resolveToolName(ctx, event);
  if (toolName) return toolName;

  if ('toolCallId' in event && typeof event.toolCallId === 'string') {
    return `${event.type}:${event.toolCallId.slice(0, 8)}`;
  }

  if (event.type === 'agent_end') {
    return `agent_end:${event.reason ?? 'complete'}`;
  }

  return event.type;
}

function mapHarnessEventType(event: HarnessEvent): string {
  switch (event.type) {
    case 'tool_start':
    case 'tool_input_start':
      return 'tool_call_start';
    case 'tool_end':
      return 'tool_call_result';
    case 'tool_suspended':
      return 'tool_suspended';
    case 'message_update':
      return 'text_delta';
    case 'agent_end':
      return 'agent_done';
    case 'usage_update':
      return 'usage_update';
    case 'error':
      return 'error';
    case 'mode_changed':
      return 'mode_switch';
    default:
      return event.type;
  }
}

export function writeHarnessObservabilityEvent(
  ctx: HarnessObservabilityContext,
  event: HarnessEvent,
): void {
  if (!HARNESS_OBSERVABLE_EVENT_TYPES.has(event.type)) return;

  if (
    event.type === 'tool_start' &&
    ctx.toolCallNames &&
    typeof event.toolCallId === 'string' &&
    typeof event.toolName === 'string'
  ) {
    ctx.toolCallNames.set(event.toolCallId, event.toolName);
  }

  const spanId = randomUUID();
  const eventType = mapHarnessEventType(event);
  const name = eventDisplayName(ctx, event);

  let toolId: string | null = resolveToolName(ctx, event) ?? null;
  let inputPreview: string | null = null;
  let outputPreview: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let status: 'ok' | 'error' = 'ok';
  let errorText: string | null = null;

  if ('args' in event) {
    inputPreview = serializePreview(event.args);
  }
  if ('result' in event) {
    outputPreview = serializePreview(event.result);
  }
  if ('partialResult' in event) {
    outputPreview = serializePreview(event.partialResult);
  }
  if (event.type === 'usage_update') {
    inputTokens = event.usage.promptTokens ?? null;
    outputTokens = event.usage.completionTokens ?? null;
  }
  if (event.type === 'error') {
    status = 'error';
    errorText = event.error.message;
  }

  void db
    .insert(agentObservabilityEvents)
    .values({
      companyId: ctx.companyId,
      traceId: ctx.traceId,
      spanId,
      heartbeatRunId: ctx.heartbeatRunId,
      jobId: ctx.jobId ?? null,
      agentId: ctx.agentId,
      issueId: ctx.issueId ?? null,
      goalId: ctx.goalId ?? null,
      projectId: ctx.projectId ?? null,
      eventType: eventType as typeof agentObservabilityEvents.$inferInsert.eventType,
      name,
      status,
      toolId,
      inputPreview,
      outputPreview,
      payload: capPayload(event),
      errorText,
      inputTokens,
      outputTokens,
      occurredAt: new Date(),
    })
    .catch((err) => {
      console.error('[harness-event-writer] write failed', err);
    });
}

export interface ResumableHarnessRun {
  heartbeatRunId: string;
  harnessRunId: string;
  threadId: string;
  finishReason?: 'suspended' | 'running';
}

export async function getResumableHarnessRun(
  agentId: string,
  taskId?: string,
): Promise<ResumableHarnessRun | null> {
  const rows = await db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.agentId, agentId),
        inArray(heartbeatRuns.status, ['running', 'failed']),
      ),
    )
    .orderBy(desc(heartbeatRuns.startedAt))
    .limit(5);

  for (const row of rows) {
    if (!row.harnessRunId) continue;
    const snapshot = row.contextSnapshot as Record<string, unknown> | null;
    const snapshotTaskId =
      typeof snapshot?.taskId === 'string' ? snapshot.taskId : undefined;
    if (taskId && snapshotTaskId !== taskId) continue;

    const threadId =
      typeof snapshot?.harnessThreadId === 'string'
        ? snapshot.harnessThreadId
        : taskId
          ? `issue-${row.companyId}-${taskId}`
          : `agent-${agentId}`;

    return {
      heartbeatRunId: row.id,
      harnessRunId: row.harnessRunId,
      threadId,
      finishReason: row.status === 'running' ? 'running' : undefined,
    };
  }

  return null;
}

export async function persistHarnessRunId(
  runId: string,
  harnessRunId: string,
  threadId: string,
): Promise<void> {
  const existing = await db.query.heartbeatRuns.findFirst({
    where: eq(heartbeatRuns.id, runId),
  });
  const snapshot = (existing?.contextSnapshot ?? {}) as Record<string, unknown>;

  await db
    .update(heartbeatRuns)
    .set({
      harnessRunId,
      contextSnapshot: {
        ...snapshot,
        harnessThreadId: threadId,
      },
    })
    .where(eq(heartbeatRuns.id, runId));
}

export async function persistDurableRunId(runId: string, durableRunId: string): Promise<void> {
  await db
    .update(heartbeatRuns)
    .set({ durableRunId })
    .where(eq(heartbeatRuns.id, runId));
}

export async function getResumableDurableRun(
  agentId: string,
  taskId?: string,
): Promise<{ heartbeatRunId: string; durableRunId: string } | null> {
  const rows = await db
    .select()
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.agentId, agentId),
        inArray(heartbeatRuns.status, ['running', 'failed']),
      ),
    )
    .orderBy(desc(heartbeatRuns.startedAt))
    .limit(5);

  for (const row of rows) {
    if (!row.durableRunId) continue;
    const snapshot = row.contextSnapshot as Record<string, unknown> | null;
    const snapshotTaskId =
      typeof snapshot?.taskId === 'string' ? snapshot.taskId : undefined;
    if (taskId && snapshotTaskId !== taskId) continue;
    return { heartbeatRunId: row.id, durableRunId: row.durableRunId };
  }

  return null;
}
